import { describe, expect, it } from "vitest";
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
import {
  unitBeingAttacked,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";
import { observeExGaugeGain } from "../../../testing/production-unit/resource-gain.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";

/**
 * `UNIT_RAMI_SKYWING`（【穹を駆ける不屈の翼】朽葉ラミ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」、Issue #869）。
 *
 * 盤面の相手役は既定で全員アグレッシブ属性・物理アタッカーのスタンドインである。
 * 本番Catalogを通す戦闘はカバレッジ計測下で遅くなるため、個別にタイムアウトを延ばす。
 */

const UNIT_DEFINITION_ID = "UNIT_RAMI_SKYWING";
const SHISSEI = "MARKER_RAMI_SKYWING_SHISSEI";
const AS1_DEBUFF_MARKER = "MARKER_RAMI_SKYWING_AS1_DEBUFF";
const AS3_EX_GAIN_DOWN_MARKER = "MARKER_RAMI_SKYWING_AS3_EX_GAIN_DOWN";
const TIMEOUT_MS = 30_000;

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 失勢を後列に2段・左前に1段持たせ、既定順（中央前列）と区別できる配置。 */
const ENEMIES_WITH_SHISSEI: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: SHISSEI, stackCount: 1 }],
  },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    markers: [{ markerId: SHISSEI, stackCount: 2 }],
  },
];

/** PS: ラミを後衛中央に置き、その目の前（前衛中央）と斜め前（前衛左）に味方を置く。 */
const RAMI_BEHIND_ALLY: BoardOverrides = {
  subject: { position: { column: "CENTER", row: "BACK" } },
  allies: [
    { id: "ally:front", position: { column: "CENTER", row: "FRONT" } },
    { id: "ally:left", position: { column: "LEFT", row: "FRONT" } },
  ],
};

/** AS3: 3体ともEXゲージを持ち、削った量を観測できる盤面。 */
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

const blindOf = (unitId: string, effectActionDefinitionId: string) => ({
  unitId,
  effectActionDefinitionId,
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "BLIND",
});

const blindActions = (effectActionDefinitionId: string, unitIds: readonly string[]) =>
  unitIds.map((unitId) => ({ effectActionDefinitionId, targets: [unitId] }));

const as2Effects = (unitId: string) => [
  {
    unitId,
    effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION",
    magnitude: 0,
    timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
    consumption: { kind: "INCOMING_HIT", maxCount: 3 },
    statusKind: "HIT_EVASION",
  },
  {
    unitId,
    effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT",
    magnitude: -0.25,
    timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 2 },
  },
];

