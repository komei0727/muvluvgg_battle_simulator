/**
 * `11_インフラストラクチャ設計.md`「OpenAPI」「productionではSwagger UIを既定で
 * 公開しない。開発・検証環境だけUIを有効化できる」（#85）。`bootstrap/index.ts`
 * の`process.env["NODE_ENV"]`読み取りから判定ロジックを切り出したもの
 * ——`bootstrap()`自体はWorker Pool・Catalogを起動する重い結合テスト
 * （`index.integration.test.ts`のINT-BOOTSTRAP-006/007）でしか検証できず、
 * それらはPR Quality Gate（`mise run test:coverage`）の対象外
 * （`*.integration.test.ts`は`vitest.config.ts`が除外）のため、
 * NODE_ENV→docsEnabledの判定だけをここへ分離し、通常のテストスイートで
 * 直接検証できるようにする（レビュー指摘）。
 */
export function resolveDocsEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
