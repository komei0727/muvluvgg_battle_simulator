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
trap 'rm -f "$RENDERED_MANIFEST"' EXIT

REVISION_SUFFIX="${REVISION_SUFFIX:-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)}"
REVISION_NAME="${SERVICE}-${REVISION_SUFFIX}"
TRAFFIC_TAG="${TRAFFIC_TAG:-candidate}"

print_deploy_context
echo "REVISION_NAME=$REVISION_NAME"

echo "== resolve previous ready revision (empty on first deploy) =="
PREVIOUS_REVISION_NAME="$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"
echo "PREVIOUS_REVISION_NAME=${PREVIOUS_REVISION_NAME:-<none, first deploy>}"

echo "== render Cloud Run manifest (candidate at 0% traffic) =="
MANIFEST_TEMPLATE_PATH="$MANIFEST_TEMPLATE" \
  IMAGE="$IMAGE" \
  REVISION_NAME="$REVISION_NAME" \
  PREVIOUS_REVISION_NAME="$PREVIOUS_REVISION_NAME" \
  TRAFFIC_TAG="$TRAFFIC_TAG" \
  mise exec -- pnpm exec tsx "$REPO_ROOT/src/infrastructure/deploy/render-cloud-run-manifest-cli.ts" \
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
echo "PREVIOUS_REVISION_NAME=${PREVIOUS_REVISION_NAME:-}"
echo "CANDIDATE_URL=$CANDIDATE_URL"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "revision_name=$REVISION_NAME"
    echo "previous_revision_name=${PREVIOUS_REVISION_NAME:-}"
    echo "candidate_url=$CANDIDATE_URL"
    echo "image=$IMAGE"
  } >> "$GITHUB_OUTPUT"
fi

echo "NEXT: candidate URLへsmoke testを実行し、成功したらci-promote-traffic.shでtrafficを切り替えてください。"
