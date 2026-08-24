import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, skillFrom, unitFrom } from "../../../testing/fixtures/index.js";
import { resolveBindingSelections } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CLARA_SANTA`（【聖夜のサンタシンガー】綺羅クララ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CLARA_SANTA";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const TAG = "MARKER_CLARA_SANTA_TAG";
const TRIGGER_COUNT = createRuntimeCounterId("SKL_CLARA_SANTA_PS1_TRIGGER_COUNT");
const PS1 = createSkillDefinitionId("SKL_CLARA_SANTA_PS1");

/** 敵後列だけEXゲージを溜めた配置（`HIGHEST_EX_GAUGE_RATIO`が既定順と別の敵を選ぶ）。 */
const EX_GAUGE_ON_BACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { currentExtraGauge: 5 },
  },
];

/** 敵前列左だけHP割合を下げた配置（`LOWEST_HP_RATIO`が既定順と別の敵を選ぶ）。 */
const LOW_HP_LEFT: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 2000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 「サンタタグ」を後列に置き、同じ列の前列に未所持の敵を並べた盤面。 */
const TAG_ON_BACK_OF_LEFT_COLUMN: readonly BoardUnitSpec[] = [
  {
    id: "enemy:tagged",
    position: { column: "LEFT", row: "BACK" },
    markers: [{ markerId: TAG }],
  },
  { id: "enemy:untagged", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:other", position: { column: "CENTER", row: "FRONT" } },
];

/** アクティブスキルを2回使い終えた局面（次の1回で「3回使用するたびに」が成立する）。 */
function afterActiveSkillUses(count: number): BoardOverrides {
  return {
    subject: {
      state: { skillCounters: { [PS1]: { [TRIGGER_COUNT]: { value: count, carry: 0 } } } },
    },
  };
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CLARA_SANTA_EX",
    intent: "EXゲージの充填率が最も高い敵単体に威力233.2でEN攻撃し、対象のEXゲージを2削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_EX" },
    board: { enemies: EX_GAUGE_ON_BACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_EX_EX_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:back": -1166,
      },
      resources: [{ unitId: "enemy:back", resource: "EX_GAUGE", delta: -2 }],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_AS1",
    intent:
      "後列優先で最もHP割合が高い敵単体に威力156でEN攻撃し、自身が3回行動を終えるまでの間、対象に「サンタタグ」を付与する。さらに最もHP割合が低い敵に対し、威力46.8でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_AS1" },
    board: { enemies: LOW_HP_LEFT },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS1_DAMAGE_MAIN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS1_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS1_DAMAGE_LOWEST", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -234,
        "enemy:back": -780,
      },
      markers: [{ unitId: "enemy:back", markerId: TAG, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CLARA_SANTA_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_AS2",
    intent:
      "敵前後列に威力117でEN攻撃する。さらに1行動の間、与ダメージを20%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_AS2" },
    expected: {
      // 「サンタタグ」を持つ敵が居ないため、fallbackの既定順で基準敵＝敵前列。
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CLARA_SANTA_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_AS2",
    intent: "「サンタタグ」が付与された敵がいる列を優先し",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_AS2" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          markers: [{ markerId: TAG }],
        },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // 既定順では敵前列が先だが、タグのあるLEFT列が基準になる。同列に後列は居ない。
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CLARA_SANTA_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_AS3",
    intent: "自身から最も遠い位置にいる敵の前後列に威力159でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_AS3" },
    expected: {
      // 最も遠いのは敵後列で、その前後列＝CENTER列。
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS3_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -795,
        "enemy:back": -795,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_PS1",
    intent:
      "アクティブスキルを3回使用するたびに発動。EXゲージの充填率が最も高い敵単体に対し威力46.8で攻撃し、自身の攻撃力を2.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_SANTA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { ...afterActiveSkillUses(2), enemies: EX_GAUGE_ON_BACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_PS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_PS1_ATK_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:back": -234,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_CLARA_SANTA_PS1_ATK_UP",
          magnitude: 0.025,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_PS1",
    intent: "(不成立): 3回目でないアクティブスキル使用では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_SANTA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: afterActiveSkillUses(0),
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CLARA_SANTA_PS1",
    intent: "(不成立): EXスキルの使用は「アクティブスキルを3回使用する」に数えない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CLARA_SANTA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    board: afterActiveSkillUses(2),
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CLARA_SANTA (【聖夜のサンタシンガー】綺羅クララ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CLARA-SANTA-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-CLARA-SANTA-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-CLARA-SANTA-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-CLARA-SANTA-004 (R-TGT-09/R-TGT-10): AS2の実 `MARKER_IN_AREA` は候補自身の列に「サンタタグ」が在るかを見るため基準敵はタグ保持者とは限らず、タグを持つ敵が居なければ非空filtersが候補0件になり `fallback` が基準を供給する", () => {
    const skill = skillFrom(snapshot, "SKL_CLARA_SANTA_AS2");
    const targetBindings =
      skill.resolution.kind === "IMMEDIATE" ? skill.resolution.targetBindings : [];

    // 基準敵（`TGT_BASE`）はどのACTION stepの対象でもなく、列（`TGT_COLUMN`）を
    // 導くためだけに解決される。振る舞い表は列全体しか見えないため、基準敵が誰かは
    // 実 resolver（`resolveSkillUse` と同じ `resolveBindingSelections`）でしか見えない。
    const tagged = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      enemies: TAG_ON_BACK_OF_LEFT_COLUMN,
    });
    const taggedSelections = resolveBindingSelections(targetBindings, tagged.subject, tagged.units);
    const selectionOf = (
      selections: ReturnType<typeof resolveBindingSelections>,
      targetBindingId: string,
    ): readonly string[] =>
      [
        ...(selections.find((s) => s.targetBindingId === targetBindingId)?.selectedTargetUnitIds ??
          []),
      ]
        .map(String)
        .sort();

    // タグは後列の敵が持つが、`SAME_COLUMN_AS_BASE` の所在判定は候補自身の列を見る
    // ため前列の未所持の敵も候補になり、既定順ではそちらが基準になる。
    expect(selectionOf(taggedSelections, "TGT_BASE")).toEqual(["enemy:untagged"]);
    expect(selectionOf(taggedSelections, "TGT_COLUMN")).toEqual(["enemy:tagged", "enemy:untagged"]);

    // タグを持つ敵が1体も居なければ候補は0件になり、`fallback` の既定順が基準を出す。
    const untagged = productionBoard(snapshot, UNIT_DEFINITION_ID);
    expect(
      selectionOf(
        resolveBindingSelections(targetBindings, untagged.subject, untagged.units),
        "TGT_BASE",
      ),
    ).toEqual(["enemy:front"]);

    // 端から端まで: 攻撃とデバフは列全体（タグ未所持の前列も含む）へ入り、
    // 既定順なら選ばれていたはずの中央列の敵には何も入らない。
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_CLARA_SANTA_AS2" },
        board: { enemies: TAG_ON_BACK_OF_LEFT_COLUMN },
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_DAMAGE", targets: ["enemy:untagged"] },
        {
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          targets: ["enemy:untagged"],
        },
        { effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_DAMAGE", targets: ["enemy:tagged"] },
        {
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          targets: ["enemy:tagged"],
        },
      ],
      hpDeltas: {
        "enemy:untagged": -585,
        "enemy:tagged": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:tagged",
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:untagged",
          effectActionDefinitionId: "ACT_CLARA_SANTA_AS2_OUTGOING_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CLARA_SANTA_AS2", remaining: 1 },
      ],
    });
  });
});
