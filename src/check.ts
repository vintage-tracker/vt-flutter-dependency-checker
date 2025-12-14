#!/usr/bin/env node

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { WebClient } from '@slack/web-api';
import semver from 'semver';

interface Repository {
  name: string;
  description?: string;
  url: string;
}

interface Config {
  repositories: Repository[];
  settings: {
    includeDevDeps?: boolean;
  };
}

interface FlutterVersion {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface PackageInfo {
  name: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface CheckResult {
  repository: Repository;
  flutter: FlutterVersion;
  packages: PackageInfo[];
  error?: string;
}

/**
 * Flutterバージョンを取得
 */
async function getLatestFlutterVersion(): Promise<string> {
  try {
    const response = await axios.get(
      'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json',
      { timeout: 10000 }
    );
    const releases = response.data.releases;
    const stableReleases = releases.filter((r: any) => r.channel === 'stable');
    if (stableReleases.length > 0) {
      return stableReleases[0].version;
    }
    throw new Error('No stable releases found');
  } catch (error) {
    // Fallback to GitHub API
    const response = await axios.get(
      'https://api.github.com/repos/flutter/flutter/releases',
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Flutter-Version-Checker'
        },
        timeout: 10000
      }
    );
    const stableRelease = response.data.find(
      (r: any) => !r.prerelease && !r.draft && !r.tag_name.includes('-')
    );
    if (stableRelease) {
      return stableRelease.tag_name.replace(/^v/, '');
    }
    throw new Error('Failed to get Flutter version');
  }
}

/**
 * pubspec.yamlからFlutterバージョンを取得
 */
function getFlutterVersionFromPubspec(pubspecContent: string): string | null {
  try {
    const lines = pubspecContent.split('\n');
    let inEnvironment = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'environment:') {
        inEnvironment = true;
        continue;
      }
      if (inEnvironment && trimmed.startsWith('flutter:')) {
        const flutterConstraint = trimmed.replace('flutter:', '').trim();
        const versionMatch = flutterConstraint.match(/(\d+\.\d+\.\d+)/);
        if (versionMatch) {
          return versionMatch[1];
        }
      }
      if (inEnvironment && line.match(/^\s*\w+:/) && !line.includes('flutter:')) {
        break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GitHubからpubspec.yamlを取得
 */
async function getPubspecFromGitHub(repoUrl: string, githubToken?: string): Promise<string> {
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }
  const [, owner, repo] = match;
  
  const headers: any = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Flutter-Version-Checker'
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }
  
  const response = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/pubspec.yaml`,
    { headers, timeout: 10000 }
  );
  
  return Buffer.from(response.data.content, 'base64').toString('utf-8');
}

/**
 * pubspec.yamlから依存関係を抽出
 */
function extractDependencies(pubspec: any, includeDevDeps: boolean): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  
  if (pubspec.dependencies) {
    Object.entries(pubspec.dependencies).forEach(([name, spec]: [string, any]) => {
      if (name === 'flutter' || name === 'flutter_test') return;
      const version = typeof spec === 'string' ? spec : spec.version || 'any';
      deps.push({ name, version });
    });
  }
  
  if (includeDevDeps && pubspec.dev_dependencies) {
    Object.entries(pubspec.dev_dependencies).forEach(([name, spec]: [string, any]) => {
      if (name === 'flutter' || name === 'flutter_test') return;
      const version = typeof spec === 'string' ? spec : spec.version || 'any';
      deps.push({ name, version });
    });
  }
  
  return deps;
}

/**
 * pub.devからパッケージの最新バージョンを取得
 */
async function getLatestPackageVersion(packageName: string): Promise<string> {
  try {
    const response = await axios.get(
      `https://pub.dev/api/packages/${packageName}`,
      { timeout: 10000 }
    );
    return response.data.latest.version;
  } catch (error) {
    throw new Error(`Failed to get latest version for ${packageName}: ${error}`);
  }
}

/**
 * バージョン更新が利用可能かチェック
 */
