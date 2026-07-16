// Regression fixtures: API error envelopes for the mock-API E2E suite.
// docs/ui-design/03_API・データ連携設計.md §13 (error normalization).

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
