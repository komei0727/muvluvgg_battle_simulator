import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChangedPaths } from "./classify-changed-paths.mjs";

// Required checks must show success/skipped at the job
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

// raw/ is gitignored (.gitignore), so it can never appear in a git diff —
// classifying it would be a dead condition. If raw/ is ever un-ignored,
// re-add it to API_PATH_PREFIXES together with this test's inverse.
test("raw/ paths are unclassified (gitignored, never in a diff)", () => {
  const result = classifyChangedPaths(["raw/units/foo.md"]);
  assert.deepEqual(result, { runApi: false, runUi: false });
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

test("CI decision-logic change (scripts/ci/) runs both gates", () => {
  const result = classifyChangedPaths(["scripts/ci/classify-changed-paths.mjs"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("workflow file change runs both gates", () => {
  const result = classifyChangedPaths([".github/workflows/pr.yml"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (.prettierrc) runs both gates", () => {
  const result = classifyChangedPaths([".prettierrc"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("shared root config change (.prettierignore) runs both gates", () => {
  const result = classifyChangedPaths([".prettierignore"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

// tools/ holds local-only analysis tooling (tools/exercise-lab is a Python
// package managed by uv) that ships neither into the API image nor the UI
// bundle, and is outside the pnpm workspace. Its quality checks (ruff/pytest)
// run locally, so touching it must not spin up the TypeScript gates.
test("tools/ change runs neither gate", () => {
  const result = classifyChangedPaths([
    "tools/exercise-lab/pyproject.toml",
    "tools/exercise-lab/src/exercise_lab/cli.py",
  ]);
  assert.deepEqual(result, { runApi: false, runUi: false });
});

test("mixed API and UI change runs both gates", () => {
  const result = classifyChangedPaths(["apps/api/src/x.ts", "apps/ui/src/y.tsx"]);
  assert.deepEqual(result, { runApi: true, runUi: true });
});

test("docs-only change runs neither gate", () => {
  const result = classifyChangedPaths(["docs/ui-design/01_UI要求・画面設計.md"]);
  assert.deepEqual(result, { runApi: false, runUi: false });
});

// Intentionally unclassified: these paths cannot change what the API/UI
// jobs build or test, and the always-on `changes` job already re-checks
// formatting and this decision logic on every run.
test("local-gate script, .claude/, and root markdown changes run neither gate", () => {
  const result = classifyChangedPaths([
    "scripts/run-quality-gates.sh",
    ".claude/skills/muvluvgg-implement-issue/SKILL.md",
    "CLAUDE.md",
  ]);
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
