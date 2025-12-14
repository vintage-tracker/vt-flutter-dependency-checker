#!/usr/bin/env node

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { WebClient } from '@slack/web-api';
import semver from 'semver';
import ExcelJS from 'exceljs';

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
  
  if (!pubspec) {
    console.warn('  ⚠️  pubspec is null or undefined');
    return deps;
  }
  
  if (pubspec.dependencies) {
    Object.entries(pubspec.dependencies).forEach(([name, spec]: [string, any]) => {
      if (name === 'flutter' || name === 'flutter_test') return;
      let version: string;
      if (typeof spec === 'string') {
        version = spec;
      } else if (spec && typeof spec === 'object') {
        version = spec.version || 'any';
      } else {
        version = 'any';
      }
      deps.push({ name, version: version || 'any' });
    });
  }
  
  if (includeDevDeps && pubspec.dev_dependencies) {
    Object.entries(pubspec.dev_dependencies).forEach(([name, spec]: [string, any]) => {
      if (name === 'flutter' || name === 'flutter_test') return;
      let version: string;
      if (typeof spec === 'string') {
        version = spec;
      } else if (spec && typeof spec === 'object') {
        version = spec.version || 'any';
      } else {
        version = 'any';
      }
      deps.push({ name, version: version || 'any' });
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
    
    if (!response.data) {
      throw new Error(`No data returned from pub.dev API for ${packageName}`);
    }
    
    if (!response.data.latest) {
      throw new Error(`No latest version information found for ${packageName}. Response: ${JSON.stringify(response.data).substring(0, 200)}`);
    }
    
    if (!response.data.latest.version) {
      throw new Error(`No version property found in latest for ${packageName}. Latest object: ${JSON.stringify(response.data.latest).substring(0, 200)}`);
    }
    
    return response.data.latest.version;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(`Failed to get latest version for ${packageName}: HTTP ${error.response.status} - ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error(`Failed to get latest version for ${packageName}: No response from server`);
      }
    }
    throw new Error(`Failed to get latest version for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
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
    console.log(`  📥 Fetching pubspec.yaml from ${repository.url}...`);
    const pubspecContent = await getPubspecFromGitHub(repository.url, githubToken);
    console.log(`  ✅ pubspec.yaml fetched (${pubspecContent.length} bytes)`);
    
    const pubspec = yaml.parse(pubspecContent);
    if (!pubspec) {
      throw new Error('Failed to parse pubspec.yaml: result is null');
    }
    console.log(`  ✅ pubspec.yaml parsed successfully`);
    
    const currentFlutter = getFlutterVersionFromPubspec(pubspecContent) || latestFlutter;
    const flutter: FlutterVersion = {
      current: currentFlutter,
      latest: latestFlutter,
      updateAvailable: currentFlutter !== latestFlutter
    };
    
    console.log(`  📦 Extracting dependencies...`);
    const dependencies = extractDependencies(pubspec, true);
    console.log(`  ✅ Found ${dependencies.length} dependencies`);
    
    const packages: PackageInfo[] = [];
    
    for (const dep of dependencies) {
      if (!dep.version || dep.version === 'any') {
        console.log(`  ⏭️  Skipping ${dep.name}: version is '${dep.version}'`);
        continue;
      }
      if (typeof dep.version === 'string' && (dep.version.includes('git:') || dep.version.includes('path:'))) {
        console.log(`  ⏭️  Skipping ${dep.name}: git/path dependency`);
        continue;
      }
      
      try {
        console.log(`    🔍 Checking ${dep.name} (${dep.version})...`);
        const latest = await getLatestPackageVersion(dep.name);
        const updateAvailable = isUpdateAvailable(dep.version, latest);
        if (updateAvailable) {
          console.log(`    🔄 ${dep.name}: ${dep.version} → ${latest}`);
        }
        packages.push({
          name: dep.name,
          current: dep.version,
          latest,
          updateAvailable
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`    ❌ Failed to check package ${dep.name} (current: ${dep.version}): ${errorMessage}`);
        // エラーが発生したパッケージも結果に含める（エラー情報付き）
        packages.push({
          name: dep.name,
          current: dep.version,
          latest: 'N/A',
          updateAvailable: false
        });
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
 * バージョン更新の種類を判定（メジャー/マイナー/パッチ）
 */
function getVersionUpdateType(currentVersion: string, latestVersion: string): 'major' | 'minor' | 'patch' | null {
  try {
    const baseVersion = currentVersion.replace(/^[\^~>=<\s]+/, '').split(/\s+/)[0];
    const current = semver.valid(baseVersion);
    const latest = semver.valid(latestVersion);
    
    if (!current || !latest) {
      return null;
    }
    
    if (semver.major(latest) > semver.major(current)) {
      return 'major';
    } else if (semver.minor(latest) > semver.minor(current)) {
      return 'minor';
    } else if (semver.patch(latest) > semver.patch(current)) {
      return 'patch';
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Excelファイルを生成
 */
async function generateExcelFile(results: CheckResult[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('依存関係チェック結果');
  
  // ヘッダー行
  worksheet.columns = [
    { header: 'リポジトリ', key: 'repository', width: 20 },
    { header: 'パッケージ名', key: 'package', width: 30 },
    { header: '現在のバージョン', key: 'current', width: 20 },
    { header: '最新バージョン', key: 'latest', width: 20 },
    { header: 'Flutterバージョン', key: 'flutter', width: 25 }
  ];
  
  // ヘッダーのスタイル設定
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };
  
  let rowNumber = 2;
  
  for (const result of results) {
    if (result.error) {
      worksheet.addRow({
        repository: result.repository.name,
        package: 'エラー',
        current: result.error,
        latest: '',
        flutter: ''
      });
      worksheet.getRow(rowNumber).font = { color: { argb: 'FFFF0000' } };
      rowNumber++;
      continue;
    }
    
    // Flutterバージョン情報（更新の有無に関わらず表示）
    worksheet.addRow({
      repository: result.repository.name,
      package: 'Flutter SDK',
      current: result.flutter.current,
      latest: result.flutter.latest,
      flutter: result.flutter.updateAvailable 
        ? `${result.flutter.current} → ${result.flutter.latest}`
        : result.flutter.current
    });
    
    // 更新可能な場合はオレンジ色、最新の場合は通常の色
    if (result.flutter.updateAvailable) {
      worksheet.getRow(rowNumber).font = { color: { argb: 'FFFF6600' } };
    }
    rowNumber++;
    
    // パッケージ情報
    for (const pkg of result.packages) {
      worksheet.addRow({
        repository: result.repository.name,
        package: pkg.name,
        current: pkg.current,
        latest: pkg.latest,
        flutter: ''
      });
      
      // 更新可能な場合のみ色分け
      if (pkg.updateAvailable) {
        const updateType = getVersionUpdateType(pkg.current, pkg.latest);
        const row = worksheet.getRow(rowNumber);
        
        if (updateType === 'major') {
          // メジャーバージョンアップ: 赤色
          row.font = { color: { argb: 'FFFF0000' } };
        } else if (updateType === 'minor' || updateType === 'patch') {
          // マイナー/パッチバージョンアップ: 青色
          row.font = { color: { argb: 'FF0066CC' } };
        } else {
          // バージョン判定できない場合: 青色（デフォルト）
          row.font = { color: { argb: 'FF0066CC' } };
        }
      }
      rowNumber++;
    }
  }
  
  // バッファに書き込み
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Slackに通知を送信
 */
async function sendSlackNotification(
  channel: string,
  results: CheckResult[],
  slackToken: string,
  latestFlutter: string
): Promise<void> {
  const slack = new WebClient(slackToken);
  
  const successfulChecks = results.filter(r => !r.error).length;
  const failedChecks = results.filter(r => r.error).length;
  const hasUpdates = results.some(r => 
    !r.error && (r.flutter.updateAvailable || r.packages.some(p => p.updateAvailable))
  );
  
  // 各リポジトリのFlutterバージョン情報を収集
  const flutterVersions: Array<{ repo: string; current: string; latest: string; updateAvailable: boolean }> = [];
  for (const result of results) {
    if (!result.error) {
      flutterVersions.push({
        repo: result.repository.name,
        current: result.flutter.current,
        latest: result.flutter.latest,
        updateAvailable: result.flutter.updateAvailable
      });
    }
  }
  
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
        },
        {
          type: 'mrkdwn',
          text: `*Flutter SDK最新版*\n${latestFlutter}`
        }
      ]
    }
  ];
  
  // Flutterバージョン情報を表示
  if (flutterVersions.length > 0) {
    const flutterVersionText = flutterVersions
      .map(fv => {
        if (fv.updateAvailable) {
          return `• ${fv.repo}: ${fv.current} → ${fv.latest} 🔄`;
        } else {
          return `• ${fv.repo}: ${fv.current} ✅`;
        }
      })
      .join('\n');
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Flutter SDKバージョン*\n${flutterVersionText}`
      }
    });
  }
  
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
  
  // メッセージを送信
  const messageResponse = await slack.chat.postMessage({
    channel,
    text: hasUpdates ? 'Flutter依存関係更新通知' : 'Flutter依存関係チェック結果',
    blocks,
    username: 'Flutter Version Bot',
    icon_emoji: ':flutter:'
  });
  
  // Excelファイルを生成してスレッドに添付（新しいアップロード方法）
  try {
    console.log('📊 Generating Excel file...');
    const excelBuffer = await generateExcelFile(results);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `flutter-dependency-check-${timestamp}.xlsx`;
    
    // Step 1: アップロードURLを取得
    const getUploadURLResponse = await slack.files.getUploadURLExternal({
      filename: filename,
      length: excelBuffer.length
    });
    
    if (!getUploadURLResponse.ok || !getUploadURLResponse.upload_url || !getUploadURLResponse.file_id) {
      throw new Error(getUploadURLResponse.error || 'Failed to get upload URL');
    }
    
    const uploadUrl = getUploadURLResponse.upload_url;
    const fileId = getUploadURLResponse.file_id;
    
    // Step 2: ファイルをアップロード
    await axios.put(uploadUrl, excelBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': excelBuffer.length.toString()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    // Step 3: アップロード完了を通知
    const completeUploadOptions: any = {
      files: [{
        id: fileId,
        title: 'Flutter依存関係チェック結果'
      }],
      channel_id: channel,
      initial_comment: '📊 詳細なチェック結果をExcelファイルで添付しました。'
    };
    
    // メッセージのタイムスタンプが存在する場合はスレッドに添付
    if (messageResponse.ts) {
      completeUploadOptions.thread_ts = messageResponse.ts;
    }
    
    const completeUploadResponse = await slack.files.completeUploadExternal(completeUploadOptions);
    
    if (!completeUploadResponse.ok) {
      throw new Error(completeUploadResponse.error || 'Failed to complete upload');
    }
    
    console.log('✅ Excel file uploaded to Slack thread');
  } catch (error) {
    console.error('❌ Failed to upload Excel file:', error instanceof Error ? error.message : String(error));
    // Excelファイルのアップロードに失敗しても処理は続行
  }
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
  await sendSlackNotification(channel, results, slackToken, latestFlutter);
  console.log('✅ Done!');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

