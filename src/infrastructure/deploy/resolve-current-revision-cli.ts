import { resolveCurrentRevisionName } from "./cloud-run-traffic.js";
import type { TrafficTarget } from "./cloud-run-manifest.js";

/**
 * `gcloud run services describe --format=json`のstdout（JSON）をstdinから読み、
 * `status.traffic`のpercent===100 revisionをstdoutへ書く（bootstrap時は空行）。
 * `scripts/cloud-run/ci-deploy-candidate.sh`から呼ばれる
 * （PRレビュー指摘 #112 P1-1: `status.latestReadyRevisionName`は未promoteの
 * 失敗candidateもReadyになり得るため使わない）。
 */
interface ServiceDescribeJson {
  readonly status?: { readonly traffic?: readonly TrafficTarget[] };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin();
const service = JSON.parse(input) as ServiceDescribeJson;
const revisionName = resolveCurrentRevisionName(service.status?.traffic ?? []);
process.stdout.write(revisionName ?? "");
