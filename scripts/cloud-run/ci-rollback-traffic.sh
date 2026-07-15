#!/usr/bin/env bash
# 手動rollback: 指定した（または`stable-previous` tagが指す、直前にpromoteされた）
# revisionへproduction trafficを100%戻す（Issue #106 `M45-INFRA-002`、
# `.github/workflows/rollback-cloud-run.yml`から呼ばれる）。API URL自体は
# 変わらないため、Pagesの再deployは通常不要。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise

if [ -z "${TARGET_REVISION:-}" ]; then
  echo "== TARGET_REVISION未指定: stable-previous tagが指すrevisionを自動検出 =="
  # 「直近のReady revision」は使わない——複数回連続でcandidateがsmokeに
  # 失敗すると、未promoteの失敗revisionがReadyのまま残り、`candidate` tagは
  # 常に最新の失敗revisionへ移るため、tagだけの除外でも古い失敗revisionを
  # 再選択し得る（PRレビュー指摘 #112 P1、2026-07-15再レビュー）。
  # `stable-previous`はpromote成功時にだけ`ci-promote-traffic.sh`が更新する
  # 永続的な記録であり、必ず「過去に実際promoteされたrevision」を指す。
  TARGET_REVISION="$(gcloud run services describe "$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format=json \
    | TAG_NAME=stable-previous mise exec -- pnpm exec tsx "$REPO_ROOT/src/infrastructure/deploy/resolve-tagged-revision-cli.ts")"

  if [ -z "$TARGET_REVISION" ]; then
    echo "ERROR: stable-previous tagが見つかりません（promoteの実績が1回以下、または既にrollback済み）。" >&2
    echo "       TARGET_REVISIONを明示して再実行してください。" >&2
    exit 1
  fi
fi

print_deploy_context
echo "TARGET_REVISION=$TARGET_REVISION"

echo "== roll back: shift 100% traffic to target revision =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${TARGET_REVISION}=100"

echo "== mark the rolled-back-to revision as stable (keeps future promote's rotation accurate) =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-tags="stable=${TARGET_REVISION}"

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'

echo
echo "NEXT: SERVICE_URLに対して04-smoke-test.shを再実行し、正常性を確認してください。"
