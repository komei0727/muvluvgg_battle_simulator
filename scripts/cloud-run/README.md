# Manual Cloud Run deployment

手動デプロイは、動作確認のタイミングごとに次のscriptへ分割する。
各scriptが成功し、末尾のverification checkpointを確認してから次へ進む。

## CI/CD（`#106` `M45-INFRA-002`）

`.github/workflows/main.yml`の`deploy` jobが、mainへのpush（`quality` job成功後）ごとに
次を自動実行する。CIからは実行しない一度限りの手動セットアップは`00-`・`00b-`で始まる
scriptに分離してある。

| Script                                                    | 実行者・タイミング                                                | 内容                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-bootstrap-ci-cd.sh`                                   | project IAM adminが一度だけ手動実行                               | Workload Identity Pool／Provider（このrepository＋`production` GitHub Environmentへ限定）、最小権限deploy service account、Cloud Run runtime identity（既定のCompute Engine SA）への`roles/iam.serviceAccountUser`限定付与を行う。                                                   |
| `00b-configure-billing-and-logging.sh`                    | Billing Account Administratorが一度だけ手動実行                   | Billing budget alert（50/90/100%閾値）とlog保持期間を設定する。                                                                                                                                                                                                                      |
| `ci-deploy-candidate.sh`                                  | `deploy` job（CI）                                                | 現在productionのrevision（`status.traffic`のpercent===100、`latestReadyRevisionName`は使わない）へtraffic 100%を固定したまま、新revisionを`candidate` tag・traffic 0%で作成する。既存の`stable`／`stable-previous` tagもmanifestへ再宣言し、`services replace`で消えないようにする。 |
| （candidate Catalogから最小simulation requestを組み立て） | `deploy` job（CI）                                                | 選択可能なUnitが無ければここでjobを失敗させる（smoke testを黙ってskipしない）。                                                                                                                                                                                                      |
| （`04-smoke-test.sh`を`candidate` URLへ再利用）           | `deploy` job（CI）                                                | live・ready・Catalog GET・最小simulation・実GET/POSTのCORSを確認する。失敗時はここでjobが止まり、traffic切替は起きない。                                                                                                                                                             |
| `ci-promote-traffic.sh`                                   | `deploy` job（CI、smoke test成功後のみ）                          | `candidate` revisionへtrafficを100%昇格し、`stable`（今回promoteしたrevision）／`stable-previous`（直前の`stable`）tagを回す。                                                                                                                                                       |
| `ci-rollback-traffic.sh`                                  | `.github/workflows/rollback-cloud-run.yml`（`workflow_dispatch`） | 指定（または`stable-previous` tagが指すrevisionを自動検出した）revisionへtrafficを100%戻し、`stable` tagをrollback先へ付け替える。「直近のReady revision」は使わない——未promoteの失敗revisionもReadyになり得るため。                                                                 |

`stable`／`stable-previous` tagは、promote成功時にだけ更新される永続的な記録である
（`00-bootstrap-ci-cd.sh`が作るIAM権限とは無関係。Cloud RunのService tag機構を使う）。
「直近のReady revision」をrollback候補にしないのは、複数回連続でcandidateがsmokeに
失敗すると、未promoteの失敗revisionがReadyのまま残り、`candidate` tagは常に最新の
失敗revisionへ移るため、tagだけの除外でも古い失敗revisionを再選択し得るため
（PRレビュー指摘 #112 P1、2026-07-15再レビュー）。

`00-bootstrap-ci-cd.sh`の出力（`WORKLOAD_IDENTITY_PROVIDER`・`SERVICE_ACCOUNT_EMAIL`）は、
このrepositoryの`production` GitHub Environment variableへ`GCP_WORKLOAD_IDENTITY_PROVIDER`・
`GCP_SERVICE_ACCOUNT_EMAIL`として登録する（`GCP_PROJECT_ID`も併せて登録する）。
Cloud Run URLをGitHub Environment変数（`VITE_API_BASE_URL`）へ書き込むには、
Variables書き込みのみに絞ったfine-grained personal access token（repository
`Variables: write`のみ）を作成し、`VARS_ADMIN_TOKEN` repository secretへ登録する
（Google Cloudの長期credentialではないため、受け入れ条件「service account JSON keyなどの
長期Google Cloud credentialを保存しない」には抵触しない）。

## Manual (一度限り／障害対応)

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
段階的traffic切替や自動rollbackを実装しない。それらは本ファイル冒頭の
「CI/CD」節で説明する`.github/workflows/main.yml`の`deploy` jobと
`rollback-cloud-run.yml`が扱う（Issue `#106` `M45-INFRA-002`）。
