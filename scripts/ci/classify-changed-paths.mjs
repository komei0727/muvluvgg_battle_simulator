// Decides which CI quality gates a changed-path list must run.
//
// Used by the `changes` job in .github/workflows/pr.yml and main.yml. That
// job always runs (workflow-level `on.*.paths` filters are avoided so
// required status checks report success/skipped instead of never
// triggering — PR #118 review); its output feeds job-level `if:` guards on
// the API/UI quality gates and the Cloud Run deploy job.

const API_PATH_PREFIXES = ["apps/api/", "raw/", "deploy/", "scripts/cloud-run/"];
const API_EXACT_PATHS = new Set(["Dockerfile", ".dockerignore", "scripts/container-smoke-test.sh"]);
const UI_PATH_PREFIXES = ["apps/ui/"];

// Root-level config that affects both workspaces (dependency graph, tool
// versions, or the CI decision logic itself) — run both gates when touched.
const SHARED_EXACT_PATHS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "mise.toml",
  "mise.lock",
  ".prettierrc",
  ".prettierignore",
]);
const SHARED_PATH_PREFIXES = [".github/workflows/"];

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function isApiPath(path) {
  return startsWithAny(path, API_PATH_PREFIXES) || API_EXACT_PATHS.has(path);
}

function isUiPath(path) {
  return startsWithAny(path, UI_PATH_PREFIXES);
}

function isSharedPath(path) {
  return SHARED_EXACT_PATHS.has(path) || startsWithAny(path, SHARED_PATH_PREFIXES);
}

/**
 * @param {readonly string[]} changedPaths repo-root-relative paths
 * @returns {{ readonly runApi: boolean; readonly runUi: boolean }}
 */
export function classifyChangedPaths(changedPaths) {
  const apiChanged = changedPaths.some(isApiPath);
  const uiChanged = changedPaths.some(isUiPath);
  const sharedChanged = changedPaths.some(isSharedPath);

  const runApi = apiChanged || sharedChanged;
  // API changes can break the UI's hand-mirrored contract types, so the UI
  // gate must also run whenever the API gate does.
  const runUi = uiChanged || runApi;

  return { runApi, runUi };
}

// CLI: reads newline-delimited changed paths from stdin, writes
// `run_api=true|false` / `run_ui=true|false` lines to stdout for the
// workflow to append to $GITHUB_OUTPUT. Guarded so importing this module
// from tests never triggers a stdin read.
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const changedPaths = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const { runApi, runUi } = classifyChangedPaths(changedPaths);
  process.stdout.write(`run_api=${String(runApi)}\n`);
  process.stdout.write(`run_ui=${String(runUi)}\n`);
}
