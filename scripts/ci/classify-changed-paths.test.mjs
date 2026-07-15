import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChangedPaths } from "./classify-changed-paths.mjs";

// PR #118 review: required checks must show success/skipped at the job
// level rather than the workflow never triggering, so this decision logic
// is a pure function the `changes` job's `if:` conditions read from — it
// must be independently testable from the git-diff plumbing around it.

test("UI-only change runs only the UI gate", () => {
  const result = classifyChangedPaths(["apps/ui/src/App.tsx", "apps/ui/package.json"]);
  assert.deepEqual(result, { runApi: false, runUi: true });
});

test("API-only change runs the API gate and the UI gate (contract mirror check)", () => {
  const result = classifyChangedPaths(["apps/api/src/domain/battle/x.ts"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("Catalog raw source change runs the API gate", () => {
  const result = classifyChangedPaths(["raw/units/foo.md"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("root Dockerfile change runs the API gate", () => {
  const result = classifyChangedPaths(["Dockerfile"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test(".dockerignore change runs the API gate", () => {
  const result = classifyChangedPaths([".dockerignore"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("Cloud Run deploy config change runs the API gate", () => {
  const result = classifyChangedPaths(["deploy/cloud-run/service.json"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("Cloud Run deploy script change runs the API gate", () => {
  const result = classifyChangedPaths(["scripts/cloud-run/02-build-and-push-image.sh"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("container smoke test script change runs the API gate", () => {
  const result = classifyChangedPaths(["scripts/container-smoke-test.sh"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (package.json) runs both gates", () => {
  const result = classifyChangedPaths(["package.json"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (pnpm-lock.yaml) runs both gates", () => {
  const result = classifyChangedPaths(["pnpm-lock.yaml"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (pnpm-workspace.yaml) runs both gates", () => {
  const result = classifyChangedPaths(["pnpm-workspace.yaml"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (mise.toml) runs both gates", () => {
  const result = classifyChangedPaths(["mise.toml"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("workflow file change runs both gates", () => {
  const result = classifyChangedPaths([".github/workflows/pr.yml"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("mixed API and UI change runs both gates", () => {
  const result = classifyChangedPaths(["apps/api/src/x.ts", "apps/ui/src/y.tsx"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("docs-only change runs neither gate", () => {
  const result = classifyChangedPaths(["docs/ui-design/01_UI要求・画面設計.md"]);
  assert.deepEqual(result, { runApi: false, runUi: false });
});

test("no changed paths runs neither gate", () => {
  const result = classifyChangedPaths([]);
  assert.deepEqual(result, { runApi: false, runUi: false });
});

test("a package.json nested under apps/ui/ is treated as a UI path, not the shared root one", () => {
  const result = classifyChangedPaths(["apps/ui/package.json"]);
  assert.deepEqual(result, { runApi: false, runUi: true });
});
