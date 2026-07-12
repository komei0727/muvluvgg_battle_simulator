type TestKind = "POSITIVE" | "NEGATIVE" | "BOUNDARY" | "PROPERTY" | "SCENARIO";

export interface RuleTestCoverage {
  ruleId: string;
  testCaseIds: string[];
  kinds: TestKind[];
}

export const RULE_COVERAGE: readonly RuleTestCoverage[] = [
  // NUM: 数値表現
  {
    ruleId: "R-NUM-01",
    testCaseIds: [
      "UT-R-NUM-01-001",
      "UT-R-NUM-01-002",
      "UT-R-NUM-01-003",
      "UT-R-NUM-01-004",
      "UT-R-NUM-01-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-NUM-02",
    testCaseIds: [
      "UT-R-NUM-02-001",
      "UT-R-NUM-02-002",
      "UT-R-NUM-02-003",
      "UT-R-NUM-02-004",
      "UT-R-NUM-02-005",
      "UT-R-NUM-02-006",
      "UT-R-NUM-02-007",
      "UT-R-NUM-02-008",
      "UT-R-NUM-02-009",
      "UT-R-NUM-02-010",
      "UT-R-NUM-02-011",
      "UT-R-NUM-02-012",
      "UT-R-NUM-02-013",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-NUM-03",
    testCaseIds: [
      "UT-R-NUM-03-001",
      "UT-R-NUM-03-002",
      "UT-R-NUM-03-003",
      "UT-R-NUM-03-004",
      "UT-R-NUM-03-005",
      "UT-R-NUM-03-006",
    ],
    kinds: ["BOUNDARY", "PROPERTY"],
  },
  { ruleId: "R-NUM-04", testCaseIds: [], kinds: [] },

  // FRM: 編成
  {
    ruleId: "R-FRM-01",
    testCaseIds: ["UT-R-FRM-01-001", "UT-R-FRM-01-002", "UT-R-FRM-01-003", "UT-R-FRM-01-004"],
    kinds: ["BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-FRM-02",
    testCaseIds: [
      "UT-R-FRM-02-001",
      "UT-R-FRM-02-002",
      "UT-R-FRM-02-003",
      "UT-R-FRM-02-004",
      "UT-R-FRM-02-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-FRM-03",
    testCaseIds: ["UT-R-FRM-03-001"],
    kinds: ["POSITIVE"],
  },
  {
    ruleId: "R-FRM-04",
    testCaseIds: [
      "UT-R-FRM-04-001",
      "UT-R-FRM-04-002",
      "UT-R-FRM-04-003",
      "UT-R-FRM-04-004",
      "UT-R-FRM-04-005",
      "UT-R-FRM-04-006",
    ],
    kinds: ["BOUNDARY", "NEGATIVE", "POSITIVE"],
  },
  {
    ruleId: "R-FRM-05",
    testCaseIds: [
      "UT-R-FRM-05-001",
      "UT-R-FRM-05-002",
      "UT-R-FRM-05-003",
      "UT-R-FRM-05-004",
      "UT-R-FRM-05-005",
    ],
    kinds: ["BOUNDARY", "NEGATIVE"],
  },
  { ruleId: "R-FRM-06", testCaseIds: [], kinds: [] },

  // POS: 座標
  { ruleId: "R-POS-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-POS-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-POS-03", testCaseIds: [], kinds: [] },

  // BON: 編成ボーナス
  { ruleId: "R-BON-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-BON-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-BON-03", testCaseIds: [], kinds: [] },

  // STA: ステータス
  { ruleId: "R-STA-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-STA-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-STA-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-STA-04", testCaseIds: [], kinds: [] },

  // ORD: 行動順
  { ruleId: "R-ORD-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ORD-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-ORD-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-ORD-04", testCaseIds: [], kinds: [] },

  // ACT: 行動
  { ruleId: "R-ACT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-04", testCaseIds: [], kinds: [] },

  // TGT: 対象選択
  { ruleId: "R-TGT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-06", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-07", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-08", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-09", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-10", testCaseIds: [], kinds: [] },

  // SKL: スキル
  { ruleId: "R-SKL-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-06", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-07", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-08", testCaseIds: [], kinds: [] },

  // PS: パッシブスキル
  { ruleId: "R-PS-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-06", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-07", testCaseIds: [], kinds: [] },
  { ruleId: "R-PS-08", testCaseIds: [], kinds: [] },

  // MEM: Memory発動
  { ruleId: "R-MEM-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-MEM-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-MEM-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-MEM-04", testCaseIds: [], kinds: [] },

  // ACTN: EffectAction解決
  { ruleId: "R-ACTN-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACTN-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACTN-03", testCaseIds: [], kinds: [] },

  // HIT: 命中
  { ruleId: "R-HIT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-HIT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-HIT-03", testCaseIds: [], kinds: [] },

  // CRT: 会心
  { ruleId: "R-CRT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-CRT-02", testCaseIds: [], kinds: [] },

  // ATR: 属性
  { ruleId: "R-ATR-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ATR-02", testCaseIds: [], kinds: [] },

  // DMG: ダメージ
  { ruleId: "R-DMG-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-DMG-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-DMG-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-DMG-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-DMG-05", testCaseIds: [], kinds: [] },

  // HEAL: 回復計算
  { ruleId: "R-HEAL-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-HEAL-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-HEAL-03", testCaseIds: [], kinds: [] },

  // SHD: シールド
  { ruleId: "R-SHD-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-SHD-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-SHD-03", testCaseIds: [], kinds: [] },

  // SUB: サブユニット
  { ruleId: "R-SUB-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-SUB-02", testCaseIds: [], kinds: [] },

  // INT: 防御介入
  { ruleId: "R-INT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-INT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-INT-03", testCaseIds: [], kinds: [] },

  // LNK: リンク
  { ruleId: "R-LNK-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-LNK-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-LNK-03", testCaseIds: [], kinds: [] },

  // DOT: 継続ダメージ
  { ruleId: "R-DOT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-DOT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-DOT-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-DOT-04", testCaseIds: [], kinds: [] },

  // STS: 状態異常
  { ruleId: "R-STS-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-STS-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-STS-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-STS-04", testCaseIds: [], kinds: [] },

  // EFF: 効果
  { ruleId: "R-EFF-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-06", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-07", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-08", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-09", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-10", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-11", testCaseIds: [], kinds: [] },

  // END: 勝敗判定
  { ruleId: "R-END-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-END-02", testCaseIds: [], kinds: [] },
];
