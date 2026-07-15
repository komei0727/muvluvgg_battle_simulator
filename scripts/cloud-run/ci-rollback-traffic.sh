#!/usr/bin/env bash
# 手動rollback: 指定した（または直前にtraffic 100%だった）revisionへproduction
# trafficを100%戻す（Issue #106 `M45-INFRA-002`、`.github/workflows/rollback-cloud-run.yml`
# から呼ばれる）。API URL自体は変わらないため、Pagesの再deployは通常不要。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud
require_command mise

if [ -z "${TARGET_REVISION:-}" ]; then
  echo "== TARGET_REVISION未指定: 現在100%ではない直近のready revisionを自動検出 =="
  TARGET_REVISION="$(gcloud run revisions list \
    --service="$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format=json | mise exec -- node --input-type=module -e '
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const revisions = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const ready = revisions
        .filter((r) => r.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"))
        .sort((a, b) => new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp));
      const current = ready.find((r) => (r.status?.traffic ?? []).some((t) => t.percent === 100));
      const previous = ready.find((r) => r.metadata.name !== current?.metadata?.name);
      if (!previous) {
        console.error("ERROR: no previous ready revision found to roll back to");
        process.exit(1);
      }
      process.stdout.write(previous.metadata.name);
    ')"
fi

: "${TARGET_REVISION:?rollback先のrevisionを特定できませんでした。TARGET_REVISIONを明示してください}"

print_deploy_context
echo "TARGET_REVISION=$TARGET_REVISION"

echo "== roll back: shift 100% traffic to target revision =="
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --to-revisions="${TARGET_REVISION}=100"

echo "== verification checkpoint: traffic split =="
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='yaml(status.url,status.traffic)'

echo
echo "NEXT: SERVICE_URLに対して04-smoke-test.shを再実行し、正常性を確認してください。"
