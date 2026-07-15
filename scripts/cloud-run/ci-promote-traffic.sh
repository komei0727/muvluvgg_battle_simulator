#!/usr/bin/env bash
# CI: smoke test成功後、candidate revisionへproduction trafficを100%切り替える
# （Issue #106 `M45-INFRA-002`）。この script実行前にtrafficを動かさないため、
# smoke test失敗時はこのscriptを呼ばなければ新revisionへtrafficは流れない。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

: "${REVISION_NAME:?REVISION_NAMEを設定してください（ci-deploy-candidate.shの出力）}"

print_deploy_context
echo "REVISION_NAME=$REVISION_NAME"

echo "== promote candidate revision to 100% traffic =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${REVISION_NAME}=100"

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'
