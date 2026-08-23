// Regression fixtures: API error envelopes for the mock-API E2E suite.
// docs/ui-design/03_API・データ連携設計.md §13 (error normalization).
//
// REF-053 (Issue #598): kept hand-written rather than sourced from
// apps/ui/src/test/fixtures/error-invalid-command.json /
// error-capacity.json — those are generated from a different trigger
// (an out-of-range turnLimit) than this fixture's scenario (a position
// conflict on the first ally slot), so swapping content here would mean
// rewriting error-handling.spec.ts's scenario, not a pure input swap. The
// generated fixtures give independent structural coverage via
// error-normalizer.contract-fixtures.test.ts.

// 422: server-side validation rejects the first ally unit slot.
export const battleValidationErrorFixture = {
  schemaVersion: 1,
  error: {
    code: "INVALID_COMMAND",
    message: "配置が不正です。",
    violations: [
      {
        path: "/allyFormation/units/0",
        ruleId: "POSITION_CONFLICT",
        message: "同じ座標に複数のユニットは配置できません。",
      },
    ],
  },
};

// 503: server is at capacity. Retry-After is served as a response header by
// the mock route, not part of this body.
export const battleCapacityErrorFixture = {
  schemaVersion: 1,
  error: {
    code: "CAPACITY_EXCEEDED",
    message: "サーバーが混雑しています。",
    violations: [],
  },
};
