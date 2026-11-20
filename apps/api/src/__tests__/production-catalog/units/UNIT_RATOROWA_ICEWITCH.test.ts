import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
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
  selectedActiveSkill,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
  type SkillUseObservation,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitDefeated } from "../../../testing/production-unit/trigger-events.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  expireInstance,
  observeEffectExpiry,
} from "../../../testing/production-unit/effect-expiry.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { FormationSlotInput } from "../../../application/simulation/simulate-battle-command.js";
import { SimulateTotalWarUseCase } from "../../../application/simulation/simulate-total-war-use-case.js";
import { loadCatalogFromDirectory } from "../../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { ManualClock } from "../../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../../testing/id/fixed-battle-id-generator.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";

/**
 * `UNIT_RATOROWA_ICEWITCH`（【氷の魔女】フィカーツィア・ラトロワ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」、Issue #870）。
 *
 * 盤面の相手役は既定で全員アグレッシブ属性・物理アタッカーのスタンドインである。
 * 本番Catalogを通す戦闘はカバレッジ計測下で遅くなるため、個別にタイムアウトを延ばす。
 */

const UNIT_DEFINITION_ID = "UNIT_RATOROWA_ICEWITCH";
const TIMEOUT_MS = 30_000;

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** EX: HP割合が最も低い敵を前衛中央に置き、隣接2体（後・左）がそろう盤面。 */
const ENEMY_FRONT_WOUNDED: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 3000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** EX・AS1: HP割合が最も低い敵を左前に置き、既定順（前衛中央）と区別する。隣接は前衛中央のみ。 */
const ENEMY_LEFT_WOUNDED: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 3000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 自身以外の味方を `count` 体（全員生存）並べる。AS1の生存人数判定・PS2の人数判定用。 */
const POSITIONS = [
  { column: "LEFT", row: "FRONT" },
  { column: "RIGHT", row: "FRONT" },
  { column: "LEFT", row: "BACK" },
  { column: "CENTER", row: "BACK" },
] as const;

function alliesOf(
  count: number,
  spec: (index: number) => Partial<BoardUnitSpec> = () => ({}),
): readonly BoardUnitSpec[] {
  return POSITIONS.slice(0, count).map((position, index) => ({
    id: `ally:${index + 1}`,
    position,
    ...spec(index),
  }));
}

/** PS2: 自身（シャイ）と、先頭 `shy` 体がシャイの味方4体。 */
function ps2Board(shy: number, sub: "MAIN" | "SUB" = "MAIN") {
  return {
    subject: { attribute: "SHY" as const },
    allies: alliesOf(4, (index) =>
      index < shy
        ? sub === "MAIN"
          ? { attribute: "SHY" as const }
          : { state: { subAttribute: "SHY" as const } }
        : {},
    ),
  };
}

/** PS2の段階（自身以外のシャイの人数）ごとの攻撃力・防御力上昇。 */
const PS2_STEP_IDS = {
  "1": ["ACT_RATOROWA_ICEWITCH_PS2_ATK_UP_1", "ACT_RATOROWA_ICEWITCH_PS2_DEF_UP_1"],
  "2": ["ACT_RATOROWA_ICEWITCH_PS2_ATK_UP_2", "ACT_RATOROWA_ICEWITCH_PS2_DEF_UP_2"],
  "3": ["ACT_RATOROWA_ICEWITCH_PS2_ATK_UP_3", "ACT_RATOROWA_ICEWITCH_PS2_DEF_UP_3"],
} as const;

type Ps2Step = keyof typeof PS2_STEP_IDS;

const ps2Effects = (unitIds: readonly string[], step: Ps2Step, magnitude: number) =>
  unitIds.flatMap((unitId) => [
    {
      unitId,
      effectActionDefinitionId: PS2_STEP_IDS[step][0],
      magnitude,
    },
    {
      unitId,
      effectActionDefinitionId: PS2_STEP_IDS[step][1],
      magnitude,
    },
  ]);

const ps2Actions = (unitIds: readonly string[], step: Ps2Step) =>
  unitIds.flatMap((unitId) => [
    { effectActionDefinitionId: PS2_STEP_IDS[step][0], targets: [unitId] },
    { effectActionDefinitionId: PS2_STEP_IDS[step][1], targets: [unitId] },
  ]);

