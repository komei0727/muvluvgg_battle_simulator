import { describe, expect, it } from "vitest";
import { resolveDocsEnabled } from "./docs-enabled.js";

describe("resolveDocsEnabled", () => {
  it("CFG-DOCS-001 (11_インフラストラクチャ設計.md「OpenAPI」「productionではSwagger UIを既定で公開しない」/ #85 レビュー指摘: PR Quality Gateが実行する通常テストスイートでNODE_ENV→docsEnabledの判定を検証する): returns false when NODE_ENV is production", () => {
    expect(resolveDocsEnabled("production")).toBe(false);
  });

  it("CFG-DOCS-002 (「開発・検証環境だけUIを有効化できる」): returns true for a non-production NODE_ENV such as development", () => {
    expect(resolveDocsEnabled("development")).toBe(true);
  });

  it("CFG-DOCS-003: returns true when NODE_ENV is unset, so docs stay available by default outside explicit production configuration", () => {
    expect(resolveDocsEnabled(undefined)).toBe(true);
  });
});
