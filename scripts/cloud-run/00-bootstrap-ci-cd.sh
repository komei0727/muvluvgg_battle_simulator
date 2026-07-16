#!/usr/bin/env bash
# Timing 0（一度だけ、GCP project owner／IAM adminが手動実行）:
# GitHub ActionsからCloud Runへdeployするための、長期credentialを使わない
# Workload Identity Federation・最小権限deploy service accountを作成し、
# Billing budget alertとlog保持期間を設定する（Issue #106 `M45-INFRA-002`）。
#
# このscriptはCIから実行しない。実行後に出力されるPROVIDER／SERVICE_ACCOUNT
# の値を、このrepositoryの `production` GitHub Environment variableへ
# 手動で登録する（GCP long-lived credentialではないためsecretにする必要はない）。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

GITHUB_REPOSITORY="${GITHUB_REPOSITORY:?例: export GITHUB_REPOSITORY=komei0727/muvluvgg_battle_simulator}"
GITHUB_ENVIRONMENT="${GITHUB_ENVIRONMENT:-production}"
POOL_ID="${POOL_ID:-github-actions-pool}"
PROVIDER_ID="${PROVIDER_ID:-github-actions-provider}"
DEPLOY_SA_ID="${DEPLOY_SA_ID:-github-actions-deployer}"
DEPLOY_SA_EMAIL="${DEPLOY_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

print_deploy_context
echo "GITHUB_REPOSITORY=$GITHUB_REPOSITORY"
echo "GITHUB_ENVIRONMENT=$GITHUB_ENVIRONMENT"

echo "== enable required Google Cloud APIs =="
gcloud services enable \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  --project="$PROJECT_ID"

echo "== create least-privilege deploy service account (idempotent) =="
if gcloud iam service-accounts describe "$DEPLOY_SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account already exists: $DEPLOY_SA_EMAIL"
else
  gcloud iam service-accounts create "$DEPLOY_SA_ID" \
    --project="$PROJECT_ID" \
    --display-name="GitHub Actions Cloud Run deployer (#106 M45-INFRA-002)"
fi

echo "== grant least-privilege project roles =="
# roles/run.admin ではなくrun.developerに留める。deploy用SAへ
# run.services.setIamPolicyは付与しない（allUsers invoker bindingは
# 03-deploy-service.shの一度限りの手動実行で既に設定済みの前提）。
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/run.developer" \
  --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/cloudbuild.builds.editor" \
  --condition=None >/dev/null
# `.github/workflows/pages-live-smoke-cold-start.yml`が`gcloud logging read`で
# Cloud Runの起動ログ("muvluvgg-battle-simulator started")を検索し、live smoke
# testが実際に新規instance起動(cold start)を発生させたことを確認するために必要
# （`logging.logEntries.list`）。`roles/run.developer`には含まれない
# （PRレビュー指摘 #125 3回目レビュー P1）。
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/logging.viewer" \
  --condition=None >/dev/null

echo "== grant Artifact Registry write access scoped to the repository only =="
gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/artifactregistry.writer" >/dev/null

# `gcloud builds submit`が暗黙にproject既定のCompute Engine SA（roles/editor）を
# 選ばないよう、Docker imageのbuild/push専用SAを作る。標準のCloud Build実行
# roleだけを付与し、deploy用SAにはこのidentityに対するactAsだけを許可する。
echo "== create dedicated Cloud Build service account (idempotent) =="
if gcloud iam service-accounts describe "$BUILD_SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account already exists: $BUILD_SERVICE_ACCOUNT_EMAIL"
else
  gcloud iam service-accounts create "$BUILD_SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" \
    --display-name="Cloud Build image builder"
fi

echo "== grant Cloud Build execution role to the dedicated build identity =="
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None >/dev/null

echo "== grant Service Account User on the Cloud Build identity ($BUILD_SERVICE_ACCOUNT_EMAIL) only =="
gcloud iam service-accounts add-iam-policy-binding "$BUILD_SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

