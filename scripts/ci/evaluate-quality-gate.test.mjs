import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateQualityGate } from "./evaluate-quality-gate.mjs";

// A reusable-workflow call that skips produces a check-run named after the
// caller job id alone (`quality`), never the inner job name
// (`quality / Quality Gate`). Branch protection therefore cannot require the
// per-workspace gates directly — it requires the aggregate job this logic
// backs, which `if: always()` guarantees is created on every run.

test("UI-only change passes when the UI gate succeeded and the API gates skipped", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: true,
    results: { changes: "success", quality: "skipped", container: "skipped", ui: "success" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("full change passes when every gate succeeded", () => {
  const result = evaluateQualityGate({
    runApi: true,
    runUi: true,
    results: { changes: "success", quality: "success", container: "success", ui: "success" },
  });
  assert.equal(result.ok, true);
});

test("documentation-only change passes when every gate skipped", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: false,
    results: { changes: "success", quality: "skipped", container: "skipped", ui: "skipped" },
  });
  assert.equal(result.ok, true);
});

test("a required gate that failed fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: true,
    runUi: true,
    results: { changes: "success", quality: "failure", container: "success", ui: "success" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /quality/);
});

test("a required gate that was cancelled fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: true,
    results: { changes: "success", quality: "skipped", container: "skipped", ui: "cancelled" },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /ui/);
});

// The dangerous case this job exists to catch: a gate the classification
// demanded never ran. Treating that as success would let an unverified
// change merge behind a green aggregate check.
test("a required gate that was skipped fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: true,
    runUi: true,
    results: { changes: "success", quality: "skipped", container: "success", ui: "success" },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /quality/);
});

test("a gate that ran despite not being required fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: true,
    results: { changes: "success", quality: "success", container: "skipped", ui: "success" },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /quality/);
});

test("a failed classification job fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: false,
    results: { changes: "failure", quality: "skipped", container: "skipped", ui: "skipped" },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /changes/);
});

// `changes` also runs repo-wide format:check and ci:test, so a skip there
// means those never ran either — it can only be a cancellation casualty.
test("a skipped classification job fails the aggregate", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: false,
    results: { changes: "skipped", quality: "skipped", container: "skipped", ui: "skipped" },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /changes/);
});

test("every violated expectation is reported, not just the first", () => {
  const result = evaluateQualityGate({
    runApi: true,
    runUi: true,
    results: { changes: "success", quality: "failure", container: "failure", ui: "failure" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 3);
});

test("the summary lists every gate with its classification and result", () => {
  const result = evaluateQualityGate({
    runApi: false,
    runUi: true,
    results: { changes: "success", quality: "skipped", container: "skipped", ui: "success" },
  });
  assert.match(result.summary, /run_api/);
  assert.match(result.summary, /run_ui/);
  assert.match(result.summary, /quality/);
  assert.match(result.summary, /container/);
  assert.match(result.summary, /ui/);
});
