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
    | TAG_NAME=stable-previous mise exec -- pnpm --filter api exec tsx "$REPO_ROOT/apps/api/src/infrastructure/deploy/resolve-tagged-revision-cli.ts")"

  if [ -z "$TARGET_REVISION" ]; then
    echo "ERROR: stable-previous tagが見つかりません（promoteの実績が1回以下、または既にrollback済み）。" >&2
    echo "       TARGET_REVISIONを明示して再実行してください。" >&2
    exit 1
  fi
fi

print_deploy_context
echo "TARGET_REVISION=$TARGET_REVISION"

echo "== roll back: shift traffic, mark target as stable, and clear stable-previous atomically =="
# --to-revisions・--update-tags・--remove-tagsを1回のupdate-traffic呼び出しに
# まとめる。traffic切替とtag更新を別呼び出しに分けると、間で失敗した場合に
# 「新trafficは既にtarget revisionだがstableは旧revisionのまま」という不整合が
# 残り得る（PRレビュー指摘 #112 P2と同種の懸念）。stable-previousは削除する
# ——rollback後もstable-previousが残ると、次回の自動rollbackが「現在traffic
# を受けているrevision」を再び選び、no-opのまま成功扱いになってしまう
# （PRレビュー指摘 #112 P1、2026-07-15 3回目レビュー）。rollback後、より
# 過去のrevisionへ更にrollbackしたい場合はTARGET_REVISIONを明示する。
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${TARGET_REVISION}=100" \
  --update-tags="stable=${TARGET_REVISION}" \
  --remove-tags="stable-previous"

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'

echo
echo "NEXT: SERVICE_URLに対して04-smoke-test.shを再実行し、正常性を確認してください。"
