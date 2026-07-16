#!/usr/bin/env bash

# Cloud Run手動デプロイスクリプト共通設定。
# 呼び出し側が`set -euo pipefail`を設定してからsourceする。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

: "${PROJECT_ID:?PROJECT_IDを設定してください（例: export PROJECT_ID=my-gcp-project）}"

REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-muvluvgg-battle-simulator}"
SERVICE="${SERVICE:-muvluvgg-battle-simulator-api}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
REGISTRY_ROOT="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}"
IMAGE="${REGISTRY_ROOT}/api:${IMAGE_TAG}"

# publicly-invokable(allUsers)なCloud Run containerのruntime identity。
# project既定のCompute Engine SA(既定でroles/editor)へ委ねない専用SAで、
# project IAM roleは付与しない(00-bootstrap-ci-cd.shが作成するP1レビュー指摘対応)。
# gcloud iam service-accounts createのaccount IDは6〜30文字制限のため、
# service名(muvluvgg-battle-simulator-api、29文字)をそのまま流用できない。
RUNTIME_SERVICE_ACCOUNT_ID="${RUNTIME_SERVICE_ACCOUNT_ID:-battle-sim-api-runtime}"
RUNTIME_SERVICE_ACCOUNT_EMAIL="${RUNTIME_SERVICE_ACCOUNT_EMAIL:-${RUNTIME_SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com}"

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $command_name" >&2
    exit 1
  fi
}

print_deploy_context() {
  echo "PROJECT_ID=$PROJECT_ID"
  echo "REGION=$REGION"
  echo "REPOSITORY=$REPOSITORY"
  echo "SERVICE=$SERVICE"
  echo "IMAGE=$IMAGE"
  echo "RUNTIME_SERVICE_ACCOUNT_EMAIL=$RUNTIME_SERVICE_ACCOUNT_EMAIL"
}
