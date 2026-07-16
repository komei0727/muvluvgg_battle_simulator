import { readFileSync } from "node:fs";
import {
  buildCandidateTrafficTargets,
  renderCloudRunManifest,
  type KnativeServiceManifest,
} from "./cloud-run-manifest.js";

/**
 * `MANIFEST_TEMPLATE_PATH`・`IMAGE`・`REVISION_NAME`・`PREVIOUS_REVISION_NAME`・
 * `RUNTIME_SERVICE_ACCOUNT_EMAIL`（必須）、`STABLE_PREVIOUS_REVISION_NAME`・
 * `TRAFFIC_TAG`（省略可）を環境変数から読み、描画したCloud Run Knative Service
 * manifestをJSONでstdoutへ書く。`scripts/cloud-run/ci-deploy-candidate.sh`から
 * 呼ばれる（#106 `M45-INFRA-002`）。
 *
 * `PREVIOUS_REVISION_NAME`は必須——CIは初回Cloud Run deployを行わない前提
 * （最初のrevisionは`scripts/cloud-run/03-deploy-service.sh`の一度限りの
 * 手動セットアップで事前に作成済み）のため、現在100% trafficを受けている
 * revisionを特定できない状態でこのCLIを呼ぶこと自体を早期に拒否する
 * （PRレビュー指摘 #112、2026-07-15、5回目）。
 *
 * `RUNTIME_SERVICE_ACCOUNT_EMAIL`も必須——未指定のまま`renderCloudRunManifest`
 * を呼ぶと、`spec.template.spec.serviceAccountName`が空になりCloud Runは
 * project既定のCompute Engine SA（既定でroles/editor）をruntime identityに
 * 使ってしまう。本serviceはallUsersへ公開されているため、専用の最小権限
 * runtime SAを明示するfail-fastな契約にする（P1レビュー指摘）。
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

const manifestTemplatePath = requireEnv("MANIFEST_TEMPLATE_PATH");
const image = requireEnv("IMAGE");
const revisionName = requireEnv("REVISION_NAME");
const previousRevisionName = requireEnv("PREVIOUS_REVISION_NAME");
const stablePreviousRevisionName = optionalEnv("STABLE_PREVIOUS_REVISION_NAME");
const trafficTag = process.env["TRAFFIC_TAG"] ?? "candidate";
const serviceAccountName = requireEnv("RUNTIME_SERVICE_ACCOUNT_EMAIL");

const template = JSON.parse(readFileSync(manifestTemplatePath, "utf-8")) as KnativeServiceManifest;

const traffic = buildCandidateTrafficTargets({
  newRevisionName: revisionName,
  previousRevisionName,
  stablePreviousRevisionName,
  tag: trafficTag,
});

const rendered = renderCloudRunManifest({
  template,
  image,
  revisionName,
  traffic,
  serviceAccountName,
});
process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
