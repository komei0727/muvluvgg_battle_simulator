#!/usr/bin/env bash
# Timing 5: dry-run設定から約1日後、削除候補の監査ログと現在のimageを確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

LOG_RESULT="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cleanup-dry-run.XXXXXX")"
trap 'rm -f "$LOG_RESULT"' EXIT

echo "== cleanup policies =="
gcloud artifacts repositories list-cleanup-policies "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID"

echo "== current api image versions =="
gcloud artifacts docker images list "$REGISTRY_ROOT/api" \
  --include-tags \
  --project="$PROJECT_ID"

echo "== verification checkpoint: dry-run deletion candidates =="
LOG_FILTER="protoPayload.serviceName=\"artifactregistry.googleapis.com\" AND protoPayload.request.parent=\"projects/${PROJECT_ID}/locations/${REGION}/repositories/${REPOSITORY}/packages/-\" AND protoPayload.request.validateOnly=true"
gcloud logging read "$LOG_FILTER" \
  --resource-names="projects/$PROJECT_ID" \
  --project="$PROJECT_ID" \
  --limit=20 \
  --format='yaml(timestamp,protoPayload.request.names)' > "$LOG_RESULT"

if [ -s "$LOG_RESULT" ]; then
  cat "$LOG_RESULT"
  echo
  echo "上記がdry-runで削除対象となるversionです。最新3 versionが含まれないことを確認してください。"
else
  echo "削除候補のdry-runログは見つかりませんでした。"
  echo "imageが3個以下なら正常です。4個以上なら、設定から約1日待ったうえで再確認してください。"
  echo "また、Artifact RegistryのDATA_WRITE監査ログが有効であることを確認してください。"
fi

echo
echo "NEXT: dry-run結果が妥当であることを確認後、06-enable-cleanup-policy.shを実行してください。"
