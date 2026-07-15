#!/usr/bin/env bash
# Timing 6: dry-run結果を確認した後、最新3 image以外の自動削除を有効化する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

POLICY_FILE="$REPO_ROOT/deploy/artifact-registry/cleanup-policy.json"

if [ "${CONFIRM_ENABLE_CLEANUP:-}" != "yes" ]; then
  echo "STOP: cleanup deletion is not enabled yet." >&2
  echo "05-verify-cleanup-dry-run.shの結果を確認後、次のように明示して再実行してください:" >&2
  echo "  CONFIRM_ENABLE_CLEANUP=yes $0" >&2
  exit 2
fi

echo "== enable cleanup deletion: keep latest 3 api image versions =="
gcloud artifacts repositories set-cleanup-policies "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --policy="$POLICY_FILE" \
  --no-dry-run

echo "== verification checkpoint: active cleanup policies =="
gcloud artifacts repositories list-cleanup-policies "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID"

echo
echo "Cleanupはバックグラウンドで定期実行され、削除まで約1日かかる場合があります。"
echo "最新3 versionの合計保存容量が0.5 GiBを超える場合、無料枠には収まりません。"
