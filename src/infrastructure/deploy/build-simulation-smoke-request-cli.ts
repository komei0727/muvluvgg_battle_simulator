import { buildSimulationSmokeRequest, type SmokeCatalog } from "./simulation-smoke-request.js";

/**
 * `GET /api/v1/battle-simulation-catalog`のresponse bodyをstdinから読み、
 * 最小simulation smoke test requestをstdoutへJSONで書く。選択可能なUnitが
 * 無い場合は例外でexit code非0になり、呼び出し元のCI stepを失敗させる
 * （`scripts/cloud-run/ci-deploy-candidate.sh`／`.github/workflows/main.yml`から
 * 呼ばれる。PRレビュー指摘 #112 P1-3: 有効なrequestを構築できない場合は
 * simulation smoke testを黙ってskipせず、deployを失敗させる）。
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const input = await readStdin();
const catalog = JSON.parse(input) as SmokeCatalog;
const request = buildSimulationSmokeRequest(catalog);
process.stdout.write(`${JSON.stringify(request)}\n`);
