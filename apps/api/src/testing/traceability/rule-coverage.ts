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
      "PROP-NUM-02-001",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "PROPERTY"],
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
      "UT-R-NUM-03-007",
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
      "UT-R-NUM-04-028",
      "UT-R-NUM-04-029",
      "UT-R-NUM-04-030",
      "UT-R-NUM-04-031",
      // M7-015（Issue #269、`CAP_MARKER_STACK_FORMULA`）: R-NUM-04の
      // 「`MARKER_COUNT_SCALE`は評価時点の`MarkerState.stackCount`を参照する」
      // だけが実ライフサイクル検証を持たないまま残っていた（EFF-004／Issue #160は
      // Marker本体だけを実装してcloseし、M7-010／Issue #177の監査が所有者不在を
      // 検出した）。`UT-R-NUM-04-032`/`033`はこのFormulaを使う定義に
      // `CAP_MARKER_STACK_FORMULA`宣言を必須とするCatalog検証、
      // ユニット効果軸の3件（REF-043／Issue #390 で移送）が実`catalog/`の
      // `APPLY_STAT_MOD.formula`（`target: SKILL_SOURCE`）と
      // `DAMAGE.damageModifiers`（`target: TARGET`）の両経路の実測である。
      // 所持数0・比例・`max`頭打ち・別markerId非寄与は各ユニットの`-001`
      // 振る舞い表が行として持ち、`-004`以降は評価結果の届き先
      // （CombatStat再計算・`DamageCalculated`の集計欄・独立Reducer復元）を持つ。
      "UT-R-NUM-04-032",
      "IT-UNIT-CHIYURU-NEWYEAR-005",
      "IT-UNIT-KARINA-DOWNER-007",
      "IT-UNIT-FEE-BATH-004",
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
      "PROP-POS-03-001",
      "PROP-POS-03-002",
      "PROP-POS-03-003",
      "PROP-POS-03-004",
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
  // Issue #460: R-STA-01はステータスを2分類する。割合補正ステータス（HP・攻撃力・
  // 防御力・行動速度）は乗算、パーセントポイント加算ステータス（会心率・会心ダメージ
  // ボーナス・属性相性ボーナス）は加減算で合成する。`020`〜`024`が式の分岐そのもの、
  // `025`〜`026`が編成補正（R-BON-03のクレバー会心率+15pp）、`030`〜`034`が戦闘中
  // バフ・デバフ、`027`〜`029`がCatalog投入時の`valueType: RATIO`拒否を固定する。
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
      "UT-R-STA-01-018",
      "UT-R-STA-01-019",
      "UT-R-STA-01-020",
      "UT-R-STA-01-021",
      "UT-R-STA-01-022",
      "UT-R-STA-01-023",
      "UT-R-STA-01-024",
      "UT-R-STA-01-025",
      "UT-R-STA-01-026",
      "UT-R-STA-01-027",
      "UT-R-STA-01-028",
      "UT-R-STA-01-029",
      "UT-R-STA-01-030",
      "UT-R-STA-01-031",
      "UT-R-STA-01-032",
      "UT-R-STA-01-033",
      "UT-R-STA-01-034",
      "UT-R-STA-01-035",
      "UT-STAT-PREVIEW-025",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-STA-02",
    testCaseIds: ["UT-R-STA-02-001", "UT-R-STA-02-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-STA-03の同種グループ鍵（`EffectKindKey`）はIssue #519でCatalog宣言由来に
  // なった。`selectNonStackableWinners`/`combineEffects`は鍵に対して不可知のまま
  // （UT-R-STA-03-001〜005が選択規則そのものを検証する）で、変わったのは鍵の
  // 導出（`effectKindKeyOf`）と、それを付与時に焼き込む経路である。
  // - 導出規則（宣言優先・省略時は定義ID）: UT-R-STA-03-006〜008
  // - 付与インスタンスと`EffectApplied`が運ぶ鍵: UT-R-STA-03-009
  // - 鍵を共有する2定義がCombatStat合成で1件へ絞られること／宣言が無ければ
  //   従来どおり別グループのままであること: UT-R-STA-03-010/011
  // - Catalog authoring側（`kindKey`のパースと同種グループの一貫性検証）:
  //   UT-CAT-ACT-115〜117・UT-CAT-IDX-108/111/112/113
  {
    ruleId: "R-STA-03",
    testCaseIds: [
      "UT-R-STA-03-001",
      "UT-R-STA-03-002",
      "UT-R-STA-03-003",
      "UT-R-STA-03-004",
      "UT-R-STA-03-005",
      "UT-R-STA-03-006",
      "UT-R-STA-03-007",
      "UT-R-STA-03-008",
      "UT-R-STA-03-009",
      "UT-R-STA-03-010",
      "UT-R-STA-03-011",
      "UT-CAT-ACT-115",
      "UT-CAT-ACT-116",
      "UT-CAT-ACT-117",
      "UT-CAT-IDX-108",
      "UT-CAT-IDX-111",
      "UT-CAT-IDX-112",
      "UT-CAT-IDX-113",
      // Issue #520: `Q-CAT-EFF-16`（raw原文が「重複可」を付けないバフは重複なし）を
      // 実 production Catalog へ適用した結果。`APPLY_STAT_MOD` は `NON_STACKABLE`
      // で表し、同種選択（この規則）が積み増しを止める。エレーナEXの2定義だけは
      // 共有`kindKey`で1グループへ括る（`Q-CAT-EFF-23`）。
      "IT-UNIT-ELENA-MOODMAKER-011",
      "IT-UNIT-ELENA-MOODMAKER-012",
      "IT-UNIT-ELENA-MOODMAKER-014",
      "IT-UNIT-AOI-ELEGANT-008",
      "IT-UNIT-AOI-ELEGANT-009",
      "IT-UNIT-AOI-ELEGANT-010",
      "IT-UNIT-CLARA-TSUNDERE-005",
      "IT-UNIT-CLARA-TSUNDERE-006",
      "IT-UNIT-FEE-ACTOR-007",
      "IT-UNIT-FEE-ACTOR-008",
      "IT-UNIT-KARINA-DOWNER-009",
      "IT-UNIT-LAURA-MOUNTAIN-005",
      "IT-UNIT-RAVEL-MODEL-004",
      "IT-UNIT-SIENA-DIVA-008",
      "IT-UNIT-SIENA-DIVA-009",
      // 同種の鍵は付与元`BattleUnitId`を含まないため、R-FRM-03で同じ
      // `UnitDefinitionId`を2枠編成しても1グループのままである。重複してよいかを
      // 決めるのは付与元の数ではなく原文の記載であることを、記載の無いAS2と
      // 「重複可」付きのPS1が同じ盤面で分かれることで固定する。
      "IT-UNIT-CLARA-TSUNDERE-007",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "PROPERTY", "BOUNDARY", "SCENARIO"],
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
  {
    ruleId: "R-ORD-01",
    testCaseIds: [
      "UT-ACTION-QUEUE-007",
      "UT-R-ORD-01-001",
      "UT-R-ORD-01-002",
      "UT-R-ORD-01-003",
      "UT-R-ORD-01-004",
      "UT-R-ORD-01-005",
      "UT-R-ORD-01-006",
      "UT-R-ORD-01-007",
      "UT-R-ORD-01-009",
      // Issue #517: EXゲージ満タン側で適格性を保ったままAPだけ0にされたAS予約は
      // 除去されない。この「AP 0のまま行動機会が回ってくる」唯一の抜け穴を固定する。
      "UT-ACTION-PHASE-019",
      "SCN-BTL-023",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
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
      "PROP-ORD-02-001",
      "PROP-ORD-02-002",
      "PROP-ORD-02-003",
      "PROP-ORD-02-004",
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
    testCaseIds: [
      "UT-ACTION-QUEUE-009",
      "UT-ACTION-QUEUE-010",
      "UT-R-ORD-04-001",
      "UT-R-ORD-04-002",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },

  // ACT: 行動
  {
    ruleId: "R-ACT-01",
    testCaseIds: [
      "UT-ACTION-PHASE-005",
      "UT-R-ACT-01-001",
      "UT-R-ACT-01-002",
      "UT-R-ACT-01-003",
      "UT-R-ACT-01-004",
      "UT-R-ACT-01-004B",
      "UT-R-ACT-01-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-ACT-02",
    testCaseIds: [
      "UT-R-ACT-02-001",
      "UT-R-ACT-02-002",
      "UT-R-ACT-02-003",
      "UT-R-ACT-02-004",
      "UT-R-ACT-02-005",
      "UT-R-ACT-02-006",
      "UT-R-ACT-02-007",
      "UT-R-ACT-02-008",
      "UT-R-ACT-02-009",
      "UT-R-ACT-02-010",
      "UT-R-ACT-02-011",
      "UT-R-ACT-02-012",
      "UT-R-ACT-02-013",
      "UT-R-ACT-02-014",
      "UT-R-ACT-02-015",
      "IT-UNIT-ELENA-MOODMAKER-009",
      "IT-UNIT-LYDIA-GENIUS-004",
      "IT-UNIT-LILY-HERO-004",
      "IT-UNIT-MAO-COMMITTEE-006",
      "IT-UNIT-TATIANA-SAGE-007",
      "SCN-BTL-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
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
      // Issue #517: 待機の消費リソースが待機の理由ではなくAP残量で決まること
      // （気絶・凍結・EX使用不可・使用可能なASなしの4経路が、AP1以上ならAP1・
      // AP 0ならEXゲージ全量という同じ二択の両側で一致すること）。
      "UT-R-ACT-03-008",
      "UT-ACTION-PHASE-019",
      "UT-ACTION-PHASE-020",
      "UT-R-PS-05-001",
      "UT-R-PS-05-002",
      "PROP-ACT-03-001",
      "PROP-ACT-03-002",
      "PROP-ACT-03-003",
      // REL-004（Issue #203）: EX上限超過の破棄は`ExtraGaugeOverflowDiscarded`
      // （DIAGNOSTICカテゴリ）で観測する。Issue #465で`DETAILED`が全イベントを
      // 返すようになったため、この破棄イベントが`DETAILED`のレスポンスへ実際に
      // 現れることを実`catalog/`・実HTTP経路で固定する。
      "IT-REL-004-LOG-LEVEL-002",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "PROPERTY"],
  },
  // R-ACT-04: Issue #34が`ResourceChanged`をAP/PP/EXゲージ変更の主イベントとして
  // 追加し、`ActionStarted`/`ActionWaited`/`PassiveActivated`から状態差分を
  // 移した（重複記録なし）。消費→増加の順序、変化量0での発行省略を検証する。
  {
    ruleId: "R-ACT-04",
    testCaseIds: [
      "UT-R-ACT-04-001",
      "UT-R-ACT-04-002",
      "UT-R-ACT-04-015",
      "UT-R-PS-05-003",
      // リソース獲得量Modifier（`APPLY_RESOURCE_GAIN_MOD`、M7-002/Issue #185）。
      // 合成順・丸め・上限適用順はM7-002へ委譲されたまま台帳未登録だったため、
      // REF-022（Issue #351）で本則へ還流し既存テストを登録した:
      // 付与時のrateDelta評価・resource一致の全インスタンス合算・負率・
      // -100%下限の0クランプ・full stackでのEXゲージ増加倍化。
      "UT-R-ACT-04-006",
      "UT-R-ACT-04-007",
      "UT-R-ACT-04-011",
      "UT-R-ACT-04-012",
      "UT-R-ACT-04-013",
      "UT-R-ACT-04-014",
      // REF-045（Issue #392）でユニット効果軸へ移送した。実 production の獲得量
      // 補正が保持者の以後の行動でのEXゲージ獲得量だけを増減させ、基礎量
      // （消費APと同量）は動かないこと。-100%を下回る重複では0で打ち止まる。
      "IT-UNIT-MAIA-SALON-004",
      "IT-UNIT-KARINA-DOWNER-008",
      "IT-UNIT-SENKA-SCHEMER-006",
    ],
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
  // Issue #170 (TGT-001)でFRONT_ROW/BACK_ROW（前後列優先）を実装した
  // （target-selection-policy.test.tsのUT-R-TGT-06-001〜003で回帰検証）。
  // R-TGT-06は左右列指定時の「指定列からの列距離順」まで含む単一ルールであり
  // （`07_戦闘ルール詳細.md`）、完了定義（Rule全体の受け入れ条件と
  // production経路が揃った時点）に照らすと前後列優先だけでは完了計上できない。
  // TGT-002（CAP_TARGET_FILTER_ORDER、Issue #169）でfilters・残りのorderキー
  // （NEAREST/LEFT_TO_RIGHT/統計値の極値/MARKER_COUNT/UNIT_TYPE_PRIORITY/
  // SELF_LOWEST_PRIORITY）を実装したが、左右列指定時の「指定列からの列距離順」
  // （右列優先: 右→中央→左、左列優先: 左→中央→右）専用のTargetOrderKeyは
  // production Catalogに使用例が無く対象外のまま残した（必要になった時点で
  // キーを追加する、TGT-001以来の既定方針）。TGT-002はこのIssueで完了するため、
  // 残る左右列優先は次にproduction使用例が現れた時点の担当Issueへ引き継ぐ。
  // M7-010（Issue #177、監査）: その「担当Issue」は実際には作られておらず、
  // TGT-002（Issue #169）もclose済みで所有者不在だったため、production需要待ちの
  // 残作業を追跡するM7-019（Issue #273）へ明示的に割り当てた。
  { ruleId: "R-TGT-06", testCaseIds: [], kinds: [] },
  {
    ruleId: "R-TGT-07",
    testCaseIds: ["UT-R-TGT-07-001", "UT-R-TGT-07-002"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // TGT-004（Issue #167）: R-TGT-08「ステルス」。フェーズ1（AppliedEffect基盤）・
  // フェーズ2（対象選択リダイレクト・消費本体、
  // target-selection-policy.tsの`applyStealthRedirect`・
  // `EffectSequencePlan.stealthConsumptions`/`resolveEffectSequencePlan`の
  // `expireEffects`配線）に続き、フェーズ3でproduction Catalogの
  // `ACT_MAO_COMMITTEE_PS2_STEALTH`（近似なし、`APPLY_STATUS`/`STEALTH`/
  // `SKILL_USE`期間/`linkedEffectGroupId`）を実際に付与する`APPLY_STATUS`
  // resolver（`effect-action-group-resolver.ts`）・`statusKind`のDomain
  // Event/StateDelta/独立Reducer配線・`SKILL_USE`期間減算の実配線
  // （`action-skill-use-resolver.ts`）を完成させ、実カタログ定義を単体実行する
  // 統合テスト（ユニット効果軸の `IT-UNIT-MAO-COMMITTEE-004`/`005`）で
  // 対象選択・消費・独立Reducer復元まで確認したため、Rule完了として扱う。`SKL_MAO_COMMITTEE_PS2`自身が同じstepで解決する
  // CLEANSE（`REMOVE_EFFECTS`、M7-001）・HEAL（`APPLY_CONTINUOUS_HEAL`、
  // M7-005）・DMG_DOWN（`APPLY_DAMAGE_MOD`、DMG-002）は当時未実装のkindだった
  // ため、スキル全体のend-to-end実行はスコープ外
  // のまま（R-TGT-08自体の完了とは独立）。
  {
    ruleId: "R-TGT-08",
    testCaseIds: [
      "UT-R-TGT-08-001",
      "UT-R-TGT-08-002",
      "UT-R-TGT-08-003",
      "UT-R-TGT-08-004",
      "UT-R-TGT-08-005",
      "UT-R-TGT-08-006",
      "UT-R-TGT-08-007",
      "UT-R-TGT-08-008",
      "UT-R-TGT-08-009",
      "UT-R-TGT-08-010",
      "UT-R-TGT-08-011",
      "UT-R-EFF-09-008",
      "UT-SKILL-RESOLUTION-SERVICE-010",
      "UT-SKILL-RESOLUTION-SERVICE-011",
      "UT-SKILL-RESOLUTION-SERVICE-012",
      "UT-SKILL-RESOLUTION-SERVICE-013",
      "UT-SKILL-RESOLUTION-SERVICE-014",
      "IT-UNIT-MAO-COMMITTEE-004",
      "IT-UNIT-MAO-COMMITTEE-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // Issue #170 (TGT-001)で`kind`評価(SELF/SELECT/BINDING_DERIVED)・戦闘不能除外・
  // area(BASE解決含む: ADJACENT_ORTHOGONAL/DIRECTLY_AHEAD_OF_BASE/BEHIND_BASE/
  // SAME_ROW_AS_BASE/SAME_COLUMN_AS_BASE)・orderの評価順を実装した（回帰検証は
  // target-selection-policy.test.tsのUT-R-TGT-09-001〜009、production統合は
  // IT-UNIT-LUCIE-MAID-004）。RES-005（Issue #172）で`kind`/`base`
  // 参照とも`TRIGGER_SOURCE`/`TRIGGER_TARGET`を実装した（回帰検証は
  // UT-CAP-TRIGGER-CONTEXT-004〜008、production統合はIT-UNIT-SUIRAN-CHAOS-004）。
  // R-TGT-09は`kind→includeDefeated→filters→area→order→count→fallback`の全7段階を
  // 規定する単一ルールであり、TGT-002（CAP_TARGET_FILTER_ORDER、Issue #169）で
  // 残っていた#3（非空filters）を実装し、production統合まで揃ったため、全7段階が
  // 揃い完了とする。production側の証跡はREF-037（Issue #384）でユニット効果軸へ
  // 移送した — `SKL_LYDIA_GENIUS_EX`のOR/POSITION_COLUMN filterは
  // IT-UNIT-LYDIA-GENIUS-005、`SKL_CLARA_SANTA_AS2`のMARKER_IN_AREA filterは
  // IT-UNIT-CLARA-SANTA-004が持つ。MARKER_COUNT順・EXCLUDE_RESOLVED_UNIT・
  // UNIT_TYPE_PRIORITY+SELF_LOWEST_PRIORITYは、それぞれ
  // IT-UNIT-DOROTHEA-PIONEER-001・IT-UNIT-MIHIME-SNIPER-001・
  // IT-UNIT-SHIRANA-SORA-001の振る舞い表が実行結果まで固定している（`it.each`のため
  // ここからは参照できない）。
  {
    ruleId: "R-TGT-09",
    testCaseIds: [
      "UT-R-TGT-09-001",
      "IT-UNIT-LUCIE-MAID-004",
      "UT-TGT-002-001",
      "IT-UNIT-LYDIA-GENIUS-005",
      "IT-UNIT-CLARA-SANTA-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // Issue #168 (TGT-003, CAP_TARGET_BINDING_FALLBACK)で`R-TGT-10`の3点を実装した:
  // (1) sequence開始時のtargetBindings定義順固定 — `skill-resolution-service.ts`の
  // `resolveEffectSequence`が全bindingとeagerなACTION step対象を一度だけ解決し、
  // `applyEffectActionGroups`はその計画済みmapを参照するだけで再解決しない（回帰検証は
  // effect-action-group-resolver.test.tsのUT-R-TGT-10-009: resolveSkillOrderが一度だけ
  // 解決したbindingが、先行stepによる戦闘不能化後も再評価されず元の対象を指し続ける
  // ことを、実際の`resolveSkillOrder`→`applyEffectActionGroups`の経路で検証する）。
  // (2) 参照時点の戦闘不能skip（明示`includeDefeated`がない限り）— RES-002（Issue #174）
  // が全EffectAction種別に共通実装済み（回帰検証はeffect-action-group-resolver.test.tsの
  // UT-R-ACTN-01-001〜006/010）。(3) 候補0件時のfallback経路評価 — TGT-003で
  // `target-selection-policy.ts`の`resolveTargets`に実装した（回帰検証は
  // target-selection-policy.test.tsのUT-R-TGT-10-001〜008）。3点ともUnitテストレベルの
  // 実ライフサイクル配線は揃っていたが、production Catalogの`fallback`使用例
  // （`SKL_CLARA_SANTA_AS2`/`SKL_LYDIA_GENIUS_EX`）はいずれも非空`filters`を伴うため、
  // 無改変のproduction Catalogでfallback経路を通すproduction統合テストが必要だった。
  // TGT-002（CAP_TARGET_FILTER_ORDER、Issue #169）でfiltersを実装し、両スキルの
  // fallback+filters経路を追加したことで、production経路が揃い完了とする。REF-037
  // （Issue #384）でユニット効果軸へ移送し、IT-UNIT-CLARA-SANTA-004が
  // 「サンタタグ」を持つ敵が居ない盤面のfallbackを binding 単位で持つ。
  // `SKL_LYDIA_GENIUS_EX`もかつてfallbackの証跡だったが、原文の代替攻撃条件が
  // 「左右列**と後列を合わせた**範囲が空」であり単一selectorの`fallback`では
  // 表現できないため、Issue #495でBRANCHへ置き換えた。IT-UNIT-LYDIA-GENIUS-005は
  // 現在はbinding単位の候補生成（`optional`な列bindingが空でも後列は拾われる）を
  // 押さえる。production の`fallback`使用例は`SKL_CLARA_SANTA_AS2`と
  // `SKL_URUU_SUMMER_EX`が残る。
  {
    ruleId: "R-TGT-10",
    testCaseIds: [
      "UT-R-TGT-10-009",
      "UT-R-TGT-10-001",
      "UT-CAT-SEQ-041",
      "UT-CAT-SEQ-042",
      "UT-CAT-SEQ-043",
      "IT-UNIT-LYDIA-GENIUS-005",
      "IT-UNIT-CLARA-SANTA-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },

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
      "UT-R-SKL-01-005",
      "UT-R-SKL-INT-001",
      "UT-R-SKL-INT-002",
      "UT-R-SKL-INT-003",
      "UT-R-SKL-INT-004",
      "UT-R-SKL-INT-005",
      "UT-R-SKL-INT-006",
      "UT-R-HEAL-04-018",
      "UT-R-HEAL-04-019",
      "UT-R-HEAL-04-020",
      "UT-R-HEAL-04-021",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  // R-SKL-02: 対象ごとの効果適用直後にPS候補を直ちに解決する要件をIssue #34
  // （`applyDamageAction`のヒット単位フック、`UT-R-SKL-02-001`）で満たし、
  // Issue #73でEffectAction単位のイベント（`EffectActionStarting`/
  // `EffectActionCompleted`）後の即時連鎖（`UT-R-SKL-06-011`）を追加した。
  {
    ruleId: "R-SKL-02",
    testCaseIds: ["UT-R-SKL-02-001", "UT-R-SKL-02-005", "UT-R-SKL-06-011", "UT-R-HEAL-04-019"],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-SKL-03",
    testCaseIds: [
      "UT-R-SKL-03-001",
      "UT-R-SKL-03-002",
      "UT-R-SKL-03-003",
      "UT-DAMAGE-APPLICATION-003",
      "UT-DAMAGE-APPLICATION-007",
      "UT-DAMAGE-APPLICATION-008",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
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
      // REL-004（Issue #203）: 行動外のトップレベルイベントから発動したPSの
      // クールタイムは設定scopeを持たない。その状態がAPI公開形へ載ることを
      // 実`catalog/`（`SKL_LUCIE_MAID_PS1`）で固定する。
      "IT-REL-004-DOC-SCHEMA-002",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-SKL-05",
    testCaseIds: [
      // 実`catalog/`のCHARGE定義2件で、チャージ開始→保留中→解放の一巡を通し、
      // `ChargeStarted`／`ChargeReleaseCompleted`のStateDeltaと独立Reducer復元まで
      // 固定する。R-SKL-05が効果解決の手順を持たない（`resolveChargeStart`が開始側
      // stepを一つも解決しない）ことと、Catalog側の開始側`steps`が空であることの
      // 一致も同じ観測が見る。
      "IT-UNIT-MIRIAM-MAGE-004",
      "IT-UNIT-SIENA-OFFSTAGE-005",
      "UT-ACTION-PHASE-012",
      "UT-ACTION-PHASE-013",
      "UT-ACTION-PHASE-014",
      "UT-R-ACT-01-004",
      "UT-R-ACT-01-004B",
      "UT-R-STS-02-004",
      "UT-RESULT-ASSEMBLER-009",
      "UT-SKILL-RESOLUTION-SERVICE-008",
      "UT-STATE-REDUCER-017",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // R-SKL-06: ACTION stepの条件評価（`evaluateEffectStepCondition`、
  // `UT-R-SKL-06-001`〜005）、対象・action定義順解決とtargetUnitIds集約
  // （`resolveEffectSequence`、`UT-R-SKL-06-006`/007）、step/action単位の
  // ドメインイベント発行（`applyEffectActionGroups`、`UT-R-SKL-06-008`〜011）
  // をIssue #73で実装した。RES-004後半（Issue #171、`CAP_EFFECT_STEP_CONDITION`）
  // で、conditionが自身のtargetを参照するTARGET_STATE/TARGET_HAS_MARKERを対象
  // ごとに個別評価する経路（`EffectStepTargetContext`、`UT-R-SKL-06-016`〜021。
  // このtargetCondition化に伴い動的判定用だった`conditionReferencesStepTarget`
  // 自体はIssue #230で削除し、対応する`UT-R-SKL-06-013`〜015も除去した）と
  // production Catalog検証
  // （`IT-CAP-EFFSTEP-001`〜004）を追加した（他の条件kind・「集合条件」は
  // 引き続き対象外）。REF-036（Issue #383）でその機能軸をユニット効果軸
  // （`IT-UNIT-AOI-ELEGANT-005`・`IT-UNIT-LUCIE-MAID-006`/`007`）へ移送した。
  // Issue #171で、対象別条件を常に
  // `DeferredStepPlan`へ回し（`isEagerActionStep`）、`EffectStepStarting`由来の
  // 連鎖が確定した後の最新`box.units`で再評価する経路（`resolveAfterTiming`）へ
  // 修正し、先行stepおよび同stepの連鎖によるMarker変更を正しく反映することを
  // `UT-R-SKL-06-022`/`023`で検証した。さらに`EffectStepStarting`
  // 連鎖が使用者を戦闘不能にした場合は対象別条件の再評価自体を行わない
  // （`unresolvedEffectCount: 0`のまま`INTERRUPTED`）よう順序を修正し、
  // `UT-R-SKL-06-024`で検証した。RES-004集合条件（Issue #227、
  // `CAP_EFFECT_STEP_SET_CONDITION`）で、Area/TargetFilterによる絞り込み後の
  // 対象集合（`TargetReference`が解決する集合）の存在・件数をしきい値判定する
  // `TARGET_SET_COUNT`を追加した（`TargetSetResolver`/`conditionReferencesTargetSetCount`、
  // `UT-R-SKL-06-025`〜033）。対象別条件と同じ理由（先行stepやPS/Memory連鎖後の
  // 最新状態を反映する必要がある）で常に`DeferredStepPlan`へ回し、ACTION step
  // 自身の条件（対象別条件を伴わない場合を含む）とBRANCHの条件の両方から
  // 使えることを`UT-R-SKL-06-034`〜038で検証した。加えて、
  // 自身のtargetを参照しないTARGET_SET_COUNT単独の条件が、対象別条件と同じ
  // `resolveAfterTiming`経路（このstep自身の`EffectStepStarting`が誘発する
  // PS/Memory連鎖後に再評価する）を経由していなかった欠陥を修正し、
  // `UT-R-SKL-06-039`で検証した。さらに、対象別
  // 条件（TARGET_STATE/TARGET_HAS_MARKERが自身のtargetを参照する、対象ごとに
  // 真偽が変わる評価）と`TARGET_SET_COUNT`（step全体で1回だけ評価する評価）を
  // 同じconditionツリーにAND/OR/NOTで混在させた場合の実行時量化ロジック
  // （`EffectStepTargetContext.wholeSet`、その後`buildEffectStepPerTargetFilter`
  // を候補ごとに評価してから`.some()`で量化する方式）を2回試みたが、いずれも
  // 「対象別条件が全員falseなら対象0件成立扱い」（R-SKL-06）と「集合条件が
  // falseならEffectStepSkipped」という2つの契約のどちらを優先すべきか単一の
  // booleanでは一意に定まらないことが判明した（再々々指摘、Issue #227）。
  // 対症的な量化ロジックは全て撤回し、代わりに自身の`target`を参照する対象別
  // 条件と`TARGET_SET_COUNT`の混在自体を`catalog-integrity.ts`の
  // `MIXED_STEP_TARGET_SET_CONDITION`検証がCatalogロード時点で明示的に拒否する
  // よう設計を変更した。`resolveAfterTiming`は対象別条件（`satisfied: true`
  // 固定）とTARGET_SET_COUNT単独（step全体を一度だけ評価）の2つの独立した
  // 経路へ戻し、混在時の量化ロジック自体を持たない。続く再々々々指摘で、
  // 拒否判定が「自身の`target`と一致する」参照だけを見ていたため、`SELF`等
  // 別のTargetReferenceを参照する対象別条件との組み合わせ（`TARGET_SET_COUNT`
  // 単独経路は対象ごとの文脈を持たないため、参照先を問わずTARGET_STATE/
  // TARGET_HAS_MARKERに到達した時点で例外になる）がpreflightを通過してしまう
  // 配線漏れを指摘され、参照先を問わない判定（`conditionContainsTargetStateOrMarker`）
  // へ広げ、`BRANCH`自身の`condition`（同じ理由で対象ごとの文脈を持たない）も
  // 対象に含めた。Issue #225（RES-004、親#171）で、raw原文取得により
  // `SKL_TATIANA_SAGE_EX`の「凶兆」2つ以上／未満の対象別分岐条件
  // （`TARGET_HAS_MARKER`/`NOT(...)`、`IT-CAP-EFFSTEP-005`。REF-036／Issue #383 で
  // `IT-UNIT-TATIANA-SAGE-008` へ移送した）を近似なしへ更新した。
  // デバフ本体（`APPLY_DAMAGE_MOD`）の実行時解決は`CAP_DAMAGE_MOD`（`DMG-002`、
  // Issue #192）待ちのため、`EffectSequencePlan`レベルの振り分け検証に留め、
  // 不完全変換テーマ`DAMAGE_MOD_KIND_UNIMPLEMENTED`として残していた。
  // `DMG-002`が`APPLY_DAMAGE_MOD`を実ライフサイクルへ配線した後、Issue #225が
  // 機能軸の `IT-CAP-TATIANA-OMEN-PROD-*` で同じ対象別条件を実`resolveSkillUse`
  // 経由の実付与（Marker混在AOE・Domain Event・StateDelta・stateVersion・
  // 独立Reducer復元）まで通し、この暫定的な検証範囲を解消した。REF-031（Issue
  // #361）でその機能軸をユニット効果軸（`IT-UNIT-TATIANA-SAGE-*`）へ移送した。
  // Issue #230（RES-004-CONDITION-SCOPE）で、ACTION stepの単一`condition`を
  // `stepCondition`（step全体を一度だけ評価するgate。falseなら
  // `EffectStepSkipped`）と`targetCondition`（対象ごとに個別評価するfilter。
  // 全対象falseならR-SKL-08の対象0件`SKIPPED`扱い）という独立したスキーマ
  // フィールドへ分離した（`effect-sequence.ts`の`EFFECT_STEP_ALLOWED_KEYS`、
  // `condition-definition.ts`の`STEP_CONDITION_KINDS`/`TARGET_CONDITION_KINDS`）。
  // これにより、Issue #227が`MIXED_STEP_TARGET_SET_CONDITION`として拒否して
  // いた「対象別条件（TARGET_STATE/TARGET_HAS_MARKER）と`TARGET_SET_COUNT`を
  // 同じACTIONで同時に使う」構成が、型・Catalogスキーマの両方で最初から
  // 混在不可能な2つの独立フィールドとして自然に両立できるようになった
  // （`resolveRawStep`のACTIONケースは、以前の「対象別条件」/
  // 「TARGET_SET_COUNT単独」という二分岐を撤回し、`stepCondition`を1回評価
  // →満たされれば`targetCondition`を対象ごとに評価、という単一の経路へ統一
  // した）。`MIXED_STEP_TARGET_SET_CONDITION`はACTIONの対象から外れ、
  // `target`を持たず単一`condition`のままのBRANCHにだけ引き続き適用される。
  // 4つの組み合わせ（両条件true、gate false、filter全件false、filter一部
  // true）を`UT-R-SKL-06-040`〜`043`で検証した。Issue #230:
  // これらはすべてトップレベルACTIONだったため、同じcombined条件を持つACTIONが
  // BRANCH.thenSteps/REPEAT.steps/RANDOM_BRANCHのbranch.stepsそれぞれに
  // ネストされた場合も同じ経路（`resolveStepDefinitionList`経由の
  // `resolveRawStep`）をたどることを`UT-R-SKL-06-049`〜`051`で追加検証した。
  // 既存の対象別条件・
  // `TARGET_SET_COUNT`単体のテスト（`UT-R-SKL-06-016`〜`039`、
  // 当時の`IT-CAP-EFFSTEP-001`〜`005`）は`stepCondition`/`targetCondition`への
  // 機械的な読み替えのみで、検証内容自体は変えていない。
  // Issue #230: `resolveBranchStep`が常に`targetContext: undefined`で
  // `evaluateEffectStepCondition`を呼ぶため、production Catalogに既に存在した
  // BRANCHの`TARGET_STATE`/`TARGET_HAS_MARKER`（`SELF`/`TRIGGER_SOURCE`/
  // count:1の`BINDING`など、高々1体にしか解決されない参照）が実行時に必ず
  // 例外になっていた欠陥を修正した。`resolveTargetSet`経由で0〜1体を直接
  // 評価する経路を追加し（`UT-R-SKL-06-044`〜`048`）、複数体に解決されうる
  // 参照はCatalogロード時点で拒否する（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`、
  // `UT-CAT-IDX-064`〜`068`）。この新しい境界に合わせ、production Catalogの
  // `SKL_MERU_SIRIUS_PS1`（`TRIGGER_TARGET`参照、複数対象になりうる）と
  // `SKL_HARRIET_SAGE_AS1`（`TGT_ADJ`という`BINDING_DERIVED`参照、0〜N体）は
  // 対応するBRANCHをACTIONの`targetCondition`（対象ごとの正しいfilter）へ
  // 書き換えた — 単に例外を避けるだけでなく、意図どおり対象ごとに判定する
  // 挙動へ修正している。さらに`targetReferenceIsSingleUnit`が
  // `BINDING`の主selectorだけを見て`fallback`（`TargetSelectorDefinition`が
  // 任意に持てる、候補0件時の代替selector）を無視していたため、主selectorが
  // count:1でも`fallback`がcount:"ALL"等なら誤って通過してしまう欠陥を
  // `selectorGuaranteesAtMostOneUnit`（fallback連鎖を再帰的に検査）で修正し、
  // `UT-CAT-IDX-069`/`070`で検証した。
  // CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（M7-001D、Issue #247）: `stepCondition`/
  // `targetCondition`/`BRANCH.condition`（Issueが明示する3スコープ全て）から
  // EVENT_PAYLOADを評価できるようにし、PS発動を
  // 引き起こしたトリガーイベント自身のpayloadを参照して、発動後の一部stepだけを
  // 条件付けられるようにした（`evaluateEffectStepCondition`のEVENT_PAYLOAD case、
  // `UT-R-SKL-06-052`〜`055`。`055`はtargetCondition scope、TARGET_STATEとのAND
  // 併用）。EVENT_PAYLOADを含むstepConditionはLAST_RESULT/TARGET_SET_COUNTと同じ
  // 理由でplanning時点では確定せずDeferredStepPlanへ回す（`isEagerActionStep`）。
  // トリガーイベントを持たないAS/EX active skillでの誤用（実行時に初めて例外に
  // なる）は`EVENT_PAYLOAD_REQUIRES_PS_SKILL`としてCatalog構築時に拒否し、
  // `UT-CAT-IDX-080`で検証した。加えて、
  // `UT-R-SKL-06-055`は`evaluateEffectStepCondition`へ`triggerEventPayload`を
  // 直接渡しており、`buildEffectStepPerTargetFilter`の実配線を検証できて
  // いなかったため、`PassiveActivationRuntime.onFactEvent`から実`DamageApplied`
  // イベントで駆動し、payloadの変化だけで`targetCondition`の対象集合が変わる
  // ことを`IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-001`/`002`で検証した。`UNIT_TARISA_
  // TROUBLEMAKER`の`SKL_TARISA_TROUBLEMAKER_PS1`（「与えたダメージが10以下だった
  // 場合、『負けん気』を3つ解除する」）を実production Catalogに対し
  // 近似なしへ変換した（REF-031／Issue #361 でユニット効果軸
  // `IT-UNIT-TARISA-TROUBLEMAKER-006` へ移送済み）。
  // M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`）: `TARGET_HAS_EFFECT`
  // （`CAP_TARGET_EFFECT_QUERY`）と`TARGET_STATE`の`HAS_STATUS`/`UNIT_TYPE`/`ROLE`
  // （`CAP_TARGET_STATE_EXTENDED_FIELD`）を条件評価器へ接続した。分類元は
  // `effect-category-classifier.ts`ただ1つのまま、`grantEffect`が付与時点に
  // `AppliedEffect.categories`（と`APPLY_STAT_MOD`の`statModStat`）へ焼き込み、
  // 照会側（`applied-effect-query.ts`、ACTION step条件とPS trigger条件が共有）は
  // 定義マップを引かずに最新の`BattleUnit`だけを読む（`UT-R-SKL-06-056`〜`063`、
  // `UT-R-PS-01-056`〜`058`）。`HAS_STATUS`は対象が複数の状態を同時に保持しうる
  // ため単一値へ解決せず存在量化として評価する（`UT-R-SKL-06-064`/`065`、
  // `UT-R-PS-01-059`）。trigger scopeの`UNIT_TYPE`/`ROLE`は
  // `RuntimeCounterLookupContext.unitDefinitions`を候補検出（`passive-trigger-matcher.ts`）と
  // 再確認（`reconfirm-passive-candidate.ts`）の両方へ通して解決する（`UT-R-PS-01-055`）。
  // 変換台帳の対象5行（`SKL_CHIYURU_MAZE_AS1`/`SKL_FLUTE_INFLUENCER_PS2`/
  // `SKL_MAIA_LAZY_AS1`/`SKL_NOEL_RUMBLE_AS1`/`SKL_SHOUKA_SCHEMER_AS3`）を近似なしへ
  // 更新し、実ライフサイクルで検証した（REF-037／Issue #384でユニット効果軸へ移送し、
  // 5スキルとも各ユニットの`-001`振る舞い表が成立側と不成立側を1行ずつ持つ）。
  // `SKL_SHOUKA_SCHEMER_AS3`の「対象の攻撃力がデバフ」は`statKinds`で、
  // `SKL_CHIYURU_MAZE_AS1`/`SKL_NOEL_RUMBLE_AS1`の毒・炎上は`continuousDamageKinds`で
  // 絞り込む — どちらも無ければ「何らかのデバフ」への近似が残っていた。
  // 「条件」と「NOT(条件)」を2つのACTION stepへ分けると、`targetCondition`は各stepの
  // PS/Memory連鎖の後に再評価されるため、強化版の適用中に条件が崩れると通常版まで
  // 走ってしまう（`IT-UNIT-NOEL-RUMBLE-004`が
  // 旧構造で実際に両方の実行を検出する）。分岐の選択は`BRANCH`で一度だけ確定させ、
  // BRANCHで参照できない`TRIGGER_TARGET`（`SKL_FLUTE_INFLUENCER_PS2`）は
  // 「基本回復は無条件、増加分だけ条件付き」の加算形にした。AS/EXの`activationCondition`も
  // BRANCHと同じ「高々1体」制約が実行時に効くため、`ACTIVATION_CONDITION_UNBOUNDED_REFERENCE`
  // でCatalogロード時点から同じ制約を課す（`UT-CAT-IDX-092`〜`094`）。
  // 制約は対象数だけでは足りず、参照kind自体もskill typeごとに評価器の契約と一致させる
  // （AS/EXの`evaluateActivationCondition`は`SELF`/`BINDING`、PSの
  // `evaluateTriggerCondition`は`SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`しか解決しない）。
  // `ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE`として`UT-CAT-IDX-095`/`096`で固定した。
  // CHARGEの`activationCondition`は行動選択時に評価されるため、検証対象のbindingは
  // 開始側だけに限定する（`UT-CAT-IDX-097`）。
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
      "UT-R-SKL-06-016",
      "UT-R-SKL-06-017",
      "UT-R-SKL-06-018",
      "UT-R-SKL-06-019",
      "UT-R-SKL-06-020",
      "UT-R-SKL-06-021",
      "UT-R-SKL-06-022",
      "UT-R-SKL-06-023",
      "UT-R-SKL-06-024",
      "UT-R-SKL-06-025",
      "UT-R-SKL-06-026",
      "UT-R-SKL-06-027",
      "UT-R-SKL-06-028",
      "UT-R-SKL-06-029",
      "UT-R-SKL-06-030",
      "UT-R-SKL-06-031",
      "UT-R-SKL-06-032",
      "UT-R-SKL-06-033",
      "UT-R-SKL-06-034",
      "UT-R-SKL-06-035",
      "UT-R-SKL-06-036",
      "UT-R-SKL-06-037",
      "UT-R-SKL-06-038",
      "UT-R-SKL-06-039",
      "UT-R-SKL-06-040",
      "UT-R-SKL-06-041",
      "UT-R-SKL-06-042",
      "UT-R-SKL-06-043",
      "UT-R-SKL-06-044",
      "UT-R-SKL-06-045",
      "UT-R-SKL-06-046",
      "UT-R-SKL-06-047",
      "UT-R-SKL-06-048",
      "UT-R-SKL-06-049",
      "UT-R-SKL-06-050",
      "UT-R-SKL-06-051",
      "UT-R-SKL-06-052",
      "UT-R-SKL-06-053",
      "UT-R-SKL-06-054",
      "UT-R-SKL-06-055",
      "UT-CAT-IDX-079",
      "UT-CAT-IDX-080",
      "IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-001",
      "IT-CAP-TRIGGER-PAYLOAD-TARGETCOND-002",
      "IT-UNIT-TARISA-TROUBLEMAKER-006",
      "IT-UNIT-AOI-ELEGANT-005",
      "IT-UNIT-LUCIE-MAID-006",
      "IT-UNIT-LUCIE-MAID-007",
      "IT-UNIT-TATIANA-SAGE-004",
      "IT-UNIT-TATIANA-SAGE-006",
      "IT-UNIT-TATIANA-SAGE-008",
      // Issue #520: `APPLY_DAMAGE_MOD`／`APPLY_HEALING_MOD`／
      // `APPLY_ATTACK_DAMAGE_BONUS`は`STACKABLE`しか受理せず合成側で最強1件を
      // 選ぶ経路が無いため、`Q-CAT-EFF-16`の「重複なし」は付与側のガードで表す。
      // 対象が高々1体に解決する参照は`BRANCH`、`TRIGGER_TARGET`のように複数体へ
      // 解決する参照は対象ごとに評価する`targetCondition`を使う。
      "IT-UNIT-ELENA-MOODMAKER-013",
      "IT-UNIT-AOI-ELEGANT-011",
      "IT-UNIT-OLGA-VETERAN-008",
      "IT-UNIT-JULIE-SNOW-004",
      // `targetCondition` を選んだ理由そのもの — 契機が複数体へ解決するとき、
      // 保持済みの対象だけが除外され残りには付与されること（対象ごとの評価）。
      "IT-UNIT-JULIE-SNOW-005",
      "UT-R-SKL-06-056",
      "UT-R-SKL-06-057",
      "UT-R-SKL-06-058",
      "UT-R-SKL-06-059",
      "UT-R-SKL-06-060",
      "UT-R-SKL-06-061",
      "UT-R-SKL-06-062",
      "UT-R-SKL-06-063",
      "UT-R-SKL-06-064",
      "UT-R-SKL-06-065",
      "UT-R-SKL-06-066",
      // RES-004-STATUS-CONDITION（Issue #224）: 「対象が状態異常にある場合」を
      // 単一の分類元（`AppliedEffect.categories`の`STATUS`）で照会し、AOEの
      // 対象ごとに評価する（`SKL_CHIYURU_MAZE_EX`）。同じ総称照会へ寄せた
      // `SKL_NANAE_COMMANDER_PS1`は`IT-UNIT-NANAE-COMMANDER-001`の振る舞い表が
      // 成立側と不成立側を持つ（`it.each`のためここからは参照できない）。
      "UT-R-SKL-06-067",
      "UT-R-SKL-06-068",
      "IT-UNIT-CHIYURU-MAZE-004",
      "IT-UNIT-MERU-FLATSPIN-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-SKL-07: BRANCH/RANDOM_BRANCH/REPEATをIssue #217で実装した
  // （`resolveBranchStep`/`resolveRandomBranchStep`/`resolveRepeatStep`、
  // `effect-action-group-resolver.ts`）。`DeferredStepPlan`（`skill-resolution-service.ts`）
  // がこれらのstepを生の定義のまま持ち越し、実行時にJITで解決する。
  // Issue #230: BRANCHの`condition`が`SELF`等の高々1体にしか解決され
  // ない`TARGET_STATE`/`TARGET_HAS_MARKER`を含んでいても、`resolveBranchStep`が
  // 例外を投げず正しく分岐することを`UT-R-SKL-07-111`で検証した。
  // RES-003 production統合（Issue #173）: 実`catalog/`からロードした未改変の
  // production代表を実resolver（`applyEffectActionGroups`）で駆動し、`RANDOM_BRANCH`の
  // 定義順weighted選択（`SKL_KATE_PALADIN_EX`、`IT-UNIT-KATE-PALADIN-001`/`004`）と
  // `BRANCH`のthen/else分岐（`SKL_KEI_JACKKNIFE_AS2`のマーカー条件、
  // `SKL_SENKA_SCHEMER_EX`のIS_ALIVE条件・空else）をユニット効果軸の振る舞い表
  // （`IT-UNIT-KEI-JACKKNIFE-001`／`IT-UNIT-SENKA-SCHEMER-001`）で両枝とも固定し、
  // `EffectStepStarting`の発行・選ばれなかった腕の不実行・独立Reducer復元は
  // `IT-UNIT-KEI-JACKKNIFE-004`／`IT-UNIT-SENKA-SCHEMER-004`が持つ。
  // `CAP_RANDOM_BRANCH`/
  // `CAP_RESOLUTION_BRANCH_REPEAT`を`IMPLEMENTED`へ昇格。`REPEAT`はランタイム実装済み・
  // 単体テスト（下記UT）済みだがproduction定義が現時点で存在しない。
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
      "UT-R-SKL-07-111",
      "IT-UNIT-KATE-PALADIN-004",
      "IT-UNIT-KEI-JACKKNIFE-004",
      "IT-UNIT-SENKA-SCHEMER-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "SCENARIO"],
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
      // DMG-003（Issue #196、POST_DAMAGE_CRITICAL_BRANCH）: `LAST_RESULT`の
      // `criticalHitCount`（直前ACTION step全体の会心ヒット数）と、その
      // step-wideスコープをproduction定義の形のまま固定する証跡。
      "UT-R-SKL-08-021",
      "UT-R-SKL-08-022",
      "UT-R-SKL-08-023",
      // step-wideスコープ（横一列2体のうち1体だけが会心した回でも追撃が2体へ入る）を
      // production定義の形のまま固定する。
      "IT-UNIT-ROSIE-ARTIST-004",
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
      // 110-133は010-033と同じトリガー照合の観点を、selector評価・matcher・
      // PassiveActivationRuntimeの各層で検証する系列（010-033は
      // trigger-condition-evaluator側）。
      "UT-R-PS-01-110",
      "UT-R-PS-01-111",
      "UT-R-PS-01-112",
      "UT-R-PS-01-113",
      "UT-R-PS-01-114",
      "UT-R-PS-01-115",
      "UT-R-PS-01-116",
      "UT-R-PS-01-117",
      "UT-R-PS-01-118",
      "UT-R-PS-01-119",
      "UT-R-PS-01-120",
      "UT-R-PS-01-121",
      "UT-R-PS-01-122",
      "UT-R-PS-01-123",
      "UT-R-PS-01-124",
      "UT-R-PS-01-125",
      "UT-R-PS-01-126",
      "UT-R-PS-01-127",
      "UT-R-PS-01-128",
      "UT-R-PS-01-129",
      "UT-R-PS-01-130",
      "UT-R-PS-01-131",
      "UT-R-PS-01-132",
      "UT-R-PS-01-133",
      "UT-R-PS-01-134",
      "UT-R-PS-01-135",
      "UT-R-PS-01-136",
      "UT-R-PS-01-137",
      // 138-140は`DAMAGE_MAX_HP_RATIO`条件（1ヒットの被弾量を最大HP比で照合、
      // アニス・ベネットPS1「最大HP×15%以上のダメージを負った際」の前提機構）。
      "UT-R-PS-01-138",
      "UT-R-PS-01-139",
      "UT-R-PS-01-140",
      "UT-R-PS-01-037",
      "UT-R-PS-01-038",
      "UT-R-PS-01-039",
      "UT-R-PS-01-040",
      "UT-R-PS-01-041",
      "UT-R-PS-01-042",
      "UT-R-PS-01-043",
      "UT-R-PS-01-044",
      "UT-R-PS-01-045",
      "UT-R-PS-01-046",
      "UT-R-PS-01-047",
      "UT-R-PS-01-048",
      "UT-R-PS-01-049",
      "UT-R-PS-01-050",
      "UT-R-PS-01-051",
      "UT-R-PS-01-052",
      "UT-R-PS-01-053",
      "UT-R-PS-01-054",
      // M7-011（Issue #265、EFFECT_APPLIED_CLASSIFICATION_PAYLOAD）: 「敵にデバフが
      // 付与された際」等、付与された効果の分類を発動契機にするPS。REF-041（Issue #388）で
      // ユニット効果軸へ移送し、契機は実 resolver が発行した `EffectApplied` から取る。
      "IT-UNIT-KEI-JACKKNIFE-007",
      "IT-UNIT-SIENA-DIVA-007",
      "IT-UNIT-NADYA-SUCCESSOR-005",
      "IT-UNIT-KATE-PALADIN-005",
      "IT-UNIT-LILY-SINGER-004",
      "IT-UNIT-MEIYA-FATED-004",
      "IT-UNIT-URUU-TIMID-004",
      "IT-CAT-PROD-013",
      // ターン境界は`sourceUnitId`/`targetUnitIds`を持たないグローバルイベントで、
      // production Catalogの`SELF`/`SELF`はその帰属先不在に依拠して成立する。
      "IT-UNIT-KARINA-DOWNER-004",
      "UT-R-PS-01-055",
      "UT-R-PS-01-056",
      "UT-R-PS-01-057",
      "UT-R-PS-01-058",
      "UT-R-PS-01-059",
      // trigger scopeの`UNIT_TYPE`（`SKL_LUCIE_MAID_PS1`の「物理型／敏捷型の敵から
      // 攻撃される直前」）はユニット効果軸が実PS経路で成立・不成立とも押さえる。
      "IT-UNIT-LUCIE-MAID-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
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
      "UT-R-PS-04-013",
      "UT-R-PS-04-014",
      "UT-R-PS-04-015",
      "UT-R-PS-04-016",
      "UT-R-PS-04-017",
      "UT-R-PS-04-018",
      // 「所有者がチャージ中でない」を実`catalog/`のPS（`SKL_SIENA_OFFSTAGE_PS1`）と
      // 実CHARGE定義（`SKL_SIENA_OFFSTAGE_AS1`）で固定する。候補判定（R-PS-01）側の
      // 除外・直前確認の`OWNER_CHARGING`・解放後に制限が解けることを一度に見る。
      "IT-UNIT-SIENA-OFFSTAGE-006",
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
    testCaseIds: [
      "UT-R-PS-05-001",
      "UT-R-PS-05-002",
      "UT-R-PS-05-003",
      "UT-R-PS-05-005",
      "UT-R-PS-05-006",
    ],
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
      // R-ATM-01改訂（Issue #479）で「効果1件ごとの即時割り込み」から
      // 「効果処理完了後の保留キュー」へ置き換わったため、旧`UT-R-PS-06-008`は
      // `UT-R-ATM-01-001`として新しい規約を検証する。
      "UT-R-ATM-01-001",
      "UT-R-PS-06-009",
    ],
    kinds: ["POSITIVE", "SCENARIO"],
  },
  {
    ruleId: "R-PS-07",
    testCaseIds: ["UT-R-PS-04-007", "UT-R-PS-06-007", "UT-R-PS-07-001", "UT-R-PS-07-005"],
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
  {
    ruleId: "R-MEM-01",
    testCaseIds: [
      "UT-R-MEM-01-001",
      "UT-R-MEM-01-002",
      "UT-R-MEM-01-003",
      "UT-R-MEM-01-004",
      "UT-R-MEM-01-005",
      "UT-R-MEM-01-006",
      "UT-R-MEM-01-007",
      "UT-R-MEM-01-008",
      "IT-MEM-HARD-WARMUP-001",
      "IT-MEM-EURO-TOWER-DAY-001",
      "IT-MEM-FUUKI-IINKAI-004",
      "IT-MEM-CHAOS-MAIDEN-004",
      "IT-MEM-DISCONTENT-AND-ANXIETY-004",
      "IT-MEM-BUSY-DAY-SLUMBER-004",
      "IT-MEM-PANTS-STRAY-CAT-001",
      "IT-MEM-PYXIS-MA-SOEUR-004",
      "IT-MEM-SIRIUS-SUGAR-004",
      "IT-MEM-TREBLE-QUINTET-004",
      "IT-MEM-TRINITY-JEWEL-004",
      "IT-MEM-THREE-MAIDS-HOSPITALITY-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-MEM-02",
    testCaseIds: [
      "UT-R-MEM-02-001",
      "UT-R-MEM-02-002",
      "UT-R-MEM-02-003",
      "UT-R-MEM-02-004",
      "UT-R-MEM-02-005",
      "IT-MEM-HARD-WARMUP-004",
      "IT-MEM-HEART-COLOR-004",
      "IT-MEM-STRANGERS-004",
      "IT-MEM-PANTS-STRAY-CAT-004",
      "IT-MEM-CHAOS-MAIDEN-TWINTAIL-FEST-004",
      "IT-MEM-MOMOZONO-NEW-YEAR-004",
      "IT-MEM-EURO-TOWER-DAY-004",
      "IT-MEM-CHAOS-MAIDEN-005",
      "IT-MEM-TREBLE-QUINTET-005",
      "IT-MEM-FUUKI-IINKAI-005",
      "IT-MEM-INCOGNITO-SISTER-ADVENTURE-005",
      "IT-MEM-DISCONTENT-AND-ANXIETY-006",
      "IT-MEM-CURIOUS-EQUIPMENT-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-MEM-03",
    testCaseIds: [
      "UT-R-MEM-03-001",
      "UT-R-MEM-03-002",
      "UT-R-MEM-03-003",
      "IT-MEM-HARD-WARMUP-001",
      "IT-MEM-CHAOS-MAIDEN-TWINTAIL-FEST-001",
      "IT-MEM-MOMOZONO-NEW-YEAR-001",
      "IT-MEM-INCOGNITO-SISTER-ADVENTURE-001",
      "IT-MEM-CURIOUS-EQUIPMENT-002",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-MEM-04",
    testCaseIds: [
      "UT-R-MEM-04-001",
      "UT-R-MEM-04-002",
      "UT-R-MEM-04-003",
      "UT-R-MEM-04-004",
      "UT-R-MEM-04-005",
      "UT-CAT-IDX-081",
      "UT-CAT-IDX-082",
      "UT-CAT-IDX-083",
      "UT-CAT-IDX-084",
      "UT-CAT-IDX-085",
      "UT-CAT-IDX-086",
      "UT-CAT-IDX-087",
      "UT-CAT-IDX-088",
      "UT-CAT-IDX-089",
      "UT-STATE-REDUCER-032",
      "IT-MEM-TIMID-REINDEER-EVE-002",
      "IT-MEM-PANTS-STRAY-CAT-002",
      "IT-MEM-CHAOS-MAIDEN-002",
      "IT-MEM-ALWAYS-PICO-BESIDE-YOU-004",
      "IT-MEM-ALWAYS-PICO-BESIDE-YOU-005",
      "UT-R-EFF-10-019",
      "UT-R-EFF-10-020",
    ],
    kinds: ["POSITIVE", "NEGATIVE"],
  },

  // ATM: スキル効果処理の割り込み制御
  // Issue #478が設計改訂（旧「効果1件ごとの即時割り込み」→保留キュー方式）、
  // Issue #479がR-ATM-01/02のエンジン実装、Issue #480がR-ATM-03/04を担当する。
  {
    ruleId: "R-ATM-01",
    testCaseIds: [
      // 保留キュー本体: 効果処理中の候補は検出のみ即時・発動は完了後。
      "UT-R-ATM-01-001",
      // 保留中に前提が崩れた候補はR-PS-04の発動直前確認で破棄される。
      "UT-R-ATM-01-002",
      // 効果処理フェーズ境界のFACT（EffectSequenceスコープのRuntimeCounterReset）。
      "UT-R-ATM-01-003",
      // 実ライフサイクル（PS自身のEffectSequence・DAMAGE内部イベント・
      // COOLDOWN_MANIPULATION内部イベント・チャージ解放中の反撃）。
      "UT-R-ATM-01-004",
      "UT-R-ATM-01-005",
      "UT-R-ATM-01-006",
      "UT-R-ATM-01-007",
      // 状態保守（R-EFF-09の検出粒度・R-EFF-10のMarker解除）は即時のまま、
      // 発動だけが後段フェーズへ移ることの証跡。
      "UT-R-EFF-09-030",
      "UT-R-EFF-10-034",
      "IT-UNIT-TARISA-TROUBLEMAKER-008",
      // 効果処理中のFACTイベントがヒットを取り消せなくなったこと（旧R-DMG-05の
      // 途中終了経路が仕様上消えたこと）。
      "UT-R-DMG-05-008",
      "UT-R-DMG-05-009",
      // 回復リンクの転送途中にPS/Memory発動が挟まらないこと（07 R-HEAL-04の注記）。
      "UT-R-HEAL-04-017",
      "UT-R-HEAL-04-018",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-ATM-02",
    testCaseIds: [
      // 後段フェーズ: 完了イベント発行 → 保留キュー（発生順） → 完了イベント自身の候補。
      "UT-R-ATM-02-001",
      // 中断で終わった効果処理でも保留分は解決する。
      "UT-R-ATM-02-002",
      // 保留候補から発動したPS/Memoryも同じ3フェーズで再帰する（深さ優先の維持）。
      "UT-R-ATM-02-003",
      // AS/EX経路: 中断で終わったスキル使用でも保留分は排出する。
      "UT-R-ATM-02-004",
      // 実行ガードは保留キュー全体で1つ — グループごとにリセットしない。
      "UT-GUARD-012",
      "UT-GUARD-013",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-ATM-03",
    testCaseIds: [
      // #2〜#3 構造走査: DAMAGEを適用しうるstepの対象を、定義順→束縛順で初出重複排除する。
      "UT-R-ATM-03-001",
      // #2 分岐で実際には攻撃されない対象も含める／damageTypesは分岐をまたいで足し込む。
      "UT-R-ATM-03-002",
      // #6 非DAMAGE stepと`LAST_*_TARGETS`参照は観測対象に寄与しない。
      "UT-R-ATM-03-003",
      // #2 `SELF`・`REPEAT`の内側・複数bindingの並び。
      "UT-R-ATM-03-004",
      // #7 `EVENT_PAYLOAD field: "damageType"`の別名規約（集合のいずれかで成立）。
      "UT-R-ATM-03-005",
      // #1〜#3・#6 実経路（`resolveSkillUse`）での発行位置と対象の取捨。
      "UT-R-ATM-03-006",
      // #7 捕捉済み追撃ライダー（R-FUP-01）の型が集合へ加わる。
      "UT-R-ATM-03-007",
      "UT-R-ATM-03-008",
      // #4 発行直前に戦闘不能である対象へは発行しない。
      "UT-R-ATM-03-009",
      // #1 実経路ごとの発行（AS/EXは`UT-R-ATM-03-006`、PSとチャージ解放はこの2件）。
      "UT-R-ATM-03-010",
      "UT-R-ATM-03-011",
      // 全production戦闘で「スキル使用ごと・対象ごとにちょうど1回、最初のヒットより前」。
      // 実production定義（`SKL_SHIRANA_SORA_PS2`）が#7の別名規約で発動することは
      // `IT-UNIT-SHIRANA-SORA-001`の振る舞い表が固定する（表駆動のため
      // `UT-TRACEABILITY-005`の単一テスト対応を満たさず、ここには列挙しない）。
      "IT-AUDIT-ATM-001",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-ATM-04",
    testCaseIds: [
      // 効果処理中TIMINGイベントを契機にするCatalogをロード時に拒否し、
      // 効果処理の外のTIMINGイベントは引き続き受理する。
      "UT-R-ATM-04-001",
    ],
    kinds: ["POSITIVE", "NEGATIVE"],
  },

  // ACTN: EffectAction解決
  {
    ruleId: "R-ACTN-01",
    testCaseIds: [
      // #2 対象戦闘不能skip(明示指定なし): 全kindが対象戦闘不能を理由に適用をスキップする。
      "UT-R-ACTN-01-001",
      "UT-R-ACTN-01-002",
      "UT-R-ACTN-01-003",
      "UT-R-ACTN-01-004",
      // #2 対象戦闘不能でも生存対象には通常どおり適用される(誤検出がないことの境界)。
      "UT-R-ACTN-01-005",
      // #2 明示指定(TargetSelectorDefinition.includeDefeated: true)がある場合は戦闘不能対象にも適用される。
      // DAMAGEもapplyDamageAction内部のヒット単位チェックで同じ明示指定を尊重する。
      "UT-R-ACTN-01-006",
      "UT-R-ACTN-01-008",
      "UT-R-ACTN-01-010",
      "UT-DAMAGE-APPLICATION-015",
      // #2/#5 明示指定下でも、既に戦闘不能だった対象への継続ヒットはUnitDefeatedを再発行しない
      // (08_ドメインイベント.md「HPが0になった直後」)。
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
  // DMG-011（Issue #186、M8完了監査）でR-ACTN-02「即時効果」を完了計上した。
  // 本ルールは4種の即時EffectActionそれぞれを他のルール群へ委譲する規定であり、
  // `MODIFY_RESOURCE`（`DISTRIBUTE`を含む）だけが自前の規約を持つ。委譲先が
  // すべて実装済みになった時点で初めて全条項が成立するため、完了責任は
  // `DMG-001`（Issue #195）から本監査へ引き継がれていた
  // （DMG-001／Issue #195 からの再割当）。
  {
    ruleId: "R-ACTN-02",
    testCaseIds: [
      // 第1項 `DAMAGE`は`R-HIT-*`/`R-CRT-*`/`R-DMG-*`/`R-SHD-*`に従う。
      // 委譲先を1本の列として通しで観測するのは本監査が追加した2件で、
      // 実 `catalog/` の全production戦闘（イベント順・保存則）を対象にする。
      "IT-AUDIT-M8-001",
      "IT-AUDIT-M8-002",
      "SCN-BTL-015",
      // 第2項 `HEAL`は`R-HEAL-*`に従ってHPを回復する。
      "UT-R-HEAL-01-001",
      "UT-R-HEAL-01-002",
      // 第3項 `MODIFY_RESOURCE`の整数化と`[0, 現在最大値]`への丸め。
      "UT-R-ACTN-02-001",
      "UT-R-ACTN-02-002",
      "UT-R-ACTN-02-003",
      "UT-R-ACTN-02-004",
      "UT-R-ACTN-02-005",
      "UT-R-ACTN-02-007",
      "UT-R-ACTN-02-008",
      "UT-R-ACTN-02-009",
      "UT-R-ACTN-02-010",
      "UT-R-ACTN-02-011",
      // REF-045（Issue #392）でユニット効果軸へ移送した。実 production のHP支払いが
      // 公開差分を持ち独立Reducerで復元できること・残HPが支払い額に満たない場合に
      // `bounds.min: 0` で0止まりになること。
      "IT-UNIT-LILY-HERO-005",
      // 第4項 `DISTRIBUTE`の分配規約（総量の等分・端数切り捨て・参照ごとに独立）。
      "UT-R-ACTN-02-012",
      "UT-R-ACTN-02-014",
      "UT-R-ACTN-02-015",
      "UT-R-ACTN-02-016",
      "UT-R-ACTN-02-017",
      "UT-R-ACTN-02-018",
      "UT-R-ACTN-02-019",
      "UT-R-ACTN-02-020",
      "UT-R-ACTN-02-021",
      "UT-R-ACTN-02-022",
      // 第5項 `REMOVE_EFFECTS`のカテゴリ・解除数・優先順。
      "UT-R-EFF-02-011",
      "UT-R-EFF-02-012",
      "UT-R-EFF-02-016",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // M7-002A（Issue #255、`CAP_RESOURCE_CAPACITY_MOD`／G-09）で、R-ACTN-03
  // 「継続状態の付与」に初めて機械検証を登録した。`MODIFY_RESOURCE_CAPACITY`は
  // 「付与後、影響するステータス…を再評価する」（同ルール第4項）のリソース上限版で
  // あり、付与・失効・解除のたびに不変の基準から上限を再合成する
  // （`resource-capacity-recalculation-service.ts`）。`APPLY_STAT_MOD`等の
  // `AppliedEffect`保持そのものは引き続きR-EFF-01/R-STA-04側の台帳が担う。
  {
    ruleId: "R-ACTN-03",
    testCaseIds: [
      // 上限の再合成（純粋関数）: 基準・ADD合算・SET後勝ち・R-EFF-05の有効性・
      // 0未満clamp・R-NUM-02切り捨て・HPだけCombatStat側へ合流。
      "UT-R-ACTN-03-001",
      "UT-R-ACTN-03-002",
      "UT-R-ACTN-03-003",
      "UT-R-ACTN-03-004",
      "UT-R-ACTN-03-005",
      "UT-R-ACTN-03-006",
      "UT-R-ACTN-03-007",
      "UT-R-ACTN-03-008",
      "UT-R-ACTN-03-009",
      // R-STA-04の再計算フックへの配線: `ResourceCapacityChanged`・変化なしでの
      // 無発行・失効時の基準復帰と現在値clamp・HP上限低下での`UnitDefeated`。
      "UT-R-ACTN-03-010",
      "UT-R-ACTN-03-011",
      "UT-R-ACTN-03-012",
      "UT-R-ACTN-03-013",
      "UT-R-ACTN-03-014",
      // 実resolver経由の付与と、`EFFECT_IMMUNITY`による付与拒否。
      "UT-R-ACTN-03-015",
      "UT-R-ACTN-03-016",
      // Catalogロード時点の`CAP_RESOURCE_CAPACITY_MOD`宣言必須。
      "UT-R-ACTN-03-017",
      // 実production定義（`ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP`）の実ライフサイクル。
      "IT-UNIT-FLUTE-VAMPIRE-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },

  // HIT: 命中
  {
    ruleId: "R-HIT-01",
    testCaseIds: ["UT-R-HIT-01-001", "UT-R-HIT-01-002"],
    kinds: ["POSITIVE"],
  },
  // 「対象がチャージ中なら自身の回避効果を発動させない」は、実`catalog/`のCHARGE定義
  // （`SKL_MIRIAM_MAGE_AS2`）で作ったチャージ状態と実production回避効果
  // （`ACT_ANIS_TROUBLEMAKER_EX_EVASION`）を実ライフサイクルで突き合わせて固定する。
  // 抑止する側と抑止される側が別ユニットにあるため、両ユニットのファイルへ同じ観測を
  // 複製してある（`12_テスト戦略.md`「`IT-CAP-*` の retire 基準」3）。どちらも
  // チャージなしの対照を併せ持ち、不発の原因がチャージ状態だけであることを固定する。
  {
    ruleId: "R-HIT-02",
    testCaseIds: [
      "IT-UNIT-MIRIAM-MAGE-005",
      "IT-UNIT-ANIS-TROUBLEMAKER-004",
      "UT-R-HIT-02-001",
      "UT-R-HIT-02-002",
      "UT-R-HIT-02-003",
      "UT-R-HIT-02-004",
      "UT-R-HIT-02-005",
      "UT-R-HIT-02-006",
      "UT-R-HIT-02-007",
      "UT-R-HIT-02-008",
      "UT-R-HIT-02-009",
      "UT-R-HIT-02-010",
      "UT-R-HIT-02-011",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-HIT-03",
    testCaseIds: [
      "UT-R-HIT-03-001",
      "UT-R-HIT-03-002",
      "UT-R-HIT-03-003",
      "UT-R-HIT-03-004",
      "UT-R-HIT-03-005",
      "UT-R-HIT-03-006",
      "UT-R-HIT-03-007",
      "UT-R-HIT-03-008",
      "UT-R-HIT-03-009",
      "UT-R-HIT-03-010",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  // M7-018（Issue #272）で新設。R-HIT-04「Nヒット回避」は、回避が成立した
  // 被ヒットが回避を成立させたインスタンス自身の`INCOMING_HIT`消費を1消費する
  // （R-EFF-07の一般規則に対する本ルール固有の例外）ことを規定する。M7-004
  // （Issue #183）は回避の判定（R-HIT-02）までを実装したが、この消費が無いため
  // production定義（`ACT_ANIS_TROUBLEMAKER_PS1_EVASION`等の`EVASION`と
  // `ACT_FLUTE_VAMPIRE_PS2_EVASION`の`HIT_EVASION`、いずれもraw原文は
  // 「Nヒットだけ攻撃を回避するバフ」）のヒット数が実際には制限されていなかった。
  // `CAP_HIT_COUNT_EVASION`（Nヒット回避）が要求していたのはまさにこの部分で、
  // 判定側と合わせてここで完了する。消費契機はR-EFF-07に対して**逆**であり
  // （回避したMISSで消費し、命中確定では消費しない）、後者の除外が抜けると
  // 確率回避の失敗や必中で残数を失う（`UT-R-HIT-04-010`/`011`が両方向を固定する）。
  {
    ruleId: "R-HIT-04",
    testCaseIds: [
      "UT-R-HIT-04-001",
      "UT-R-HIT-04-002",
      "UT-R-HIT-04-003",
      "UT-R-HIT-04-004",
      "UT-R-HIT-04-005",
      "UT-R-HIT-04-006",
      "UT-R-HIT-04-007",
      "UT-R-HIT-04-008",
      "UT-R-HIT-04-009",
      "UT-R-HIT-04-010",
      "UT-R-HIT-04-011",
      // REF-044（Issue #391）でユニット効果軸へ移送した。実 `HIT_EVASION` が同じ
      // 2ヒット攻撃の1ヒット目だけを回避し、その被ヒットで消費し切って失効し、
      // 2ヒット目はそのまま命中することを実 resolver で固定する。
      "IT-UNIT-FLUTE-VAMPIRE-008",
      // 「チャージ中で発動しなかった場合」も被ヒット消費を減らさない、という本ルール
      // 固有の境界をproduction定義で固定する。抑止する側（チャージ）と抑止される側
      // （`HIT_EVASION`）が別ユニットにあるため両ユニットへ複製してある。
      "IT-UNIT-SIENA-OFFSTAGE-007",
      "IT-UNIT-FLUTE-VAMPIRE-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // M7-018（Issue #272）で新設。R-HIT-05「必中付与」は、使用者が持つ
  // `GUARANTEED_HIT`効果が攻撃側定義の`accuracy.mode`に関わらずその使用者の
  // 攻撃を必中にする（回避効果・Nヒット回避のどちらも発動させない）ことと、
  // 暗闇（R-HIT-03 #6）には影響しないことを規定する。
  {
    ruleId: "R-HIT-05",
    testCaseIds: [
      "UT-R-HIT-05-001",
      "UT-R-HIT-05-002",
      "UT-R-HIT-05-003",
      "UT-R-HIT-05-004",
      "UT-R-HIT-05-005",
      "UT-R-HIT-05-006",
      "UT-R-HIT-05-007",
      "UT-R-HIT-05-008",
      // UT-R-HIT-05-009（「別Taskが持つstatus種別はresolverに拒否され続ける」境界）は
      // DMG-003A（Issue #295）で除去した。最後の未配線だったCRITICAL_GUARANTEE/
      // CRITICAL_PREVENTIONがR-CRT-03として配線され、resolverの許可リストが
      // `StatusKind`の全値を網羅した時点で、この境界自体が存在しなくなったため。
      // REF-044（Issue #391）でユニット効果軸へ移送した。貫通する側（必中バフ）と
      // 貫通される側（回避効果）が別ユニットにあるため、retire基準3に従って両ユニット
      // へ同じ観測を複製してある。
      "IT-UNIT-LAYLA-ENTREPRENEUR-005",
      "IT-UNIT-FLUTE-VAMPIRE-009",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

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
  // Issue #476: 会心ダメージボーナスは既定値50%（Q-CAT-05）を含んだユニット
  // ステータスであり、会心倍率の基準は100%である（Q-DMG-09）。`UT-R-CRT-02-003`が
  // 既定値ちょうどで150%になることを、`IT-AUDIT-BONUS-001`がCatalog既定値からの
  // 経路ごと固定する — 倍率式だけを見るテストでは、既定値の出所と基準の乖離を
  // 検出できないため。
  {
    ruleId: "R-CRT-02",
    testCaseIds: [
      "UT-R-CRT-02-001",
      "UT-R-CRT-02-002",
      "UT-R-CRT-02-003",
      "UT-R-CRT-02-004",
      "UT-R-CRT-02-005",
      "IT-AUDIT-BONUS-001",
    ],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  // DMG-003A（Issue #295）で新設。R-CRT-03「会心保証・会心不可」は、使用者が持つ
  // `CRITICAL_GUARANTEE`/`CRITICAL_PREVENTION`効果を攻撃側定義の`critical.mode`へ
  // 畳み込んだ実効会心モード（`PREVENTED` > `GUARANTEED` > `NORMAL`）で会心判定を
  // 行うことを規定する。どちらの効果も保持者自身の攻撃に働き、防御側の保持は
  // 参照しない（`UT-R-CRT-03-015`/`IT-UNIT-TARISA-TROUBLEMAKER-009`がこの向きを
  // 固定する）。会心不可が会心保証に勝つ順序は、サブユニット追加ダメージの
  // `PREVENTED`固定（R-SUB-02）が使用者の会心保証で破られないことも同時に守る
  // （`UT-R-CRT-03-007`）。
  {
    ruleId: "R-CRT-03",
    testCaseIds: [
      "UT-R-CRT-03-001",
      "UT-R-CRT-03-002",
      "UT-R-CRT-03-003",
      "UT-R-CRT-03-004",
      "UT-R-CRT-03-005",
      "UT-R-CRT-03-006",
      "UT-R-CRT-03-007",
      "UT-R-CRT-03-008",
      "UT-R-CRT-03-009",
      "UT-R-CRT-03-010",
      "UT-R-CRT-03-011",
      "UT-R-CRT-03-012",
      "UT-R-CRT-03-013",
      "UT-R-CRT-03-014",
      "UT-R-CRT-03-015",
      // REF-044（Issue #391）でユニット効果軸へ移送した。会心保証が実効モードを
      // `GUARANTEED` へ倒して確率判定を行わないことは `IT-UNIT-MIKOTO-SURVIVOR-006`、
      // 会心不可が保持者側にしか働かないことは `IT-UNIT-TARISA-TROUBLEMAKER-009` が
      // 持つ。付与そのもの（`statusKind`・期間）は各ユニットの `-001` 振る舞い表が
      // 固定している（`it.each` のためここからは参照できない）。
      "IT-UNIT-MIKOTO-SURVIVOR-006",
      "IT-UNIT-TARISA-TROUBLEMAKER-009",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
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
  // Issue #476: 属性相性ボーナスも既定値25%を含んだユニットステータスで、有利属性
  // 倍率の基準は100%である（Q-DMG-09）。会心側と同じ構成で`IT-AUDIT-BONUS-002`が
  // Catalog既定値からの経路を固定する。
  {
    ruleId: "R-ATR-02",
    testCaseIds: [
      "UT-R-ATR-02-001",
      "UT-R-ATR-02-002",
      "UT-R-ATR-02-003",
      "UT-R-ATR-02-004",
      "UT-R-ATR-02-005",
      "UT-R-ATR-02-006",
      "IT-AUDIT-BONUS-002",
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
      "PROP-DMG-01-001",
      "PROP-DMG-01-002",
      "PROP-DMG-01-003",
      "PROP-DMG-01-004",
      // Issue #476: 属性倍率と会心倍率が同じ一撃へ重なったときの積を、Catalog既定値
      // だけを持つユニットで固定する（Q-DMG-09）。
      "IT-AUDIT-BONUS-003",
      // M7-015（Issue #269）: R-DMG-01の「Action内追加ダメージ倍率」を、
      // production定義（`ACT_KARINA_DOWNER_AS1_DAMAGE`／`ACT_FEE_BATH_AS2_DAMAGE`の
      // `damageModifiers`）が実際に使う`MARKER_COUNT_SCALE`で実測した。同一AOE解決の
      // 対象ごとに倍率が分かれること、複数ヒットが同じ所持数を読むことを含む。
      // REF-043（Issue #390）でユニット効果軸へ移送した。
      "IT-UNIT-KARINA-DOWNER-007",
      "IT-UNIT-FEE-BATH-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "PROPERTY"],
  },
  {
    ruleId: "R-DMG-02",
    testCaseIds: [
      "UT-R-DMG-02-001",
      "UT-R-DMG-02-002",
      "UT-R-DMG-02-003",
      "UT-R-DMG-02-004",
      "UT-R-DMG-02-005",
      "UT-R-DMG-02-006",
      "UT-R-DMG-02-007",
      "UT-R-DMG-02-008",
      "UT-R-DMG-02-009",
      "UT-R-DMG-02-010",
      // RES-004-TATIANA-EX（Issue #225）: #3「計算結果が1未満の場合も1とする」を
      // production Catalogの実定義で踏む唯一の経路。`ACT_TATIANA_SAGE_EX_DEBUFF`
      // が与ダメージ倍率を0まで落とすため丸め前ダメージは0になるが、最終ダメージは
      // この最終化規則で1へ引き上げられる（`APPLY_DAMAGE_MOD`はこの全体不変条件の
      // 上書きを宣言しないため、効果定義側では0にできない）。
      "IT-UNIT-TATIANA-SAGE-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-DMG-03",
    testCaseIds: [
      "UT-R-DMG-03-001",
      "UT-R-DMG-03-002",
      "UT-R-DMG-03-003",
      "UT-R-DMG-03-004",
      // REF-039（Issue #386）: `IT-CAP-DAMAGE-MOD-PROD-001` の移送先。実PS2が付けた
      // 被ダメージ補正に対して、攻撃側の`damageReductionIgnoreRate`が負の補正だけを
      // 割合で無視することを実ダメージpipelineで見る。
      "IT-UNIT-MAO-COMMITTEE-007",
      // DMG-003（Issue #196、TEMP_PIERCING_GRANT）: 静的な`DamagePayload.piercing`
      // と`APPLY_PIERCING_MOD`由来の一時貫通を「無視されずに残る割合の積」で
      // 合成する（`combat/piercing-policy.ts`）。
      "UT-R-DMG-03-020",
      "UT-R-DMG-03-021",
      "UT-R-DMG-03-022",
      "UT-R-DMG-03-023",
      // 合成結果が`DamageWillBeApplied`のsnapshotだけで
      // なく確定計算（`DamageCalculated`の`effectiveDefense`）まで届くことを
      // 直接固定する（合成関数そのものではなく配線の回帰テスト）。
      "UT-R-DMG-03-024",
      // 一時貫通（`APPLY_PIERCING_MOD`）と静的貫通（`DamagePayload.piercing`）を
      // production定義のまま実ダメージpipelineで見る。
      "IT-UNIT-RAMI-NEWYEAR-004",
      "IT-UNIT-EVIE-KYONSHI-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-DMG-04",
    testCaseIds: [
      "UT-R-DMG-04-001",
      "UT-R-DMG-04-002",
      "UT-R-DMG-04-003",
      "UT-R-DMG-04-004",
      "UT-R-DMG-04-005",
      "UT-R-DMG-04-006",
      "UT-R-DMG-04-007",
      "UT-R-DMG-04-008",
      "UT-R-DMG-04-009",
      "UT-R-DMG-04-010",
      "UT-R-DMG-04-011",
      "UT-R-DMG-04-012",
      "UT-R-DMG-04-013",
      // REF-039（Issue #386）: `IT-CAP-DAMAGE-MOD-PROD-002`〜`005` の移送先。
      // 動的条件付き補正がヒットごとに評価されること（`HP_RATIO_COMPARISON`／
      // `UNIT_HAS_MARKER`／`UNIT_STATE`）と、集計結果が`DamageCalculated`へ
      // 実値で載ることを、実 production 定義の付与から通して見る。
      "IT-UNIT-KOTOHA-REBEL-005",
      "IT-UNIT-AOI-ELEGANT-006",
      "IT-UNIT-ELENA-MOODMAKER-010",
      "IT-UNIT-KEI-JACKKNIFE-006",
      "UT-R-DMG-04-014",
      "UT-R-DMG-04-015",
      // RES-004-TATIANA-EX（Issue #225）: `SKL_TATIANA_SAGE_EX`の
      // `ACT_TATIANA_SAGE_EX_DEBUFF`（`direction: OUTGOING`／`damageType: null`／
      // `CONSTANT -1.0`）を、対象別条件で振り分けられた実AOE解決から実際に付与し、
      // 保持者の次の攻撃で与ダメージ倍率が0まで落ちること（最終ダメージは
      // R-DMG-02（最終化）#3の最低1ダメージで止まる）まで実ライフサイクルで固定する。
      "IT-UNIT-TATIANA-SAGE-004",
      "IT-UNIT-TATIANA-SAGE-005",
      "IT-UNIT-TATIANA-SAGE-006",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  // DMG-011（Issue #186、M8完了監査）でR-DMG-05「ダメージイベント順」を完了計上した。
  // #4（`DamageWillBeApplied`）は`DMG-001`が実装したが、残る#5（防御介入、`DMG-006`）・
  // #7（シールド／サブユニット、`DMG-004`／`DMG-005`）・#9（リンク／反射、`DMG-007`／
  // `DMG-006`）が4Taskへまたがり、各Taskは自分が追加したイベントの前後関係だけを
  // 検証していた。9手順が1本の列として成立していることを固定するのが
  // `IT-AUDIT-M8-001`で、実 `catalog/` の全production戦闘の全ヒットを対象にする。
  {
    ruleId: "R-DMG-05",
    testCaseIds: [
      // #1〜#9を通しで（production全戦闘・全ヒット）。
      "IT-AUDIT-M8-001",
      // #4 `DamageWillBeApplied`（TIMING）の位置と、その連鎖後の前提再検証。
      "UT-R-DMG-05-001",
      "UT-R-DMG-05-002",
      "UT-R-DMG-05-003",
      "UT-R-DMG-05-004",
      "UT-R-DMG-05-005",
      "UT-R-DMG-05-006",
      // #2/#3 命中判定・会心判定のPS連鎖と、その途中終了。
      "UT-R-DMG-05-007",
      "UT-R-DMG-05-008",
      "UT-R-DMG-05-009",
      // #7 シールド→サブユニット→HPの適用順（`SCN-BTL-015`）と保存則。
      "SCN-BTL-015",
      "IT-AUDIT-M8-002",
      // #9 リンク・反射の追加イベントと、そこから再びリンク・反射が起きないこと。
      "SCN-BTL-016",
      "IT-AUDIT-M8-003",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // REF-022（Issue #351）でR-DMG-06「攻撃時追加ダメージ」を新設した。
  // `APPLY_ATTACK_DAMAGE_BONUS`はM7-004が実装しテストも存在したが、
  // `07_戦闘ルール詳細.md`にはR-SUB-02の除外条項しか無く、加算そのものの
  // 規定とルール登録が欠けていた（R-HIT-04/05・R-CRT-03と同じ
  // 「production定義だけが存在」の後追いルール化）。
  {
    ruleId: "R-DMG-06",
    testCaseIds: [
      // #1 付与時snapshot（formulaの1回評価とAppliedEffect保持）。
      "UT-R-BON-ATTACK-DMG-001",
      // #2 ヒットへの加算、#3 ダメージ無効による上限、#4 回避時の非加算。
      "UT-R-BON-ATTACK-DMG-002",
      "UT-R-BON-ATTACK-DMG-003",
      "UT-R-BON-ATTACK-DMG-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-DMG-07",
    testCaseIds: [
      // 付与時の焼き込みとR-DMG-04合成からの除外。
      "UT-R-DMG-07-001",
      "UT-R-DMG-07-002",
      // 閾値判定・不参加条件・R-DMG-03減衰・下限0の純関数ポリシー。
      "UT-R-DMG-07-003",
      "UT-R-DMG-07-004",
      "UT-R-DMG-07-005",
      "UT-R-DMG-07-006",
      // 一括INCOMING_HIT消費からの除外とインスタンス指定消費。
      "UT-R-DMG-07-007",
      // full stack: 軽減・境界・消費枯渇による途中失効、サブユニット追加ヒットへの適用。
      "UT-R-DMG-07-008",
      "UT-R-DMG-07-009",
      "UT-R-DMG-07-010",
      "UT-R-DMG-07-011",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },

  // HEAL: 回復計算
  {
    ruleId: "R-HEAL-01",
    testCaseIds: [
      "UT-R-HEAL-01-001",
      "UT-R-HEAL-01-002",
      "UT-R-HEAL-01-003",
      "UT-R-HEAL-01-004",
      "UT-R-HEAL-01-005",
      "UT-R-HEAL-01-006",
      "UT-R-HEAL-01-007",
      "UT-R-HEAL-01-008",
      "IT-UNIT-LUCIE-COMPANION-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-HEAL-02",
    testCaseIds: ["UT-R-HEAL-02-001", "UT-R-HEAL-02-002", "UT-R-HEAL-02-003"],
    kinds: ["POSITIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-HEAL-03",
    testCaseIds: [
      "UT-R-HEAL-03-001",
      "UT-R-HEAL-03-002",
      "UT-R-HEAL-03-003",
      "UT-R-HEAL-03-004",
      "IT-UNIT-LUCIE-COMPANION-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-HEAL-04",
    testCaseIds: [
      "UT-R-HEAL-04-001",
      "UT-R-HEAL-04-002",
      "UT-R-HEAL-04-004",
      "UT-R-HEAL-04-005",
      "UT-R-HEAL-04-006",
      "UT-R-HEAL-04-007",
      "UT-R-HEAL-04-008",
      "UT-R-HEAL-04-009",
      "UT-R-HEAL-04-010",
      "UT-R-HEAL-04-011",
      "UT-R-HEAL-04-012",
      "UT-R-HEAL-04-013",
      "UT-R-HEAL-04-014",
      "UT-R-HEAL-04-015",
      "UT-R-HEAL-04-016",
      "UT-R-HEAL-04-017",
      "UT-R-HEAL-04-018",
      "UT-R-HEAL-04-019",
      "UT-R-HEAL-04-020",
      "UT-R-HEAL-04-021",
      // 転送先が演習の敵だった場合のスコア減算（R-TEX-02 #5、Issue #503）。
      "UT-R-HEAL-04-022",
      "IT-UNIT-ELENA-MOODMAKER-004",
      "IT-UNIT-ELENA-MOODMAKER-005",
      "IT-UNIT-ELENA-MOODMAKER-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

  // SHD: シールド
  {
    ruleId: "R-SHD-01",
    testCaseIds: [
      "UT-R-SHD-01-001",
      "UT-R-SHD-01-002",
      "UT-R-SHD-01-003",
      "UT-R-SHD-01-004",
      "UT-R-SHD-01-005",
      "UT-R-SHD-01-006",
      "UT-R-SHD-01-007",
      "UT-R-SHD-01-008",
      "UT-R-SHD-01-009",
      "UT-R-SHD-01-010",
      "UT-R-SHD-01-011",
      "UT-R-SHD-01-012",
      "UT-R-SHD-01-013",
      "UT-R-SHD-01-014",
      "UT-R-SHD-01-015",
      "UT-R-SHD-01-016",
      "UT-R-SHD-01-017",
      "UT-R-SHD-01-018",
      "UT-R-SHD-01-019",
      "UT-R-SHD-01-020",
      "UT-R-SHD-01-021",
      // REF-044（Issue #391）でユニット効果軸へ移送した。`shieldType: EN` の
      // タイプ別プール（EN攻撃だけを受け物理は素通りさせる）と枯渇失効に伴う
      // R-EFF-09カスケードは `IT-UNIT-LILY-SINGER-006`、`decay` の行動ごとの漸減と
      // 4行動での枯渇失効は `IT-UNIT-SHIRANA-LUCKY-004` が持つ。
      "IT-UNIT-LILY-SINGER-006",
      "IT-UNIT-SHIRANA-LUCKY-004",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-SHD-02",
    testCaseIds: [
      "UT-R-SHD-02-001",
      "UT-R-SHD-02-002",
      "UT-R-SHD-02-003",
      "UT-R-SHD-02-004",
      "UT-R-SHD-02-005",
      "UT-R-SHD-02-006",
      "UT-R-SHD-02-007",
      // REF-044（Issue #391）: プールを超えた分だけがHPへ抜けることを実 production
      // 定義で固定する。
      "IT-UNIT-AOI-GUARDIAN-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-SHD-03",
    testCaseIds: [
      "UT-R-SHD-03-001",
      "UT-R-SHD-03-002",
      "UT-R-SHD-03-003",
      "PROP-SHD-03-001",
      "PROP-SHD-03-002",
      // REF-044（Issue #391）でユニット効果軸へ移送した。振り分け5欄の合計が
      // 計算ダメージと一致することを実 production 定義で固定する。
      "IT-UNIT-AOI-GUARDIAN-005",
      // 第2項で破棄された超過分がユニット別集計（`10_API設計.md`「集計セマンティクス」）
      // へ算入されることを固定する。
      "UT-UNIT-SUMMARY-007",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "PROPERTY"],
  },

  // SUB: サブユニット
  // DMG-005（Issue #190）: サブユニットの耐久力・吸収順・追加ダメージ・追加デバフを
  // 実ライフサイクルへ配線した。
  {
    ruleId: "R-SUB-01",
    testCaseIds: [
      "UT-R-SUB-01-001",
      "UT-R-SUB-01-002",
      "UT-R-SUB-01-003",
      "UT-R-SUB-01-004",
      "UT-R-SUB-01-005",
      "UT-R-SUB-01-006",
      "UT-R-SUB-01-007",
      "UT-R-SUB-01-008",
      "UT-R-SUB-01-009",
      "UT-R-SUB-01-010",
      "UT-R-SUB-01-011",
      // REF-045（Issue #392）でユニット効果軸へ移送した。実 production の
      // サブユニットが被ダメージを吸収し、耐久力を超えた分だけHPへ抜けて枯渇時に
      // 失効すること・存続期間を書かないインスタンスが行動終了で減らないこと。
      "IT-UNIT-SHIRANA-SORA-004",
      "IT-UNIT-OLGA-VETERAN-007",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-SUB-02",
    testCaseIds: [
      "UT-R-SUB-02-001",
      "UT-R-SUB-02-002",
      "UT-R-SUB-02-003",
      "UT-R-SUB-02-004",
      "UT-R-SUB-02-005",
      "UT-R-SUB-02-006",
      "UT-R-SUB-02-007",
      "UT-R-SUB-02-008",
      "UT-R-SUB-02-009",
      "UT-R-SUB-02-010",
      "UT-R-SUB-02-011",
      "UT-R-SUB-02-012",
      "UT-R-SUB-02-013",
      "UT-R-SUB-02-014",
      "UT-R-SUB-02-015",
      "UT-R-SUB-02-016",
      // REF-045（Issue #392）でユニット効果軸へ移送した。保持数だけ追加ヒットが
      // 増えること・付随デバフが重複して積まれること・追加ダメージのタイプが
      // 定義の宣言（EN）で決まるか契機の攻撃から引き継がれるか。
      "IT-UNIT-SHIRANA-SORA-005",
      "IT-UNIT-NADYA-SUCCESSOR-004",
      "IT-UNIT-OLGA-VETERAN-007",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },

  // FUP: 追撃（攻撃ライダー）
  // Issue #474: 「当該攻撃に威力Xのダメージ…を追加する」（`SKL_SUIRAN_CHAOS_PS3`／
  // `SKL_CHIYURU_MAZE_PS2`／`SKL_FEE_ACTOR_PS1`）を、保持者のAS/EXスキル使用の攻撃へ
  // 相乗りする`APPLY_FOLLOW_UP_ATTACK`として実装した。
  {
    ruleId: "R-FUP-01",
    testCaseIds: [
      // Catalog表現: payload構造・NEXT_OUTGOING_ATTACK必須・onHitEffect参照検証。
      "UT-CAT-ACT-111",
      "UT-CAT-ACT-112",
      "UT-CAT-ACT-113",
      "UT-CAT-ACT-114",
      "UT-CAT-IDX-105",
      "UT-CAT-IDX-106",
      "UT-CAT-IDX-107",
      // ライダー捕捉: 消費と同じ到達点・対象集約・命中/会心の合算。
      "UT-R-FUP-01-001",
      "UT-R-FUP-01-002",
      "UT-R-FUP-01-003",
      // 追撃解決: 保持者ステータスでの通常ダメージ計算・会心継承・onHitEffect付与。
      "UT-R-FUP-01-004",
      "UT-R-FUP-01-005",
      "UT-R-FUP-01-006",
      // 付与: isFollowUpAttack判別子・重複可・消費残数の保持。
      "UT-R-FUP-01-007",
      // スキル使用単位: 全step解決後・SkillUseCompleted前の1回だけの解決と消費失効、
      // 複数DAMAGE actionでも1回・複数ライダーの各1回・非攻撃スキルの非消費・
      // 追撃中断のSkillUseInterrupted伝播。
      "UT-R-FUP-01-008",
      "UT-R-FUP-01-009",
      "UT-R-FUP-01-010",
      "UT-R-FUP-01-011",
      "UT-R-FUP-01-012",
      // R-TEX-06 #5のフェーズ末尾順序のうち「追撃 → `EffectSequence`スコープの
      // `RuntimeCounterReset`」は演習に限らない通常戦闘の挙動であるため、追撃ヒットが
      // counter更新の対象に入ることをR-FUP-01側の証跡として持つ（Issue #523）。
      "UT-R-FUP-01-013",
      // production実ライフサイクル（3ユニット）。
      "IT-UNIT-SUIRAN-CHAOS-011",
      "IT-UNIT-CHIYURU-MAZE-006",
      "IT-UNIT-FEE-ACTOR-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },

  // INT: 防御介入
  // DMG-006（Issue #188）: 引き寄せ・肩代わり・反射・致死耐えを実ライフサイクルへ
  // 配線した。R-INT-01 #3（`APPLY_DAMAGE_LINK`）はDMG-007（Issue #187）が
  // R-LNK-01〜03とともに実装した。
  {
    ruleId: "R-INT-01",
    testCaseIds: [
      "UT-R-INT-01-001",
      "UT-R-INT-01-002",
      "UT-R-INT-01-003",
      "UT-R-INT-01-004",
      "UT-R-INT-01-005",
      "UT-R-INT-01-006",
      "UT-R-INT-01-007",
      "UT-R-INT-01-008",
      "UT-R-INT-01-010",
      "UT-R-INT-01-011",
      "UT-R-INT-01-012",
      "UT-R-INT-01-013",
      "UT-R-INT-01-014",
      // 引き寄せ（#1）・肩代わり（#2）・反射（#4）・致死耐え（#5）をproduction定義の
      // ままそれぞれの保持者側で見る。
      "IT-UNIT-KARINA-DOWNER-005",
      "IT-UNIT-EVIE-ECO-005",
      "IT-UNIT-LUNA-HUNGRY-004",
      "IT-UNIT-KOTOHA-REBEL-006",
      // #5の耐えで適用されなかった分がユニット別集計（`10_API設計.md`
      // 「集計セマンティクス」）へ算入されることを固定する。
      "UT-UNIT-SUMMARY-008",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-INT-02",
    testCaseIds: [
      "UT-R-INT-02-001",
      "UT-R-INT-02-002",
      "UT-R-INT-02-003",
      "UT-R-INT-02-004",
      "UT-R-INT-02-005",
      "UT-R-INT-02-010",
      "UT-R-INT-02-011",
      "IT-UNIT-EVIE-ECO-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-INT-03",
    testCaseIds: [
      "UT-R-INT-03-001",
      "UT-R-INT-03-002",
      "UT-R-INT-03-010",
      "UT-R-INT-03-011",
      "UT-R-INT-03-012",
      "IT-UNIT-LUNA-HUNGRY-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE"],
  },

  // LNK: リンク
  // DMG-007（Issue #187）: R-INT-01 #3のリンク状態を実ライフサイクルへ配線した。
  {
    ruleId: "R-LNK-01",
    testCaseIds: [
      "UT-R-LNK-01-001",
      "UT-R-LNK-01-002",
      "UT-R-LNK-01-003",
      "UT-R-LNK-01-010",
      "UT-R-LNK-01-011",
      // REF-039（Issue #386）: `IT-CAP-DAMAGE-LINK-STATE-PROD-001`〜`003` の移送先。
      // `linkTo: SELF`／`linkTo: BINDING` の焼き込みと転送、元ダメージが減らないこと、
      // 期間の減算主体が付与者であることを、実 production スキルの使用から通して見る。
      "IT-UNIT-SUIRAN-CASINO-004",
      "IT-UNIT-SUIRAN-CASINO-005",
      "IT-UNIT-CHIZURU-DOMESTIC-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-LNK-02",
    testCaseIds: [
      "UT-R-LNK-02-001",
      "UT-R-LNK-02-002",
      "UT-R-LNK-02-003",
      "UT-R-LNK-02-004",
      "UT-R-LNK-02-010",
      "UT-R-LNK-02-011",
      "UT-R-LNK-02-012",
      "UT-R-LNK-02-013",
      "UT-R-LNK-02-030",
      "UT-R-LNK-02-031",
      "UT-R-LNK-02-033",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-LNK-03",
    testCaseIds: [
      "UT-R-LNK-03-010",
      "UT-R-LNK-03-020",
      "UT-R-LNK-03-034",
      "UT-R-LNK-03-035",
      "UT-R-LNK-03-036",
      "UT-R-LNK-03-037",
    ],
    kinds: ["POSITIVE", "NEGATIVE"],
  },

  // DOT: 継続ダメージ
  // DMG-008（Issue #189）: 継続ダメージ・炎上・毒を実ライフサイクルへ配線した。
  // REF-043（Issue #390）でユニット効果軸へ移送し、実 production の付与を
  // 保持者自身の行動開始（`fireContinuousHealsOnActionStart`）へ通した発生量・
  // シールドへの振り分け・独立Reducer復元として検証する。
  {
    ruleId: "R-DOT-01",
    testCaseIds: [
      "UT-R-DOT-01-001",
      "UT-R-DOT-01-002",
      "UT-R-DOT-01-003",
      "UT-R-DOT-01-004",
      "UT-R-DOT-01-005",
      "UT-R-DOT-01-006",
      "IT-UNIT-SENKA-SCHEMER-005",
      "IT-UNIT-CHIYURU-MAZE-005",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-DOT-02",
    testCaseIds: [
      "UT-R-DOT-02-001",
      "UT-R-DOT-02-002",
      "UT-R-DOT-01-005",
      "IT-UNIT-MAO-COMMITTEE-009",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-DOT-03",
    testCaseIds: [
      "UT-R-DOT-03-001",
      "UT-R-DOT-03-002",
      "UT-R-DOT-03-003",
      "IT-UNIT-SENKA-SCHEMER-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-DOT-04",
    testCaseIds: [
      "UT-R-DOT-04-001",
      "UT-R-DOT-04-002",
      "UT-R-DOT-04-003",
      "UT-R-DOT-04-004",
      "UT-R-DOT-04-005",
      "UT-R-DOT-04-006",
      "UT-R-DOT-04-007",
      "UT-R-DOT-04-008",
      "UT-R-DOT-04-009",
      "UT-R-DOT-04-010",
      "UT-R-DOT-04-011",
      "IT-UNIT-LUCIE-COMPANION-006",
      "IT-UNIT-CHIYURU-MAZE-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

  // STS: 状態異常
  {
    ruleId: "R-STS-01",
    testCaseIds: [
      // M7-011（Issue #265）: `EffectApplied.categories`が状態異常へ`STATUS`と
      // `DEBUFF`の両方を与え、STEALTH等の有利な`APPLY_STATUS`には与えない。
      "UT-R-EFF-01-061",
      "UT-R-EFF-01-062",
      "IT-UNIT-KEI-JACKKNIFE-007",
      "IT-UNIT-SIENA-DIVA-007",
      "UT-CAT-ACT-075",
      "UT-R-EFF-02-004",
      "UT-R-EFF-02-013",
      "UT-R-EFF-03-017",
      "UT-R-STS-01-001",
      // RES-004-STATUS-CONDITION（Issue #224）: 「状態異常として定義された効果」は
      // `01_ユビキタス言語.md`が列挙する5種であり、`APPLY_STATUS`の気絶・凍結・暗闇に
      // 加えて`APPLY_CONTINUOUS_DAMAGE`の炎上・毒も`STATUS`へ分類する（固定継続
      // ダメージは名前付きの状態異常ではないため対象外）。
      "UT-R-EFF-02-007",
      "UT-R-EFF-02-008",
      "UT-R-EFF-02-009",
      "IT-UNIT-CHIYURU-MAZE-004",
      // 公開API（`EffectStateResponse.category`）も同じ分類元
      // （`EffectSnapshot.categories`）を読む。継続ダメージは`magnitude`が正値のため、
      // 符号から導くと毒・炎上がAPI上だけ`BUFF`になりR-STS-01と矛盾していた。
      // API層の証跡は`simulate-battle-response-mapper.test.ts`の`API-RESP-012G`
      // （台帳が集計する`UT`/`IT`等の接頭辞を持たないためIDとしては挙げない）。
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-STS-02",
    testCaseIds: [
      "UT-R-ACT-01-001",
      "UT-R-ACT-01-002",
      "UT-R-EFF-01-046",
      "UT-R-EFF-01-051",
      "UT-R-STS-02-001",
      "UT-R-STS-02-002",
      "UT-R-STS-02-003",
      "UT-R-STS-02-004",
      "UT-R-STS-02-005",
      "UT-R-STS-02-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-STS-03",
    testCaseIds: [
      "UT-R-STS-03-001",
      "UT-R-STS-03-002",
      "UT-R-STS-03-003",
      "UT-R-STS-03-004",
      "UT-R-STS-03-005",
      "UT-R-STS-03-006",
      "UT-R-STS-03-007",
      "UT-R-STS-03-008",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
  {
    ruleId: "R-STS-04",
    testCaseIds: [
      "UT-R-HIT-03-001",
      "UT-R-HIT-03-002",
      "UT-R-HIT-03-003",
      "UT-R-HIT-03-004",
      "UT-R-HIT-03-005",
      "UT-R-HIT-03-006",
      "UT-R-HIT-03-007",
      "UT-R-HIT-03-008",
      "UT-R-HIT-03-009",
      "UT-R-HIT-03-010",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },

  // CFS/DTH: 混乱と幻惑（DMG-009、Issue #193）
  {
    ruleId: "R-CFS-01",
    testCaseIds: [
      "UT-R-CFS-01-001",
      "UT-R-CFS-01-002",
      "UT-R-CFS-01-003",
      "UT-R-CFS-01-004",
      "UT-R-CFS-01-005",
      "UT-R-CFS-01-006",
      "UT-R-CFS-01-007",
      "UT-R-CFS-01-008",
      // `BINDING_DERIVED` の `base` binding まで再帰的に反転すること（REF-040で
      // 是正）。base を残すと `area` の同陣営絞りで候補が0件になる。binding直下だけ
      // でなく `fallback` ツリー内の `BINDING_DERIVED` も同じ深さまで追随する。
      "UT-R-CFS-01-009",
      "UT-R-CFS-01-010",
      "IT-UNIT-OLGA-VETERAN-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-CFS-02",
    testCaseIds: [
      "UT-R-CFS-02-001",
      "UT-R-CFS-02-002",
      "UT-R-CFS-02-003",
      "UT-R-CFS-02-004",
      "UT-R-CFS-02-005",
      "UT-R-CFS-02-006",
      "UT-R-CFS-02-101",
      "UT-R-CFS-02-102",
      "UT-R-CFS-02-103",
      "IT-UNIT-OLGA-VETERAN-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-DTH-01",
    testCaseIds: [
      "UT-R-DTH-01-001",
      "UT-R-DTH-01-002",
      "UT-R-DTH-01-003",
      "UT-R-DTH-01-004",
      // 変換後に敵HPが実際に増えた分の演習スコア減算（R-TEX-02 #5、Issue #503）。
      "UT-R-DTH-01-005",
      "UT-R-DTH-01-006",
      "UT-R-EFF-02-028",
      "IT-UNIT-TATIANA-SAGE-010",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

  // EFF: 効果
  {
    ruleId: "R-EFF-01",
    testCaseIds: [
      // M7-011（Issue #265）: `EffectApplied` payloadの効果分類
      // （`effectKind`/`categories`、`08_ドメインイベント.md`「EffectApplied payload」）。
      "UT-R-EFF-01-059",
      "UT-R-EFF-01-060",
      "UT-R-EFF-01-061",
      "UT-R-EFF-01-062",
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
      // TGT-004フェーズ1（Issue #167）: SKILL_USE単位の
      // grantedSkillUseId初期化・減算（applied-effect.ts/applied-effect-duration.ts）。
      "UT-R-EFF-01-035",
      "UT-R-EFF-01-036",
      "UT-R-EFF-01-037",
      "UT-R-EFF-01-038",
      "UT-R-EFF-01-039",
      "UT-R-EFF-01-040",
      "UT-R-EFF-01-041",
      "UT-R-EFF-01-063",
      "UT-R-EFF-01-064",
      "UT-R-EFF-01-065",
      "UT-R-EFF-01-066",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-02: M7-001（Issue #181）。効果カテゴリ分類（`effect-category-classifier.ts`）・
  // 解除件数上限・付与順優先・R-EFF-09カスケード・EffectRemoved/StateDelta/CombatStat
  // 再計算（`effect-removal-service.ts`）と実ライフサイクル配線
  // （`effect-action-group-resolver.ts`のREMOVE_EFFECTS branch、REMOVE_MARKERのcount）。
  // REMOVE_BUFF_CATEGORY・REMOVE_EFFECTS_COUNT_LIMITを実production Catalog
  // （Mihime/Lily/Mao）に対して`IT-UNIT-MIHIME-SNIPER-004`／`IT-UNIT-LILY-SINGER-005`
  // （`maxRemovals` 3／5の頭打ち）と`IT-UNIT-MAO-COMMITTEE-008`（BUFF+DEBUFFの2カテゴリ・
  // SHIELDは巻き込まない・解除の公開差分だけからの独立Reducer復元）が検証する。
  // 状態異常種別限定免疫（R-EFF-03、`CAP_SPECIFIC_IMMUNITY`）はM7-001B（Issue #243）で完了した。
  // M7-001A（Issue #242、`REMOVE_EFFECTS_CATEGORY_GAP`）: SHIELD/SUBUNITカテゴリの
  // 実行時拒否を解除した。DMG-004（`CAP_SHIELD`）/DMG-005（`CAP_SUBUNIT`）が
  // シールド・サブユニットを`AppliedEffect.shield`/`AppliedEffect.subUnit`として
  // 実行時状態にしたため、他カテゴリと同じ`removeEffects`経路でインスタンスごと解除
  // できる（プール・耐久力はインスタンス集合からの導出値）。`UT-R-EFF-02-024/025`が
  // シールド・サブユニットの非負`magnitude`が`BUFF`へ落ちないこと（`REMOVE_EFFECTS`の
  // BUFF解除に巻き込まれない）を分類元で固定し、`UT-R-EFF-02-022/023`が実resolver経路の
  // 解除を、`IT-UNIT-YUI-HEIR-005`がYui EX（敵単体のシールド全解除→防御力デバフ→
  // 攻撃の順序、無属性・EN属性の両プール）と`IT-UNIT-OLGA-VETERAN-006`がOlga PS1
  // （自身のシールド・サブユニット全解除→同じstepでの3体付与）をproduction Catalog
  // 定義に対して検証する。
  // M7-001C（Issue #244）: 残りのREMOVE_BUFF_CATEGORY対象（Noel PS2・Shouka EX/AS3・
  // Senka PS2）をcategories:["BUFF"]へ変換した。`IT-UNIT-SHOUKA-SCHEMER-005`が
  // EX 3件／AS3 1件の`maxRemovals`と対象選択（ENEMY、SELFではない）を、
  // `IT-UNIT-NOEL-RUMBLE-005`が上限なしの全解除とバフ／デバフの向きによる分岐を、
  // `IT-UNIT-SENKA-CHRISTMAS-004`がTRIGGER_TARGET配線（契機の対象だけ、傍観者の敵は
  // 対象外）を、いずれもresolveSkillUse/PassiveActivationRuntime経由の実resolverで
  // 検証する。
  // Tarisa PS1の条件付きREMOVE_MARKER（与ダメージ<=10で3つ解除）は、トリガーイベント
  // payloadをresolution.stepsで参照する手段が未実装のため対象外（新機能実装が必要な
  // ため、監査専用のM7-010ではなく専用task M7-001D、Issue #247へ引き継ぐ）。
  {
    ruleId: "R-EFF-02",
    testCaseIds: [
      "UT-R-EFF-02-001",
      "UT-R-EFF-02-002",
      "UT-R-EFF-02-003",
      "UT-R-EFF-02-004",
      "UT-R-EFF-02-005",
      "UT-R-EFF-02-006",
      "UT-R-EFF-02-007",
      "UT-R-EFF-02-008",
      "UT-R-EFF-02-009",
      "UT-R-EFF-02-010",
      "UT-R-EFF-02-011",
      "UT-R-EFF-02-012",
      "UT-R-EFF-02-013",
      "UT-R-EFF-02-014",
      "UT-R-EFF-02-015",
      "UT-R-EFF-02-016",
      "UT-R-EFF-02-020",
      "UT-R-EFF-02-021",
      "UT-R-EFF-02-022",
      "UT-R-EFF-02-023",
      "UT-R-EFF-02-024",
      "UT-R-EFF-02-025",
      // DMG-003A（Issue #295）: 会心不可（`CRITICAL_PREVENTION`）は
      // 状態異常ではないが保持者を弱化するため`DEBUFF`へ分類する。対になる
      // `CRITICAL_GUARANTEE`は`BUFF`のまま。
      "UT-R-EFF-02-026",
      "UT-R-EFF-02-027",
      // REF-044（Issue #391）でユニット効果軸へ移送した。実 resolver の分類と、
      // バフ解除／デバフ解除のどちらに当たるかを production 定義で固定する。
      "IT-UNIT-TARISA-TROUBLEMAKER-010",
      "IT-UNIT-MIKOTO-SURVIVOR-007",
      // REF-042（Issue #389）でユニット効果軸へ移送した。
      "IT-UNIT-MIHIME-SNIPER-004",
      "IT-UNIT-LILY-SINGER-005",
      "IT-UNIT-MAO-COMMITTEE-008",
      "IT-UNIT-SHOUKA-SCHEMER-005",
      "IT-UNIT-NOEL-RUMBLE-005",
      "IT-UNIT-SENKA-CHRISTMAS-004",
      "IT-UNIT-YUI-HEIR-005",
      "IT-UNIT-OLGA-VETERAN-006",
      "UT-CAT-COND-037",
      "UT-CAT-COND-038",
      "UT-CAT-COND-039",
      "UT-CAT-COND-040",
      "UT-CAT-COND-041",
      "UT-CAT-COND-042",
      "UT-CAT-COND-043",
      // REF-037（Issue #384）でユニット効果軸へ移送した。`statKinds`の絞り込みは
      // IT-UNIT-SHOUKA-SCHEMER-004、単一BRANCHが分岐を一度だけ確定することは
      // IT-UNIT-NOEL-RUMBLE-004が持つ。`SKL_CHIYURU_MAZE_AS1`（毒）・
      // `SKL_FLUTE_INFLUENCER_PS2`（デバフ）・`SKL_MAIA_LAZY_AS1`（バフ）・
      // `SKL_NOEL_RUMBLE_AS1`（炎上）の成立／不成立は、それぞれのユニットの`-001`
      // 振る舞い表が実行結果まで固定している（`it.each`のためここからは参照できない）。
      "IT-UNIT-SHOUKA-SCHEMER-004",
      "IT-UNIT-NOEL-RUMBLE-004",
      "UT-CAT-IDX-092",
      "UT-CAT-IDX-093",
      "UT-CAT-IDX-094",
      "UT-CAT-IDX-095",
      "UT-CAT-IDX-096",
      "UT-CAT-IDX-097",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-03: M7-001B（Issue #243、EFFECT_IMMUNITY_STATUS_GRANULARITY）。
  // `EFFECT_IMMUNITY`の`statusKinds`によるSTATUSカテゴリの状態異常種別限定
  // （`effect-category-classifier.ts`のMARKER分類追加＋`effect-immunity-service.ts`の
  // `findBlockingImmunity`/`rejectEffectApplication`）と、実ライフサイクル配線
  // （`effect-action-group-resolver.ts`のEFFECT_IMMUNITY branch（免疫登録）、
  // APPLY_STAT_MOD/APPLY_STATUS/APPLY_MARKER branchでの付与拒否・
  // `EffectApplicationRejected`・R-EFF-07 STATUS_BLOCKED消費による免疫自身の失効）。
  {
    ruleId: "R-EFF-03",
    testCaseIds: [
      "UT-R-EFF-03-001",
      "UT-R-EFF-03-002",
      "UT-R-EFF-03-003",
      "UT-R-EFF-03-004",
      "UT-R-EFF-03-005",
      "UT-R-EFF-03-006",
      "UT-R-EFF-03-007",
      "UT-R-EFF-03-008",
      "UT-R-EFF-03-009",
      "UT-R-EFF-03-010",
      "UT-R-EFF-03-011",
      "UT-R-EFF-03-012",
      "UT-R-EFF-03-013",
      "UT-R-EFF-03-014",
      "UT-R-EFF-03-015",
      "UT-R-EFF-03-016",
      "UT-R-EFF-03-017",
      "UT-R-EFF-03-018",
      // DMG-003A（Issue #295）: 会心不可が`DEBUFF`免疫で実際に付与拒否されることを
      // production定義で固定する。REF-044（Issue #391）でユニット効果軸へ移送し、
      // 免疫も合成ではなく実 `ACT_TARISA_TROUBLEMAKER_EX_IMMUNITY` を使う形になった。
      "IT-UNIT-TARISA-TROUBLEMAKER-010",
      // M7-001B（Issue #243、`CAP_SPECIFIC_IMMUNITY`）の`statusKinds`（種別限定
      // 免疫）は、REF-043（Issue #390）でユニット効果軸へ移送した。production
      // 代表2件それぞれで、指定種別（気絶）が拒否され、同じ行動のstat debuffと
      // 別種別（凍結）は通ることを実 resolver で固定する。
      "IT-UNIT-AOI-GUARDIAN-004",
      "IT-UNIT-HIIRO-LONEWOLF-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-04: EFF-003（Issue #159）。行動単位期間の減算・失効
  // （`applied-effect-duration.ts`のowner解決、`duration-expiry-service.ts`の
  // cascade・CombatStat再計算、`action-completion.ts`への実ライフサイクル
  // 配線）。REF-041（Issue #388）でユニット効果軸へ移送し、EFFECT_TARGET/
  // EFFECT_SOURCE/BATTLEの3種類のownerを1件ずつ、実 `recordActionCompletion` を
  // 通した行動終了の列として検証する。
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
      "IT-UNIT-DOROTHEA-PIONEER-005",
      "IT-UNIT-CLARA-TSUNDERE-004",
      "IT-UNIT-KARINA-DOWNER-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-05: `effective-effect-selector.ts`の選択規則自体（次点繰上げ含む）は
  // 早期からUT-R-EFF-05-001〜013で単体検証済みだったが、Catalog Schemaの
  // `APPLY_STAT_MOD.stacking.mode`が`STACKABLE`しか許可せず、
  // `effect-action-group-resolver.ts`も`duplicate: true`固定で付与していたため、
  // 実ライフサイクルからduplicate:falseの重複なし経路・最強選択・次点繰上げ・
  // `EffectiveEffectChanged`のいずれにも到達できなかった。
  // M7-010（Issue #177、監査）が、完了責任を持っていたEFF-002（Issue #165）の
  // 所有者不在を検出し、同じギャップを持つ不完全変換テーマ
  // `STACK_LIMIT_ON_STAT_MOD`（1行）ごとM7-012（Issue #266）へ引き継いだ。
  //
  // M7-012（Issue #266）が`stacking.mode: NON_STACKABLE`と重複上限
  // `stacking.max`をCatalogスキーマ・Mapper（`effect-action-definition-factory.ts`）
  // へ追加し、resolverが`stacking.mode`から`duplicate`を導くよう配線したため、
  // 重複なし経路が実ライフサイクルから到達可能になった:
  // - 付与（`duplicate: false`）・最強選択・`EffectiveEffectChanged`→
  //   `CombatStatChanged`順序: UT-R-EFF-05-017/018（`applyEffectActionGroups`）
  // - 次点繰上げの実失効経路: UT-R-EFF-05-021（`expireEffects`）
  // - 重複上限（上限到達時は付与せず`resultKind: SKIPPED`、別定義は上限を
  //   共有しない）: UT-R-EFF-05-014〜016/019/020、および実production Catalogの
  //   `ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`（`stacking.max: 14`）を実付与経路から
  //   検証する`IT-UNIT-TARISA-TROUBLEMAKER-004`／`005`（REF-031／Issue #361 で
  //   機能軸 `IT-CAP-STAT-MOD-STACK-LIMIT-PROD-*` から移送）。
  //
  // `NON_STACKABLE`を宣言するproduction定義は現時点で存在しない（raw原文が
  // 明記するのは「重複可」だけで、重複なしへの再分類はどの台帳行も要求して
  // いない）ため、`IT-`層は重複上限だけを対象にし、重複なし経路はR-EFF-11の
  // `EFFECT_SEQUENCE`スコープと同じく明示的な実ライフサイクルテストで検証する。
  {
    ruleId: "R-EFF-05",
    testCaseIds: [
      "UT-R-EFF-05-001",
      "UT-R-EFF-05-002",
      "UT-R-EFF-05-003",
      "UT-R-EFF-05-004",
      "UT-R-EFF-05-005",
      "UT-R-EFF-05-006",
      "UT-R-EFF-05-007",
      "UT-R-EFF-05-008",
      "UT-R-EFF-05-009",
      "UT-R-EFF-05-010",
      "UT-R-EFF-05-011",
      "UT-R-EFF-05-012",
      "UT-R-EFF-05-013",
      "UT-R-EFF-05-014",
      "UT-R-EFF-05-015",
      "UT-R-EFF-05-016",
      "UT-R-EFF-05-017",
      "UT-R-EFF-05-018",
      "UT-R-EFF-05-019",
      "UT-R-EFF-05-020",
      "UT-R-EFF-05-021",
      "UT-CAT-ACT-079",
      "UT-CAT-ACT-080",
      "UT-CAT-ACT-081",
      "UT-CAT-ACT-082",
      "IT-UNIT-TARISA-TROUBLEMAKER-004",
      "IT-UNIT-TARISA-TROUBLEMAKER-005",
      // Issue #519: `stacking.max`の重複数も、R-EFF-05の文言どおり同種
      // （`EffectKindKey`）単位で数える。鍵を宣言した定義群は定義をまたいで1つの
      // 上限を数え（UT-R-EFF-05-022）、宣言の無い定義は定義ID単位のまま
      // （UT-R-EFF-05-023、実Catalogの`max: 14`は上のIT-が引き続き担う）。
      // 鍵を共有する定義群が食い違う`max`を宣言できないことはCatalogロード時に
      // 保証する（UT-CAT-IDX-109/110）。
      "UT-R-EFF-05-022",
      "UT-R-EFF-05-023",
      "UT-CAT-IDX-109",
      "UT-CAT-IDX-110",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-06: EFF-003。ターン単位期間の減算・失効（`battle.ts`のTURN_ENDING
  // 配線）。REF-041（Issue #388）でユニット効果軸へ移送し、`IT-UNIT-SIENA-DIVA-006`が
  // 実production CatalogのTURN単位`duration`で、行動終了では減らないことと併せて検証する。
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
      "IT-UNIT-SIENA-DIVA-006",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-07: EFF-003。消費条件（NEXT_OUTGOING_ATTACK/NEXT_INCOMING_ATTACK/
  // OUTGOING_HIT/INCOMING_HIT、`damage-application-service.ts`への実
  // ライフサイクル配線）。`STATUS_BLOCKED`は状態付与無効化の仕組み自体が
  // 未実装（M7-001）のため到達不能のまま残す。REF-041（Issue #388）でユニット効果軸へ
  // 移送し、`IT-UNIT-FEE-ACTOR-005`が実production CatalogのNEXT_OUTGOING_ATTACK消費を
  // 実ダメージpipelineで検証する（消費させた一撃自身に効果が乗る遅延失効を含む）。
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
      "UT-R-EFF-07-014",
      "UT-R-EFF-07-015",
      "IT-UNIT-FEE-ACTOR-005",
      "IT-UNIT-TATIANA-SAGE-005",
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
  // R-EFF-09: linkedEffectGroupの親子連動カスケード。EFF-003（Issue #159）が
  // `AppliedEffect`同士、EFF-004（Issue #160）が`MarkerState`同士を種別ごとに
  // 実装し、`UT-R-EFF-09-001`〜`008`と`IT-UNIT-HARRIET-SAGE-004`／`005`
  // （UNIT_HARRIET_SAGEの実`linkedEffectGroupId` `HARRIET_CURSE_LINK`／
  // `HARRIET_BARRIER`。REF-041／Issue #388でユニット効果軸へ移送）が検証している。
  //
  // M7-010（Issue #177、監査）: しかしR-EFF-09の第1項「同じ
  // `linkedEffectGroupId`を持つ`AppliedEffect`**と**`MarkerState`は親子連動
  // グループとして扱う」は未実装で、`catalog-integrity.ts`が該当Catalog定義を
  // `UNSUPPORTED_MARKER_LINKED_GROUP`としてロード時点で拒否していたため、
  // 「SchemaやMapperが定義を受理するだけでは完了としない」という
  // 完了基準に照らして未完了へ戻した。
  //
  // M7-013（Issue #267）: そのcross-typeカスケードを実装して完了させた。
  // 種別ごとに分かれていた2つの収集関数を`model/linked-effect-group.ts`の
  // `collectLinkedGroupCascade`（`AppliedEffect`と`MarkerState`を同じBFSへ載せ、
  // `linkedEffectGroupRole`の`CHILD`例外も種別を問わず適用する）へ統合し、
  // カスケード分の除去・イベント発行を`effects/linked-group-cascade.ts`へ
  // 共通化して、失効（`expireEffects`）・解除（`removeEffects`）・Marker除去
  // （`removeMarkers`/`reduceMarkerStack`）・凍結解除（`removeFreezeEffectSteps`）の
  // 4経路すべてを同じ実装へ配線した。`catalog-integrity.ts`の拒否も撤去し、
  // production Catalogの2グループ（`TARISA_TROUBLEMAKER_PS1_LINK`／
  // `AOI_ELEGANT_AS1_KOUYOU_LINK`）を近似なしへ更新した。
  //
  // カスケードの通知粒度と失効順には2つの制約がある。
  // (1) 1インスタンスの除去ごとにPS/Memoryの即時連鎖へ通知する
  // （`notifyRemovalStep`。まとめて最後に通知すると、子の`EffectExpired`を
  // triggerにするPSがイベント順ではまだ存在する親Marker／親効果を除去済みとして
  // 観測し、`08_ドメインイベント.md`の「各イベントに対応するPS/Memory候補を
  // 直ちに解決する」契約を破る。`UT-R-EFF-09-020`が固定）。
  //
  // REF-042（Issue #389）: この粒度は**評価経路を問わない**（R-EFF-09）が、
  // `REMOVE_MARKER`／`REMOVE_EFFECTS`のEffectActionハンドラだけは同期版の
  // `removeMarkers`／`reduceMarkerStack`／`removeEffects`を直接呼んでいたため、
  // 同期callbackを持たない経路——PS自身のEffectSequence解決——では通知が
  // EffectAction 1件ぶんにまとまっていた。実 `catalog/` で連動グループの親Markerを
  // 外す2定義（`ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER`・
  // `ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU`）はどちらもPS経路にしか現れないため、
  // 実データでは規約が一度も守られていなかった。`removeEffectsSteps`／
  // `reduceMarkerStackSteps`を追加し、両ハンドラを`SteppedEffectActionHandler`へ変えて
  // 共通driver（`driveRemovalSteps`）から1除去ごとに駆動する — callbackがあれば
  // その場で通知し、無ければ`EFFECT_RESOLVED`としてdriverへ`yield`する。
  // `UT-R-EFF-09-025`〜`027`がgenerator側を、`IT-UNIT-TARISA-TROUBLEMAKER-008`が
  // 実 production 経路（子の失効 → watcher PSの発動 → 親Markerの除去）を固定する。
  //
  // 同時に、`yield`から再開する側の契約も要る（`consumeResolvedByDriver`）。
  // `takePending`が捕捉位置を進めるのは`yield`直前のrecorder末尾までで、driverが
  // その`yield`を処理する間に子連鎖が積んだイベントはその後ろへ入る。再開時に
  // 捨てないと次stepの`takePending`／EffectAction完了時の`innerEvents`が拾い直し、
  // 同じイベントが2度`resolveEvent`へ渡る（PSは発動済みGuardで覆い隠れるが、
  // Memoryやイベントごとに走るRuntimeCounter更新は二重に実行される）。同じ形で
  // `yield`していたDAMAGE・HEALのハンドラにも同じ欠落があった。
  // `UT-R-EFF-09-028`（複数インスタンスの`REMOVE_EFFECTS`）・`UT-R-EFF-09-029`
  // （多段DAMAGE）が、子連鎖のイベントが一度もdriverへ返らないことを固定する。
  // (2) カスケード対象の並びを`linkedEffectGroupRole`（`CHILD`→ロールなし→
  // `PARENT`）を第1キーに変更した（スキーマが禁じていない「同一グループに複数の
  // `PARENT`」で、カスケードされた`PARENT`が同グループの`CHILD`より先に失効し得た。
  // `UT-R-EFF-09-019`が固定）。
  //
  // 通知粒度とロール順の適用範囲は次の3点へ広がる。
  // (3) DAMAGE pipelineの消費失効（`DamageEventContext.consumeEffectDuration`／
  // `finalizeConsumedEffectDurations`）も凍結解除と同じステップ`yield`型の
  // generatorへ変え（`expireEffectsSteps`）、callbackがあればステップごとに
  // 同期通知、無ければ1ステップずつyieldしてdriverの更新stateを次の除去へ
  // 注入するようにした（`UT-R-EFF-09-022`が固定）。
  // (4) TURN_ENDINGの期間イベント（`EffectDurationReduced`/`EffectExpired`/
  // `MarkerUpdated`/`MarkerRemoved`）も`turnEndPassiveRuntime`へ発生順に通知し、
  // `finalizeResolutionScope`をその後（`06_戦闘状態遷移.md` TURN_ENDING #9）へ
  // 移した（`UT-R-EFF-09-023`が固定）。それまでTURN期間満了のカスケードは
  // PS/Memory候補が一度も解決されなかった。
  // (5) ロール順の整列をカスケード対象だけでなく同じ除去バッチの`seeds`へも
  // 適用した（同じグループの`PARENT`と`CHILD`が同時に0になり得る。
  // `UT-R-EFF-09-021`が固定）。
  //
  // さらに3点。
  // (6) `EffectConsumptionChanged`自身も1イベント=1stepとして`yield`する
  // （残回数が0にならない消費では失効stepが無く、PS/Memory連鎖へ一度も
  // 渡らなかった。`UT-R-EFF-07-014`が固定）。state変更も
  // step単位にした — 一括減算済みの`units`を起点にしていたため最初の観測者が
  // 未発行分の減算まで見え、かつ先行連鎖が後続対象を解除した場合に
  // 存在しない効果のsnapshot生成で実行時例外になり得た。対象の決定と適用を
  // 分け、最新stateへ1インスタンスずつ再評価しながら適用する
  // （`UT-R-EFF-07-015`が固定）。
  // (7) `TurnCompleted`も`turnEndPassiveRuntime`へ渡してから解決スコープを
  // 終了する（`06_戦闘状態遷移.md` TURN_ENDING #8、`UT-BATTLE-018`が固定）。
  // (8) カスケード分とseed分を単一の除去バッチ（`orderGroupRemovals`／
  // `removeGroupMembersSteps`）へ統合し、メンバー固有の`reason`/`cascaded`を
  // 保ったまま一度だけrole順へ整列する — 二段で処理していたため非seedの
  // `PARENT`がseedの`CHILD`より先に失効し得た（`UT-R-EFF-09-024`が固定）。
  {
    ruleId: "R-EFF-09",
    testCaseIds: [
      "UT-R-EFF-09-001",
      "UT-R-EFF-09-002",
      "UT-R-EFF-09-003",
      "UT-R-EFF-09-004",
      "UT-R-EFF-09-005",
      "UT-R-EFF-09-006",
      "UT-R-EFF-09-007",
      "UT-R-EFF-09-008",
      "UT-R-EFF-09-009",
      "UT-R-EFF-09-010",
      "UT-R-EFF-09-011",
      "UT-R-EFF-09-012",
      "UT-R-EFF-09-013",
      "UT-R-EFF-09-014",
      "UT-R-EFF-09-015",
      "UT-R-EFF-09-016",
      "UT-R-EFF-09-017",
      "UT-R-EFF-09-018",
      "UT-R-EFF-09-019",
      "UT-R-EFF-09-020",
      "UT-R-EFF-09-021",
      "UT-R-EFF-09-022",
      "UT-R-EFF-09-023",
      "UT-R-EFF-09-024",
      // REF-042（Issue #389）: 同期callbackを持たない経路のためのステップ版と、
      // その経路が`yield`中に発生した子連鎖のイベントを再通知しないこと。
      "UT-R-EFF-09-025",
      "UT-R-EFF-09-026",
      "UT-R-EFF-09-027",
      "UT-R-EFF-09-028",
      "UT-R-EFF-09-029",
      // Issue #479: PS自身のEffectSequence解決でも、凍結解除カスケードの
      // `EffectExpired`は`FreezeRemoved`より前に届く（発動時機はR-ATM-01が決める）。
      "UT-R-EFF-09-030",
      "UT-R-EFF-10-010",
      "UT-R-EFF-10-011",
      "IT-UNIT-HARRIET-SAGE-004",
      "IT-UNIT-HARRIET-SAGE-005",
      // REF-042（Issue #389）でユニット効果軸へ移送した。cross-typeカスケードの
      // production 2グループは`IT-UNIT-TARISA-TROUBLEMAKER-007`（「負けん気」、
      // 独立Reducer復元を含む）と`IT-UNIT-AOI-ELEGANT-007`（「高揚」、実 `REMOVE_MARKER`）
      // が持ち、通知粒度は`IT-UNIT-TARISA-TROUBLEMAKER-008`が記録する。
      "IT-UNIT-TARISA-TROUBLEMAKER-007",
      "IT-UNIT-TARISA-TROUBLEMAKER-008",
      "IT-UNIT-AOI-ELEGANT-007",
      // M7-020（Issue #279）: 付与者戦闘不能によるMarker解除も、他の3経路と同じく
      // 単一の除去バッチとしてR-EFF-09のcross-typeカスケード・role順を通る。
      // PS連鎖内部経路でも「各インスタンスの失効イベントは
      // 次のインスタンスへ進む前にPS/Memoryの即時連鎖へ渡す」を満たす
      // （`removeMarkersSteps`＋`resolveChild`、`UT-R-EFF-10-034`が固定）。
      "UT-R-EFF-10-030",
      "UT-R-EFF-10-034",
      "IT-UNIT-AOI-ELEGANT-004",
      // Issue #500: 演習のブレイク解除（R-TEX-05 #2）でも「カスケードは`dispellable`を
      // 問わない」が優先する — 解除不可の子は、解除対象になった親と同じグループなら道連れになる。
      "UT-R-TEX-05-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // R-EFF-10: EFF-004（Issue #160）。ADD/KEEP_EXISTING/REFRESH/REPLACEの4方針、
  // stack.max clamp・0未満禁止（`marker-apply-service.ts`）、明示的
  // `REMOVE_MARKER`とlinkedEffectGroupカスケード
  // （`marker-removal-service.ts`/`model/linked-effect-group.ts`）、ACTION/TURN単位
  // Duration失効（`marker-duration.ts`、`action-completion.ts`/`battle.ts`への
  // 実ライフサイクル配線）を実装した。`MarkerState.stackCount`を**読む**側は
  // それぞれ別タスクのスコープとして残した — `MARKER_COUNT_SCALE`Formula評価は
  // M7-015（Issue #269）が実ライフサイクル検証（R-NUM-04側で計上。REF-043／
  // Issue #390 でユニット効果軸へ移送済み）まで通して完了させ、
  // `TARGET_HAS_MARKER`Condition評価はRES-004（Issue #171）、`HAS_MARKER`
  // TargetSelector評価はTGT-002（Issue #169）が担当する。
  // `AppliedEffect`をまたぐlinkedEffectGroup
  // カスケード（cross-type、R-EFF-09第1項）はM7-013（Issue #267）が実装し、
  // それまで`catalog-integrity.ts`が`UNSUPPORTED_MARKER_LINKED_GROUP`として
  // 拒否していた組合せ（同じ`linkedEffectGroupId`を`APPLY_MARKER`と非Marker種別の
  // 両方が使う）を受理できるようにした（拒否自体も撤去した）。
  // 一方、schema上は許容されるが未実装のMarker Duration機構（`consumption`、
  // `expiration`、`HIT`/`SKILL_USE`単位の`timeLimit`）も同じCatalog integrity
  // パスで`UNSUPPORTED_MARKER_DURATION`として拒否する。
  // API応答（`BattleUnitStateResponse.markers`/`UnitStateDeltaResponse.markers`、
  // `markers`はv1後方互換のため任意プロパティとして追加）と、独立Reducer復元の
  // 一致判定（`simulation-result-assembler.ts`の`unitSnapshotsEqual`）へも
  // Markerを反映した。
  // M7-020（Issue #279、`MARKER_REMOVAL_ON_SOURCE_DEATH`）: 付与者
  // （`MarkerState.sourceUnitId`）の戦闘不能を解除契機として宣言する
  // `DurationDefinition.removeOnSourceDefeated`（`APPLY_MARKER`専用）を追加した。
  // 抽出は`lifecycle/marker-source-defeat-service.ts`、実ライフサイクル配線は
  // `passive-activation-service.ts`のトップレベル（`applyMarkerSourceDefeatRemovals`）
  // とPS連鎖内部（`applyMarkerSourceDefeatRemovalsForChain`、PSのEffectSequenceが
  // 与えたダメージによる`UnitDefeated`は`onFactEvent`を経由しないため）の2経路。
  // 評価タイミングはR-EFF-08と同じ「関連イベント発行後、PS/Memory候補抽出前」で、
  // 解除は`removeMarkers`へ流し込むためR-EFF-09のcross-typeカスケードが子効果を
  // そのまま巻き込む。非`APPLY_MARKER`への宣言は`catalog-integrity.ts`が
  // `UNSUPPORTED_SOURCE_DEFEATED_REMOVAL`として拒否する（`UT-R-EFF-10-022`）。
  // production Catalogの`ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`（「高揚」）が
  // `IT-UNIT-AOI-ELEGANT-004`で検証される。
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
      "UT-R-EFF-10-019",
      "UT-R-EFF-10-020",
      // M7-020（Issue #279）: Catalog受理・拒否
      "UT-R-EFF-10-021",
      "UT-R-EFF-10-022",
      // M7-020: 対象抽出（成立・不成立・境界）
      "UT-R-EFF-10-023",
      "UT-R-EFF-10-024",
      "UT-R-EFF-10-025",
      "UT-R-EFF-10-026",
      "UT-R-EFF-10-027",
      "UT-R-EFF-10-028",
      "UT-R-EFF-10-029",
      // M7-020: 実ライフサイクル配線（カスケード連動・評価タイミング・不成立・
      // PS連鎖内部の`UnitDefeated`・PS連鎖内部での逐次通知）
      "UT-R-EFF-10-030",
      "UT-R-EFF-10-031",
      "UT-R-EFF-10-032",
      "UT-R-EFF-10-033",
      "UT-R-EFF-10-034",
      // M7-020: Catalog schema（`removeOnSourceDefeated`のマッピングと検証）
      "UT-CAT-DUR-027",
      "UT-CAT-DUR-028",
      "UT-CAT-DUR-029",
      "UT-CAT-DUR-030",
      "IT-MEM-ALWAYS-PICO-BESIDE-YOU-004",
      "IT-UNIT-AOI-ELEGANT-004",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  // M7完了条件「R-EFF-11がAppliedEffect／EffectSequenceスコープを
  // 含めて台帳上で完了する」を満たす。`SkillRuntime`スコープ（M6最小実装、
  // Issue #143）・`AppliedEffect`スコープ（EFF-005、Issue #162）・`EffectSequence`
  // スコープ（EFF-006、Issue #212）の3スコープすべてを実装・検証済み。
  // `Battle`／`BattleUnit`スコープは利用するproduction定義が存在しないため
  // Feature Complete必須対象に含めず、Catalogロード時点で明示的に拒否する
  // （`UT-CAT-RCU-011`）。`SkillRuntime`スコープは production Catalog上の
  // 発動回数・累計ダメージ閾値counterで検証済み
  // （`IT-UNIT-HIIRO-LONEWOLF-005`／`IT-UNIT-MIKOTO-SURVIVOR-005`）。
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
      "UT-CAT-IDX-036",
      "UT-CAT-IDX-037",
      "UT-CAT-IDX-038",
      "UT-CAT-IDX-040",
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
      "UT-R-EFF-11-027",
      // 発動回数counterの書き込みと、それを読む次の発動の阻止。
      "IT-UNIT-HIIRO-LONEWOLF-005",
      // 累計ダメージ閾値counterのcarry・閾値跨ぎ・公開差分（carryは載らない）。
      "IT-UNIT-MIKOTO-SURVIVOR-005",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },

  // R-EFF-12: M7-014（Issue #268、`DYNAMIC_DURATION_ON_REAPPLY`）。
  // `duration.reapply`（既存インスタンスの残り回数を見て初期残り回数を差し替える）
  // のCatalog検証・汎用付与経路・R-STS-02との組み合わせ・未対応経路の拒否と、
  // 実カタログ`ACT_SIENA_DIVA_PS1_STUN`の実ライフサイクル。
  {
    ruleId: "R-EFF-12",
    testCaseIds: [
      "UT-CAT-DUR-021",
      "UT-CAT-DUR-022",
      "UT-CAT-DUR-023",
      "UT-CAT-DUR-024",
      "UT-CAT-DUR-025",
      "UT-CAT-DUR-026",
      "UT-R-EFF-12-001",
      "UT-R-EFF-12-002",
      "UT-R-EFF-12-003",
      "UT-R-EFF-12-004",
      "UT-R-EFF-12-005",
      "UT-R-EFF-12-006",
      "UT-R-EFF-12-007",
      // Issue #519: 「同じ効果」の一致判定はR-STA-03の同種グループ鍵へ寄せず
      // `EffectActionDefinitionId`単位に据え置く（据え置きの回帰）。
      "UT-R-EFF-12-008",
      "UT-CAT-IDX-090",
      "UT-CAT-IDX-091",
      "IT-UNIT-SIENA-DIVA-004",
      "IT-UNIT-SIENA-DIVA-005",
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
  // ENH: 基本ステータス強化。強化指定の受理・拒否（R-ENH-01 #3・R-ENH-02 #1・
  // R-ENH-04 #1/#2・R-ENH-05 #4/#5）はDomainではなくCommand検証とpreflightが持つ
  // 受け入れ条件なので、Application層のテストIDも同じルールの証跡として挙げる。
  {
    ruleId: "R-ENH-01",
    testCaseIds: [
      "UT-R-ENH-01-001",
      "UT-R-ENH-01-002",
      "UT-R-ENH-01-003",
      "UT-CMD-014",
      "UT-CMD-015",
      "UT-CMD-020",
      "UT-CMD-021",
      "UT-FORMATION-MAPPER-005",
      "UT-FORMATION-MAPPER-006",
      "UT-STAT-PREVIEW-003",
      "UT-STAT-PREVIEW-011",
      "UT-R-FRM-FACTORY-010",
      "IT-ENH-001",
      "IT-ENH-002",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-ENH-02",
    testCaseIds: [
      "UT-R-ENH-02-001",
      "UT-R-ENH-02-002",
      "UT-R-ENH-02-003",
      "UT-R-ENH-02-004",
      "UT-R-ENH-02-005",
      "UT-R-ENH-02-006",
      "UT-R-ENH-02-007",
      "UT-R-ENH-02-008",
      "PROP-ENH-02-001",
      "PROP-ENH-02-002",
      "UT-CMD-016",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-ENH-03",
    testCaseIds: ["UT-R-ENH-03-001", "UT-R-ENH-03-002", "UT-R-ENH-01-002"],
    kinds: ["POSITIVE"],
  },
  {
    ruleId: "R-ENH-04",
    testCaseIds: [
      "UT-R-ENH-04-001",
      "UT-R-ENH-04-002",
      "UT-R-ENH-04-003",
      "UT-R-ENH-04-004",
      "UT-R-ENH-04-005",
      "UT-CMD-018",
      "UT-CMD-019",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE"],
  },
  {
    ruleId: "R-ENH-05",
    testCaseIds: [
      "UT-R-ENH-05-001",
      "UT-R-ENH-05-002",
      "UT-R-ENH-05-003",
      "PROP-ENH-05-001",
      "UT-CMD-017",
      "UT-PREFLIGHT-007",
      "UT-PREFLIGHT-008",
      "UT-PREFLIGHT-009",
      "UT-STAT-PREVIEW-014",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "NEGATIVE", "PROPERTY"],
  },
  {
    ruleId: "R-ENH-06",
    testCaseIds: [
      "UT-R-ENH-06-001",
      "UT-R-ENH-06-002",
      "UT-R-ENH-06-003",
      "UT-R-ENH-06-004",
      "UT-R-ENH-06-005",
      "UT-R-ENH-06-006",
      "UT-R-ENH-06-007",
      "UT-R-ENH-06-008",
      "UT-R-ENH-06-009",
      "PROP-ENH-06-001",
      "PROP-ENH-06-002",
      "UT-R-ENH-01-002",
      "UT-R-FRM-FACTORY-009",
      "UT-STAT-PREVIEW-024",
      "API-STAT-PREVIEW-013",
      "IT-ENH-001",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "PROPERTY", "SCENARIO"],
  },
  // TEX: 戦術演習（M10設計時新設。Phase 1〜7＝TEX-002〜008でproduction経路が揃い、
  // TEX-009／Issue #435が計上した）。
  // 受理・拒否条件のうち編成制約（R-TEX-01 #2/#3）と固定ターン数（#4）はDomainだけで
  // なくCommand検証・HTTP境界にも受け入れ条件があるため、Application／Presentation層の
  // テストIDも同じルールの証跡として挙げている。
  // `*.e2e.test.ts`（`E2E-TEX-001`〜`004`）は台帳へ挙げない — 他ルールと同じく、
  // 常時実行される`mise run test`の区分だけを証跡として数える。
  {
    ruleId: "R-TEX-01",
    testCaseIds: [
      "UT-R-TEX-01-001",
      "UT-R-TEX-01-002",
      "UT-R-TEX-01-003",
      "UT-R-TEX-01-004",
      "UT-R-TEX-01-005",
      "UT-R-TEX-01-006",
      "UT-TEXCMD-001",
      "UT-TEXCMD-002",
      "UT-TEXCMD-003",
      "UT-TEXCMD-004",
      "UT-TEXCMD-005",
      "UT-TEXCMD-006",
      "UT-TEXUSECASE-001",
      "UT-TEXUSECASE-003",
      "UT-TEXUSECASE-004",
      "UT-TEXUSECASE-005",
      "API-TEX-004",
      "API-TEX-005",
      "API-TEX-006",
      "SCN-BTL-024",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-02",
    testCaseIds: [
      "UT-R-TEX-02-001",
      "UT-R-TEX-02-002",
      "UT-R-TEX-02-003",
      "UT-R-TEX-02-004",
      "UT-R-TEX-02-005",
      "UT-R-TEX-02-006",
      "UT-R-TEX-02-007",
      "UT-R-TEX-02-008",
      "UT-R-TEX-02-009",
      "UT-R-TEX-02-010",
      "UT-R-TEX-02-011",
      "UT-R-TEX-02-012",
      "UT-R-TEX-02-013",
      "UT-R-TEX-02-014",
      "UT-R-TEX-02-015",
      "UT-R-TEX-02-016",
      "UT-R-TEX-02-017",
      "UT-R-TEX-02-018",
      "UT-R-TEX-02-019",
      "UT-R-TEX-02-020",
      "UT-R-TEX-02-021",
      "UT-R-TEX-02-022",
      "UT-R-TEX-02-023",
      "UT-R-TEX-02-024",
      // #5/#6（Issue #503）: ブレイク復活以外で敵HPが増えた分の減算と、下限0のクランプ。
      "UT-R-TEX-02-025",
      "UT-R-TEX-02-026",
      "UT-R-TEX-02-027",
      "UT-R-TEX-02-028",
      "UT-R-TEX-02-029",
      "UT-R-TEX-02-030",
      "UT-R-TEX-02-031",
      "UT-R-TEX-02-032",
      "UT-R-TEX-02-033",
      "UT-R-TEX-02-034",
      "UT-R-TEX-02-035",
      "UT-R-TEX-02-036",
      "UT-R-TEX-02-037",
      "UT-R-TEX-02-038",
      "UT-R-TEX-02-039",
      "UT-R-TEX-02-040",
      "UT-R-TEX-02-041",
      "UT-R-TEX-02-042",
      "UT-R-TEX-02-043",
      "PROP-TEX-001",
      "PROP-TEX-006",
      "API-TEX-002",
      "API-TEXRESP-003",
      "SCN-BTL-027",
      // #2の計上量とユニット別集計（`10_API設計.md`「集計セマンティクス」）が同じ量を
      // 数えていることを、ブレイクを繰り返す演習全体で照合する。#3の敵の自傷があると
      // 味方の`damageDealt`合計では足りず、敵の`damageTaken`だけが加算総量と一致する。
      "IT-UNIT-SUMMARY-001",
      "IT-UNIT-SUMMARY-002",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "PROPERTY", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-03",
    testCaseIds: [
      "UT-R-TEX-03-001",
      "UT-R-TEX-03-002",
      "UT-R-TEX-03-003",
      "UT-R-TEX-03-004",
      "UT-R-TEX-03-005",
      "UT-R-TEX-03-006",
      "UT-R-TEX-03-007",
      "UT-R-TEX-03-008",
      "UT-R-TEX-03-009",
      "UT-R-TEX-03-010",
      "UT-R-TEX-03-011",
      "UT-R-TEX-03-012",
      "UT-R-TEX-03-013",
      "UT-R-TEX-03-014",
      "UT-R-TEX-03-015",
      "UT-R-TEX-03-016",
      // Issue #523（`R-TEX-03` #5〜#7の保留方式）: 保留フレームの有無が解決位置を
      // 決めること（`UT-R-TEX-03-017`〜`021`）と、1回の効果処理につき高々1回である
      // こと（`UT-R-TEX-03-019`、`SCN-BTL-027`）を固定する。
      "UT-R-TEX-03-017",
      "UT-R-TEX-03-018",
      "UT-R-TEX-03-019",
      "UT-R-TEX-03-020",
      "UT-R-TEX-03-021",
      "UT-R-TEX-03-022",
      "UT-R-TEX-03-023",
      "UT-R-TEX-03-024",
      "API-TEX-002",
      "API-TEXRESP-003",
      "SCN-BTL-027",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-04",
    testCaseIds: [
      "UT-R-TEX-04-001",
      "UT-R-TEX-04-002",
      "UT-R-TEX-04-003",
      "UT-R-TEX-04-004",
      "UT-R-TEX-04-005",
      "UT-R-TEX-04-006",
      "UT-R-TEX-04-007",
      "UT-R-TEX-04-008",
      "UT-R-TEX-04-009",
      "UT-R-TEX-04-010",
      "UT-R-TEX-04-011",
      "UT-R-TEX-04-012",
      "UT-R-TEX-04-013",
      "UT-R-TEX-04-014",
      "UT-R-TEX-04-015",
      "UT-R-TEX-04-016",
      "UT-R-TEX-04-017",
      "UT-R-TEX-04-018",
      "UT-R-TEX-04-019",
      "UT-R-TEX-04-020",
      "PROP-TEX-002",
      "PROP-TEX-003",
      "PROP-TEX-004",
      "PROP-TEX-005",
      "UT-TEXASSEMBLER-006",
      "UT-TEXASSEMBLER-007",
      "API-TEXRESP-004",
      "SCN-BTL-025",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY", "PROPERTY", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-05",
    // `UT-R-TEX-05-002`が#4（回復として扱わない）の否定側を持つ。#1〜#3・#5は復活が
    // 「起きること」の証跡で足りるが、#4だけは回復経路が生きた盤面で「起きないこと」を
    // 見なければ固定できない（回復量補正・回復リンク・回復契機トリガーの不在）。
    // #2の解除不可免除は`UT-R-TEX-05-003`（敵自身のバフ）と`UT-R-TEX-05-004`
    // （味方が付与したデバフ）が対称性を、`UT-R-TEX-05-005`がR-EFF-09連動の優先を持つ。
    testCaseIds: [
      "UT-R-TEX-05-001",
      "UT-R-TEX-05-002",
      "UT-R-TEX-05-003",
      "UT-R-TEX-05-004",
      "UT-R-TEX-05-005",
      "UT-R-TEX-04-019",
      "SCN-BTL-026",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-06",
    // Issue #523（保留方式）で#4〜#8の証跡を追加した。#4.3「保留窓の間、敵は戦闘不能
    // として観測されない」は`isDefeated`という単一の問い合わせ点へ例外を寄せたため、
    // `UT-R-TEX-06-003`〜`005`がその1か所を、`UT-R-TEX-06-002`が実際のヒット列で
    // SKIPされないことを固定する。#5の解決位置は完了イベント種別ごとに
    // （`SkillUseCompleted`／`SkillUseInterrupted`／`ChargeReleaseCompleted`／
    // `PassiveResolved`）別の証跡が要る。
    testCaseIds: [
      "UT-R-TEX-06-001",
      "UT-R-TEX-06-002",
      "UT-R-TEX-06-003",
      "UT-R-TEX-06-004",
      "UT-R-TEX-06-005",
      "UT-R-TEX-06-006",
      "UT-R-TEX-06-007",
      "UT-R-TEX-06-008",
      "UT-R-TEX-06-009",
      "UT-R-TEX-06-010",
      "UT-R-TEX-06-011",
      // #4.3の保留窓は、到達したヒット自身のイベント発行より前に開かなければならない
      // （`UT-R-TEX-06-012`）。保留窓が無い経路では従来の意味が残る（`013`が対称側）。
      "UT-R-TEX-06-012",
      "UT-R-TEX-06-013",
      "UT-R-TEX-03-005",
      "UT-R-TEX-03-012",
      "UT-R-TEX-03-013",
      "UT-R-TEX-03-016",
      // #5の「追撃 → RuntimeCounterReset」は通常戦闘にも効く順序であり、R-FUP-01側の
      // 証跡（`UT-R-FUP-01-013`）がその半分を固定する。
      "UT-R-FUP-01-013",
      "SCN-BTL-025",
      "SCN-BTL-027",
    ],
    kinds: ["POSITIVE", "BOUNDARY", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-07",
    testCaseIds: ["UT-R-TEX-07-001", "UT-R-TEX-07-002"],
    kinds: ["POSITIVE", "NEGATIVE"],
  },
  {
    ruleId: "R-TEX-08",
    testCaseIds: ["UT-R-TEX-08-001"],
    kinds: ["POSITIVE"],
  },
  {
    ruleId: "R-TEX-09",
    testCaseIds: [
      "UT-R-TEX-09-001",
      "UT-R-TEX-09-002",
      "UT-R-TEX-09-003",
      "UT-R-TEX-09-004",
      "UT-R-TEX-09-005",
      "UT-R-TEX-09-006",
      "UT-R-TEX-09-007",
      "UT-R-TEX-09-008",
      "UT-R-TEX-09-009",
      "UT-R-TEX-09-010",
      "UT-TEXUSECASE-001",
      "SCN-BTL-024",
      "SCN-BTL-028",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  {
    ruleId: "R-TEX-10",
    testCaseIds: [
      "UT-R-TEX-10-001",
      "UT-R-TEX-10-002",
      "UT-R-TEX-10-003",
      "UT-R-TEX-10-004",
      "UT-TEXASSEMBLER-001",
      "UT-TEXASSEMBLER-002",
      "UT-TEXASSEMBLER-003",
      "UT-TEXASSEMBLER-004",
      "UT-TEXASSEMBLER-005",
      "UT-TEXASSEMBLER-008",
      "UT-TEXASSEMBLER-009",
      "UT-TEXASSEMBLER-010",
      "UT-TEXUSECASE-001",
      "UT-TEXUSECASE-002",
      "IT-TEX-001",
      "IT-TEX-002",
      "IT-TEX-003",
      "API-TEX-001",
      "API-TEX-010",
      "API-TEXRESP-001",
      "API-TEXRESP-007",
      "SCN-BTL-024",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "SCENARIO"],
  },
  // TEX-010（Issue #447）: 演習ユニットのカテゴリと編成プール。設計と同じPRで
  // 実装・テスト登録まで完了している（ruleAssignmentsへの割当は不要）。
  {
    ruleId: "R-TEX-11",
    testCaseIds: [
      "UT-R-TEX-11-001",
      "UT-R-TEX-11-002",
      "UT-R-TEX-11-003",
      "UT-R-TEX-11-004",
      "UT-R-TEX-11-005",
      "UT-R-TEX-11-006",
      "UT-R-TEX-11-007",
      "UT-CAT-UNIT-015",
      "UT-CAT-UNIT-016",
      "UT-CAT-UNIT-017",
      "UT-CAT-UNIT-018",
      "UT-CAT-UNIT-019",
      "UT-STAT-PREVIEW-019",
      "UT-STAT-PREVIEW-022",
      "UT-STAT-PREVIEW-023",
      "API-STAT-PREVIEW-008",
      "API-TEX-011",
      "IT-CAT-INV-003",
    ],
    kinds: ["POSITIVE", "NEGATIVE", "BOUNDARY"],
  },
];
