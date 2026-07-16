#!/usr/bin/env bash
# CI: 現在稼働中のrevisionへtrafficを100%固定したまま、新revisionを0%traffic・
# `candidate` tag付きで作成する（Issue #106 `M45-INFRA-002`）。
# `gcloud run services replace`は`--no-traffic`を持たないため、manifest自体の
# `spec.traffic`で新revisionへ0%を宣言し、traffic切替の隙間を作らない。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise
require_command git

MANIFEST_TEMPLATE="$REPO_ROOT/deploy/cloud-run/service.json"
RENDERED_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cloud-run-candidate.json.XXXXXX")"
CURRENT_SERVICE_JSON="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cloud-run-current-service.json.XXXXXX")"
DESCRIBE_STDERR="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cloud-run-describe-stderr.XXXXXX")"
trap 'rm -f "$RENDERED_MANIFEST" "$CURRENT_SERVICE_JSON" "$DESCRIBE_STDERR"' EXIT

REVISION_SUFFIX="${REVISION_SUFFIX:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)}"
REVISION_NAME="${SERVICE}-${REVISION_SUFFIX}"
TRAFFIC_TAG="${TRAFFIC_TAG:-candidate}"

print_deploy_context
echo "REVISION_NAME=$REVISION_NAME"

if ! gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format=json > "$CURRENT_SERVICE_JSON" 2>"$DESCRIBE_STDERR"; then
  echo '{}' > "$CURRENT_SERVICE_JSON"
  echo "WARNING: gcloud run services describe failed for service '$SERVICE':" >&2
  cat "$DESCRIBE_STDERR" >&2
fi

echo "== resolve current production revision =="
# `status.latestReadyRevisionName`は使わない——失敗して一度もpromoteされて
# いないcandidateもReadyになり得るため、次回deployでそれへtraffic 100%を
# 誤って固定してしまう（PRレビュー指摘 #112 P1-1）。`status.traffic`の
# percent===100 revisionだけを正とする（`resolveCurrentRevisionName`）。
PREVIOUS_REVISION_NAME="$(mise exec -- pnpm --filter api exec tsx \
  "$REPO_ROOT/apps/api/src/infrastructure/deploy/resolve-current-revision-cli.ts" \
  < "$CURRENT_SERVICE_JSON")"

# CIは初回Cloud Run deployを行わない——最初のrevisionは
# scripts/cloud-run/03-deploy-service.sh（一度限りの手動セットアップ）で
# 事前に作成済みの前提。describeの失敗（上記WARNING）やservice未作成を
# 「初回deploy」として扱い、未smoke-testの新revisionへ即100% trafficを流す
# ことは、Issue #106の安全条件「smoke test成功後にのみtrafficを確定する」に
# 反するため、fail closedでここを停止する（PRレビュー指摘 #112、
# 2026-07-15、5回目）。
if [ -z "$PREVIOUS_REVISION_NAME" ]; then
  echo "ERROR: 現在100% trafficを受けている既存revisionを特定できませんでした。" >&2
  echo "        service '$SERVICE' が未作成なら、先にscripts/cloud-run/03-deploy-service.sh" >&2
  echo "        （一度限りの手動セットアップ、scripts/cloud-run/README.md「Manual」参照）を" >&2
  echo "        実行してください。describe自体が失敗した場合は上記WARNINGを確認し、" >&2
  echo "        GCP側の一時的な問題でないか調査してください。" >&2
  exit 1
fi
echo "PREVIOUS_REVISION_NAME=$PREVIOUS_REVISION_NAME"

echo "== resolve current stable-previous tag (preserved across this deploy attempt) =="
# `services replace`はspec.traffic全体をこのdeployの新しいdesired stateとして
# 適用するため、既存のstable-previous tagをmanifestへ明示的に含めないと、
# deploy attempt（成功・失敗いずれでも）ごとに失われてしまう
# （PRレビュー指摘 #112 P1、2026-07-15再レビュー）。
STABLE_PREVIOUS_REVISION_NAME="$(TAG_NAME=stable-previous mise exec -- pnpm --filter api exec tsx \
  "$REPO_ROOT/apps/api/src/infrastructure/deploy/resolve-tagged-revision-cli.ts" \
  < "$CURRENT_SERVICE_JSON")"
echo "STABLE_PREVIOUS_REVISION_NAME=${STABLE_PREVIOUS_REVISION_NAME:-<none>}"

echo "== render Cloud Run manifest (candidate at 0% traffic) =="
MANIFEST_TEMPLATE_PATH="$MANIFEST_TEMPLATE" \
  IMAGE="$IMAGE" \
  REVISION_NAME="$REVISION_NAME" \
  PREVIOUS_REVISION_NAME="$PREVIOUS_REVISION_NAME" \
  STABLE_PREVIOUS_REVISION_NAME="$STABLE_PREVIOUS_REVISION_NAME" \
  TRAFFIC_TAG="$TRAFFIC_TAG" \
  RUNTIME_SERVICE_ACCOUNT_EMAIL="$RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  mise exec -- pnpm --filter api exec tsx "$REPO_ROOT/apps/api/src/infrastructure/deploy/render-cloud-run-manifest-cli.ts" \
  > "$RENDERED_MANIFEST"

echo "== deploy candidate revision =="
# unauthenticated invocation (allUsers -> roles/run.invoker) はservice単位のIAM
# policyであり、revisionをまたいで維持される。一度限りの手動セットアップ
# （scripts/cloud-run/03-deploy-service.sh、Timing 3）で設定済みの前提とし、
# ここでは繰り返さない（deploy用service accountをrun.services.setIamPolicyまで
# 拡張しないため、least privilegeを保てる）。
gcloud run services replace "$RENDERED_MANIFEST" \
  --region="$REGION" \
  --project="$PROJECT_ID"

CANDIDATE_URL="$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format=json | TRAFFIC_TAG="$TRAFFIC_TAG" mise exec -- node --input-type=module -e '
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const service = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const target = (service.status?.traffic ?? []).find((t) => t.tag === process.env.TRAFFIC_TAG);
    if (!target?.url) {
      console.error(`ERROR: no traffic target tagged "${process.env.TRAFFIC_TAG}"`);
      process.exit(1);
    }
    process.stdout.write(target.url);
  ')"

if [ -z "$CANDIDATE_URL" ]; then
  echo "ERROR: could not resolve candidate URL for tag '$TRAFFIC_TAG'" >&2
  exit 1
fi

echo
echo "REVISION_NAME=$REVISION_NAME"
echo "PREVIOUS_REVISION_NAME=$PREVIOUS_REVISION_NAME"
echo "CANDIDATE_URL=$CANDIDATE_URL"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "revision_name=$REVISION_NAME"
    echo "previous_revision_name=$PREVIOUS_REVISION_NAME"
    echo "candidate_url=$CANDIDATE_URL"
    echo "image=$IMAGE"
  } >> "$GITHUB_OUTPUT"
fi

echo "NEXT: candidate URLへsmoke testを実行し、成功したらci-promote-traffic.shでtrafficを切り替えてください。"
