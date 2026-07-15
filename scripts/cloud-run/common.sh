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
}
