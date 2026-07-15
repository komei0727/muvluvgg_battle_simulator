#!/usr/bin/env bash
# CI: smoke test成功後、candidate revisionへproduction trafficを100%切り替える
# （Issue #106 `M45-INFRA-002`）。この script実行前にtrafficを動かさないため、
# smoke test失敗時はこのscriptを呼ばなければ新revisionへtrafficは流れない。
#
# 昇格に合わせて`stable`／`stable-previous` tagを回す。この2つはpromote成功時
# にだけ更新される永続的な記録であり、rollback先の自動検出
# （`ci-rollback-traffic.sh`）はこれを読む。「直近のReady revision」を rollback
# 先候補にすると、複数回連続でcandidateがsmokeに失敗した際に未promoteの
# 失敗revisionを再選択してしまうため使わない（PRレビュー指摘 #112 P1、
# 2026-07-15再レビュー）。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise

: "${REVISION_NAME:?REVISION_NAMEを設定してください（ci-deploy-candidate.shの出力）}"

print_deploy_context
echo "REVISION_NAME=$REVISION_NAME"

echo "== resolve current stable revision (empty on first-ever promote) =="
CURRENT_STABLE_REVISION_NAME="$( (gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format=json 2>/dev/null || echo '{}') \
  | TAG_NAME=stable mise exec -- pnpm exec tsx "$REPO_ROOT/src/infrastructure/deploy/resolve-tagged-revision-cli.ts")"
echo "CURRENT_STABLE_REVISION_NAME=${CURRENT_STABLE_REVISION_NAME:-<none, first promote>}"

echo "== promote candidate revision to 100% traffic =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${REVISION_NAME}=100"

echo "== rotate stable/stable-previous tags =="
if [ -n "$CURRENT_STABLE_REVISION_NAME" ] && [ "$CURRENT_STABLE_REVISION_NAME" != "$REVISION_NAME" ]; then
  gcloud run services update-traffic "$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --update-tags="stable-previous=${CURRENT_STABLE_REVISION_NAME},stable=${REVISION_NAME}"
else
  gcloud run services update-traffic "$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --update-tags="stable=${REVISION_NAME}"
fi

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'
