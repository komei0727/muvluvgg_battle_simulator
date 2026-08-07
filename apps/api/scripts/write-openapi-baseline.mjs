/**
 * `apps/api/openapi/v1-baseline.json` を再生成する。
 *
 * このファイルは「v1として公開済みの契約」を凍結したもので、
 * `openapi-compatibility.test.ts` の `API-OPENAPI-022` が破壊的変更検査の基準に使う。
 * 後方互換な追加（任意プロパティ・新イベント種別・新エラーコード・新列挙値）は
 * 検査を通るため、追加のたびに更新する必要はない。更新するのは
 * 「baselineが古くなったと判断したとき」だけで、その差分はレビュー対象になる
 * （`12_テスト戦略.md`「Snapshot更新時は仕様変更と単なる出力変化をレビューで区別する」）。
 *
 * 実行方法（`apps/api/` で `pnpm run build` 済みであること）:
 *   mise exec -- node scripts/write-openapi-baseline.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const { buildServer } = await import(resolve(here, "../dist/presentation/http/build-server.js"));
const { buildOpenApiTestUseCase } = await import(
  resolve(here, "../dist/testing/http/openapi-test-use-case.js")
);

const app = await buildServer(buildOpenApiTestUseCase());
await app.ready();
const document = app.swagger();
await app.close();

const target = resolve(here, "../openapi/v1-baseline.json");
mkdirSync(dirname(target), { recursive: true });
// 書き出し前にPrettierを通す。素の`JSON.stringify`のままコミットすると
// `format:check`（品質ゲート）が整形差分で落ちる。
//
// 入力を`null, 2`で展開しておくのは、PrettierのJSON出力が入力の改行位置を
// 引き継ぐため。詰めた1行を渡すと配列・objectが畳まれ、契約baselineとしての
// 行単位diffがレビューで読めなくなる。
const options = await resolveConfig(target);
writeFileSync(
  target,
  await format(JSON.stringify(document, null, 2), { ...options, filepath: target }),
);
stdout.write(`wrote ${target}\n`);
