#!/usr/bin/env bash
# `11_インフラストラクチャ設計.md`「Container契約」
# 「production imageはローカルcontainer testで、`PORT`の上書き、Catalog読込、
# Worker file解決、SIGTERM、non-root実行を検証する」を満たすlocal smoke test。
# `docker`が必要。`mise exec -- pnpm run validate-catalog`などと同様、
# CIやローカルから明示的に実行する（`mise run check`には含めない——
# Dockerを要求する`test:integration`/`test:e2e`/`test:load`と同じ扱い）。
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_TAG="muvluvgg-battle-simulator-api:smoke-test"
PROD_CONTAINER="muvluvgg-smoke-prod-catalog"
FIXTURE_CONTAINER="muvluvgg-smoke-fixture-catalog"
PROD_PORT=18080
FIXTURE_PORT=18081
FIXTURE_CATALOG_DIR="$(pwd)/src/infrastructure/catalog/__fixtures__/runtime/valid/minimal"

cleanup() {
  docker rm -f "$PROD_CONTAINER" "$FIXTURE_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAILED: $1" >&2
  exit 1
}

wait_for_http() {
  local url="$1"
  local attempts=0
  until curl -sS -o /dev/null "$url" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      fail "timed out waiting for $url"
    fi
    sleep 0.5
  done
}

expect_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local method="${4:-GET}"
  local actual
  actual=$(curl -sS -o /dev/null -X "$method" -w '%{http_code}' "$url")
  if [ "$actual" != "$expected" ]; then
    fail "$label: expected HTTP $expected, got $actual ($url)"
  fi
  echo "OK: $label -> $actual"
}

echo "== build (linux/amd64) =="
docker build --platform linux/amd64 -t "$IMAGE_TAG" .

echo "== run: baked-in production Catalog =="
docker run -d --name "$PROD_CONTAINER" -p "${PROD_PORT}:8080" \
  -e PORT=8080 \
  -e WORKER_MAX_QUEUE=1 \
  -e SHUTDOWN_GRACE_MS=8000 \
  -e CORS_ALLOWED_ORIGINS=https://komei0727.github.io \
  "$IMAGE_TAG" >/dev/null

RUN_USER=$(docker exec "$PROD_CONTAINER" whoami)
if [ "$RUN_USER" = "root" ]; then
  fail "container must not run as root (got: $RUN_USER)"
fi
echo "OK: container runs as non-root user ($RUN_USER)"

wait_for_http "http://localhost:${PROD_PORT}/health/live"
expect_status "GET /health/live (injected PORT, 0.0.0.0 bind)" "http://localhost:${PROD_PORT}/health/live" 200
expect_status "GET /health/ready (Catalog + Worker warm-up succeeded)" "http://localhost:${PROD_PORT}/health/ready" 200
expect_status "GET /api/v1/battle-simulation-catalog (baked-in Catalog resolves)" \
  "http://localhost:${PROD_PORT}/api/v1/battle-simulation-catalog" 200
expect_status "GET /openapi.json (always public)" "http://localhost:${PROD_PORT}/openapi.json" 200
expect_status "GET /docs (Swagger UI disabled in production)" "http://localhost:${PROD_PORT}/docs" 404

echo "== SIGTERM: readiness fails immediately, process exits within SHUTDOWN_GRACE_MS =="
docker kill --signal=SIGTERM "$PROD_CONTAINER" >/dev/null
SIGTERM_START=$(date +%s)
until [ "$(docker inspect -f '{{.State.Running}}' "$PROD_CONTAINER" 2>/dev/null)" = "false" ]; do
  ELAPSED=$(( $(date +%s) - SIGTERM_START ))
  if [ "$ELAPSED" -ge 10 ]; then
    fail "container did not stop within 10s of SIGTERM (SHUTDOWN_GRACE_MS=8000)"
  fi
  sleep 0.5
done
SIGTERM_ELAPSED=$(( $(date +%s) - SIGTERM_START ))
EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$PROD_CONTAINER")
if [ "$EXIT_CODE" != "0" ]; then
  fail "container exited with code $EXIT_CODE after SIGTERM (expected 0)"
fi
echo "OK: SIGTERM -> graceful exit 0 in ${SIGTERM_ELAPSED}s (<= SHUTDOWN_GRACE_MS=8s + margin)"

echo "== run: bind-mounted minimal Catalog fixture (selectable units) for an end-to-end simulation =="
docker run -d --name "$FIXTURE_CONTAINER" -p "${FIXTURE_PORT}:8080" \
  -e PORT=8080 \
  -e CATALOG_PATH=/fixtures/catalog \
  -e WORKER_MAX_QUEUE=1 \
  -v "${FIXTURE_CATALOG_DIR}:/fixtures/catalog:ro" \
  "$IMAGE_TAG" >/dev/null

wait_for_http "http://localhost:${FIXTURE_PORT}/health/ready"
expect_status "GET /health/ready (mounted Catalog resolves)" "http://localhost:${FIXTURE_PORT}/health/ready" 200

SIMULATION_STATUS=$(curl -sS -o /tmp/muvluvgg-smoke-simulation.json -w '%{http_code}' \
  -X POST "http://localhost:${FIXTURE_PORT}/api/v1/battle-simulations" \
  -H 'Content-Type: application/json' \
  -d '{
    "allyFormation": {
      "units": [{ "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } }],
      "memoryDefinitionIds": []
    },
    "enemyFormation": {
      "units": [{ "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } }],
      "memoryDefinitionIds": []
    },
    "turnLimit": 3
  }')
if [ "$SIMULATION_STATUS" != "200" ]; then
  fail "POST /api/v1/battle-simulations: expected HTTP 200, got $SIMULATION_STATUS ($(cat /tmp/muvluvgg-smoke-simulation.json))"
fi
echo "OK: POST /api/v1/battle-simulations -> 200 (compiled Worker resolved and executed a minimal battle)"
rm -f /tmp/muvluvgg-smoke-simulation.json

echo "== all container smoke checks passed =="
