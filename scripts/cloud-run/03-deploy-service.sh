#!/usr/bin/env bash
# Timing 3: manifestを展開してCloud Runへ適用し、service URLとrevisionを確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise

MANIFEST_TEMPLATE="$REPO_ROOT/deploy/cloud-run/service.json"
RENDERED_MANIFEST="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cloud-run-service.json.XXXXXX")"
trap 'rm -f "$RENDERED_MANIFEST"' EXIT

print_deploy_context
echo "== render Cloud Run manifest =="
export IMAGE SERVICE RUNTIME_SERVICE_ACCOUNT_EMAIL
mise exec -- node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  manifest.metadata.name = process.env.SERVICE;
  manifest.spec.template.spec.containers[0].image = process.env.IMAGE;
  manifest.spec.template.spec.serviceAccountName = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL;
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
' "$MANIFEST_TEMPLATE" > "$RENDERED_MANIFEST"

echo "== deploy Cloud Run service =="
gcloud run services replace "$RENDERED_MANIFEST" \
  --region="$REGION" \
  --project="$PROJECT_ID"

echo "== allow unauthenticated invocation (repository contract) =="
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --member=allUsers \
  --role=roles/run.invoker

echo "== verification checkpoint: deployed service and URL =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(metadata.name,status.url,status.latestReadyRevisionName,status.traffic)'

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"
echo
echo "SERVICE_URL=$SERVICE_URL"
echo "NEXT: revisionがReadyであることを確認後、04-smoke-test.shを実行してください。"
