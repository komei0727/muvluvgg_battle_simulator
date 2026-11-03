import { describe, expect, it } from "vitest";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, skillFrom, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitDefeated } from "../../../testing/production-unit/trigger-events.js";
import { observeExGaugeGain } from "../../../testing/production-unit/resource-gain.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";

/**
 * `UNIT_KOTOHA_DAILY`（【歩む先に新たな日常を】コトハ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」、Issue #760）。
 *
 * 盤面の相手役は既定で全員アグレッシブ属性・物理アタッカーのスタンドインである。
 * AS2の「ロールがアタッカーだった場合」の不成立側は、実Catalogの非アタッカー
 * （PSを持たないサポーター）を1体だけ置いて作る。
 */

const UNIT_DEFINITION_ID = "UNIT_KOTOHA_DAILY";
const NON_ATTACKER_UNIT_ID = "UNIT_MAIA_LAZY";
const EX_GAIN_DOWN_MARKER = "MARKER_KOTOHA_DAILY_EX_EX_GAIN_DOWN";
const PS1 = createSkillDefinitionId("SKL_KOTOHA_DAILY_PS1");

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  NON_ATTACKER_UNIT_ID,
]);

/** EX: 前列の2体だけがEXゲージを持ち、削った量を観測できる盤面。 */
const ENEMIES_WITH_EX_GAUGE: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { currentExtraGauge: 3 },
    },
    {
      id: "enemy:left",
      position: { column: "LEFT", row: "FRONT" },
      state: { currentExtraGauge: 3 },
    },
    {
      id: "enemy:back",
      position: { column: "CENTER", row: "BACK" },
      state: { currentExtraGauge: 3 },
    },
  ],
};

/**
 * AS2: 左列前の敵だけ累計与ダメージが多く、その後ろに非アタッカーを置く。既定順なら
 * 中央列が選ばれるため、左列が対象になれば累計与ダメージ順が効いている。
 */
const LEFT_COLUMN_TOP_DAMAGE_DEALER: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { cumulativeDamageDealt: 5000 },
  },
  {
    id: "enemy:leftback",
    position: { column: "LEFT", row: "BACK" },
    unitDefinitionId: NON_ATTACKER_UNIT_ID,
  },
];

const AS2_EFFECTS = (targets: readonly string[]) =>
  targets.map((unitId) => ({
    unitId,
    effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_DOT",
    magnitude: 100,
    timeLimit: { unit: "ACTION", count: 3 },
  }));

const CONFUSION_EFFECT = (unitId: string) => ({
  unitId,
  effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_CONFUSION",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "CONFUSION",
});

/** PS: 発動したときの観測（攻撃してきた敵前列への反撃と凍結）。 */
const PS_ACTIVATED = {
  actions: [
    { effectActionDefinitionId: "ACT_KOTOHA_DAILY_PS1_DAMAGE", targets: ["enemy:front"] },
    { effectActionDefinitionId: "ACT_KOTOHA_DAILY_PS1_FREEZE", targets: ["enemy:front"] },
  ],
  hpDeltas: { "enemy:front": -624 },
  effectsApplied: [
    {
      unitId: "enemy:front",
      effectActionDefinitionId: "ACT_KOTOHA_DAILY_PS1_FREEZE",
      magnitude: 0,
      timeLimit: { unit: "ACTION", count: 1 },
      statusKind: "FREEZE",
    },
  ],
  resources: [
    { unitId: "ally:subject", resource: "PP", delta: -2 },
    { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
  ],
  cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_KOTOHA_DAILY_PS1", remaining: 2 }],
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_EX",
    intent:
      "敵横一列に威力37.1で5ヒットEN攻撃してEXゲージを1ずつ削り、自身が1回行動を終えるまでの間得られるEXゲージが-100%されるデバフを付与する。EX減速デバフは自身が倒れると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_DAILY_EX", actionType: "EX" },
    board: ENEMIES_WITH_EX_GAUGE,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_DOWN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN_MARKER",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_DOWN", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN_MARKER",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN", targets: ["enemy:left"] },
      ],
      // 1ヒット (1000-500)×0.371 = 185.5 → 185 を5ヒット。
      hpDeltas: { "enemy:front": -925, "enemy:left": -925 },
      effectsApplied: ["enemy:front", "enemy:left"].map((unitId) => ({
        unitId,
        effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN",
        magnitude: -1,
        timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
      })),
      markers: [
        { unitId: "enemy:front", markerId: EX_GAIN_DOWN_MARKER, stackCount: 1 },
        { unitId: "enemy:left", markerId: EX_GAIN_DOWN_MARKER, stackCount: 1 },
      ],
      // ヒット数によらず対象ごとに1だけ削る。横一列に居ない後列は削らない。
      resources: [
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:left", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_AS1",
    intent:
      "敵単体に威力124.8でEN攻撃し、次の攻撃での与ダメージを20%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_DAILY_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DMG_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -624 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DMG_DOWN",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KOTOHA_DAILY_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_AS1",
    intent: "(シャイ属性): 対象がシャイ属性の場合、この攻撃は対象の防御力を50%無視する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_DAILY_AS1" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, attribute: "SHY" },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DAMAGE_PIERCE",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DMG_DOWN", targets: ["enemy:front"] },
      ],
      // (1000 - 500×0.5) × 1.248 = 936
      hpDeltas: { "enemy:front": -936 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS1_DMG_DOWN",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KOTOHA_DAILY_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_AS2",
    intent:
      "最も累計与ダメージが多い敵が含まれる敵前後列に威力124.8でEN攻撃し、3行動の間攻撃力×10%の継続ENダメージを付与する。対象のロールがアタッカーだった場合、さらに1行動の混乱を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_DAILY_AS2" },
    board: { enemies: LEFT_COLUMN_TOP_DAMAGE_DEALER },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_DOT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_DAMAGE", targets: ["enemy:leftback"] },
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_DOT", targets: ["enemy:leftback"] },
        // 非アタッカー（enemy:leftback）は targetCondition で除外される。
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS2_CONFUSION", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -624, "enemy:leftback": -624 },
      effectsApplied: [
        ...AS2_EFFECTS(["enemy:left"]),
        CONFUSION_EFFECT("enemy:left"),
        ...AS2_EFFECTS(["enemy:leftback"]),
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KOTOHA_DAILY_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_AS3",
    intent:
      "自身に対して2行動の間、攻撃時に攻撃力×11.7%のダメージを追加するバフを付与する。さらにアグレッシブ属性の他の味方に対しても、2行動の間、攻撃時に攻撃力×11.7%のダメージを追加するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KOTOHA_DAILY_AS3" },
    board: {
      allies: [
        { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" }, attribute: "CUTE" },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS3_BONUS_DAMAGE",
          targets: ["ally:subject"],
        },
        // アグレッシブでない ally:back には付与しない。
        { effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS3_BONUS_DAMAGE", targets: ["ally:front"] },
      ],
      // 付与者（コトハ）の攻撃力 1000 × 11.7% を焼き込む（R-DMG-06 #1）。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS3_BONUS_DAMAGE",
          magnitude: 117,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_AS3_BONUS_DAMAGE",
          magnitude: 117,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
    intent:
      "他のアグレッシブ属性の味方が敵からアクティブスキルで攻撃された後に発動。対象の敵単体に威力124.8でEN反撃し、1行動の凍結を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: PS_ACTIVATED,
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
    intent: "(不成立: 自身): 自身が攻撃された場合は発動しない（「他の」味方）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
    intent: "(不成立: 属性): アグレッシブ属性でない味方が攻撃された場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    board: {
      allies: [{ id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "CUTE" }],
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
    intent: "(不成立: スキル種別): パッシブスキルによる攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "PS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
    intent: "(不成立: クールタイム): クールタイム中は条件を満たしても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    board: {
      subject: {
        state: { cooldowns: { [PS1]: { unit: "ACTION", remaining: 1 } } },
      },
    },
    expected: { activated: false },
  },
];

