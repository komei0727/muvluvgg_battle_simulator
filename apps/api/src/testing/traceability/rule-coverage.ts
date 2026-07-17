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
    testCaseIds: ["UT-R-FRM-03-001", "UT-R-FRM-FACTORY-002", "UT-R-FRM-FACTORY-007"],
    kinds: ["POSITIVE", "NEGATIVE"],
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
  {
    ruleId: "R-FRM-06",
    testCaseIds: [
      "UT-PREFLIGHT-001",
      "UT-PREFLIGHT-002",
      "UT-PREFLIGHT-003",
      "UT-PREFLIGHT-004",
      "UT-PREFLIGHT-005",
      "UT-PREFLIGHT-006",
      "UT-USECASE-003",
      "UT-USECASE-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE"],
  },

  // POS: 座標
  {
    ruleId: "R-POS-01",
    testCaseIds: [
      "UT-R-POS-01-001",
      "UT-R-POS-01-002",
      "UT-R-POS-01-003",
      "UT-R-POS-01-004",
      "UT-R-POS-01-005",
      "UT-R-POS-01-006",
      "UT-R-POS-01-007",
      "UT-R-POS-01-008",
      "UT-R-POS-01-009",
      "UT-R-POS-01-010",
      "UT-R-POS-01-011",
      "UT-R-POS-01-012",
      "UT-R-POS-01-013",
      "UT-R-POS-01-014",
      "UT-R-POS-01-015",
      "UT-R-POS-01-016",
      "UT-R-POS-01-017",
      "UT-R-POS-01-018",
      "UT-R-POS-01-019",
      "UT-R-POS-01-020",
      "UT-R-POS-01-021",
      "UT-R-POS-01-022",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-POS-02",
    testCaseIds: ["UT-R-POS-02-001", "UT-R-POS-02-002", "UT-R-POS-02-003", "UT-R-POS-02-004"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-POS-03",
    testCaseIds: [
      "UT-R-POS-03-001",
      "UT-R-POS-03-002",
      "UT-R-POS-03-003",
      "UT-R-POS-03-004",
      "UT-R-POS-03-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "PROPERTY"],
  },

  // BON: 編成ボーナス
  {
    ruleId: "R-BON-01",
    testCaseIds: [
      "UT-R-BON-01-001",
      "UT-R-BON-01-002",
      "UT-R-BON-01-003",
      "UT-R-BON-01-004",
      "UT-R-BON-01-005",
      "UT-R-BON-01-006",
      "UT-R-BON-01-007",
      "UT-R-BON-01-008",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-BON-02",
    testCaseIds: [
      "UT-R-BON-02-001",
      "UT-R-BON-02-002",
      "UT-R-BON-02-003",
      "UT-R-BON-02-004",
      "UT-R-BON-02-005",
    ],
    kinds: ["POSITIVE", "PROPERTY"],
  },
  {
    ruleId: "R-BON-03",
    testCaseIds: [
      "UT-R-BON-03-001",
      "UT-R-BON-03-002",
      "UT-R-BON-03-003",
      "UT-R-BON-03-004",
      "UT-R-BON-03-005",
      "UT-R-BON-03-006",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },

  // STA: ステータス
  {
    ruleId: "R-STA-01",
    testCaseIds: [
      "UT-R-STA-01-001",
      "UT-R-STA-01-002",
      "UT-R-STA-01-003",
      "UT-R-STA-01-004",
      "UT-R-STA-01-005",
      "UT-R-STA-01-006",
      "UT-R-STA-01-010",
      "UT-R-STA-01-011",
      "UT-R-STA-01-012",
      "UT-R-STA-01-013",
      "UT-R-STA-01-014",
      "UT-R-STA-01-015",
      "UT-R-STA-01-016",
      "UT-R-STA-01-017",
      "UT-R-STA-01-018",
      "UT-R-STA-01-019",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-STA-02",
    testCaseIds: ["UT-R-STA-02-001", "UT-R-STA-02-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-STA-03",
    testCaseIds: [
      "UT-R-STA-03-001",
      "UT-R-STA-03-002",
      "UT-R-STA-03-003",
      "UT-R-STA-03-004",
      "UT-R-STA-03-005",
    ],
    kinds: ["POSITIVE", "PROPERTY"],
  },
  {
    ruleId: "R-STA-04",
    testCaseIds: [
      "UT-R-STA-04-001",
      "UT-R-STA-04-002",
      "UT-R-STA-04-003",
      "UT-R-STA-04-004",
      "UT-R-STA-04-005",
      "UT-R-STA-04-006",
      "UT-R-STA-04-007",
      "UT-R-STA-04-008",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },

  // ORD: 行動順
  { ruleId: "R-ORD-01", testCaseIds: [], kinds: [] },
  {
    ruleId: "R-ORD-02",
    testCaseIds: [
      "UT-R-ORD-02-001",
      "UT-R-ORD-02-002",
      "UT-R-ORD-02-003",
      "UT-R-ORD-02-004",
      "UT-R-ORD-02-005",
      "UT-R-ORD-02-006",
      "UT-R-ORD-02-007",
    ],
    kinds: ["POSITIVE", "PROPERTY", "SCENARIO"],
  },
  {
    ruleId: "R-ORD-03",
    testCaseIds: [
      "UT-ACTION-QUEUE-003",
      "UT-ACTION-QUEUE-004",
      "UT-ACTION-QUEUE-008",
      "UT-ACTION-PHASE-005B",
      "UT-ACTION-PHASE-012",
    ],
    kinds: ["POSITIVE", "SCENARIO"],
  },
  { ruleId: "R-ORD-04", testCaseIds: [], kinds: [] },

  // ACT: 行動
  { ruleId: "R-ACT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-02", testCaseIds: [], kinds: [] },
  // R-ACT-03は「AS・PS・EXのコストは1以上」というCatalog検証の下限だけを
  // UT-CAT-SKL-019/020/021・UT-INFRA-SCHEMA-011で検証している。行が示す
  // 各消費量そのもの（PS・EXの実消費、AP0・EX満タン時の特殊待機、チャージ
  // 効果発動）はPS/EX/M5未実装のため、13_実装計画.md「後続依存を持つルールは
  // 完了計上しない」に従い台帳上は未完了のままとする。
  { ruleId: "R-ACT-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-04", testCaseIds: [], kinds: [] },

  // TGT: 対象選択
  {
    ruleId: "R-TGT-01",
    testCaseIds: [
      "UT-R-TGT-01-001",
      "UT-R-TGT-01-002",
      "UT-R-TGT-01-003",
      "UT-R-TGT-01-004",
      "UT-R-TGT-01-005",
      "UT-R-TGT-01-006",
      "UT-R-TGT-01-007",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-TGT-02",
    testCaseIds: ["UT-R-TGT-02-001", "UT-R-TGT-02-002", "UT-R-TGT-02-003", "UT-R-TGT-02-004"],
    kinds: ["POSITIVE", "PROPERTY"],
  },
  { ruleId: "R-TGT-03", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-04", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-06", testCaseIds: [], kinds: [] },
  {
    ruleId: "R-TGT-07",
    testCaseIds: ["UT-R-TGT-07-001", "UT-R-TGT-07-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  { ruleId: "R-TGT-08", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-09", testCaseIds: [], kinds: [] },
  { ruleId: "R-TGT-10", testCaseIds: [], kinds: [] },

  // SKL: スキル
  { ruleId: "R-SKL-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-03", testCaseIds: [], kinds: [] },
  {
    ruleId: "R-SKL-04",
    testCaseIds: [
      "UT-COOLDOWN-001",
      "UT-COOLDOWN-002",
      "UT-COOLDOWN-003",
      "UT-COOLDOWN-004",
      "UT-COOLDOWN-005",
      "UT-COOLDOWN-006",
      "UT-COOLDOWN-007",
      "UT-COOLDOWN-008",
      "UT-COOLDOWN-009",
      "UT-COOLDOWN-010",
      "UT-COOLDOWN-011",
      "UT-COOLDOWN-012",
      "UT-COOLDOWN-013",
      "UT-ACTION-PHASE-009",
      "UT-ACTION-PHASE-010",
      "UT-ACTION-PHASE-011",
      "UT-ACTION-PHASE-013",
      "UT-BATTLE-013",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },
  { ruleId: "R-SKL-05", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-06", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-07", testCaseIds: [], kinds: [] },
  { ruleId: "R-SKL-08", testCaseIds: [], kinds: [] },
  {
    ruleId: "R-SKL-09",
    testCaseIds: [
      "UT-COOLDOWN-014",
      "UT-COOLDOWN-015",
      "UT-COOLDOWN-016",
      "UT-COOLDOWN-017",
      "UT-COOLDOWN-018",
      "UT-COOLDOWN-019",
      "UT-COOLDOWN-020",
      "UT-COOLDOWN-021",
      "UT-ACTION-PHASE-015",
      "UT-ACTION-PHASE-016",
      "UT-ACTION-PHASE-017",
      "UT-R-ACT-02-006",
      "UT-R-ACT-02-007",
      "UT-R-ACT-02-008",
      "UT-COOLDOWN-CHECK-001",
      "UT-COOLDOWN-CHECK-002",
      "UT-COOLDOWN-CHECK-003",
      "UT-CAT-ACT-056",
      "UT-CAT-ACT-057",
      "UT-CAT-ACT-058",
      "UT-CAT-ACT-059",
      "UT-CAT-ACT-060",
      "UT-CAT-ACT-061",
      "UT-CAT-IDX-017",
      "UT-CAT-IDX-018",
      "UT-CAT-IDX-019",
      "IT-COOLDOWN-MANIP-PROD-001",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "SCENARIO"],
  },

  // PS: パッシブスキル（#19: PassiveTriggerMatcher・候補検出・優先順）
  {
    ruleId: "R-PS-01",
    testCaseIds: [
      "UT-R-PS-01-001",
      "UT-R-PS-01-002",
      "UT-R-PS-01-003",
      "UT-R-PS-01-004",
      "UT-R-PS-01-005",
      "UT-R-PS-01-006",
      "UT-R-PS-01-007",
      "UT-R-PS-01-008",
      "UT-R-PS-01-010",
      "UT-R-PS-01-011",
      "UT-R-PS-01-012",
      "UT-R-PS-01-013",
      "UT-R-PS-01-014",
      "UT-R-PS-01-015",
      "UT-R-PS-01-016",
      "UT-R-PS-01-017",
      "UT-R-PS-01-018",
      "UT-R-PS-01-019",
      "UT-R-PS-01-020",
      "UT-R-PS-01-021",
      "UT-R-PS-01-022",
      "UT-R-PS-01-023",
      "UT-R-PS-01-024",
      "UT-R-PS-01-025",
      "UT-R-PS-01-026",
      "UT-R-PS-01-027",
      "UT-R-PS-01-028",
      "UT-R-PS-01-029",
      "UT-R-PS-01-030",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-PS-02",
    testCaseIds: [
      "UT-R-PS-02-001",
      "UT-R-PS-02-002",
      "UT-R-PS-02-003",
      "UT-R-PS-02-004",
      "UT-R-PS-02-005",
      "UT-R-PS-02-006",
    ],
    kinds: ["POSITIVE", "PROPERTY"],
  },
  // R-PS-03「同時発動制限」+`exclusiveActivationGroupId`排他グループ（#21:
  // `applySimultaneousActivationLimit`）。
  {
    ruleId: "R-PS-03",
    testCaseIds: [
      "UT-R-PS-03-001",
      "UT-R-PS-03-002",
      "UT-R-PS-03-003",
      "UT-R-PS-03-004",
      "UT-R-PS-03-005",
      "UT-R-PS-03-006",
      "UT-R-PS-03-007",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-PS-04",
    testCaseIds: [
      "UT-R-PS-04-001",
      "UT-R-PS-04-002",
      "UT-R-PS-04-003",
      "UT-R-PS-04-004",
      "UT-R-PS-04-005",
      "UT-R-PS-04-006",
      "UT-R-PS-04-007",
      "UT-R-PS-04-008",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  // R-PS-05「発動と再入防止」は6ステップ（発動済み集合への記録、PP消費とEX増加、
  // クールタイム設定、`PassiveActivated`発行、EffectSequence解決、`PassiveResolved`
  // 発行）を要求する。#21が実装したのは#1（`resolvePassiveChain`内の
  // `recordActivation`呼び出し）とSkill中断結果の接続点（`interruptedCandidates`）
  // だけで、PP消費・EX増加・Cooldown設定・イベント発行は#34のスコープ。
  // 13_実装計画.md「後続依存を持つルールは完了計上しない」に従い、#34完了まで
  // 台帳上は未完了のままとする。
  { ruleId: "R-PS-05", testCaseIds: [], kinds: [] },
  // R-PS-06「新規候補の即時処理」: `resolvePassiveChain`（#21）は`activate`が
  // 効果解決の途中で`yield`するたびに、その候補連鎖を完全に解決してから元の
  // ジェネレータを再開する。これにより「親の効果A→子PS→親の効果B」の順序
  // （UT-R-PS-06-008）を、PSがEffectSequence全体を終えてからしか新規候補を
  // 報告できない設計では表現できなかった粒度で満たす。
  {
    ruleId: "R-PS-06",
    testCaseIds: [
      "UT-R-PS-06-001",
      "UT-R-PS-06-002",
      "UT-R-PS-06-003",
      "UT-R-PS-06-004",
      "UT-R-PS-06-005",
      "UT-R-PS-06-006",
      "UT-R-PS-06-007",
      "UT-R-PS-06-008",
    ],
    kinds: ["POSITIVE", "SCENARIO"],
  },
  {
    ruleId: "R-PS-07",
    testCaseIds: ["UT-R-PS-04-007", "UT-R-PS-06-007", "UT-R-PS-07-001"],
    kinds: ["POSITIVE", "NEGATIVE"],
  },
  // R-PS-08「先制攻撃」: 候補順序はUT-R-PS-08-001〜003（#19）で検証済み。同時発動制限
  // (R-PS-03)との統合はUT-R-PS-03-003（先制候補が同時発動制限内でも優先される）で
  // 検証し、これで完了計上する。
  {
    ruleId: "R-PS-08",
    testCaseIds: ["UT-R-PS-08-001", "UT-R-PS-08-002", "UT-R-PS-08-003", "UT-R-PS-03-003"],
    kinds: ["POSITIVE", "PROPERTY"],
  },

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
  {
    ruleId: "R-HIT-01",
    testCaseIds: ["UT-R-HIT-01-001", "UT-R-HIT-01-002"],
    kinds: ["POSITIVE"],
  },
  { ruleId: "R-HIT-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-HIT-03", testCaseIds: [], kinds: [] },

  // CRT: 会心
  {
    ruleId: "R-CRT-01",
    testCaseIds: [
      "UT-R-CRT-01-001",
      "UT-R-CRT-01-002",
      "UT-R-CRT-01-003",
      "UT-R-CRT-01-004",
      "UT-R-CRT-01-005",
      "UT-R-CRT-01-006",
      "UT-R-CRT-01-007",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-CRT-02",
    testCaseIds: ["UT-R-CRT-02-001", "UT-R-CRT-02-002"],
    kinds: ["POSITIVE"],
  },

  // ATR: 属性
  {
    ruleId: "R-ATR-01",
    testCaseIds: [
      "UT-R-ATR-01-001",
      "UT-R-ATR-01-002",
      "UT-R-ATR-01-003",
      "UT-R-ATR-01-004",
      "UT-R-ATR-01-005",
      "UT-R-ATR-01-006",
      "UT-R-ATR-01-007",
      "UT-R-ATR-01-008",
      "UT-R-ATR-01-009",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-ATR-02",
    testCaseIds: [
      "UT-R-ATR-02-001",
      "UT-R-ATR-02-002",
      "UT-R-ATR-02-003",
      "UT-R-ATR-02-004",
      "UT-R-ATR-02-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },

  // DMG: ダメージ
  {
    ruleId: "R-DMG-01",
    testCaseIds: [
      "UT-R-DMG-01-001",
      "UT-R-DMG-01-002",
      "UT-R-DMG-01-003",
      "UT-R-DMG-01-004",
      "UT-R-DMG-01-005",
      "UT-R-DMG-01-006",
      "UT-R-DMG-01-007",
      "UT-R-DMG-01-008",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-DMG-02はダメージ計算の最終切り捨てと最低1ダメージ(damage-calculator.ts、
  // UT-DAMAGE-CALCULATOR-001/002で検証)だけを#9で実装している。「ダメージ無効
  // 効果がある場合も結果を1とする」は効果システム(M7)が無いため未実装であり、
  // 13_実装計画.md「後続依存を持つルールは完了計上しない」に従い台帳上は
  // 未完了のままとする。
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
  // R-END-01の2つの判定タイミング区分を#9で両方カバーした:
  // (1) ターン開始・終了などの行動外トップレベル解決スコープ完了後
  //     (battle.tsのTURN_STARTING/TURN_ENDING、UT-R-END-01-001〜004)
  // (2) ユニットの1行動完了後 (action-phase-resolver.tsの各行動処理直後、
  //     UT-ACTION-PHASE-003/UT-BATTLE-010/011)。
  // 「PS/Memory連鎖完了後」はPS/Memoryエンジン自体が未実装(M6/M7)のため、
  // 現状は行動完了直後がそのままPS/Memory連鎖完了後と等価になる。
  {
    ruleId: "R-END-01",
    testCaseIds: [
      "UT-R-END-01-001",
      "UT-R-END-01-002",
      "UT-R-END-01-003",
      "UT-R-END-01-004",
      "UT-ACTION-PHASE-003",
      "UT-BATTLE-010",
      "UT-BATTLE-011",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-END-02",
    testCaseIds: [
      "UT-R-END-02-001",
      "UT-R-END-02-002",
      "UT-R-END-02-003",
      "UT-R-END-02-004",
      "UT-R-END-02-005",
      "UT-R-END-02-006",
      "UT-R-END-02-007",
      "UT-BATTLE-012",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
];
