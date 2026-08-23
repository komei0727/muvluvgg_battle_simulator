import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// GitHub Pages serves this project from a repository subpath. The Pages deploy
// workflow (Issue #99) sets VITE_BASE_PATH to "/<repository>/"; local dev and
// preview default to root so `pnpm run dev` keeps working without extra setup.
const basePath = process.env["VITE_BASE_PATH"] ?? "/";

// index.html's CSP meta (style-src 'self') targets the production build,
// which never generates inline styles (05_非機能・アクセシビリティ設計.md
// §11). `vite dev` doesn't meet that assumption — it injects CSS Modules as
// inline <style> tags for HMR — so the same meta blocks all styling under
// `pnpm run dev`. Strip it for the dev server only; `vite build` output is
// untouched.
function stripDevCspMeta(): Plugin {
  return {
    name: "strip-dev-csp-meta",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\n?/, "");
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [react(), stripDevCspMeta()],
  build: {
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: [fileURLToPath(new URL("./src/test/setup.ts", import.meta.url))],
    css: true,
    // ページ全体を描画するcomponentテストはCIランナー上で開発機の約10倍かかる
    // （`UI-CT-035`はローカル0.5秒に対しCI 4.8〜5.0秒。1キーストロークごとに
    // ページ再描画とステータスプレビュー再取得が走るため）。既定の5秒では
    // 実装の退行ではなくランナーの負荷で落ちるので、ハングの検出力を残したまま
    // 3倍の余裕を持たせる。
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      // Vitest 4 measures only files loaded during the run by default;
      // include untested source files too so the denominator is the whole app.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      // Floor matches the API-side gate (apps/api/vitest.config.ts): baseline
      // (measured at Issue #593: lines 93.50 / branches 87.60 / functions
      // 96.98 / statements 93.59) minus a ~3pt regression margin, rounded
      // down. Raise stepwise as the suite grows; never lower to admit a
      // regression (06_UIテスト戦略.md §10).
      thresholds: {
        lines: 90,
        functions: 93,
        branches: 84,
        statements: 90,
        // 06_UIテスト戦略.md §10: request mapper / validator / summary
        // projector / error normalizer target 100% branch coverage. Enforced
        // per-file at the measured baseline (Issue #593) so it guards against
        // regression even where the target isn't fully reached yet.
        "src/features/formation/request-mapper.ts": { branches: 94 },
        "src/shared/api/response-validator.ts": { branches: 88 },
        "src/shared/api/error-normalizer.ts": { branches: 91 },
        "src/features/summary/summary-projector.ts": { branches: 100 },
        // REF-055 (Issue #600): selectRoster moved out of summary-projector.ts
        // into entities/roster.ts along with RosterEntry; it carries the same
        // 100% branch target it had before the move.
        "src/entities/roster.ts": { branches: 100 },
      },
    },
  },
});