function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  try {
    const baseVersion = currentVersion.replace(/^[\^~>=<\s]+/, '').split(/\s+/)[0];
    if (semver.valid(baseVersion) && semver.valid(latestVersion)) {
      return semver.gt(latestVersion, baseVersion) && 
             !semver.satisfies(latestVersion, currentVersion);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * リポジトリをチェック
 */
async function checkRepository(
  repository: Repository,
  latestFlutter: string,
  githubToken?: string
): Promise<CheckResult> {
  try {
    const pubspecContent = await getPubspecFromGitHub(repository.url, githubToken);
    const pubspec = yaml.parse(pubspecContent);
    
    const currentFlutter = getFlutterVersionFromPubspec(pubspecContent) || latestFlutter;
    const flutter: FlutterVersion = {
      current: currentFlutter,
      latest: latestFlutter,
      updateAvailable: currentFlutter !== latestFlutter
    };
    
    const dependencies = extractDependencies(pubspec, true);
    const packages: PackageInfo[] = [];
    
    for (const dep of dependencies) {
      if (dep.version === 'any' || dep.version.includes('git:') || dep.version.includes('path:')) {
        continue;
      }
      
      try {
        const latest = await getLatestPackageVersion(dep.name);
        packages.push({
          name: dep.name,
          current: dep.version,
          latest,
          updateAvailable: isUpdateAvailable(dep.version, latest)
        });
      } catch (error) {
        console.warn(`Failed to check ${dep.name}: ${error}`);
      }
    }
    
    return {
      repository,
      flutter,
      packages
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to check ${repository.name}: ${errorMessage}`);
    return {
      repository,
      flutter: {
        current: 'unknown',
        latest: latestFlutter,
        updateAvailable: false
      },
      packages: [],
      error: errorMessage
    };
  }
}

/**
 * Slackに通知を送信
 */
async function sendSlackNotification(
  channel: string,
  results: CheckResult[],
  slackToken: string
): Promise<void> {
  const slack = new WebClient(slackToken);
  
  const successfulChecks = results.filter(r => !r.error).length;
  const failedChecks = results.filter(r => r.error).length;
  const hasUpdates = results.some(r => 
    !r.error && (r.flutter.updateAvailable || r.packages.some(p => p.updateAvailable))
  );
  
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: hasUpdates ? '🔄 Flutter依存関係更新通知' : '✅ Flutter依存関係チェック結果'
      }
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*総リポジトリ数*\n${results.length}個`
        },
        {
          type: 'mrkdwn',
          text: `*成功*\n${successfulChecks}個`
        },
        {
          type: 'mrkdwn',
          text: `*失敗*\n${failedChecks}個`
        }
      ]
    }
  ];
  
  // 更新があるリポジトリの詳細
  for (const result of results) {
    if (result.error) {
      // 失敗したリポジトリの情報を表示
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*❌ ${result.repository.name}*\nエラー: ${result.error}`
        }
      });
      continue;
    }
    
    const outdatedPackages = result.packages.filter(p => p.updateAvailable);
    const hasFlutterUpdate = result.flutter.updateAvailable;
    
    if (hasFlutterUpdate || outdatedPackages.length > 0) {
      const packageList = outdatedPackages
        .slice(0, 5)
        .map(p => `• ${p.name}: ${p.current} → ${p.latest}`)
        .join('\n');
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${result.repository.name}*\n` +
            (hasFlutterUpdate ? `Flutter: ${result.flutter.current} → ${result.flutter.latest}\n` : '') +
            (outdatedPackages.length > 0 
              ? `更新可能パッケージ (${outdatedPackages.length}個):\n${packageList}${outdatedPackages.length > 5 ? `\n... 他 ${outdatedPackages.length - 5}個` : ''}`
              : '')
        }
      });
    }
  }
  
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `最終チェック: ${new Date().toLocaleString('ja-JP')}`
      }
    ]
  });
  
  await slack.chat.postMessage({
    channel,
    text: hasUpdates ? 'Flutter依存関係更新通知' : 'Flutter依存関係チェック結果',
    blocks,
    username: 'Flutter Version Bot',
    icon_emoji: ':flutter:'
  });
}

/**
 * メイン処理
 */
async function main() {
  const configPath = process.env.REPOSITORIES_CONFIG || path.join(process.cwd(), 'repositories.json');
  
  if (!fs.existsSync(configPath)) {
    console.error(`Error: ${configPath} not found`);
    console.error('Please create repositories.json or set REPOSITORIES_CONFIG environment variable');
    process.exit(1);
  }
  
  const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const githubToken = process.env.GH_TOKEN;
  
  if (!slackToken) {
    console.error('Error: SLACK_BOT_TOKEN environment variable is required');
    process.exit(1);
  }
  
  console.log('🔍 Checking Flutter versions and packages...');
  const latestFlutter = await getLatestFlutterVersion();
  console.log(`✅ Latest Flutter version: ${latestFlutter}`);
  
  const results: CheckResult[] = [];
  for (const repo of config.repositories) {
    console.log(`Checking ${repo.name}...`);
    const result = await checkRepository(repo, latestFlutter, githubToken);
    results.push(result);
  }
  
  console.log('📤 Sending notification to Slack...');
  // チャンネルIDは環境変数で指定（必須）
  const channel = process.env.SLACK_CHANNEL;
  if (!channel) {
    console.error('Error: SLACK_CHANNEL environment variable is required');
    process.exit(1);
  }
  await sendSlackNotification(channel, results, slackToken);
  console.log('✅ Done!');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

