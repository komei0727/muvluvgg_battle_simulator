#!/usr/bin/env bash
# Timing 2: production imageをbuild/pushし、Artifact Registryへの登録を確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

print_deploy_context
echo "== build and push image with Cloud Build =="
gcloud builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --tag="$IMAGE"

echo "== verification checkpoint: pushed image =="
gcloud artifacts docker images describe "$IMAGE" \
  --project="$PROJECT_ID"

echo
echo "NEXT: image digestとtagを確認後、同じIMAGE_TAGをexportして03-deploy-service.shを実行してください。"
echo "export IMAGE_TAG=$IMAGE_TAG"