const PS_RESOURCES = [
  { unitId: "ally:subject", resource: "PP", delta: -1 },
  { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
] as const;

const PS2_COOLDOWN = [
  { unitId: "ally:subject", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2", remaining: 99 },
] as const;

const PS2_TRIGGER = {
  kind: "PASSIVE",
  skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2",
  trigger: turnStarted({ turnNumber: 1 }),
} as const;

const AS2_SHIELD = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_SHIELD",
  // 攻撃力1000 × 150%
  magnitude: 1500,
  timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
};

const as2Expected = (allyId: string): SkillUseObservation => ({
  actions: [
    { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_SHIELD", targets: ["ally:subject"] },
    { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK", targets: [allyId] },
    { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY", targets: [allyId] },
    {
      effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      targets: ["ally:subject"],
    },
  ],
  effectsApplied: [
    AS2_SHIELD,
    {
      unitId: "ally:subject",
      effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      magnitude: 0,
    },
    {
      unitId: allyId,
      effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
      magnitude: 1,
    },
    {
      unitId: allyId,
      effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      magnitude: 0,
    },
  ],
  resources: [
    { unitId: "ally:subject", resource: "AP", delta: -1 },
    { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
  ],
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_EX",
    intent:
      "最もHP割合の低い敵単体、および対象に隣接する敵2体に対し威力132.6で攻撃し、与えたダメージの300%分のシールドを自身に付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_EX", actionType: "EX" },
    board: { enemies: ENEMY_FRONT_WOUNDED },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_DAMAGE", targets: ["enemy:front"] },
        // 隣接2体は ADJACENT_DIRECTION 順（後→左）に解決される。
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_SHIELD", targets: ["ally:subject"] },
      ],
      // (1000-500)×1.326 = 663
      hpDeltas: { "enemy:front": -663, "enemy:left": -663, "enemy:back": -663 },
      effectsApplied: [
        // 663×3体×300% = 5967。無期限（期間・消費の宣言なし）。
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_SHIELD",
          magnitude: 5967,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_EX",
    intent: "(対象選択): HP割合が最も低い左前の敵を基点にし、隣接は前衛中央の1体だけになる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_EX", actionType: "EX" },
    board: { enemies: ENEMY_LEFT_WOUNDED },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -663, "enemy:left": -663 },
      effectsApplied: [
        // 663×2体×300% = 3978
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_EX_SHIELD",
          magnitude: 3978,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1",
    intent:
      "最もHP割合の低い敵単体に威力137.8で攻撃し、次の攻撃での与ダメージを50%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1" },
    board: { enemies: ENEMY_LEFT_WOUNDED },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS1_DMG_DOWN",
          targets: ["enemy:left"],
        },
      ],
      // (1000-500)×1.378 = 689
      hpDeltas: { "enemy:left": -689 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS1_DMG_DOWN",
          magnitude: -0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1",
    intent: "(不成立): 生存している味方が5人以上の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1" },
    board: { allies: alliesOf(4) },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2",
    intent:
      "自身に攻撃力×150%のシールドを付与後、シャイ属性を優先して最もHP割合が低い他の味方単体と自身の間にダメージリンクを付与し、さらに自身と対象に向けられるデバフを無効にする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2" },
    // HP割合はアグレッシブの味方のほうが低いが、シャイの味方を優先する。
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          attribute: "SHY",
          state: { currentHp: 8000 },
        },
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 1000 },
        },
      ],
    },
    expected: as2Expected("ally:front"),
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2",
    intent: "(シャイ優先: サブ属性): サブ属性シャイの味方もシャイとして優先する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 8000, subAttribute: "SHY" },
        },
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 1000 },
        },
      ],
    },
    expected: as2Expected("ally:front"),
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2",
    intent: "(シャイ不在): シャイの味方がいなければ、HP割合が最も低い他の味方を選ぶ",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 8000 },
        },
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 1000 },
        },
      ],
    },
    expected: as2Expected("ally:back"),
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2",
    intent: "(不成立): 自身以外の味方が生存していない場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS2" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          attribute: "SHY",
          state: { currentHp: 0 },
        },
      ],
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS1",
    intent:
      "他の味方が倒された際に発動。1行動の間自身の攻撃力を25%上昇させ（重複可）、1ヒットまで被ダメージを無効にするバフを付与する。さらに「お勉強といこうか」のクールタイムを解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    board: {
      subject: {
        state: {
          cooldowns: {
            [createSkillDefinitionId("SKL_RATOROWA_ICEWITCH_AS1")]: {
              unit: "ACTION",
              remaining: 1,
            },
          },
        },
      },
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 0 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_DAMAGE_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_CD_RESET",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_ATK_UP",
          magnitude: 0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        // 消費されるまで残る（期間の宣言なし）。
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_DAMAGE_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
      resources: [...PS_RESOURCES],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RATOROWA_ICEWITCH_AS1", remaining: 0 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS1",
    intent: "(不成立: 敵の撃破): 敵が倒されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS1",
      trigger: unitDefeated({ unit: "enemy:left", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 0 },
        },
      ],
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2",
    intent:
      "ターン開始時に発動。自身以外で編成されているシャイ属性の味方1人につき防御力を7.5%、攻撃力を7.5%、シャイ属性の味方へ上昇させる（3人で上限）",
    use: PS2_TRIGGER,
    board: ps2Board(3),
    expected: {
      actions: ps2Actions(["ally:subject", "ally:1", "ally:2", "ally:3"], "3"),
      effectsApplied: ps2Effects(["ally:subject", "ally:1", "ally:2", "ally:3"], "3", 0.225),
      resources: [...PS_RESOURCES],
      cooldowns: [...PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2",
    intent: "(上限): シャイの味方が4人いても3人分（22.5%）で止まる",
    use: PS2_TRIGGER,
    board: ps2Board(4),
    expected: {
      // 対象は既定順（前列→後列）で並ぶため、後列左の ally:3 は後列中央の ally:4 より後になる。
      actions: ps2Actions(["ally:subject", "ally:1", "ally:2", "ally:4", "ally:3"], "3"),
      effectsApplied: ps2Effects(
        ["ally:subject", "ally:1", "ally:2", "ally:3", "ally:4"],
        "3",
        0.225,
      ),
      resources: [...PS_RESOURCES],
      cooldowns: [...PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2",
    intent: "(2人): シャイの味方2人なら15%",
    use: PS2_TRIGGER,
    board: ps2Board(2),
    expected: {
      actions: ps2Actions(["ally:subject", "ally:1", "ally:2"], "2"),
      effectsApplied: ps2Effects(["ally:subject", "ally:1", "ally:2"], "2", 0.15),
      resources: [...PS_RESOURCES],
      cooldowns: [...PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_RATOROWA_ICEWITCH_PS2",
    intent: "(1人・サブ属性): サブ属性シャイの味方1人も数え、7.5%",
    use: PS2_TRIGGER,
    board: ps2Board(1, "SUB"),
    expected: {
      actions: ps2Actions(["ally:subject", "ally:1"], "1"),
      effectsApplied: ps2Effects(["ally:subject", "ally:1"], "1", 0.075),
      resources: [...PS_RESOURCES],
      cooldowns: [...PS2_COOLDOWN],
    },
  },
];

/** AS2の1回の使用で付く親子を、実定義で前提として作る（同じスキル使用で付与する）。 */
const AS2_SET: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_SHIELD", target: "SELF" },
  {
    effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
    target: "ALLY",
    withPrevious: true,
  },
  {
    effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
    target: "ALLY",
    withPrevious: true,
  },
  {
    effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
    target: "SELF",
    withPrevious: true,
  },
];

const definitionIdsOf = (units: readonly BattleUnit[], unitId: string) =>
  units
    .find((unit) => unit.battleUnitId === unitId)!
    .appliedEffects.map((effect) => String(effect.effectActionDefinitionId))
    .sort();

/** 既定盤面の前提アクション `ALLY` は既定順の先頭（前衛左の ally:front）へ解決される。 */
const LINKED_ALLY = "ally:front";

describe("production Catalog UNIT_RATOROWA_ICEWITCH (【氷の魔女】フィカーツィア・ラトロワ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-RATOROWA-ICEWITCH-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-RATOROWA-ICEWITCH-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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
    "IT-UNIT-RATOROWA-ICEWITCH-003: every EffectAction reachable from this unit was actually executed by the table above",
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
    "IT-UNIT-RATOROWA-ICEWITCH-004 [R-ACT-02]: 生存している味方が5人ならAS1を飛ばして次のAS2を使い、4人（1人戦闘不能を含む）ならAS1を使う",
    () => {
      const select = (allies: readonly BoardUnitSpec[]) =>
        selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID, board: { allies } });

      expect(select(alliesOf(4))).toBe("SKL_RATOROWA_ICEWITCH_AS2");
      expect(select(alliesOf(3))).toBe("SKL_RATOROWA_ICEWITCH_AS1");
      expect(select(alliesOf(4, (index) => (index === 0 ? { state: { currentHp: 0 } } : {})))).toBe(
        "SKL_RATOROWA_ICEWITCH_AS1",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-005 [R-EFF-07]: AS1のデバフを受けた敵は次の攻撃1回だけ与ダメージが半減する",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const debuffed = applyPrecedingActions(board, [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS1_DMG_DOWN", target: "ENEMY" },
      ]);
      const strike = (units: readonly BattleUnit[]) =>
        observeLifecycleDamageProbe({
          definitions: board.definitions,
          units,
          attackerUnitId: "enemy:front",
          targetUnitId: "ally:back",
        });

      const first = strike(debuffed);
      // 500×(1-0.5) = 250
      expect(first.hpDeltas).toEqual({ "ally:back": -250 });
      expect(definitionIdsOf(first.units, "enemy:front")).toEqual([]);
      expect(strike(first.units).hpDeltas).toEqual({ "ally:back": -500 });
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-006 [R-EFF-09, R-SHD-01]: リンク先の味方が受けたダメージは100%ラトロワへ転送されシールドが吸収し、シールドが割れるとリンクとデバフ無効も消える",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const linked = applyPrecedingActions(board, AS2_SET);
      expect(definitionIdsOf(linked, LINKED_ALLY)).toEqual([
        "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
        "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      ]);

      const strike = (units: readonly BattleUnit[], power: number) =>
        observeLifecycleDamageProbe({
          definitions: board.definitions,
          units,
          attackerUnitId: "enemy:front",
          targetUnitId: LINKED_ALLY,
          power,
        });

      // 500ダメージはすべてラトロワへ転送され、シールド1500が吸収する（HPは誰も減らない）。
      const absorbed = strike(linked, 1);
      expect(absorbed.hpDeltas).toEqual({});
      expect(definitionIdsOf(absorbed.units, LINKED_ALLY)).toEqual([
        "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
        "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      ]);

      // 残量1000のシールドへ1500が転送され、割れた残り500がラトロワのHPへ入る。
      const broken = strike(absorbed.units, 3);
      expect(broken.hpDeltas).toEqual({ "ally:subject": -500 });
      expect(definitionIdsOf(broken.units, LINKED_ALLY)).toEqual([]);
      expect(definitionIdsOf(broken.units, "ally:subject")).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-007 [R-EFF-04, R-EFF-09]: AS2のシールドはラトロワの1行動の終了で消え、リンクとデバフ無効も同時に消える",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const linked = applyPrecedingActions(board, AS2_SET);
      const observed = observeEffectExpiry({
        units: linked,
        definitions: board.definitions,
        steps: [{ kind: "ACTION_END", actor: "ally:subject" }],
      });
      // 子の巻き添え失効が先に、親（シールド）の期限切れが最後に発行される。
      expect(observed.steps[0]!.expired).toEqual([
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
        {
          unitId: LINKED_ALLY,
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
        {
          unitId: LINKED_ALLY,
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
          reason: "LINKED_GROUP_CASCADE",
          cascaded: true,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_SHIELD",
          reason: "TIME_LIMIT",
          cascaded: false,
        },
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-008 [R-EFF-09]: AS2を続けて使うと、前の使用のシールドが消えても新しい使用のリンクとデバフ無効は残る",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const twice = applyPrecedingActions(board, [...AS2_SET, ...AS2_SET]);
      expect(definitionIdsOf(twice, LINKED_ALLY)).toHaveLength(4);

      // 先に付いた（前の使用の）シールドを失効させる。
      const { units } = expireInstance({
        units: twice,
        definitions: board.definitions,
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_AS2_SHIELD",
        reason: "TIME_LIMIT",
      });
      expect(definitionIdsOf(units, LINKED_ALLY)).toEqual([
        "ACT_RATOROWA_ICEWITCH_AS2_DAMAGE_LINK",
        "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
      ]);
      expect(definitionIdsOf(units, "ally:subject")).toEqual([
        "ACT_RATOROWA_ICEWITCH_AS2_DEBUFF_IMMUNITY",
        "ACT_RATOROWA_ICEWITCH_AS2_SHIELD",
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-009 [R-EFF-07]: PS1のダメージ無効は行動をまたいで残り、1ヒットで消費される",
    () => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const immune = applyPrecedingActions(board, [
        { effectActionDefinitionId: "ACT_RATOROWA_ICEWITCH_PS1_DAMAGE_IMMUNITY", target: "SELF" },
      ]);
      const elapsed = observeEffectExpiry({
        units: immune,
        definitions: board.definitions,
        steps: [
          { kind: "ACTION_END", actor: "ally:subject" },
          { kind: "TURN_END" },
          { kind: "ACTION_END", actor: "ally:subject" },
        ],
      });
      expect(elapsed.steps.every((step) => step.expired === undefined)).toBe(true);

      const strike = (units: readonly BattleUnit[]) =>
        observeLifecycleDamageProbe({
          definitions: board.definitions,
          units,
          attackerUnitId: "enemy:front",
          targetUnitId: "ally:subject",
        });
      const first = strike(elapsed.units);
      expect(first.hpDeltas).toEqual({});
      expect(definitionIdsOf(first.units, "ally:subject")).toEqual([]);
      expect(strike(first.units).hpDeltas).toEqual({ "ally:subject": -500 });
    },
    TIMEOUT_MS,
  );

  it(
    "IT-UNIT-RATOROWA-ICEWITCH-010 [R-TWR-05]: 総力戦の2編成目で出撃した場合も、出撃後のターン開始時にPS2が発動する",
    () => {
      // 1編成目は最大HP1で1ターン目に全滅し、ターン2の冒頭に2編成目（ラトロワとシャイの
      // フィー）が出撃する。敵は倒れないようにして、戦闘をターン2まで進める。
      const ONE_HP = { module: { hp: { fixed: 0, ratio: -1 } } } as const;
      const UNBREAKABLE = { module: { hp: { ratio: 10_000 } } } as const;
      const slot = (
        unitDefinitionId: string,
        column: 0 | 1 | 2,
        row: "FRONT" | "REAR",
        enhancement: NonNullable<FormationSlotInput["enhancement"]>,
      ): FormationSlotInput => ({
        unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
        position: { column, row },
        enhancement,
      });
      const formation = (slots: readonly FormationSlotInput[]) => ({
        slots,
        memoryDefinitionIds: [],
        enhancement: {},
      });
      const result = new SimulateTotalWarUseCase({
        battleCatalog: loadCatalogFromDirectory(PRODUCTION_CATALOG_DIR),
        battleIdGenerator: new FixedBattleIdGenerator(["B_RATOROWA_TW"]),
        randomSourceFactory: { create: () => ({ next: () => 0.5 }) },
        clock: new ManualClock(0),
      }).execute(
        {
          allyFormations: [
            formation([slot("UNIT_LUCIE_COMPANION", 1, "REAR", ONE_HP)]),
            formation([
              slot(UNIT_DEFINITION_ID, 1, "REAR", ONE_HP),
              slot("UNIT_FEE_ACTOR", 0, "FRONT", ONE_HP),
            ]),
          ],
          enemyFormations: [formation([slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT", UNBREAKABLE)])],
          logLevel: "DETAILED",
        },
        { requestId: "ratorowa-total-war", deadlineEpochMs: Number.MAX_SAFE_INTEGER },
      );

      const details = (event: (typeof result.events)[number]) =>
        event.details as Record<string, unknown>;
      const deployed = result.events.find(
        (event) => event.type === "FORMATION_DEPLOYED" && details(event).side === "ALLY",
      )!;
      expect(details(deployed)).toMatchObject({ formationNumber: 2, turnNumber: 2 });
      const [ratorowa, fee] = details(deployed).battleUnitIds as readonly [string, string];

      const ps2 = result.events.filter(
        (event) =>
          event.type === "PASSIVE_ACTIVATED" &&
          details(event).skillDefinitionId === "SKL_RATOROWA_ICEWITCH_PS2",
      );
      expect(ps2.map((event) => [event.turnNumber, details(event).actorUnitId])).toEqual([
        [2, ratorowa],
      ]);
      // 自身以外のシャイはフィー1人なので、自身とフィーへ7.5%ずつ。
      const buffed = result.events
        .filter(
          (event) =>
            event.type === "EFFECT_APPLIED" &&
            String(details(event).effectActionDefinitionId).startsWith(
              "ACT_RATOROWA_ICEWITCH_PS2_",
            ),
        )
        .map((event) => [details(event).effectActionDefinitionId, details(event).targetUnitId]);
      expect(buffed).toEqual([
        ["ACT_RATOROWA_ICEWITCH_PS2_ATK_UP_1", ratorowa],
        ["ACT_RATOROWA_ICEWITCH_PS2_DEF_UP_1", ratorowa],
        ["ACT_RATOROWA_ICEWITCH_PS2_ATK_UP_1", fee],
        ["ACT_RATOROWA_ICEWITCH_PS2_DEF_UP_1", fee],
      ]);
    },
    TIMEOUT_MS,
  );
});
