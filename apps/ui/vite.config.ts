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
  },
});
