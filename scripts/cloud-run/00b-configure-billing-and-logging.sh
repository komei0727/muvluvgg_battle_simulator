#!/usr/bin/env bash
# Timing 0b（一度だけ、Billing Account Administratorが手動実行）:
# 費用超過の早期検知（Billing budget alert）とlog保持期間を設定する
# （Issue #106 `M45-INFRA-002`受け入れ条件「Billing budget alertとログ保持期間
# が設定される」）。project IAM adminとBilling Account Administratorは別権限の
# ため、00-bootstrap-ci-cd.shとは別scriptに分離する。
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"
require_command gcloud

BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:?例: export BILLING_ACCOUNT_ID=012345-6789AB-CDEF01（gcloud billing accounts listで確認）}"
BUDGET_AMOUNT_USD="${BUDGET_AMOUNT_USD:-10}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-30}"

print_deploy_context
echo "BILLING_ACCOUNT_ID=$BILLING_ACCOUNT_ID"
echo "BUDGET_AMOUNT_USD=$BUDGET_AMOUNT_USD"
echo "LOG_RETENTION_DAYS=$LOG_RETENTION_DAYS"

echo "== create billing budget alert (50%/90%/100% thresholds, billing account admins notified) =="
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT_ID" \
  --display-name="${SERVICE}-budget" \
  --budget-amount="${BUDGET_AMOUNT_USD}USD" \
  --filter-projects="projects/${PROJECT_ID}" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0

echo "== set _Default log bucket retention =="
gcloud logging buckets update _Default \
  --project="$PROJECT_ID" \
  --location=global \
  --retention-days="$LOG_RETENTION_DAYS"

echo
echo "NEXT: 想定外の費用増加時は maximum instances の見直しかservice停止を検討してください"
echo "      （運用手順.md「Cloud Run rollback」参照）。budget amountは初期見積りのため、"
echo "      実運用のtraffic量に応じて調整してください。"
