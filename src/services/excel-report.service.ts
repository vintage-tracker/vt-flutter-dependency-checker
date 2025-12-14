import ExcelJS from 'exceljs';
import { CheckResult } from '../types/dependency-types';
import { getVersionUpdateType } from '../utils/version-utils';

/**
 * リポジトリ用のシートを作成
 */
function createRepositorySheet(workbook: ExcelJS.Workbook, result: CheckResult): void {
  // シート名は31文字以内（Excelの制限）で、リポジトリ名を使用
  const sheetName = result.repository.name.length > 31 
    ? result.repository.name.substring(0, 31) 
    : result.repository.name;
  
  const worksheet = workbook.addWorksheet(sheetName);
  
  // ヘッダー行
  worksheet.columns = [
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
  
  if (result.error) {
    worksheet.addRow({
      package: 'エラー',
      current: result.error,
      latest: '',
      flutter: ''
    });
    worksheet.getRow(rowNumber).font = { color: { argb: 'FFFF0000' } };
    return;
  }
  
  // Flutterバージョン情報（更新の有無に関わらず表示）
  worksheet.addRow({
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

/**
 * 概要シートを作成
 */
function createSummarySheet(workbook: ExcelJS.Workbook, results: CheckResult[]): void {
  const worksheet = workbook.addWorksheet('概要');
  
  // ヘッダー行
  worksheet.columns = [
    { header: 'リポジトリ', key: 'repository', width: 25 },
    { header: 'Flutter (現在)', key: 'flutterCurrent', width: 20 },
    { header: 'Flutter (最新)', key: 'flutterLatest', width: 20 },
    { header: 'Flutter更新', key: 'flutterUpdate', width: 15 },
    { header: '更新可能パッケージ数', key: 'outdatedCount', width: 20 },
    { header: '総パッケージ数', key: 'totalCount', width: 15 },
    { header: '状態', key: 'status', width: 15 }
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
        flutterCurrent: 'エラー',
        flutterLatest: '',
        flutterUpdate: '',
        outdatedCount: '',
        totalCount: '',
        status: 'エラー'
      });
      worksheet.getRow(rowNumber).font = { color: { argb: 'FFFF0000' } };
      rowNumber++;
      continue;
    }
    
    const outdatedCount = result.packages.filter(p => p.updateAvailable).length;
    const totalCount = result.packages.length;
    const hasFlutterUpdate = result.flutter.updateAvailable;
    
    worksheet.addRow({
      repository: result.repository.name,
      flutterCurrent: result.flutter.current,
      flutterLatest: result.flutter.latest,
      flutterUpdate: hasFlutterUpdate ? '要更新' : '最新',
      outdatedCount: outdatedCount,
      totalCount: totalCount,
      status: hasFlutterUpdate || outdatedCount > 0 ? '要更新' : '最新'
    });
    
    // 状態に応じて色分け
    const row = worksheet.getRow(rowNumber);
    if (hasFlutterUpdate || outdatedCount > 0) {
      row.getCell(7).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFEB9C' }
      };
      row.getCell(7).font = { color: { argb: 'FF9C5700' }, bold: true };
    } else {
      row.getCell(7).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFC6EFCE' }
      };
      row.getCell(7).font = { color: { argb: 'FF006100' }, bold: true };
    }
    
    // Flutter更新がある場合は色分け
    if (hasFlutterUpdate) {
      row.getCell(4).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFEB9C' }
      };
      row.getCell(4).font = { color: { argb: 'FF9C5700' }, bold: true };
    }
    
    rowNumber++;
  }
}

/**
 * Excelファイルを生成
 */
export async function generateExcelFile(results: CheckResult[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  
  // 概要シートを作成（最初のシート）
  createSummarySheet(workbook, results);
  
  // 各リポジトリごとにシートを作成
  for (const result of results) {
    createRepositorySheet(workbook, result);
  }
  
  // バッファに書き込み
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

