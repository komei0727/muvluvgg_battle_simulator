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
CANCEL_CONTAINER="muvluvgg-smoke-cancel"
PROD_PORT=18080
FIXTURE_PORT=18081
CANCEL_PORT=18082
FIXTURE_CATALOG_DIR="$(pwd)/src/infrastructure/catalog/__fixtures__/runtime/valid/minimal"

# `11_インフラストラクチャ設計.md`「同一ユニット重複と最大編成人数を受理する」
# （`12_テスト戦略.md`End-to-Endテスト#5）。5対5・99ターン・DIAGNOSTICは
# CANCEL_CONTAINERで複数件同時に投げるための「computeに数百msかかる」戦闘
# として使う（fixture Catalogの`UNIT_001`だけで構成できる。詳細は後段の
# `CANCEL_CONCURRENCY`まわりのコメント参照）。
LARGE_BATTLE_BODY='{
  "allyFormation": {
    "units": [
      { "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 1, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 2, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "REAR" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 1, "row": "REAR" } }
    ],
    "memoryDefinitionIds": []
  },
  "enemyFormation": {
    "units": [
      { "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 1, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 2, "row": "FRONT" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "REAR" } },
      { "unitDefinitionId": "UNIT_001", "position": { "column": 1, "row": "REAR" } }
    ],
    "memoryDefinitionIds": []
  },
  "turnLimit": 99,
  "options": { "logLevel": "DIAGNOSTIC" }
}'

cleanup() {
  docker rm -f "$PROD_CONTAINER" "$FIXTURE_CONTAINER" "$CANCEL_CONTAINER" >/dev/null 2>&1 || true
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
    if [ "$attempts" -ge 60 ]; then
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

# `docker inspect -f '{{.State.Running}}'`をpollし、`start_epoch`からの経過秒数
# を返す。呼び出し側が`docker kill`直前に取得した時刻を渡すことで、
# 「SIGTERM送信からの総停止時間」を計測する（呼び出し時点を起点にすると、
# SIGTERM送信後の他の検証に費やした時間が計測から漏れる）。
wait_for_stop_seconds() {
  local container="$1"
  local start_epoch="$2"
  local timeout_seconds="$3"
  until [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "false" ]; do
    local elapsed=$(( $(date +%s) - start_epoch ))
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      fail "$container did not stop within ${timeout_seconds}s of SIGTERM"
    fi
    sleep 0.2
  done
  echo $(( $(date +%s) - start_epoch ))
}

# `docker logs -f --tail 0`で新規ログだけを非同期にwatchし始め、
# `LOG_WATCHER_PID`（グローバル）へwatcherのPIDを設定する（呼び出し側は
# `wait_for_log_match`でこのPIDを待つ）。`$(...)`コマンド置換でPIDを返すと
# 置換自体がsubshellを作り、その中で背景化したjobは呼び出し元shellの子で
# なくなって`wait`できなくなるため、あえてグローバル変数で受け渡す。
# 「backgroundで投げたPOSTが実際にFastifyへ到達した」ことを観測してから
# SIGTERMを送るための同期点として使う——同期なしでは、schedulerの都合で
# SIGTERMがPOSTのTCP acceptより先行し、接続拒否/resetで`set -e`ごとテストを
# 偶発的に落とす可能性がある。呼び出し側は、このwatcherがattachし終わる
# （`--tail 0`が「これ以降のログだけ」を意味するため、attach前に出たログは
# 拾えない）のを確実に待ってから対象のrequestを送ること。
start_log_watch() {
  local container="$1"
  local pattern="$2"
  local timeout_seconds="$3"
  ( timeout "${timeout_seconds}s" bash -c \
    "docker logs -f --tail 0 '$container' 2>&1 | grep -q -m1 '$pattern'" ) &
  LOG_WATCHER_PID=$!
}

wait_for_log_match() {
  local watcher_pid="$1"
  local description="$2"
  if ! wait "$watcher_pid"; then
    fail "did not observe $description in time"
  fi
}

echo "== build (linux/amd64) =="
docker build --platform linux/amd64 -t "$IMAGE_TAG" .

echo "== run: baked-in production Catalog (SHUTDOWN_GRACE_MS=8000, matches Cloud Run config) =="
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

echo "== SIGTERM: readiness stops serving immediately, total stop time <= SHUTDOWN_GRACE_MS(8s) + margin =="
# `shutdown.ts`「ステップ3」はapp.close()を即座に呼び、Fastify(Node 18.2+)は
# 既定でidle keep-alive接続も強制close対象にする。そのため、SIGTERM後に
# 「新しいTCP接続」で`GET /health/ready`や`POST`を送ると、
# アプリケーションの`shutdownGate.isShuttingDown()`（503 CAPACITY_EXCEEDED、
# `build-server.test.ts`「API-CONTRACT-022」が`app.inject()`で決定的に検証
# 済み）へ到達する前に、listening socket自体のtear-downと競合して
# 接続拒否／resetになり得る——これは不具合ではなく「新しいリクエストを
# 受け付けない」ことの別の現れ方である。よってcontainer境界のsmoke testでは
# 「非200 or 接続失敗のどちらかに確実になる」ことだけを検証し、具体的な
# HTTP statusはアプリケーション層の既存契約テストに委ねる。「実行中だった
# リクエストが不完全な結果を200として返さない」ことは、後段の
# `CANCEL_CONTAINER`（実際に処理中の接続で検証、socket tear-downと競合しない）
# で確認する。
# 総停止時間はSIGTERM送信の直前から計測する（後続のreadiness確認に
# 費やした時間を漏らさないため——`wait_for_stop_seconds`へ渡す）。
PROD_SIGTERM_SENT_AT=$(date +%s)
docker kill --signal=SIGTERM "$PROD_CONTAINER" >/dev/null

READY_FAIL_ATTEMPTS=0
READY_STATUS=200
while [ "$READY_STATUS" = "200" ]; do
  READY_FAIL_ATTEMPTS=$((READY_FAIL_ATTEMPTS + 1))
  if [ "$READY_FAIL_ATTEMPTS" -gt 20 ]; then
    fail "GET /health/ready still returned 200 after SIGTERM (readiness did not stop serving immediately)"
  fi
  READY_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:${PROD_PORT}/health/ready" 2>/dev/null) || READY_STATUS="000"
done
echo "OK: GET /health/ready -> $READY_STATUS (not 200) within $READY_FAIL_ATTEMPTS attempt(s) of SIGTERM"

SIGTERM_ELAPSED=$(wait_for_stop_seconds "$PROD_CONTAINER" "$PROD_SIGTERM_SENT_AT" 10)
if [ "$SIGTERM_ELAPSED" -gt 9 ]; then
  fail "container took ${SIGTERM_ELAPSED}s to stop after SIGTERM (SHUTDOWN_GRACE_MS=8000 + 1s margin = 9s budget)"
fi
EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$PROD_CONTAINER")
if [ "$EXIT_CODE" != "0" ]; then
  fail "container exited with code $EXIT_CODE after SIGTERM (expected 0)"
fi
echo "OK: SIGTERM -> graceful exit 0 in ${SIGTERM_ELAPSED}s (<= SHUTDOWN_GRACE_MS=8s + 1s margin)"

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
    "allyFormation": { "units": [{ "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } }], "memoryDefinitionIds": [] },
    "enemyFormation": { "units": [{ "unitDefinitionId": "UNIT_001", "position": { "column": 0, "row": "FRONT" } }], "memoryDefinitionIds": [] },
    "turnLimit": 3
  }')
if [ "$SIMULATION_STATUS" != "200" ]; then
  fail "POST /api/v1/battle-simulations: expected HTTP 200, got $SIMULATION_STATUS ($(cat /tmp/muvluvgg-smoke-simulation.json))"
fi
echo "OK: POST /api/v1/battle-simulations -> 200 (compiled Worker resolved and executed a minimal battle)"
rm -f /tmp/muvluvgg-smoke-simulation.json

echo "== run: SHUTDOWN_GRACE_MS=0 + concurrent in-flight battles, to prove incomplete results are never returned as success =="
# `--cpuset-cpus=0`でNode/Piscinaの`os.availableParallelism()`を1に固定する
# （実測: single vCPUのcontainerでは`availableParallelism()`が1を返す）。
# `piscina`の既定`maxThreads`は`availableParallelism * 1.5`のため、これで
# 同時実行中Workerが高々1〜2本に制限される。5対5・99ターン・DIAGNOSTICの
# 実戦闘を$CANCEL_CONCURRENCY件同時に投げれば、SIGTERM到達時点で残りは
# 確実にPiscinaのtask queueで「未開始」のまま待たされる——`shutdown.ts`
# 「ステップ4」の「未開始タスクを即座にキャンセルする」は計算速度と無関係に
# 常に成立するため、`grace=0`と組み合わせても「まだ実行中の1件」対「速い
# 計算がSIGTERM到達より先に終わる」という競合（実際に発生を確認済み）を
# 避け、「不完全な結果が200として返らない」ことを決定的に検証できる
# （`INT-WORKER-SHUTDOWN-001`のqueued-task assertionと同じ考え方を
# container境界で再現する）。
docker run -d --name "$CANCEL_CONTAINER" --cpuset-cpus="0" -p "${CANCEL_PORT}:8080" \
  -e PORT=8080 \
  -e CATALOG_PATH=/fixtures/catalog \
  -e SHUTDOWN_GRACE_MS=0 \
  -v "${FIXTURE_CATALOG_DIR}:/fixtures/catalog:ro" \
  "$IMAGE_TAG" >/dev/null
wait_for_http "http://localhost:${CANCEL_PORT}/health/ready"

CANCEL_CONCURRENCY=6
CANCEL_CURL_PIDS=()

# `--tail 0`は「watcher attach以降のログだけ」を意味するため、必ずPOSTを
# 送る前にwatcherを起動し、attachが完了するのを待ってからPOSTを送る
# （逆順だと、attach前にログ出力まで終わってしまい、watcherが恒久的に
# matchできず`timeout`まで無駄に待つ）。1件目の`incoming request`ログが
# 見えた時点で、残りも含めて既にFastifyへ到達している可能性が高いため、
# それ以上待たずただちにSIGTERMを送る。
start_log_watch "$CANCEL_CONTAINER" '"url":"/api/v1/battle-simulations"' 10
CANCEL_LOG_WATCHER_PID="$LOG_WATCHER_PID"
sleep 0.5

for i in $(seq 1 "$CANCEL_CONCURRENCY"); do
  curl -sS -o "/tmp/muvluvgg-smoke-cancelled-${i}.json" -w '%{http_code}' \
    -X POST "http://localhost:${CANCEL_PORT}/api/v1/battle-simulations" \
    -H 'Content-Type: application/json' \
    -d "$LARGE_BATTLE_BODY" > "/tmp/muvluvgg-smoke-cancelled-${i}.status" &
  CANCEL_CURL_PIDS+=("$!")
done

wait_for_log_match "$CANCEL_LOG_WATCHER_PID" "an in-flight battle request reaching Fastify"
CANCEL_SIGTERM_SENT_AT=$(date +%s)
docker kill --signal=SIGTERM "$CANCEL_CONTAINER" >/dev/null

CANCEL_TRANSPORT_FAILURES=0
for pid in "${CANCEL_CURL_PIDS[@]}"; do
  wait "$pid" || CANCEL_TRANSPORT_FAILURES=$((CANCEL_TRANSPORT_FAILURES + 1))
done

CANCEL_EXECUTION_CANCELLED_COUNT=0
for i in $(seq 1 "$CANCEL_CONCURRENCY"); do
  status_file="/tmp/muvluvgg-smoke-cancelled-${i}.status"
  body_file="/tmp/muvluvgg-smoke-cancelled-${i}.json"
  status=$(cat "$status_file" 2>/dev/null || echo "")
  case "$status" in
    200)
      if ! grep -q '"result"' "$body_file" 2>/dev/null; then
        fail "battle #$i returned HTTP 200 without a complete result body (an incomplete result must never be reported as success): $(cat "$body_file" 2>/dev/null)"
      fi
      ;;
    503)
      if grep -q '"code":"EXECUTION_CANCELLED"' "$body_file" 2>/dev/null; then
        CANCEL_EXECUTION_CANCELLED_COUNT=$((CANCEL_EXECUTION_CANCELLED_COUNT + 1))
      fi
      ;;
    "" | 000)
      : # transport-level failure (connection reset/refused) — never a false
        # success either; already counted via CANCEL_TRANSPORT_FAILURES
      ;;
    *)
      fail "battle #$i: unexpected HTTP $status ($(cat "$body_file" 2>/dev/null))"
      ;;
  esac
  rm -f "$status_file" "$body_file"