# `deploy/cloud-run/service.json`の`spec.template.spec.serviceAccountName`が
# 指すruntime identity。project既定のCompute Engine SA（既定でroles/editorを
# 持つ）をpublicly-invokable（allUsers）なcontainerのruntime identityにしない
# ため、project IAM roleを一切付与しない専用SAを作る。apps/apiのruntimeコードは
# Google Cloud APIを呼ばないため、この最小権限（ゼロroles）で十分
# （P1レビュー指摘: 侵害時にProject Editor相当のcredentialを奪われる経路を断つ）。
echo "== create dedicated Cloud Run runtime service account with zero project roles (idempotent) =="
if gcloud iam service-accounts describe "$RUNTIME_SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "service account already exists: $RUNTIME_SERVICE_ACCOUNT_EMAIL"
else
  gcloud iam service-accounts create "$RUNTIME_SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" \
    --display-name="Cloud Run API runtime identity, zero project IAM roles (P1 security review)"
fi

# `gcloud run services replace`でこのruntime SAをrevisionへ割り当てるには、
# deploy用SAがそのruntime identityへ`iam.serviceAccounts.actAs`できる必要が
# ある（`roles/run.developer`には含まれない）。project全体ではなく、この
# runtime SAへ限定してActive付与する（PRレビュー指摘 #112 P1-4を踏襲、
# 対象を既定Compute Engine SAから専用runtime SAへ変更）。
echo "== grant Service Account User on the Cloud Run runtime identity ($RUNTIME_SERVICE_ACCOUNT_EMAIL) only =="
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

echo "== create Workload Identity Pool (idempotent) =="
if gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "pool already exists: $POOL_ID"
else
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --display-name="GitHub Actions pool"
fi

POOL_NAME="$(gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global --format='value(name)')"

echo "== create GitHub OIDC provider restricted to this repository and the '$GITHUB_ENVIRONMENT' environment (idempotent) =="
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  echo "provider already exists: $PROVIDER_ID"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub Actions OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
    --attribute-condition="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.environment == '${GITHUB_ENVIRONMENT}'"
fi

echo "== bind deploy service account to the repository + environment principal only =="
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPOSITORY}" >/dev/null

PROVIDER_RESOURCE="${POOL_NAME}/providers/${PROVIDER_ID}"

echo
echo "== verification checkpoint =="
echo "WORKLOAD_IDENTITY_PROVIDER=$PROVIDER_RESOURCE"
echo "SERVICE_ACCOUNT_EMAIL=$DEPLOY_SA_EMAIL"
echo "BUILD_SERVICE_ACCOUNT_EMAIL=$BUILD_SERVICE_ACCOUNT_EMAIL"
echo "RUNTIME_SERVICE_ACCOUNT_EMAIL=$RUNTIME_SERVICE_ACCOUNT_EMAIL"
echo
echo "NEXT: WORKLOAD_IDENTITY_PROVIDER / SERVICE_ACCOUNT_EMAILを、GitHub repositoryの"
echo "      '$GITHUB_ENVIRONMENT' Environment variableへ GCP_WORKLOAD_IDENTITY_PROVIDER /"
echo "      GCP_SERVICE_ACCOUNT_EMAIL として登録してください（secretではない）。"
echo "      BUILD_SERVICE_ACCOUNT_EMAILはCloud Buildの実行identityとしてbuildのたびに"
echo "      自動で使われるため、GitHub Environment variableへの登録は不要です。"
echo "      RUNTIME_SERVICE_ACCOUNT_EMAILはCloud Run serviceのruntime identityとして"
echo "      deployのたびに自動で使われるため、GitHub Environment variableへの登録は不要です。"
echo "      既に稼働中のCloud Run serviceがある場合、次回deployで自動的にこのruntime SAへ"
echo "      切り替わります（03-deploy-service.sh／ci-deploy-candidate.shがmanifestへ設定）。"
echo "      続けて billing budget alert とlog保持期間の設定に scripts/cloud-run/README.md を参照してください。"