/** EXのEX獲得減少デバフを敵前列へ付与した状態を、実定義で前提として作る。 */
const EX_GAIN_DOWN_PRECEDING: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN_MARKER", target: "ENEMY" },
  { effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN", target: "ENEMY" },
];

describe("production Catalog UNIT_KOTOHA_DAILY (【歩む先に新たな日常を】コトハ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KOTOHA-DAILY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KOTOHA-DAILY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KOTOHA-DAILY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        [],
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-KOTOHA-DAILY-004 [R-ACT-03] (G-05): EXのデバフを持つ敵は、自分のASでEXゲージを得られない", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const debuffed = applyPrecedingActions(board, EX_GAIN_DOWN_PRECEDING);
    const earn = (units: typeof board.units, battleId: string) => {
      const observed = observeExGaugeGain({
        units,
        definitions: board.definitions,
        skill: skillFrom(snapshot, "SKL_KOTOHA_DAILY_AS3"),
        actorUnitId: "enemy:front",
        battleId,
      });
      return { gain: observed.gain, published: observed.published, modifiers: observed.modifiers };
    };

    // 対照: デバフが無ければ消費AP分（1）を得る。
    expect(earn(board.units, "B_KOTOHA_DAILY_EX_GAIN_BASE")).toEqual({
      gain: { before: 0, after: 1, gained: 1 },
      published: { baseDelta: 1, delta: 1, before: 0, after: 1 },
      modifiers: [],
    });
    expect(earn(debuffed, "B_KOTOHA_DAILY_EX_GAIN_DOWN")).toEqual({
      gain: { before: 0, after: 0, gained: 0 },
      published: null,
      modifiers: [
        {
          effectActionDefinitionId: "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN",
          magnitude: -1,
          instances: 1,
        },
      ],
    });
  });

  it("IT-UNIT-KOTOHA-DAILY-005 (R-EFF-09, R-EFF-10): EXのEX獲得減少デバフはコトハが倒れると同時に解除される", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const debuffed = applyPrecedingActions(board, EX_GAIN_DOWN_PRECEDING);
    const before = debuffed.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(before.markerStates.map((marker) => marker.markerId)).toEqual([EX_GAIN_DOWN_MARKER]);
    expect(before.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toContain(
      "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN",
    );

    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:front",
      battleId: "B_KOTOHA_DAILY_DEFEAT",
    });
    const afterDefeat = chain.fire(
      unitDefeated({ unit: "ally:subject", defeatedBy: "enemy:front" }),
      debuffed.map((unit) =>
        unit.battleUnitId === "ally:subject" ? { ...unit, currentHp: 0, isAlive: false } : unit,
      ),
    );
    const cleared = afterDefeat.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(cleared.markerStates).toEqual([]);
    expect(cleared.appliedEffects.map((effect) => effect.effectActionDefinitionId)).not.toContain(
      "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN",
    );
  });
});
