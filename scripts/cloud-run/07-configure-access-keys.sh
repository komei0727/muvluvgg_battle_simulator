#!/usr/bin/env bash
# アクセスキー（10_API設計.md「認証」）の保存先を用意し、キーの集合を登録する。
# 初回セットアップとキーの追加・失効のどちらでも使う（idempotent）。CIからは実行しない。
#
#   ACCESS_KEYS_FILE  "label:key,label:key" を1行で書いたファイル（必須）。
#                     このrepository外に置き、実行後は削除する。内容は表示しない。
#
# 1. Secret Manager APIを有効化し、secret `api-access-keys`を作成する（無ければ）
# 2. ACCESS_KEYS_FILEの内容を新しいsecret versionとして追加する
# 3. runtime service accountへ、このsecret単体のsecretAccessorを付与する
#    （project IAM roleは持たせない方針を保つ。common.sh「RUNTIME_SERVICE_ACCOUNT」）
# 4. キー別利用量のログベース指標を作成・更新する
#
# Cloud Runは環境変数へ注入したsecretの`latest`をrevision作成時に解決する。
# キーの変更を反映するには、このscriptの後にCloud Runを再deployする
# （mainへのpush、またはscripts/cloud-run/03-deploy-service.sh）。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

ACCESS_KEYS_SECRET="${ACCESS_KEYS_SECRET:-api-access-keys}"
ACCESS_KEYS_FILE="${ACCESS_KEYS_FILE:?ACCESS_KEYS_FILEに"label:key,label:key"を1行で書いたファイルを指定してください}"
METRIC_NAME="${METRIC_NAME:-api_requests_by_access_key}"
METRIC_CONFIG="$REPO_ROOT/deploy/logging/api-requests-by-access-key.yaml"

if [ ! -s "$ACCESS_KEYS_FILE" ]; then
  echo "ERROR: ACCESS_KEYS_FILE is missing or empty: $ACCESS_KEYS_FILE" >&2
  exit 1
fi
# 末尾改行だけは許し、複数行は拒否する（APIは1つの値としてcomma区切りで読む）。
if [ "$(grep -c '' "$ACCESS_KEYS_FILE")" -gt 1 ]; then
  echo "ERROR: ACCESS_KEYS_FILE must contain a single line of label:key pairs" >&2
  exit 1
fi
# 書式の厳密な検証はAPIの起動時（loadConfig）が行い、不正ならcandidate revisionが
# Readyにならずtrafficは切り替わらない。ここではラベル一覧だけを表示して確認させる
# （キー本体は表示しない）。
LABELS="$(tr -d '\n' < "$ACCESS_KEYS_FILE" | tr ',' '\n' | sed 's/:.*//' | tr '\n' ' ')"

print_deploy_context
echo "ACCESS_KEYS_SECRET=$ACCESS_KEYS_SECRET"
echo "labels to register: $LABELS"

echo "== enable Secret Manager API =="
gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID"

echo "== create secret (idempotent) =="
if gcloud secrets describe "$ACCESS_KEYS_SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "secret already exists: $ACCESS_KEYS_SECRET"
else
  gcloud secrets create "$ACCESS_KEYS_SECRET" \
    --project="$PROJECT_ID" \
    --replication-policy=automatic
fi

echo "== add a new secret version from ACCESS_KEYS_FILE =="
# 末尾改行を含めない（APIは値全体をcomma区切りで読むため、改行は最後のキーの一部になる）。
tr -d '\n' < "$ACCESS_KEYS_FILE" | gcloud secrets versions add "$ACCESS_KEYS_SECRET" \
  --project="$PROJECT_ID" \
  --data-file=-

echo "== grant the runtime service account access to this secret only =="
gcloud secrets add-iam-policy-binding "$ACCESS_KEYS_SECRET" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

echo "== create or update the per-key usage log-based metric =="
if gcloud logging metrics describe "$METRIC_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud logging metrics update "$METRIC_NAME" --project="$PROJECT_ID" --config-from-file="$METRIC_CONFIG"
else
  gcloud logging metrics create "$METRIC_NAME" --project="$PROJECT_ID" --config-from-file="$METRIC_CONFIG"
fi

echo
echo "NEXT: Cloud Runを再deployして新しいsecret versionを反映し、起動ログの"
echo "      accessKeyLabels（docs/運用手順.md「アクセスキー」）で登録したラベルを確認してください。"
echo "      ACCESS_KEYS_FILEは不要になったら削除してください: rm -P \"$ACCESS_KEYS_FILE\""
