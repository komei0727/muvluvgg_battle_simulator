import { findRevisionNameByTag } from "./cloud-run-traffic.js";
import type { TrafficTarget } from "./cloud-run-manifest.js";

/**
 * `gcloud run services describe --format=json`のstdout（JSON）をstdinから読み、
 * `TAG_NAME`環境変数が指すtagのrevision名をstdoutへ書く（無ければ空文字）。
 * `scripts/cloud-run/ci-promote-traffic.sh`（`stable`の直前値を読み、
 * `stable-previous`へ回す）と`scripts/cloud-run/ci-rollback-traffic.sh`
 * （`stable-previous`をrollback先として読む）の両方から呼ばれる
 * （PRレビュー指摘 #112 P1、2026-07-15再レビュー）。
 */
interface ServiceDescribeJson {
  readonly status?: { readonly traffic?: readonly TrafficTarget[] };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const tagName = requireEnv("TAG_NAME");
const input = await readStdin();
const service = JSON.parse(input) as ServiceDescribeJson;
const revisionName = findRevisionNameByTag(service.status?.traffic ?? [], tagName);
process.stdout.write(revisionName ?? "");
