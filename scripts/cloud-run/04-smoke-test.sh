#!/usr/bin/env bash
# Timing 4: deploy後のpublic URLでhealth・Catalog・OpenAPI・Swagger・CORSを確認する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command curl
require_command gcloud
require_command grep

SERVICE_URL="${SERVICE_URL:-$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')}"

if [ -z "$SERVICE_URL" ]; then
  echo "ERROR: Cloud Run service URL could not be resolved" >&2
  exit 1
fi

expect_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: $label expected HTTP $expected, got $actual ($url)" >&2
    exit 1
  fi
  echo "OK: $label -> HTTP $actual"
}

echo "SERVICE_URL=$SERVICE_URL"
echo "== public endpoint smoke tests =="
expect_status "GET /health/live" "$SERVICE_URL/health/live" 200
expect_status "GET /health/ready" "$SERVICE_URL/health/ready" 200
expect_status "GET Catalog" "$SERVICE_URL/api/v1/battle-simulation-catalog" 200
expect_status "GET OpenAPI" "$SERVICE_URL/openapi.json" 200
expect_status "Swagger UI is disabled" "$SERVICE_URL/docs" 404

echo "== CORS preflight smoke test =="
CORS_HEADERS="$(mktemp "${TMPDIR:-/tmp}/muvluvgg-cors-headers.XXXXXX")"
trap 'rm -f "$CORS_HEADERS"' EXIT
curl -sS -o /dev/null -D "$CORS_HEADERS" -X OPTIONS \
  "$SERVICE_URL/api/v1/battle-simulations" \
  -H 'Origin: https://komei0727.github.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type'

if ! grep -Eiq '^access-control-allow-origin:[[:space:]]*https://komei0727\.github\.io[[:space:]]*$' "$CORS_HEADERS"; then
  echo "ERROR: expected GitHub Pages Access-Control-Allow-Origin header" >&2
  cat "$CORS_HEADERS" >&2
  exit 1
fi
echo "OK: CORS allows https://komei0727.github.io"

if [ -n "${SMOKE_SIMULATION_BODY_FILE:-}" ]; then
  if [ ! -f "$SMOKE_SIMULATION_BODY_FILE" ]; then
    echo "ERROR: SMOKE_SIMULATION_BODY_FILE does not exist: $SMOKE_SIMULATION_BODY_FILE" >&2
    exit 1
  fi
  echo "== optional battle simulation smoke test =="
  SIMULATION_STATUS="$(curl -sS -o /tmp/muvluvgg-cloud-run-simulation.json -w '%{http_code}' \
    -X POST "$SERVICE_URL/api/v1/battle-simulations" \
    -H 'Content-Type: application/json' \
    --data-binary "@$SMOKE_SIMULATION_BODY_FILE")"
  if [ "$SIMULATION_STATUS" != "200" ]; then
    echo "ERROR: simulation expected HTTP 200, got $SIMULATION_STATUS" >&2
    cat /tmp/muvluvgg-cloud-run-simulation.json >&2
    exit 1
  fi
  rm -f /tmp/muvluvgg-cloud-run-simulation.json
  echo "OK: battle simulation -> HTTP 200"
else
  echo "SKIP: battle simulation（現在のproduction Catalogは選択可能Unitがないため）。"
  echo "      実行する場合はSMOKE_SIMULATION_BODY_FILEを指定してください。"
fi

echo
echo "NEXT: 全項目を確認後、cleanup設定から約1日待って05-verify-cleanup-dry-run.shを実行してください。"
