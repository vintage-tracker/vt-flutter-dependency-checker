#!/bin/bash

# Load environment variables
source .env 2>/dev/null || true

# Read repository information from repositories.json
if [ ! -f "repositories.json" ]; then
  echo "❌ エラー: repositories.json ファイルが見つかりません"
  exit 1
fi

REPO_COUNT=$(jq '.repositories | length' repositories.json)
echo "🚀 詳細経過表示付きリポジトリチェック"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 チェック対象: ${REPO_COUNT}つのリポジトリ"

# Display repository list dynamically
jq -r '.repositories[] | "   \(.name) - \(.description)"' repositories.json | nl -w3 -s". "
echo ""
echo "🔧 実行内容:"
echo "   • GitHub APIからpubspec.yaml取得"
echo "   • FVM設定からFlutterバージョン検出"
echo "   • pub.devから最新パッケージ情報取得"
echo "   • Excelレポート生成"
echo "   • Slack通知送信"
echo ""

# Create request file with proper MCP initialization
REQUEST_FILE=$(mktemp)

# Generate repositories array from repositories.json
REPOSITORIES_JSON=$(jq -c '.repositories | map({"name": .name, "url": .url, "checkImaSdk": .checkImaSdk, "imaPlatforms": .imaPlatforms})' repositories.json)

# Get settings from repositories.json
NOTIFY_CHANNEL=$(jq -r '.settings.defaultNotifyChannel // "#notification-from-locotele-bot"' repositories.json)
INCLUDE_DEV_DEPS=$(jq -r '.settings.includeDevDeps // true' repositories.json)
SECURITY_SCAN=$(jq -r '.settings.securityScan // true' repositories.json)

# Convert channel name to ID if needed (keep existing ID format for backward compatibility)
if [ "$NOTIFY_CHANNEL" = "#notification-from-locotele-bot" ]; then
  NOTIFY_CHANNEL="C0123456789A"
fi

cat > "$REQUEST_FILE" << EOF
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "check-progress-client", "version": "1.0.0"}}}
{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "check_multiple_repositories", "arguments": {"repositories": $REPOSITORIES_JSON, "notifyChannel": "$NOTIFY_CHANNEL", "includeDevDeps": $INCLUDE_DEV_DEPS, "securityScan": $SECURITY_SCAN}}}
EOF

echo "📤 MCPサーバー起動中..."

# Start server and pipe output in real-time
echo "🔌 サーバー接続完了"
echo "📊 処理開始..."

# Use a simpler approach - just run the server and process output line by line
PROCESSING_STARTED=false
# Export environment variables for the Node.js process
export SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN"
export GITHUB_TOKEN="$GITHUB_TOKEN"
export DEFAULT_SLACK_CHANNEL="$DEFAULT_SLACK_CHANNEL"
node dist/server.js < "$REQUEST_FILE" 2>&1 | while IFS= read -r line; do
  # Filter and enhance output
  if [[ "$line" == *"App Version MCP Server running on stdio"* ]]; then
    echo "✅ MCPサーバー準備完了"
  elif [[ "$line" == *"result"* && "$line" == *"protocolVersion"* ]]; then
    echo "🤝 MCP プロトコル初期化完了"
  elif [[ "$line" == *"📊 Generating Excel report"* ]]; then
    echo "📋 Excelレポート生成中..."
    PROCESSING_STARTED=true
  elif [[ "$line" == *"📎 Uploading Excel file to Slack"* ]]; then
    echo "📤 Excelファイルアップロード開始..."
  elif [[ "$line" == *"📎 Uploading file:"* ]]; then
    FILENAME=$(echo "$line" | sed 's/.*Uploading file: \([^ ]*\).*/\1/')
    echo "   📄 ファイル: $FILENAME"
  elif [[ "$line" == *"📍 Channel:"* ]]; then
    THREAD_ID=$(echo "$line" | grep -o '[0-9]*\.[0-9]*')
    echo "📍 Slackスレッド作成完了 (ID: $THREAD_ID)"
  elif [[ "$line" == *"🔗 Step 1: Getting upload URL"* ]]; then
    echo "   🔗 ステップ1: アップロードURL取得中..."
  elif [[ "$line" == *"✅ Got upload URL and file ID:"* ]]; then
    FILE_ID=$(echo "$line" | grep -o 'F[A-Z0-9]*')
    echo "   ✅ ステップ1完了: アップロードURL取得成功 (ID: $FILE_ID)"
  elif [[ "$line" == *"📤 Step 2: Uploading file binary data"* ]]; then
    echo "   📤 ステップ2: ファイルバイナリアップロード中..."
  elif [[ "$line" == *"✅ File binary uploaded successfully"* ]]; then
    echo "   ✅ ステップ2完了: ファイルアップロード成功"
  elif [[ "$line" == *"🎯 Step 3: Completing upload"* ]]; then
    echo "   🎯 ステップ3: アップロード完了処理中..."
  elif [[ "$line" == *"✅ File upload completed successfully:"* ]]; then
    echo "   ✅ ステップ3完了: ファイルアップロード完了"
  elif [[ "$line" == *"✅ Excel report sent successfully"* ]]; then
    echo "🎉 Excelレポート送信完了！"
  elif [[ "$line" == *"WARN"* ]]; then
    # Skip warning messages
    continue
  elif [[ "$line" == *"dotenv"* ]]; then
    # Skip dotenv messages
    continue
  elif [[ "$line" == *"{"* && "$line" == *"result"* && "$line" == *"totalRepositories"* ]]; then
    echo "📊 処理結果: 全リポジトリ分析完了"
  else
    # Show other important messages, but filter out JSON responses and MCP protocol messages
    if [[ ${#line} -gt 0 && "$line" != *"{"* && "$line" != *"}"* && "$line" != *"jsonrpc"* && "$line" != *"protocolVersion"* ]]; then
      echo "🔍 $line"
    fi
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 全ての処理が完了しました！"
echo "📱 Slackの #notification-from-locotele-bot チャンネルで以下を確認してください:"
echo "   • 複数リポジトリサマリーメッセージ"
echo "   • 各リポジトリの詳細スレッド (${REPO_COUNT}つ)"
echo "   • 詳細Excelレポート添付"
echo ""

# Cleanup
rm -f "$REQUEST_FILE"