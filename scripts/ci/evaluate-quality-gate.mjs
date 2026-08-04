// Decides whether a PR run's per-workspace quality gates collectively pass.
//
// Used by the `gate` job in .github/workflows/pr.yml, which is the only
// check branch protection requires. The per-workspace gates cannot be
// required directly: `quality` and `ui` are reusable-workflow calls, and a
// skipped call produces a check-run named after the caller job id alone
// (`quality`) rather than the inner job name (`quality / Quality Gate`).
// A PR whose classification skips one of them would therefore never create
// the required context and would stay Pending forever.
//
// Skipped-vs-success cannot be read off a single job's `result`: a gate is
// skipped either legitimately (run_api/run_ui said it need not run) or as a
// casualty of an upstream failure/cancellation. The classification outputs
// are what tell those apart, so the comparison is made here rather than in
// per-job `if:` expressions.

/** @typedef {"success" | "failure" | "cancelled" | "skipped"} JobResult */

const GATE_JOBS = [
  { id: "quality", workspace: "api" },
  { id: "container", workspace: "api" },
  { id: "ui", workspace: "ui" },
];

/**
 * @param {{
 *   readonly runApi: boolean;
 *   readonly runUi: boolean;
 *   readonly results: Readonly<Record<string, JobResult | string>>;
 * }} input
 * @returns {{
 *   readonly ok: boolean;
 *   readonly failures: readonly string[];
 *   readonly summary: string;
 * }}
 */
export function evaluateQualityGate({ runApi, runUi, results }) {
  const failures = [];
  const rows = [];

  // `changes` has no `if:` guard, and it is where repo-wide format:check and
  // ci:test run — anything other than success means those never reported.
  if (results.changes !== "success") {
    failures.push(`changes: expected success, got ${results.changes}`);
  }
  rows.push(`- changes: ${results.changes} (always runs)`);

  for (const job of GATE_JOBS) {
    const required = job.workspace === "api" ? runApi : runUi;
    const actual = results[job.id];
    const expected = required ? "success" : "skipped";
    if (actual !== expected) {
      failures.push(
        `${job.id}: run_${job.workspace}=${String(required)} expects ${expected}, got ${actual}`,
      );
    }
    rows.push(`- ${job.id}: ${actual} (required: ${String(required)})`);
  }

  const summary = [
    `run_api: ${String(runApi)} / run_ui: ${String(runUi)}`,
    ...rows,
    failures.length === 0
      ? "All required quality gates reported the expected result."
      : `Unmet expectations:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
  ].join("\n");

  return { ok: failures.length === 0, failures, summary };
}

// CLI: reads the classification outputs and each gate's `result` from the
// environment, prints a markdown summary, and exits non-zero when an
// expectation is unmet so the aggregate check-run fails.
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href) {
  const { ok, summary } = evaluateQualityGate({
    runApi: process.env["RUN_API"] === "true",
    runUi: process.env["RUN_UI"] === "true",
    results: {
      changes: process.env["CHANGES_RESULT"] ?? "",
      quality: process.env["QUALITY_RESULT"] ?? "",
      container: process.env["CONTAINER_RESULT"] ?? "",
      ui: process.env["UI_RESULT"] ?? "",
    },
  });

  process.stdout.write(`### Quality gate evaluation\n\n${summary}\n`);
  if (!ok) {
    process.exitCode = 1;
  }
}