done

if [ "$CANCEL_EXECUTION_CANCELLED_COUNT" -lt 1 ] && [ "$CANCEL_TRANSPORT_FAILURES" -lt 1 ]; then
  fail "none of the $CANCEL_CONCURRENCY concurrent in-flight battles was force-cancelled (expected at least one still-queued task to be rejected as EXECUTION_CANCELLED once SIGTERM arrived)"
fi
echo "OK: $CANCEL_EXECUTION_CANCELLED_COUNT/$CANCEL_CONCURRENCY concurrent in-flight battles -> 503 EXECUTION_CANCELLED at SIGTERM, none returned an incomplete result as 200 ($CANCEL_TRANSPORT_FAILURES transport-level failure(s), also never a false success)"

CANCEL_ELAPSED=$(wait_for_stop_seconds "$CANCEL_CONTAINER" "$CANCEL_SIGTERM_SENT_AT" 5)
CANCEL_EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$CANCEL_CONTAINER")
if [ "$CANCEL_EXIT_CODE" != "0" ]; then
  fail "container exited with code $CANCEL_EXIT_CODE after forced cancellation (expected 0)"
fi
echo "OK: SHUTDOWN_GRACE_MS=0 -> graceful exit 0 in ${CANCEL_ELAPSED}s"

echo "== all container smoke checks passed =="
