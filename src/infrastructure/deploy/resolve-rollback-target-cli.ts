import { readFileSync } from "node:fs";
import {
  findRevisionNameByTag,
  resolveCurrentRevisionName,
  selectRollbackTarget,
  type RevisionCandidate,
} from "./cloud-run-traffic.js";
import type { TrafficTarget } from "./cloud-run-manifest.js";

/**
 * `SERVICE_JSON_PATH`（`gcloud run services describe --format=json`）と
 * `REVISIONS_JSON_PATH`（`gcloud run revisions list --format=json`）を読み、
 * 「現在productionのrevision」と「直近candidateがtagで指すrevision」の
 * 両方を除外した、最も新しいReady revisionをstdoutへ書く
 * （`scripts/cloud-run/ci-rollback-traffic.sh`から呼ばれる）。
 *
 * PRレビュー指摘 #112 P1-2: Revision resourceにはtraffic割当が無いため、
 * Service側の`status.traffic`から判定する。直近candidateがsmoke失敗のまま
 * Readyでも、tagで除外されるため再選択されない。
 */
interface ServiceDescribeJson {
  readonly status?: { readonly traffic?: readonly TrafficTarget[] };
}

interface RawRevision {
  readonly metadata: { readonly name: string; readonly creationTimestamp: string };
  readonly status?: {
    readonly conditions?: readonly { readonly type: string; readonly status: string }[];
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const serviceJsonPath = requireEnv("SERVICE_JSON_PATH");
const revisionsJsonPath = requireEnv("REVISIONS_JSON_PATH");
const candidateTag = process.env["CANDIDATE_TAG"] ?? "candidate";

const service = JSON.parse(readFileSync(serviceJsonPath, "utf8")) as ServiceDescribeJson;
const rawRevisions = JSON.parse(readFileSync(revisionsJsonPath, "utf8")) as readonly RawRevision[];

const traffic = service.status?.traffic ?? [];
const currentRevisionName = resolveCurrentRevisionName(traffic);
const candidateRevisionName = findRevisionNameByTag(traffic, candidateTag);

const revisions: RevisionCandidate[] = rawRevisions.map((revision) => ({
  name: revision.metadata.name,
  ready:
    revision.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ?? false,
  creationTimestamp: revision.metadata.creationTimestamp,
}));

const target = selectRollbackTarget(revisions, [currentRevisionName, candidateRevisionName]);
process.stdout.write(target);
