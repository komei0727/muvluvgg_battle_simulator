#!/usr/bin/env bash
# Timing 2: production imageをbuild/pushし、Artifact Registryへの登録を確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

print_deploy_context
echo "== build and push image with Cloud Build =="
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --tag="$IMAGE" \
  --suppress-logs

echo "== verification checkpoint: pushed image =="
gcloud artifacts docker images describe "$IMAGE" \
  --project="$PROJECT_ID"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  IMAGE_DIGEST="$(gcloud artifacts docker images describe "$IMAGE" \
    --project="$PROJECT_ID" \
    --format='value(image_summary.digest)')"
  {
    echo "image=$IMAGE"
    echo "image_digest=$IMAGE_DIGEST"
  } >> "$GITHUB_OUTPUT"
fi

echo
echo "NEXT: image digestとtagを確認後、同じIMAGE_TAGをexportして03-deploy-service.shを実行してください。"
echo "export IMAGE_TAG=$IMAGE_TAG"
