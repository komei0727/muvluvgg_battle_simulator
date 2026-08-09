import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseCompleted,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SHIRANA_SORA`(【期待応える輝きの穹】一条白奈)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SHIRANA_SORA";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS1は「アクティブスキルを2回使用するたびに」発動する。2回目の使用を作る前提。 */
const ONE_ACTIVE_SKILL_USED = {
  skillCounters: {
    [createSkillDefinitionId("SKL_SHIRANA_SORA_PS1")]: {
      [createRuntimeCounterId("SKL_SHIRANA_SORA_PS1_TRIGGER_COUNT")]: { value: 1, carry: 0 },
    },
  },
};

/** AS1の `UNIT_TYPE_PRIORITY: ENERGY` を判別できる味方陣。 */
const ENERGY_ALLY: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, unitType: "ENERGY" },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS1のBRANCHが `elseSteps`（後衛）を選ぶ盤面。前列の敵を置かない。 */
const ONLY_BACK_ROW_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS2は「ENタイプの敵から」攻撃される直前にだけ発動する。 */
const ENERGY_ATTACKER: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_EX",
    intent:
      "前列の味方を優先し、1行動の間味方2体の防御力を35%上昇させる。加えて3行動の間、自身の最大HP×35%のHPを持ち、味方の攻撃時に自身の攻撃力×31.2%のENダメージを追加するサブユニット「子機Ⅱ」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_SORA_EX" },
    expected: {
      // 前列の味方は自身と ally:front の2体で、後列の ally:back は入らない。
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_DEF_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_DEF_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_DEF_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_SUBUNIT",
          // 最大HP10000 × 35%。
          magnitude: 3500,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_DEF_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_AS1",
    intent:
      "ENタイプを優先し、味方単体の攻撃力を5%上昇させる（重複可）。さらに3行動の間、自身の最大HP×25%のHPを持ち、味方の攻撃時に自身の攻撃力×31.2%のENダメージと、攻撃対象の行動速度を20低下させるデバフ（重複可）を追加するサブユニット「子機Ⅰ」を付与する。このスキルは自身以外の味方に対して優先して発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_SORA_AS1" },
    board: { allies: ENERGY_ALLY },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_SUBUNIT",
          // 最大HP10000 × 25%。
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_ATK_UP",
          magnitude: 0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_SORA_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_AS2",
    intent:
      "自身以外を優先し、HP割合の低い順に味方2体のHPを威力27.5で回復する。さらに対象にかけられたデバフを全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SHIRANA_SORA_AS2" },
    // 解除の対象になるデバフを実 production 定義で作る（自身は選択順の最後で対象外）。
    precedingActions: [
      { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN", target: "ALLY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS2_HEAL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS2_REMOVE_DEBUFF", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS2_HEAL", targets: ["ally:back"] },
        // 解除できるデバフを持たない対象では解除自体が起きない。
        {
          effectActionDefinitionId: "ACT_SHIRANA_SORA_AS2_REMOVE_DEBUFF",
          targets: ["ally:back"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: { "ally:front": 275, "ally:back": 275 },
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
    intent:
      "アクティブスキルを2回使用するたびに発動。敵単体に5ヒットEN攻撃する。対象となる敵が前衛の場合この攻撃は威力21.06となり…さらに対象に対し、1行動の間与ダメージを30%減少させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: ONE_ACTIVE_SKILL_USED } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_DAMAGE_FRONT", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          targets: ["enemy:front"],
        },
      ],
      // 1ヒット105（威力21.06%）の5ヒット。
      hpDeltas: { "enemy:front": -525 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
    intent: "後衛の場合威力15.6となる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: ONE_ACTIVE_SKILL_USED }, enemies: ONLY_BACK_ROW_ENEMIES },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_DAMAGE_BACK", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN", targets: ["enemy:back"] },
      ],
      // 1ヒット78（威力15.6%）の5ヒット。
      hpDeltas: { "enemy:back": -390 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
    // 「子機Ⅰ」の追加ダメージとデバフは味方の攻撃に相乗りするもので、付与した
    // AS1 自身は攻撃を持たない。相乗り先には同じユニットの攻撃（PS1）を使う。
    intent:
      "（子機Ⅰ保持下）味方の攻撃時に自身の攻撃力×31.2%のENダメージと、攻撃対象の行動速度を20低下させるデバフ（重複可）を追加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { state: ONE_ACTIVE_SKILL_USED } },
    precedingActions: [
      { effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_SUBUNIT", target: "SELF" },
    ],
    expected: {
      actions: [
        // 追加デバフはEffectAction群の解決器ではなくサブユニットの付与フックから
        // 直接適用されるため、実行済みEffectActionの列には現れない（付与自体は下の
        // `effectsApplied` が押さえる）。
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_DAMAGE_FRONT", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          targets: ["enemy:front"],
        },
      ],
      // 5ヒットのPS1（525）に、各ヒットへ相乗りした子機Ⅰの追加ENダメージが加わる。
      hpDeltas: { "enemy:front": -1337 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN",
          magnitude: -20,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
    intent: "(不成立): アクティブスキル使用が1回目（累計が2の倍数でない）では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS2",
    // production定義のtriggerは `EVENT_PAYLOAD field: "damageType"` を読むが、
    // `UnitBeingAttacked` payload にその欄は無い（`domain-event.ts`）。原文
    // 「自身がENタイプの敵から攻撃される直前に発動」は**攻撃側のユニット種別**を
    // 指しており、他の定義（`SKL_LUCIE_MAID_PS1`）と同じ
    // `TARGET_STATE target: TRIGGER_SOURCE / field: UNIT_TYPE` で表すのが正しい。
    // ただしそう直すと、EN同士のミラー戦でPS2が毎ヒット候補化して1解決スコープの
    // 効果解決数が実行ガード（`maxEffectsPerScope: 50`）を超え、当のユニットが
    // 戦闘を完走できなくなる。ガードの上限は M9「実行保護の全上限を設定可能にする」
    // まで固定値のため、定義の是正はその後段へ送り、ここでは実挙動を記録する。
    intent: "(実挙動): 契機の条件が `UnitBeingAttacked` に存在しない欄を読むため発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS2",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: ENERGY_ATTACKER,
    expected: { activated: false },
  },
];

/**
 * PS2が一度も発動しないため、その効果だけは表から実行できない。理由付きで
 * 実行ベース網羅から除外する（`definition-closure.ts` の `unreachable`）。
 */
const UNREACHABLE_EFFECT_ACTION_IDS: readonly string[] = ["ACT_SHIRANA_SORA_PS2_GUARD"];

describe("production Catalog UNIT_SHIRANA_SORA (【期待応える輝きの穹】一条白奈)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SHIRANA-SORA-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SHIRANA-SORA-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SHIRANA-SORA-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        UNREACHABLE_EFFECT_ACTION_IDS,
      ),
    ).toEqual([]);
  });
});