const AS2_RESOURCES = {
  resources: [
    { unitId: "ally:subject", resource: "AP", delta: -1 },
    { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
  ],
  cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_SKYWING_AS2", remaining: 1 }],
} as const;

const as3Actions = (unitId: string) =>
  [
    "ACT_RAMI_SKYWING_AS3_DAMAGE",
    "ACT_RAMI_SKYWING_AS3_EX_DOWN",
    "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN_MARKER",
    "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN",
  ].map((effectActionDefinitionId) => ({ effectActionDefinitionId, targets: [unitId] }));

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_EX",
    intent:
      "敵全体に対し1行動の暗闇（100%）を付与する。さらに最も「失勢」が多い敵を優先して敵単体に威力124.8で攻撃し、対象の攻撃力を35%低下させる（全員失勢0なら既定順）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_EX", actionType: "EX" },
    expected: {
      actions: [
        ...blindActions("ACT_RAMI_SKYWING_EX_BLIND", ["enemy:front", "enemy:left", "enemy:back"]),
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_ATK_DOWN", targets: ["enemy:front"] },
      ],
      // (1000-500)×1.248 = 624
      hpDeltas: { "enemy:front": -624 },
      effectsApplied: [
        blindOf("enemy:front", "ACT_RAMI_SKYWING_EX_BLIND"),
        // 攻撃力低下は永続（期間・消費の宣言なし）。
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_ATK_DOWN",
          magnitude: -0.35,
        },
        blindOf("enemy:left", "ACT_RAMI_SKYWING_EX_BLIND"),
        blindOf("enemy:back", "ACT_RAMI_SKYWING_EX_BLIND"),
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_EX",
    intent: "(失勢優先): 失勢が最も多い後列の敵を単体攻撃の対象にする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_EX", actionType: "EX" },
    board: { enemies: ENEMIES_WITH_SHISSEI },
    expected: {
      actions: [
        ...blindActions("ACT_RAMI_SKYWING_EX_BLIND", ["enemy:front", "enemy:left", "enemy:back"]),
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_ATK_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -624 },
      effectsApplied: [
        blindOf("enemy:front", "ACT_RAMI_SKYWING_EX_BLIND"),
        blindOf("enemy:left", "ACT_RAMI_SKYWING_EX_BLIND"),
        blindOf("enemy:back", "ACT_RAMI_SKYWING_EX_BLIND"),
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_ATK_DOWN",
          magnitude: -0.35,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_AS1",
    intent:
      "敵横一列の行動速度を1行動の間100低下させ（重複可）、1行動の暗闇（55%）を付与する。さらに自身が1回行動を終えるまでの間、対象の敵単体の攻撃力を25%、防御力を20%低下させる（全員失勢0なら既定順）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS1" },
    expected: {
      actions: [
        ...["enemy:front", "enemy:left"].flatMap((unitId) => [
          { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_SPD_DOWN", targets: [unitId] },
          { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_BLIND", targets: [unitId] },
        ]),
        {
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEBUFF_MARKER",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_ATK_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEF_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_SPD_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        blindOf("enemy:front", "ACT_RAMI_SKYWING_AS1_BLIND"),
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_ATK_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEF_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_SPD_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        blindOf("enemy:left", "ACT_RAMI_SKYWING_AS1_BLIND"),
      ],
      markers: [{ unitId: "enemy:front", markerId: AS1_DEBUFF_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_SKYWING_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_AS1",
    intent: "(失勢優先): 失勢が最も多い後列の敵を基点に、その横一列（後列）へかける",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS1" },
    board: { enemies: ENEMIES_WITH_SHISSEI },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_SPD_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_BLIND", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEBUFF_MARKER",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_ATK_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEF_DOWN", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_SPD_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        blindOf("enemy:back", "ACT_RAMI_SKYWING_AS1_BLIND"),
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_ATK_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEF_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [{ unitId: "enemy:back", markerId: AS1_DEBUFF_MARKER, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_SKYWING_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_AS2",
    intent:
      "自身および最もHP割合の低い味方単体に対し、自身が1回行動を終えるまでの間3ヒットまで攻撃を回避するバフと、2攻撃まで被ダメージを25%減少させる効果を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS2" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 3000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT", targets: ["ally:front"] },
      ],
      effectsApplied: [...as2Effects("ally:subject"), ...as2Effects("ally:front")],
      ...AS2_RESOURCES,
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_AS2",
    intent: "(自身が最低HP割合): 自身が最もHP割合の低い味方なら、自身に2重にかける",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS2" },
    board: { subject: { state: { currentHp: 3000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT", targets: ["ally:subject"] },
      ],
      effectsApplied: [...as2Effects("ally:subject"), ...as2Effects("ally:subject")],
      ...AS2_RESOURCES,
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_AS3",
    intent:
      "自身に最も近い敵と隣接する2体に対して威力81.9で攻撃し、対象のEXゲージを1削る。さらに自身が1回行動を終えるまでの間、対象が得られるEXゲージを100%減少させるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS3" },
    board: ENEMIES_WITH_EX_GAUGE,
    expected: {
      actions: [
        ...as3Actions("enemy:front"),
        // 隣接2体は ADJACENT_DIRECTION 順（後→左）に解決される。
        ...as3Actions("enemy:back"),
        ...as3Actions("enemy:left"),
      ],
      // (1000-500)×0.819 = 409.5 → 409
      hpDeltas: { "enemy:front": -409, "enemy:left": -409, "enemy:back": -409 },
      effectsApplied: ["enemy:front", "enemy:left", "enemy:back"].map((unitId) => ({
        unitId,
        effectActionDefinitionId: "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN",
        magnitude: -1,
        timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
      })),
      markers: ["enemy:front", "enemy:left", "enemy:back"].map((unitId) => ({
        unitId,
        markerId: AS3_EX_GAIN_DOWN_MARKER,
        stackCount: 1,
      })),
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:left", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
    intent:
      "（同時発動制限）自身の目の前に編成されている味方が攻撃される前に発動。攻撃してくる敵のこの行動内でのスキル威力を75%低下させ、対象に「失勢」を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
      triggeredBy: "enemy:front",
    },
    board: RAMI_BEHIND_ALLY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SKILL_POWER_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SHISSEI", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SKILL_POWER_DOWN",
          magnitude: -0.75,
          timeLimit: { unit: "ACTION", count: 1, countGrantAction: true },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: SHISSEI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
    intent: "(失勢の累積): 失勢はADD・上限なしで既存の段数へ積み上がる（5→6）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
      triggeredBy: "enemy:front",
    },
    board: {
      ...RAMI_BEHIND_ALLY,
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: SHISSEI, stackCount: 5 }],
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SKILL_POWER_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SHISSEI", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SKILL_POWER_DOWN",
          magnitude: -0.75,
          timeLimit: { unit: "ACTION", count: 1, countGrantAction: true },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: SHISSEI, stackCount: 6 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
    intent: "(不成立: 位置): 目の前ではない味方（斜め前）が攻撃される場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:left" }),
      triggeredBy: "enemy:front",
    },
    board: RAMI_BEHIND_ALLY,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
    intent: "(不成立: 自身): 自身が攻撃される場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_SKYWING_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
      triggeredBy: "enemy:front",
    },
    board: RAMI_BEHIND_ALLY,
    expected: { activated: false },
  },
];

/** AS1のステータス低下を敵前列へ付与した状態を、実定義で前提として作る。 */
const AS1_DEBUFF_PRECEDING: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEBUFF_MARKER", target: "ENEMY" },
  {
    effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_ATK_DOWN",
    target: "ENEMY",
    withPrevious: true,
  },
  {
    effectActionDefinitionId: "ACT_RAMI_SKYWING_AS1_DEF_DOWN",
    target: "ENEMY",
    withPrevious: true,
  },
];

