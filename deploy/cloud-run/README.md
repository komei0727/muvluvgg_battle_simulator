# Cloud Run service configuration

`service.json` is a Knative `Service` manifest (JSON is valid input for
`gcloud run services replace`) that declares the M4.5 initial Cloud Run
configuration described in
[`docs/ddd/11_インフラストラクチャ設計.md`](../../docs/ddd/11_インフラストラクチャ設計.md#m45-cloud-run初期設定)。

| フィールド                                              | 値                              | 対応する設計値         |
| ------------------------------------------------------- | ------------------------------- | ---------------------- |
| `metadata.name`                                         | `muvluvgg-battle-simulator-api` | Service name           |
| `metadata.annotations["run.googleapis.com/ingress"]`    | `all`                           | Ingress                |
| `spec.template.metadata.annotations[...minScale]`       | `0`                             | Minimum instances      |
| `spec.template.metadata.annotations[...maxScale]`       | `1`                             | Maximum instances      |
| `spec.template.metadata.annotations[...cpu-throttling]` | `true`                          | Billing: request-based |
| `spec.template.spec.containerConcurrency`               | `2`                             | Container concurrency  |
| `spec.template.spec.timeoutSeconds`                     | `40`                            | Request timeout        |
| `containers[0].resources.limits.cpu`/`memory`           | `1`/`1Gi`                       | CPU／Memory            |
| `containers[0].env[WORKER_MAX_QUEUE]`                   | `1`                             | `WORKER_MAX_QUEUE`     |
| `containers[0].env[SHUTDOWN_GRACE_MS]`                  | `8000`                          | `SHUTDOWN_GRACE_MS`    |
| `containers[0].env[CORS_ALLOWED_ORIGINS]`               | `https://komei0727.github.io`   | CORS allowed origin    |

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
