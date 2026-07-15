import { readFileSync } from "node:fs";
import {
  buildCandidateTrafficTargets,
  renderCloudRunManifest,
  type KnativeServiceManifest,
} from "./cloud-run-manifest.js";

/**
 * `MANIFEST_TEMPLATE_PATH`・`IMAGE`・`REVISION_NAME`・`PREVIOUS_REVISION_NAME`
 * （必須）、`STABLE_PREVIOUS_REVISION_NAME`・`TRAFFIC_TAG`（省略可）を環境変数
 * から読み、描画したCloud Run Knative Service manifestをJSONでstdoutへ書く。
 * `scripts/cloud-run/ci-deploy-candidate.sh`から呼ばれる（#106 `M45-INFRA-002`）。
 *
 * `PREVIOUS_REVISION_NAME`は必須——CIは初回Cloud Run deployを行わない前提
 * （最初のrevisionは`scripts/cloud-run/03-deploy-service.sh`の一度限りの
 * 手動セットアップで事前に作成済み）のため、現在100% trafficを受けている
 * revisionを特定できない状態でこのCLIを呼ぶこと自体を早期に拒否する
 * （PRレビュー指摘 #112、2026-07-15、5回目）。
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

const template = JSON.parse(readFileSync(manifestTemplatePath, "utf-8")) as KnativeServiceManifest;

const traffic = buildCandidateTrafficTargets({
  newRevisionName: revisionName,
  previousRevisionName,
  stablePreviousRevisionName,
  tag: trafficTag,
});

const rendered = renderCloudRunManifest({ template, image, revisionName, traffic });
process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
