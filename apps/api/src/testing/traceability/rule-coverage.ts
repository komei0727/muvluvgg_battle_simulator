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
  {
    ruleId: "R-NUM-04",
    testCaseIds: [
      "UT-R-NUM-04-001",
      "UT-R-NUM-04-002",
      "UT-R-NUM-04-003",
      "UT-R-NUM-04-004",
      "UT-R-NUM-04-005",
      "UT-R-NUM-04-006",
      "UT-R-NUM-04-007",
      "UT-R-NUM-04-008",
      "UT-R-NUM-04-009",
      "UT-R-NUM-04-010",
      "UT-R-NUM-04-011",
      "UT-R-NUM-04-012",
      "UT-R-NUM-04-013",
      "UT-R-NUM-04-014",
      "UT-R-NUM-04-015",
      "UT-R-NUM-04-016",
      "UT-R-NUM-04-017",
      "UT-R-NUM-04-018",
      "UT-R-NUM-04-019",
      "UT-R-NUM-04-020",
      "UT-R-NUM-04-021",
      "UT-R-NUM-04-022",
      "UT-R-NUM-04-023",
      "UT-R-NUM-04-024",
      "UT-R-NUM-04-025",
      "UT-R-NUM-04-026",
      "UT-R-NUM-04-027",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },

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
  {
    ruleId: "R-ORD-04",
    testCaseIds: ["UT-ACTION-QUEUE-009", "UT-ACTION-QUEUE-010", "UT-R-ORD-04-001"],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },

  // ACT: 行動
  { ruleId: "R-ACT-01", testCaseIds: [], kinds: [] },
  { ruleId: "R-ACT-02", testCaseIds: [], kinds: [] },
  // R-ACT-03: Issue #34がAS/待機のEX増加（消費量と同量、超過切り捨て）と、
  // PSのPP消費+EX増加を実装した。AS・PS・EXのコスト下限自体は
  // UT-CAT-SKL-019/020/021・UT-INFRA-SCHEMA-011が別途検証する。
  {
    ruleId: "R-ACT-03",
    testCaseIds: [
      "UT-R-ACT-03-001",
      "UT-R-ACT-03-002",
      "UT-R-ACT-03-003",
      "UT-R-ACT-03-004",
      "UT-R-ACT-03-005",
      "UT-R-ACT-03-007",
      "UT-R-PS-05-001",
      "UT-R-PS-05-002",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-ACT-04: Issue #34が`ResourceChanged`をAP/PP/EXゲージ変更の主イベントとして
  // 追加し、`ActionStarted`/`ActionWaited`/`PassiveActivated`から状態差分を
  // 移した（重複記録なし）。消費→増加の順序、変化量0での発行省略を検証する。
  {
    ruleId: "R-ACT-04",
    testCaseIds: ["UT-R-ACT-04-001", "UT-R-ACT-04-002", "UT-R-PS-05-003"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },

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
  // Issue #170 (TGT-001): FARTHEST(R-TGT-02の全体反転)を実装する。
  {
    ruleId: "R-TGT-03",
    testCaseIds: ["UT-R-TGT-03-001", "UT-R-TGT-03-002", "UT-R-TGT-03-003"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // Issue #170 (TGT-001): ADJACENT_ORTHOGONAL area(同陣営・上下左右1マス、陣営境界は越えない)。
  {
    ruleId: "R-TGT-04",
    testCaseIds: ["UT-R-TGT-04-001", "UT-R-TGT-04-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // Issue #170 (TGT-001): DIRECTLY_AHEAD_OF_BASE area(基準対象が前列なら候補0件)。
  {
    ruleId: "R-TGT-05",
    testCaseIds: ["UT-R-TGT-05-001", "UT-R-TGT-05-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // Issue #170 (TGT-001): 前後列優先(FRONT_ROW/BACK_ROW)。左右列優先(R-TGT-06の列版)は
  // production Catalogに現時点で使用例がなく、TARGET_ORDER_KEYSにも列優先専用キーが
  // 存在しないため本Issueでは未実装（将来、実際に必要になった時点でキーを追加する）。
  {
    ruleId: "R-TGT-06",
    testCaseIds: ["UT-R-TGT-06-001", "UT-R-TGT-06-002", "UT-R-TGT-06-003"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-TGT-07",
    testCaseIds: ["UT-R-TGT-07-001", "UT-R-TGT-07-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  { ruleId: "R-TGT-08", testCaseIds: [], kinds: [] },
  // Issue #170 (TGT-001): kind評価(SELF/SELECT/BINDING_DERIVED)、戦闘不能除外、
  // area($BASE解決含む: SAME_ROW_AS_BASE/SAME_COLUMN_AS_BASE/BEHIND_BASE)、
  // orderの評価順を実装する。TRIGGER_SOURCE/TRIGGER_TARGETと、baseのTRIGGER_SOURCE/
  // TRIGGER_TARGET/LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETS参照はCAP_TRIGGER_CONTEXT
  // (RES-005)スコープのため引き続き例外を投げる。filters(非空)とfallbackはそれぞれ
  // TGT-002/TGT-003(CAP_TARGET_FILTER_ORDER/CAP_TARGET_BINDING_FALLBACK)スコープ。
  {
    ruleId: "R-TGT-09",
    testCaseIds: [
      "UT-R-TGT-09-001",
      "UT-R-TGT-09-002",
      "UT-R-TGT-09-003",
      "UT-R-TGT-09-004",
      "UT-R-TGT-09-005",
      "UT-R-TGT-09-006",
      "UT-R-TGT-09-007",
      "UT-R-TGT-09-008",
      "UT-R-TGT-09-009",
      "IT-CAP-TARGET-DERIVED-AREA-PROD-001",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  { ruleId: "R-TGT-10", testCaseIds: [], kinds: [] },

  // SKL: スキル
  // R-SKL-01: 使用者戦闘不能時の中断（`applyDamageAction`のヒット単位中断＋
  // PS発動処理自身の中断検知・`PassiveInterrupted`発行）をIssue #34
  // （`UT-R-SKL-01-001`〜003）が満たし、Issue #73でACTION step/EffectAction
  // 単位の中断（`EffectStepStarting`/`EffectActionStarting`後の再検証、
  // `UT-R-SKL-01-004`）を追加して6項目を満たし切った。Issue #217で
  // `resolveEffectSequencePlan`をpending execution state一本化に再設計し、
  // BRANCH/RANDOM_BRANCH/REPEAT各段のstep entry・EffectStepStarting直後・
  // RandomBranchSelected直後・iteration間での中断不変条件
  // （`UT-R-SKL-INT-001`〜006、中断イベント種別が未解決件数から独立している
  // こと、中断後は追加のEffectAction・乱数・PS/Memory連鎖を発生させないこと）
  // を追加した。
  {
    ruleId: "R-SKL-01",
    testCaseIds: [
      "UT-R-SKL-01-001",
      "UT-R-SKL-01-002",
      "UT-R-SKL-01-003",
      "UT-R-SKL-01-004",
      "UT-R-SKL-INT-001",
      "UT-R-SKL-INT-002",
      "UT-R-SKL-INT-003",
      "UT-R-SKL-INT-004",
      "UT-R-SKL-INT-005",
      "UT-R-SKL-INT-006",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-SKL-02: 対象ごとの効果適用直後にPS候補を直ちに解決する要件をIssue #34
  // （`applyDamageAction`のヒット単位フック、`UT-R-SKL-02-001`）で満たし、
  // Issue #73でEffectAction単位のイベント（`EffectActionStarting`/
  // `EffectActionCompleted`）後の即時連鎖（`UT-R-SKL-06-011`）を追加した。
  {
    ruleId: "R-SKL-02",
    testCaseIds: ["UT-R-SKL-02-001", "UT-R-SKL-06-011"],
    kinds: ["POSITIVE", "SCENARIO"],
  },
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
  // R-SKL-06: ACTION stepの条件評価（`evaluateEffectStepCondition`、
  // `UT-R-SKL-06-001`〜005）、対象・action定義順解決とtargetUnitIds集約
  // （`resolveEffectSequence`、`UT-R-SKL-06-006`/007）、step/action単位の
  // ドメインイベント発行（`applyEffectActionGroups`、`UT-R-SKL-06-008`〜011）
  // をIssue #73で実装した（TARGET_STATE等の条件kindはM7未実装のため対象外）。
  {
    ruleId: "R-SKL-06",
    testCaseIds: [
      "UT-R-SKL-06-001",
      "UT-R-SKL-06-002",
      "UT-R-SKL-06-003",
      "UT-R-SKL-06-004",
      "UT-R-SKL-06-005",
      "UT-R-SKL-06-006",
      "UT-R-SKL-06-007",
      "UT-R-SKL-06-008",
      "UT-R-SKL-06-009",
      "UT-R-SKL-06-010",
      "UT-R-SKL-06-011",
      "UT-R-SKL-06-012",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  // R-SKL-07: BRANCH/RANDOM_BRANCH/REPEATをIssue #217で実装した
  // （`resolveBranchStep`/`resolveRandomBranchStep`/`resolveRepeatStep`、
  // `effect-action-group-resolver.ts`）。`DeferredStepPlan`（`skill-resolution-service.ts`）
  // がこれらのstepを生の定義のまま持ち越し、実行時にJITで解決する。
  {
    ruleId: "R-SKL-07",
    testCaseIds: [
      "UT-R-SKL-07-001",
      "UT-R-SKL-07-002",
      "UT-R-SKL-07-101",
      "UT-R-SKL-07-102",
      "UT-R-SKL-07-103",
      "UT-R-SKL-07-104",
      "UT-R-SKL-07-105",
      "UT-R-SKL-07-106",
      "UT-R-SKL-07-107",
      "UT-R-SKL-07-108",
      "UT-R-SKL-07-109",
      "UT-R-SKL-07-110",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  // R-SKL-08: 直前結果（`LAST_RESULT` Condition、`LAST_ACTION_TARGETS`/
  // `LAST_DAMAGED_TARGETS` TargetReference）をIssue #217で実装した
  // （`effect-step-condition-evaluator.ts`のfield比較、
  // `effect-action-group-resolver.ts`の`LastResultState`）。Catalog preflight
  // の`MISSING_PRECEDING_RESULT`定義済み解析（`catalog-integrity.ts`）が、
  // 到達しうる全経路で先行結果を保証できないCatalogを拒否する
  // （`UT-CAT-IDX-042`〜055）。
  {
    ruleId: "R-SKL-08",
    testCaseIds: [
      "UT-R-SKL-08-001",
      "UT-R-SKL-08-002",
      "UT-R-SKL-08-003",
      "UT-R-SKL-08-004",
      "UT-R-SKL-08-005",
      "UT-R-SKL-08-006",
      "UT-R-SKL-08-007",
      "UT-R-SKL-08-008",
      "UT-R-SKL-08-009",
      "UT-R-SKL-08-010",
      "UT-R-SKL-08-011",
      "UT-R-SKL-08-012",
      "UT-CAT-IDX-042",
      "UT-CAT-IDX-043",
      "UT-CAT-IDX-044",
      "UT-CAT-IDX-045",
      "UT-CAT-IDX-046",
      "UT-CAT-IDX-047",
      "UT-CAT-IDX-048",
      "UT-CAT-IDX-049",
      "UT-CAT-IDX-050",
      "UT-CAT-IDX-051",
      "UT-CAT-IDX-052",
      "UT-CAT-IDX-053",
      "UT-CAT-IDX-054",
      "UT-CAT-IDX-055",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
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
      "UT-R-SKL-09-005",
      "UT-R-SKL-09-006",
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
      "UT-R-PS-01-031",
      "UT-R-PS-01-032",
      "UT-R-PS-01-033",
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
      "UT-R-PS-04-009",
      "UT-R-PS-04-010",
      "UT-R-PS-04-011",
      "UT-R-PS-04-012",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  // R-PS-05「発動と再入防止」6ステップのうち#1（発動済み集合への記録）は#21が
  // `resolvePassiveChain`内の`recordActivation`呼び出しで実装済み。Issue #34が
  // 残り5ステップ（PP消費とEX増加、クールタイム設定、`PassiveActivated`発行、
  // EffectSequence解決、`PassiveResolved`/`PassiveInterrupted`発行）を
  // `PassiveActivationRuntime`（`domain/battle/lifecycle/passive-activation-service.ts`）
  // として実装した。
  {
    ruleId: "R-PS-05",
    testCaseIds: ["UT-R-PS-05-001", "UT-R-PS-05-002", "UT-R-PS-05-003"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-PS-06「新規候補の即時処理」: `resolvePassiveChain`（#21）は`activate`が
  // `EVENT`を`yield`するたびに、その候補連鎖を完全に解決してから元のジェネレータを
  // 再開する。これにより「親の効果A→子PS→親の効果B」の順序（UT-R-PS-06-008）を、
  // PSがEffectSequence全体を終えてからしか新規候補を報告できない設計では表現
  // できなかった粒度で満たす。UT-R-PS-06-009は実際の`EventRecorder`を使い、
  // ネストした発動が正しい`rootEventId`/`parentEventId`/`sequence`で記録される
  // ことを検証する統合テスト（`TriggerCandidateEvent`自体は照合専用でこれらの
  // フィールドを持たないため、本関数の責務は「直近の原因イベントを正しく
  // 次階層へ渡すこと」までであり、実際の採番は#73が配線する`EventRecorder`が
  // 担う）。
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
      "UT-R-PS-06-009",
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
  {
    ruleId: "R-ACTN-01",
    testCaseIds: [
      // #1 Capability preflight: EffectAction単位のrequiredCapabilitiesがpreflightで拒否対象になることを検証する。
      "UT-PREFLIGHT-008",
      // #2 対象戦闘不能skip(明示指定なし): 全kindが対象戦闘不能を理由に適用をスキップする。
      "UT-R-ACTN-01-001",
      "UT-R-ACTN-01-002",
      "UT-R-ACTN-01-003",
      "UT-R-ACTN-01-004",
      // #2 対象戦闘不能でも生存対象には通常どおり適用される(誤検出がないことの境界)。
      "UT-R-ACTN-01-005",
      // #2 明示指定(TargetSelectorDefinition.includeDefeated: true)がある場合は戦闘不能対象にも適用される。
      // DAMAGEもapplyDamageAction内部のヒット単位チェックで同じ明示指定を尊重する(PR #215再レビュー[P2])。
      "UT-R-ACTN-01-006",
      "UT-R-ACTN-01-008",
      "UT-R-ACTN-01-010",
      "UT-DAMAGE-APPLICATION-015",
      // #2/#5 明示指定下でも、既に戦闘不能だった対象への継続ヒットはUnitDefeatedを再発行しない
      // (08_ドメインイベント.md「HPが0になった直後」、PR #215再々レビュー[P2])。
      "UT-DAMAGE-APPLICATION-016",
      // #3 Formula評価: payloadのFormulaDefinitionが実際に評価される。
      "UT-R-NUM-04-027",
      // #4/#5 種別に応じた状態変更とイベント発行を、実パイプライン(applyEffectActionGroups)経由でkindごとに検証する。
      "UT-R-SKL-06-008", // DAMAGE -> HP
      "UT-R-ACTN-01-009", // COOLDOWN_MANIPULATION -> cooldowns
      "UT-R-EFF-01-021", // APPLY_STAT_MOD -> AppliedEffect
      "UT-R-ACTN-01-007", // REMOVE_MARKER -> MarkerState
      // (APPLY_MARKER -> MarkerStateはUT-R-ACTN-01-005が兼ねる)
      // #6 PS/Memory triggeredEffectsを次のEffectActionへ進む前に解決する。
      "UT-R-SKL-06-011",
      "UT-R-EFF-01-022",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
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
  {
    ruleId: "R-EFF-01",
    testCaseIds: [
      "UT-R-EFF-01-001",
      "UT-R-EFF-01-002",
      "UT-R-EFF-01-003",
      "UT-R-EFF-01-004",
      "UT-R-EFF-01-005",
      "UT-R-EFF-01-006",
      "UT-R-EFF-01-007",
      "UT-R-EFF-01-008",
      "UT-R-EFF-01-009",
      "UT-R-EFF-01-010",
      "UT-R-EFF-01-011",
      "UT-R-EFF-01-012",
      "UT-R-EFF-01-013",
      "UT-R-EFF-01-014",
      "UT-R-EFF-01-015",
      "UT-R-EFF-01-016",
      "UT-R-EFF-01-017",
      "UT-R-EFF-01-018",
      "UT-R-EFF-01-019",
      "UT-R-EFF-01-020",
      "UT-R-EFF-01-021",
      "UT-R-EFF-01-022",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  { ruleId: "R-EFF-02", testCaseIds: [], kinds: [] },
  { ruleId: "R-EFF-03", testCaseIds: [], kinds: [] },
  // R-EFF-04: EFF-003（Issue #159）。行動単位期間の減算・失効
  // （`applied-effect-duration.ts`のowner解決、`duration-expiry-service.ts`の
  // cascade・CombatStat再計算、`action-completion.ts`への実ライフサイクル
  // 配線）。`IT-CAP-COMPLEX-EXPIRATION-PROD-001`がEFFECT_TARGET/EFFECT_SOURCE/
  // BATTLEの3種類のownerを実production Catalogデータで検証する。
  {
    ruleId: "R-EFF-04",
    testCaseIds: [
      "UT-R-EFF-04-001",
      "UT-R-EFF-04-002",
      "UT-R-EFF-04-003",
      "UT-R-EFF-04-004",
      "UT-R-EFF-04-005",
      "UT-R-EFF-04-006",
      "UT-R-EFF-04-007",
      "UT-R-EFF-04-008",
      "UT-R-EFF-04-009",
      "UT-R-EFF-04-010",
      "UT-R-EFF-04-011",
      "UT-R-EFF-04-012",
      "UT-R-EFF-04-013",
      "UT-R-EFF-04-014",
      "UT-R-EFF-04-015",
      "UT-R-EFF-04-016",
      "UT-R-EFF-04-017",
      "IT-CAP-COMPLEX-EXPIRATION-PROD-001",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-05: PR #208レビュー[P2]。`effective-effect-selector.ts`の選択規則
  // 自体（次点繰上げ含む）はUT-R-EFF-05-001〜013で単体検証済みだが、Catalog
  // Schemaの`APPLY_STAT_MOD.stacking.mode`が現状"STACKABLE"しか許可せず、
  // `effect-action-group-resolver.ts`も`duplicate: true`固定で付与するため、
  // 実ライフサイクル（`resolveActionPhase`等）からduplicate:falseの重複なし
  // 経路・最強選択・次点繰上げ・`EffectiveEffectChanged`のいずれにも到達
  // できない。NON_STACKABLEのCatalog表現・Mapper・実ライフサイクルの
  // シナリオテストが揃うまで未完了のまま残す。
  { ruleId: "R-EFF-05", testCaseIds: [], kinds: [] },
  // R-EFF-06: EFF-003。ターン単位期間の減算・失効（`battle.ts`のTURN_ENDING
  // 配線）。`IT-CAP-COMPLEX-EXPIRATION-PROD-002`が実production Catalogの
  // TURN単位`duration`で検証する。
  {
    ruleId: "R-EFF-06",
    testCaseIds: [
      "UT-R-EFF-06-001",
      "UT-R-EFF-06-002",
      "UT-R-EFF-06-003",
      "UT-R-EFF-06-004",
      "UT-R-EFF-06-005",
      "UT-R-EFF-06-006",
      "UT-R-EFF-06-007",
      "IT-CAP-COMPLEX-EXPIRATION-PROD-002",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-07: EFF-003。消費条件（NEXT_OUTGOING_ATTACK/NEXT_INCOMING_ATTACK/
  // OUTGOING_HIT/INCOMING_HIT、`damage-application-service.ts`への実
  // ライフサイクル配線）。`STATUS_BLOCKED`は状態付与無効化の仕組み自体が
  // 未実装（M7-001）のため到達不能のまま残す。`IT-CAP-COMPLEX-EXPIRATION-
  // PROD-003`が実production CatalogのNEXT_OUTGOING_ATTACK消費で検証する。
  {
    ruleId: "R-EFF-07",
    testCaseIds: [
      "UT-R-EFF-07-001",
      "UT-R-EFF-07-002",
      "UT-R-EFF-07-003",
      "UT-R-EFF-07-004",
      "UT-R-EFF-07-005",
      "UT-R-EFF-07-006",
      "UT-R-EFF-07-007",
      "UT-R-EFF-07-008",
      "UT-R-EFF-07-009",
      "IT-CAP-COMPLEX-EXPIRATION-PROD-003",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-08: EFF-003。`expiration.conditions`評価（`effect-expiration-
  // condition-service.ts`、`action-completion.ts`への実ライフサイクル配線）。
  // production Catalogに`expiration.conditions`を非空で定義する行が現状
  // 存在しないため、`IT-`（production Catalog）レベルの検証対象は無い —
  // R-EFF-01と同様、実ライフサイクル関数（`recordActionCompletion`）への
  // 到達自体はUT-R-EFF-08-006が検証する。
  {
    ruleId: "R-EFF-08",
    testCaseIds: [
      "UT-R-EFF-08-001",
      "UT-R-EFF-08-002",
      "UT-R-EFF-08-003",
      "UT-R-EFF-08-004",
      "UT-R-EFF-08-005",
      "UT-R-EFF-08-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  // R-EFF-09: EFF-003。linkedEffectGroupの親子連動カスケード
  // （`applied-effect-linked-group.ts`、`duration-expiry-service.ts`の
  // 子優先順序）。`IT-CAP-COMPLEX-EXPIRATION-PROD-004`がUNIT_HARRIET_SAGEの
  // 実`linkedEffectGroupId`（`HARRIET_CURSE_LINK`）で検証する。
  {
    ruleId: "R-EFF-09",
    testCaseIds: [
      "UT-R-EFF-09-001",
      "UT-R-EFF-09-002",
      "UT-R-EFF-09-003",
      "UT-R-EFF-09-004",
      "UT-R-EFF-09-005",
      "UT-R-EFF-09-006",
      "IT-CAP-COMPLEX-EXPIRATION-PROD-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  // R-EFF-10: EFF-004（Issue #160）。ADD/KEEP_EXISTING/REFRESH/REPLACEの4方針、
  // stack.max clamp・0未満禁止（`marker-apply-service.ts`）、明示的
  // `REMOVE_MARKER`とlinkedEffectGroupカスケード（`MarkerState`同士、
  // `marker-removal-service.ts`/`marker-linked-group.ts`）、ACTION/TURN単位
  // Duration失効（`marker-duration.ts`、`action-completion.ts`/`battle.ts`への
  // 実ライフサイクル配線）を実装した。`MARKER_COUNT_SCALE`Formula評価
  // （`CAP_MARKER_STACK_FORMULA`）はcontext付きFormulaEvaluatorを要するため
  // RES-001（Issue #175）のスコープ、`TARGET_HAS_MARKER`Condition評価は
  // RES-004（Issue #171）、`HAS_MARKER`TargetSelector評価はTGT-002
  // （Issue #169）のスコープとして残す。`AppliedEffect`をまたぐlinkedEffectGroup
  // カスケード（cross-type）は未実装であり、`catalog-integrity.ts`が同じ
  // `linkedEffectGroupId`を`APPLY_MARKER`と非Marker種別の両方が使う組合せを
  // Catalogロード時点で明示的に拒否する（`UNSUPPORTED_MARKER_LINKED_GROUP`、
  // PR #210再レビュー[P2]）。Marker同士のグループは実装済みのため拒否しない。
  // 同様に、schema上は許容されるが未実装のMarker Duration機構（`consumption`、
  // `expiration`、`HIT`/`SKILL_USE`単位の`timeLimit`）も同じCatalog integrity
  // パスで`UNSUPPORTED_MARKER_DURATION`として拒否する（PR #210再レビュー[P2]）。
  // API応答（`BattleUnitStateResponse.markers`/`UnitStateDeltaResponse.markers`、
  // `markers`はv1後方互換のため任意プロパティとして追加）と、独立Reducer復元の
  // 一致判定（`simulation-result-assembler.ts`の`unitSnapshotsEqual`）へも
  // Markerを反映した（PR #210レビュー[P1]/[P2]、再レビュー[P2]）。
  {
    ruleId: "R-EFF-10",
    testCaseIds: [
      "UT-R-EFF-10-001",
      "UT-R-EFF-10-002",
      "UT-R-EFF-10-003",
      "UT-R-EFF-10-004",
      "UT-R-EFF-10-005",
      "UT-R-EFF-10-006",
      "UT-R-EFF-10-007",
      "UT-R-EFF-10-008",
      "UT-R-EFF-10-009",
      "UT-R-EFF-10-010",
      "UT-R-EFF-10-011",
      "UT-R-EFF-10-012",
      "UT-R-EFF-10-013",
      "UT-R-EFF-10-014",
      "UT-R-EFF-10-015",
      "UT-R-EFF-10-016",
      "UT-R-EFF-10-017",
      "UT-R-EFF-10-018",
      "IT-MARKER-PROD-001",
      "IT-MARKER-PROD-002",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // `13_実装計画.md`のM7完了条件「R-EFF-11がAppliedEffect／EffectSequenceスコープを
  // 含めて台帳上で完了する」を満たす。`SkillRuntime`スコープ（M6最小実装、
  // Issue #143）・`AppliedEffect`スコープ（EFF-005、Issue #162）・`EffectSequence`
  // スコープ（EFF-006、Issue #212）の3スコープすべてを実装・検証済み。
  // `Battle`／`BattleUnit`スコープは利用するproduction定義が存在しないため
  // Feature Complete必須対象に含めず、Catalogロード時点で明示的に拒否する
  // （`UT-CAT-RCU-011`）。`SkillRuntime`スコープは production Catalog上の
  // 発動回数・累計ダメージ閾値counterで検証済み（`IT-CAP-SKILL-RUNTIME-003/004`）。
  // `AppliedEffect`／`EffectSequence`スコープは利用するproduction定義が現状
  // 存在しないため、明示的Scenarioで検証した
  // （`passive-activation-service.test.ts`のRuntimeCounter APPLIED_EFFECT/
  // EFFECT_SEQUENCEスコープdescribe）。
  {
    ruleId: "R-EFF-11",
    testCaseIds: [
      "UT-RCOUNTER-M-001",
      "UT-RCOUNTER-M-002",
      "UT-RCOUNTER-M-003",
      "UT-RCOUNTER-M-004",
      "UT-RCOUNTER-M-005",
      "UT-RCOUNTER-M-006",
      "UT-RCOUNTER-M-007",
      "UT-RCOUNTER-M-008",
      "UT-RCOUNTER-M-009",
      "UT-RCOUNTER-M-010",
      "UT-RCOUNTER-M-011",
      "UT-RCOUNTER-M-012",
      "UT-RCOUNTER-M-013",
      "UT-RCOUNTER-M-014",
      "UT-CAT-RCU-001",
      "UT-CAT-RCU-002",
      "UT-CAT-RCU-003",
      "UT-CAT-RCU-004",
      "UT-CAT-RCU-005",
      "UT-CAT-RCU-006",
      "UT-CAT-RCU-007",
      "UT-CAT-RCU-008",
      "UT-CAT-RCU-009",
      "UT-CAT-RCU-010",
      "UT-CAT-RCU-011",
      "UT-CAT-RCU-012",
      "UT-CAT-RCU-013",
      "UT-CAT-RCU-014",
      "UT-CAT-RCU-015",
      "UT-CAT-RCU-016",
      "UT-CAT-IDX-034",
      "UT-CAT-IDX-036",
      "UT-CAT-IDX-037",
      "UT-CAT-IDX-038",
      "UT-CAT-IDX-039",
      "UT-CAT-IDX-040",
      "UT-CAT-IDX-041",
      "UT-STATE-REDUCER-021",
      "UT-STATE-REDUCER-022",
      "UT-STATE-REDUCER-023",
      "UT-STATE-REDUCER-024",
      "UT-STATE-REDUCER-025",
      "UT-STATE-REDUCER-026",
      "UT-STATE-REDUCER-027",
      "UT-STATE-REDUCER-028",
      "UT-STATE-REDUCER-029",
      "UT-STATE-REDUCER-030",
      "UT-STATE-REDUCER-031",
      "UT-CAT-DUR-015",
      "UT-CAT-DUR-016",
      "UT-CAT-DUR-017",
      "UT-CAT-DUR-018",
      "UT-CAT-DUR-019",
      "UT-CAT-DUR-020",
      "UT-CAT-SEQ-027",
      "UT-CAT-SEQ-028",
      "UT-CAT-SEQ-029",
      "UT-CAT-SEQ-030",
      "UT-RCOUNTER-EFF-001",
      "UT-RCOUNTER-EFF-002",
      "UT-RCOUNTER-EFF-003",
      "UT-RCOUNTER-EFF-004",
      "UT-RCOUNTER-EFF-005",
      "UT-RCOUNTER-EFF-006",
      "UT-RCOUNTER-EFF-007",
      "UT-RCOUNTER-EFF-008",
      "UT-RCOUNTER-EFF-009",
      "UT-RCOUNTER-EFF-010",
      "UT-RCOUNTER-SEQ-001",
      "UT-RCOUNTER-SEQ-002",
      "UT-RCOUNTER-SEQ-003",
      "UT-RCOUNTER-SEQ-004",
      "UT-RCOUNTER-SEQ-005",
      "UT-RCOUNTER-SEQ-006",
      "UT-RCOUNTER-SEQ-007",
      "UT-RCOUNTER-SEQ-008",
      "UT-RCOUNTER-SEQ-009",
      "UT-R-EFF-11-001",
      "UT-R-EFF-11-002",
      "UT-R-EFF-11-003",
      "UT-R-EFF-11-004",
      "UT-R-EFF-11-005",
      "UT-R-EFF-11-006",
      "UT-R-EFF-11-007",
      "UT-R-EFF-11-008",
      "UT-R-EFF-11-009",
      "UT-R-EFF-11-010",
      "UT-R-EFF-11-011",
      "UT-R-EFF-11-012",
      "UT-R-EFF-11-013",
      "UT-R-EFF-11-014",
      "UT-R-EFF-11-015",
      "UT-R-EFF-11-016",
      "UT-R-EFF-11-017",
      "UT-R-EFF-11-018",
      "UT-R-EFF-11-019",
      "UT-R-EFF-11-020",
      "UT-R-EFF-11-021",
      "UT-R-EFF-11-022",
      "UT-R-EFF-11-023",
      "UT-R-EFF-11-024",
      "UT-R-EFF-11-025",
      "IT-CAP-SKILL-RUNTIME-003",
      "IT-CAP-SKILL-RUNTIME-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

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
