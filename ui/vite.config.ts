import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// GitHub Pages serves this project from a repository subpath. The Pages deploy
// workflow (Issue #99) sets VITE_BASE_PATH to "/<repository>/"; local dev and
// preview default to root so `pnpm run dev` keeps working without extra setup.
const basePath = process.env["VITE_BASE_PATH"] ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [react()],
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
