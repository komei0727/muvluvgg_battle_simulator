#!/usr/bin/env bash
# Timing 1: 初回準備。API・repository・cleanup policyのdry-run設定を確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

POLICY_FILE="$REPO_ROOT/deploy/artifact-registry/cleanup-policy.json"

print_deploy_context
echo "== enable required Google Cloud APIs =="
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT_ID"

echo "== ensure Artifact Registry repository exists =="
if gcloud artifacts repositories describe "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Artifact Registry repository already exists: $REPOSITORY"
else
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --description="muvluvgg-battle-simulator production container images"
fi

echo "== apply cleanup policy in dry-run mode =="
gcloud artifacts repositories set-cleanup-policies "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --policy="$POLICY_FILE" \
  --dry-run

echo "== verification checkpoint: repository and cleanup policies =="
gcloud artifacts repositories describe "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID"
gcloud artifacts repositories list-cleanup-policies "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID"

echo
echo "NEXT: repositoryとdry-run設定を確認後、02-build-and-push-image.shを実行してください。"
echo "Cleanupのdry-run結果はバックグラウンド評価のため、反映まで約1日かかる場合があります。"