/** AS3のEX獲得減少デバフを敵前列へ付与した状態を、実定義で前提として作る。 */
const AS3_EX_GAIN_DOWN_PRECEDING: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN_MARKER", target: "ENEMY" },
  {
    effectActionDefinitionId: "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN",
    target: "ENEMY",
    withPrevious: true,
  },
];

const definitionIdsOf = (unit: BattleUnit) =>
  unit.appliedEffects.map((effect) => String(effect.effectActionDefinitionId));

describe("production Catalog UNIT_RAMI_SKYWING (【穹を駆ける不屈の翼】朽葉ラミ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-RAMI-SKYWING-001: $skillDefinitionId — $intent",
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
    TIMEOUT_MS,
  );

  it("IT-UNIT-RAMI-SKYWING-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it(
    "IT-UNIT-RAMI-SKYWING-003: every EffectAction reachable from this unit was actually executed by the table above",
    () => {
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
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RAMI-SKYWING-004 [R-DMG-08, R-ATM-03]: 目の前の味方への攻撃でPSが発動し、その一撃から威力×0.25で計算される。目の前以外への攻撃は等倍のまま",
    () => {
      const strike = (targetUnitId: string) => {
        const board = productionBoard(snapshot, UNIT_DEFINITION_ID, RAMI_BEHIND_ALLY);
        const chain = openPassiveChain({
          definitions: board.definitions,
          actorUnitId: "enemy:front",
          battleId: `B_RAMI_SKYWING_PS_${targetUnitId}`,
        });
        const observed = observeLifecycleDamageProbe({
          definitions: board.definitions,
          units: board.units,
          attackerUnitId: "enemy:front",
          targetUnitId,
          onFactEventForPassiveChain: (event, current) => chain.fireRecorded(event, current),
        });
        const attacker = observed.units.find((unit) => unit.battleUnitId === "enemy:front")!;
        return {
          activated: activatedPassiveSkillIds(chain),
          damage: observed.calculated.finalDamage,
          shissei: attacker.markerStates.filter((marker) => marker.markerId === SHISSEI).length,
        };
      };

      // 威力1の一撃: (1000-500)×1×(1-0.75) = 125。
      expect(strike("ally:front")).toEqual({
        activated: ["SKL_RAMI_SKYWING_PS1"],
        damage: 125,
        shissei: 1,
      });
      expect(strike("ally:left")).toEqual({ activated: [], damage: 500, shissei: 0 });
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RAMI-SKYWING-005 [R-DMG-08]: スキル威力低下を持つ者の攻撃は全対象に効き、2回付与されていれば乗算する",
    () => {
      // 低下の保持者が複数対象攻撃を撃つ形を、ラミ自身へ低下を前提付与してAS3で作る。
      const withDown = (count: number) =>
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_SKYWING_AS3" },
          precedingActions: Array.from({ length: count }, () => ({
            effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SKILL_POWER_DOWN",
            target: "SELF" as const,
          })),
        }).hpDeltas;

      // (1000-500)×0.819×0.25 = 102.375 → 102
      expect(withDown(1)).toEqual({ "enemy:front": -102, "enemy:left": -102, "enemy:back": -102 });
      // (1000-500)×0.819×0.25×0.25 = 25.59 → 25
      expect(withDown(2)).toEqual({ "enemy:front": -25, "enemy:left": -25, "enemy:back": -25 });
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RAMI-SKYWING-006 [R-HIT-04, R-EFF-07]: AS2の回避は3ヒットまで、被ダメージ軽減は2攻撃まで消費される",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const buffed = applyPrecedingActions(board, [
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_EVASION", target: "SELF" },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_AS2_DMG_CUT", target: "SELF" },
      ]);

      // 4ヒットの1攻撃: 3ヒットを回避し、4ヒット目が軽減込みで命中する（軽減は1攻撃分消費）。
      const first = observeLifecycleDamageProbe({
        definitions: board.definitions,
        units: buffed,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        hitCount: 4,
        accuracy: "NORMAL",
      });
      expect(first.hits.map((hit) => hit.result)).toEqual([
        "EVADED",
        "EVADED",
        "EVADED",
        "CONFIRMED",
      ]);
      // 500×(1-0.25) = 375
      expect(first.hpDeltas).toEqual({ "ally:subject": -375 });

      const strike = (units: readonly BattleUnit[]) =>
        observeLifecycleDamageProbe({
          definitions: board.definitions,
          units,
          attackerUnitId: "enemy:front",
          targetUnitId: "ally:subject",
          accuracy: "NORMAL",
        });
      const second = strike(first.units);
      expect(second.hits.map((hit) => hit.result)).toEqual(["CONFIRMED"]);
      expect(second.hpDeltas).toEqual({ "ally:subject": -375 });
      const third = strike(second.units);
      expect(third.hpDeltas).toEqual({ "ally:subject": -500 });
    },
    TIMEOUT_MS,
  );

  it("IT-UNIT-RAMI-SKYWING-007 [R-ACT-03]: AS3のデバフを持つ敵は、自分のASでEXゲージを得られない", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const debuffed = applyPrecedingActions(board, AS3_EX_GAIN_DOWN_PRECEDING);
    const earn = (units: typeof board.units, battleId: string) =>
      observeExGaugeGain({
        units,
        definitions: board.definitions,
        skill: skillFrom(snapshot, "SKL_RAMI_SKYWING_AS2"),
        actorUnitId: "enemy:front",
        battleId,
      }).gain;

    expect(earn(board.units, "B_RAMI_SKYWING_EX_GAIN_BASE")).toEqual({
      before: 0,
      after: 1,
      gained: 1,
    });
    expect(earn(debuffed, "B_RAMI_SKYWING_EX_GAIN_DOWN")).toEqual({
      before: 0,
      after: 0,
      gained: 0,
    });
  });

  it(
    "IT-UNIT-RAMI-SKYWING-008 (R-EFF-09, R-EFF-10): ラミが倒れるとAS1のステータス低下とAS3のEX獲得減が解除され、失勢とEXの攻撃力低下は残る",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const debuffed = applyPrecedingActions(board, [
        ...AS1_DEBUFF_PRECEDING,
        ...AS3_EX_GAIN_DOWN_PRECEDING,
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_EX_ATK_DOWN", target: "ENEMY" },
        { effectActionDefinitionId: "ACT_RAMI_SKYWING_PS1_SHISSEI", target: "ENEMY" },
      ]);
      const before = debuffed.find((unit) => unit.battleUnitId === "enemy:front")!;
      expect(definitionIdsOf(before).sort()).toEqual(
        [
          "ACT_RAMI_SKYWING_AS1_ATK_DOWN",
          "ACT_RAMI_SKYWING_AS1_DEF_DOWN",
          "ACT_RAMI_SKYWING_AS3_EX_GAIN_DOWN",
          "ACT_RAMI_SKYWING_EX_ATK_DOWN",
        ].sort(),
      );

      const chain = openPassiveChain({
        definitions: board.definitions,
        actorUnitId: "enemy:front",
        battleId: "B_RAMI_SKYWING_DEFEAT",
      });
      const afterDefeat = chain.fire(
        unitDefeated({ unit: "ally:subject", defeatedBy: "enemy:front" }),
        debuffed.map((unit) =>
          unit.battleUnitId === "ally:subject" ? { ...unit, currentHp: 0, isAlive: false } : unit,
        ),
      );
      const cleared = afterDefeat.find((unit) => unit.battleUnitId === "enemy:front")!;
      expect(cleared.markerStates.map((marker) => marker.markerId)).toEqual([SHISSEI]);
      expect(definitionIdsOf(cleared)).toEqual(["ACT_RAMI_SKYWING_EX_ATK_DOWN"]);
    },
    TIMEOUT_MS,
  );
});
