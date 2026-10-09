#!/usr/bin/env bash
# Timing 2: production imageをbuild/pushし、Artifact Registryへの登録を確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

print_deploy_context
# 手動再deploy（.github/workflows/redeploy-cloud-run.yml）はmainの同じcommitを
# 配置し直すだけなので、そのcommitのimageが既にあればbuildを省く。tagはcommit SHAで、
# pushするのはCIだけなので、同じtagは同じソースからbuildしたimageを指す。
if [ "${REUSE_EXISTING_IMAGE:-false}" = "true" ] \
  && gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "== reuse existing image (REUSE_EXISTING_IMAGE=true) =="
else
  echo "== build and push image with dedicated Cloud Build service account =="
  gcloud builds submit "$REPO_ROOT" \
    --project="$PROJECT_ID" \
    --config="$REPO_ROOT/deploy/cloud-build/build-image.yaml" \
    --substitutions="_IMAGE=$IMAGE" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SERVICE_ACCOUNT_EMAIL}" \
    --suppress-logs
fi

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
