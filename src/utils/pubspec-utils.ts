import * as yaml from 'yaml';

/**
 * .fvmrcからFlutterバージョンを取得
 */
export function getFlutterVersionFromFvmrc(fvmrcContent: string): string | null {
  try {
    const trimmed = fvmrcContent.trim();
    
    // JSON形式の.fvmrcをサポート: {"flutter": "3.32.8"}
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        if (json.flutter && typeof json.flutter === 'string') {
          const versionMatch = json.flutter.match(/(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            return versionMatch[1];
          }
        }
      } catch (jsonError) {
        // JSON解析に失敗した場合は次の方法を試す
      }
    }
    
    // YAML形式の.fvmrcをサポート: flutter: "3.24.0" または flutter: 3.24.0
    const lines = trimmed.split('\n');
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (lineTrimmed.startsWith('flutter:')) {
        const flutterValue = lineTrimmed.replace('flutter:', '').trim().replace(/['"]/g, '');
        const versionMatch = flutterValue.match(/(\d+\.\d+\.\d+)/);
        if (versionMatch) {
          return versionMatch[1];
        }
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * pubspec.yamlからFlutterバージョンを取得
 */
export function getFlutterVersionFromPubspec(pubspecContent: string): string | null {
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
 * pubspec.yamlから依存関係を抽出
 */
export function extractDependencies(pubspec: any, includeDevDeps: boolean): Array<{ name: string; version: string }> {
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

