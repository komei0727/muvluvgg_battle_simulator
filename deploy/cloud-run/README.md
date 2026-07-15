# Cloud Run service configuration

`service.json` is a Knative `Service` manifest (JSON is valid input for
`gcloud run services replace`) that declares the M4.5 initial Cloud Run
configuration described in
[`docs/ddd/11_インフラストラクチャ設計.md`](../../docs/ddd/11_インフラストラクチャ設計.md#m45-cloud-run初期設定)。

| フィールド                                              | 値                                                    | 対応する設計値                                             |
| ------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| `metadata.name`                                         | `muvluvgg-battle-simulator-api`                       | Service name                                               |
| `metadata.annotations["run.googleapis.com/ingress"]`    | `all`                                                 | Ingress                                                    |
| `spec.template.metadata.annotations[...minScale]`       | `0`                                                   | Minimum instances                                          |
| `spec.template.metadata.annotations[...maxScale]`       | `1`                                                   | Maximum instances                                          |
| `spec.template.metadata.annotations[...cpu-throttling]` | `true`                                                | Billing: request-based                                     |
| `spec.template.spec.containerConcurrency`               | `2`                                                   | Container concurrency                                      |
| `spec.template.spec.timeoutSeconds`                     | `40`                                                  | Request timeout                                            |
| `containers[0].resources.limits.cpu`/`memory`           | `1`/`1Gi`                                             | CPU／Memory                                                |
| `containers[0].env[WORKER_MAX_QUEUE]`                   | `1`                                                   | `WORKER_MAX_QUEUE`                                         |
| `containers[0].env[SHUTDOWN_GRACE_MS]`                  | `8000`                                                | `SHUTDOWN_GRACE_MS`                                        |
| `containers[0].env[CORS_ALLOWED_ORIGINS]`               | `https://komei0727.github.io`                         | CORS allowed origin                                        |
| `containers[0].startupProbe`                            | `GET /health/live:8080`（1s間隔・失敗60回まで）       | Catalog検証／Worker warm-up完了までtraffic受付を開始しない |
| `containers[0].livenessProbe`                           | `GET /health/live:8080`（10s間隔・失敗3回で再起動）   | プロセスが応答不能になった場合だけ再起動する               |
| `containers[0].readinessProbe`                          | `GET /health/ready:8080`（5s間隔・失敗2回で受付停止） | 一時的にtrafficを受けられない状態を再起動なしで反映する    |

Cloud Runは[Knative v1 manifest互換の`startupProbe`・`livenessProbe`・
`readinessProbe`をサポートする](https://docs.cloud.google.com/run/docs/configuring/healthchecks#readiness-probes)。
それぞれ役割が異なる。

- `startupProbe`（`/health/live`）: 最初の成功でtraffic受付が始まる。
  `11_インフラストラクチャ設計.md`「配備」「`/health/live`をstartup probe候補とし、
  Catalog検証とWorker warm-upが完了するまでHTTP portを公開しない既存起動順を
  維持する」——`listen()`自体がwarm-up完了後にしか呼ばれないため、
  `/health/live`が応答した時点で両方が既に完了している。
- `livenessProbe`（`/health/live`）: 失敗が続いた場合だけinstanceを再起動する。
  `/health/live`は「プロセスがHTTP応答可能なら成功する。Catalog障害やPool飽和
  では失敗しない」（`11_インフラストラクチャ設計.md`「ヘルスチェック」）ため、
  再起動が必要な致命的状態だけを検出する。
- `readinessProbe`（`/health/ready`）: 失敗している間だけそのinstanceへの新規
  traffic送出を止める（再起動はしない）。`/health/ready`は「シャットダウン
  開始前、かつWorker Poolが健全（稼働中のCatalogリビジョン不一致が未発生）」
  で成功し、一時的なキュー満杯だけでは失敗しない（`運用手順.md`「ヘルスチェック」）
  ——Graceful Shutdown開始直後やWorker Poolの致命的状態など、
  「再起動ではなく新規受付だけを止めたい」状態と直接対応する。

`region`・`project`はKnative Serviceの本文に含まれないため、適用時にコマンド引数
（またはリソース名の一部）として渡す。`image`フィールドの`${PROJECT_ID}`・
`${IMAGE_TAG}`はplaceholderであり、デプロイ時にCIが実際の値へ置換する
（置換方法・deploy workflow自体は`#106`のスコープ）。

## 適用（デプロイ時のリファレンス）

```bash
envsubst < deploy/cloud-run/service.json | \
  gcloud run services replace - \
    --region=asia-northeast1 \
    --project="$PROJECT_ID"

# 初期UIはCloud Run IAM tokenを持たないため、unauthenticated invocationを許可する。
gcloud run services add-iam-policy-binding muvluvgg-battle-simulator-api \
  --region=asia-northeast1 \
  --project="$PROJECT_ID" \
  --member=allUsers \
  --role=roles/run.invoker
```

## Artifact Registry

`image`が参照するリポジトリは事前に作成しておく（一度だけ実行すればよい）。

```bash
gcloud artifacts repositories create muvluvgg-battle-simulator \
  --repository-format=docker \
  --location=asia-northeast1 \
  --project="$PROJECT_ID" \
  --description="muvluvgg-battle-simulator production container images"
```

`src/__tests__/cloud-run-service-config.test.ts`が`service.json`の値を
`11_インフラストラクチャ設計.md`の初期設定表と自動的に突き合わせる。

手動でのproject準備、image build/push、deploy、smoke test、cleanup有効化は、
動作確認のタイミングごとに分割した
[`scripts/cloud-run/README.md`](../../scripts/cloud-run/README.md)を参照する。
