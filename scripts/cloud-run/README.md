# Manual Cloud Run deployment

手動デプロイは、動作確認のタイミングごとに次のscriptへ分割する。
各scriptが成功し、末尾のverification checkpointを確認してから次へ進む。

```bash
export PROJECT_ID="your-gcp-project-id"

# 1. API・Artifact Registry・cleanup dry-run
scripts/cloud-run/01-prepare-project-and-cleanup-dry-run.sh

# 2. image build/push。表示されたIMAGE_TAGを次のshellでも維持する
scripts/cloud-run/02-build-and-push-image.sh
export IMAGE_TAG="$(git rev-parse HEAD)"

# 3. Cloud Run deploy
scripts/cloud-run/03-deploy-service.sh

# 4. deploy後smoke test
scripts/cloud-run/04-smoke-test.sh

# 5. cleanup設定から約1日後、dry-runの削除候補を確認
scripts/cloud-run/05-verify-cleanup-dry-run.sh

# 6. dry-run結果を確認後、自動削除を有効化
CONFIRM_ENABLE_CLEANUP=yes scripts/cloud-run/06-enable-cleanup-policy.sh
```

必要に応じて次の値を上書きできる。

```bash
export REGION="asia-northeast1"
export REPOSITORY="muvluvgg-battle-simulator"
export SERVICE="muvluvgg-battle-simulator-api"
export IMAGE_TAG="$(git rev-parse HEAD)"
```

`04-smoke-test.sh`はproduction Catalogの制約により戦闘POSTを既定でskipする。
選択可能なCatalogを配備した後は、request bodyのJSON fileを指定して検証できる。

```bash
SMOKE_SIMULATION_BODY_FILE=/path/to/request.json \
  scripts/cloud-run/04-smoke-test.sh
```

`05-verify-cleanup-dry-run.sh`で削除候補を表示するには、Artifact Registryの
Data Access監査ログで`DATA_WRITE`を有効にする必要がある。ログが空の場合は、
imageが3個以下か、dry-runのバックグラウンド評価がまだ完了していない可能性もある。

cleanup policyは、このrepositoryの`api` packageを対象に、最新3 versionを保持する。
ただし、Artifact Registryの無料枠はimage数ではなく保存容量で判定されるため、
3 versionの合計が無料枠を超えれば料金が発生する。

`gcloud run services replace`はmanifestをserviceへ適用する。この手動手順は
段階的traffic切替や自動rollbackを実装しない。それらはIssue `#106`
（`M45-INFRA-002`）のGitHub Actions workflowで扱う。
