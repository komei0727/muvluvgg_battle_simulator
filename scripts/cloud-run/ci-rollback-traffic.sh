#!/usr/bin/env bash
# 手動rollback: 指定した（または直前にtraffic 100%だった）revisionへproduction
# trafficを100%戻す（Issue #106 `M45-INFRA-002`、`.github/workflows/rollback-cloud-run.yml`
# から呼ばれる）。API URL自体は変わらないため、Pagesの再deployは通常不要。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise

CANDIDATE_TAG="${TRAFFIC_TAG:-candidate}"

if [ -z "${TARGET_REVISION:-}" ]; then
  echo "== TARGET_REVISION未指定: 現在productionのrevisionと直近candidateのtagを除いた、直近のready revisionを自動検出 =="
  # Revision resourceにはtraffic割当が無いため、Service側のstatus.trafficから
  # 「現在100%のrevision」と「候補（`candidate`）tagが指すrevision」を求め、
  # 両方を除外する（PRレビュー指摘 #112 P1-2: 除外しないと、smokeに失敗した
  # ばかりの不良candidateが「直近のready revision」として再選択され得る）。
  SERVICE_JSON="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-rollback-service.json.XXXXXX")"
  REVISIONS_JSON="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-rollback-revisions.json.XXXXXX")"
  trap 'rm -f "$SERVICE_JSON" "$REVISIONS_JSON"' EXIT

  gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format=json > "$SERVICE_JSON"
  gcloud run revisions list \
    --service="$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format=json > "$REVISIONS_JSON"

  TARGET_REVISION="$(SERVICE_JSON_PATH="$SERVICE_JSON" \
    REVISIONS_JSON_PATH="$REVISIONS_JSON" \
    CANDIDATE_TAG="$CANDIDATE_TAG" \
    mise exec -- pnpm exec tsx "$REPO_ROOT/src/infrastructure/deploy/resolve-rollback-target-cli.ts")"
fi

: "${TARGET_REVISION:?rollback先のrevisionを特定できませんでした。TARGET_REVISIONを明示してください}"

print_deploy_context
echo "TARGET_REVISION=$TARGET_REVISION"

echo "== roll back: shift 100% traffic to target revision =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${TARGET_REVISION}=100"

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'

echo
echo "NEXT: SERVICE_URLに対して04-smoke-test.shを再実行し、正常性を確認してください。"
