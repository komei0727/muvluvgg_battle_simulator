import { describe, expect, it } from "vitest";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  effectActionFrom,
  loadProductionSnapshot,
  unitFrom,
} from "../../../testing/fixtures/index.js";
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
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { evasionOf } from "../../../testing/production-unit/evasion.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../../domain/battle/model/applied-effect.js";
import { createEffectActionDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";

/**
 * `UNIT_CHIYURU_SKYWING_TEX`（【穹に閃く探求の学識】月ヶ瀬ちゆる・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）。プレイアブル版
 * `UNIT_CHIYURU_SKYWING` との差分:
 *
 * - AS1+: 消費APが4から2になり、クールタイム2行動を持つ
 * - PS1+: 契機が「他の味方」から「自身」が敵からアクティブスキルで攻撃された後になる
 * - PS2+: スキル威力上昇が解除不可になる
 *
 * 盤面は攻撃力1000・防御力500で、`SKILL_POWER`のダメージは`500 × 威力`の切り捨てになる。
 * 「ランダムな敵単体」（R-TGT-11）は候補3体（前列中央・前列左・後列中央）を
 * Fisher–Yatesで並べ替えた先頭で、抽選は先頭2回を消費する。既定の抽選列（全て0.99）は
 * 後列中央を、先頭2回を0にした列は前列中央を、先頭を0.5にした列は前列左を選ぶ。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIYURU_SKYWING_TEX";
const AS1 = createSkillDefinitionId("SKL_CHIYURU_SKYWING_TEX_AS1");
const PS1 = createSkillDefinitionId("SKL_CHIYURU_SKYWING_TEX_PS1");
const SKILL_POWER_UP = "ACT_CHIYURU_SKYWING_TEX_PS2_SKILL_POWER_UP";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 演習敵は単騎（Q-TEX-01）。PS1+の契機は自身なので、味方を置かない盤面で見る。 */
const SOLO: BoardOverrides = { allies: [] };

/** 抽選の先頭をいくつか固定し、残り（命中・会心の判定）は命中・非会心へ倒す列。 */
const drawsStartingWith =
  (...head: readonly number[]) =>
  () =>
    new SequenceRandomSource([...head, ...new Array<number>(64).fill(0.99)]);

/** PS2のスキル威力+7.5を、実定義で自身へ付与した状態を前提として作る。 */
const SKILL_POWER_UP_PRECEDING: readonly PrecedingAction[] = [
  { effectActionDefinitionId: SKILL_POWER_UP, target: "SELF" },
];

/**
 * 消費されるまで続くステルス（R-TGT-08）。付与そのものは検証対象ではないため手組みする。
 * 消費は`EffectExpired`（reason: CONSUMPTION）として観測の`effectsRemoved`へ現れる。
 */
function stealthOf(holderId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_TEST_STEALTH");
  return {
    effectInstanceId: createEffectInstanceId(`TEST_STEALTH_${holderId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetUnitId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "STEALTH",
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

/** 前列中央だけがステルスを持つ敵3体。 */
const FRONT_STEALTH_ENEMIES: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { appliedEffects: [stealthOf("enemy:front")] },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

const STEALTH_CONSUMED = {
  unitId: "enemy:front",
  effectActionDefinitionId: "ACT_TEST_STEALTH",
  magnitude: 0,
  statusKind: "STEALTH",
} as const;

const TWO_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
];

const EX_ACTIONS = (target: string) => [
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_EX_DAMAGE", targets: [target] },
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_EX_DAMAGE_EXTRA", targets: [target] },
];

const AS1_ACTIONS = (target: string) => [
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS1_DAMAGE", targets: [target] },
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS1_AP_DOWN", targets: [target] },
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS1_PP_DOWN", targets: [target] },
];

const AS1_SELF_RESOURCES = [
  { unitId: "ally:subject", resource: "AP", delta: -2 },
  { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
] as const;

const AS1_COOLDOWNS = [
  { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1", remaining: 2 },
] as const;

const PS1_ACTIONS = [
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_PS1_DAMAGE", targets: ["enemy:front"] },
  { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_PS1_DMG_DOWN", targets: ["enemy:front"] },
];

const PS1_EFFECT = {
  unitId: "enemy:front",
  effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_PS1_DMG_DOWN",
  magnitude: -0.2,
  timeLimit: { unit: "ACTION", count: 1 },
} as const;

const PS1_SELF_CHANGES = {
  resources: [
    { unitId: "ally:subject", resource: "PP", delta: -1 },
    { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
  ],
  cooldowns: [
    { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1", remaining: 1 },
  ],
} as const;

const PS1_TRIGGER = realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" });

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX",
    intent: "ランダムな敵単体に威力31.2で5ヒット、さらに威力39で1ヒットEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX", actionType: "EX" },
    expected: {
      actions: EX_ACTIONS("enemy:back"),
      // 500×0.312 = 156 を5ヒット、500×0.39 = 195 を1ヒット。6ヒットとも同じ敵に入る。
      hpDeltas: { "enemy:back": -975 },
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX",
    intent: "(抽選): 抽選が変われば対象も変わり、6ヒットとも抽選した同じ敵に入る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX", actionType: "EX" },
    random: drawsStartingWith(0, 0),
    expected: {
      actions: EX_ACTIONS("enemy:front"),
      hpDeltas: { "enemy:front": -975 },
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX",
    intent: "(PS2): スキル威力+7.5は各ヒットの威力の数値に足される（31.2→38.7、39→46.5）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_EX", actionType: "EX" },
    precedingActions: SKILL_POWER_UP_PRECEDING,
    random: drawsStartingWith(0.5),
    expected: {
      actions: EX_ACTIONS("enemy:left"),
      // 500×0.387 = 193.5 → 193 を5ヒット、500×0.465 = 232.5 → 232 を1ヒット。
      hpDeltas: { "enemy:left": -1197 },
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent: "ランダムな敵単体に威力180.2でEN攻撃し（回避不可）、対象のAPとPPを2ずつ削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    expected: {
      actions: AS1_ACTIONS("enemy:back"),
      hpDeltas: { "enemy:back": -901 },
      resources: [
        ...AS1_SELF_RESOURCES,
        { unitId: "enemy:back", resource: "AP", delta: -2 },
        { unitId: "enemy:back", resource: "PP", delta: -2 },
      ],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent: "(下限): 削る量が残量を超えてもAP・PPは0未満にならない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentAp: 1, currentPp: 0 },
        },
      ],
    },
    expected: {
      // PPは既に0で動かないため、PP低下は変化なし（SKIPPED）として終わる。
      actions: [
        ...AS1_ACTIONS("enemy:back").slice(0, 2),
        {
          effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS1_PP_DOWN",
          targets: ["enemy:back"],
          resultKind: "SKIPPED",
        },
      ],
      hpDeltas: { "enemy:back": -901 },
      resources: [...AS1_SELF_RESOURCES, { unitId: "enemy:back", resource: "AP", delta: -1 }],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent: "(回避不可): 確率1で回避する状態を持つ敵にも命中する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { appliedEffects: [evasionOf("enemy:front")] },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    random: drawsStartingWith(0, 0),
    expected: {
      actions: AS1_ACTIONS("enemy:front"),
      hpDeltas: { "enemy:front": -901 },
      resources: [
        ...AS1_SELF_RESOURCES,
        { unitId: "enemy:front", resource: "AP", delta: -2 },
        { unitId: "enemy:front", resource: "PP", delta: -2 },
      ],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent:
      "(ステルス: 抽選の先頭): 抽選で先頭に来たステルス所持者はステルスを消費して次の候補へ譲る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    board: { enemies: FRONT_STEALTH_ENEMIES },
    // 先頭2回が0なら並べ替えは既定順のまま（前列中央・前列左・後列中央）。
    random: drawsStartingWith(0, 0),
    expected: {
      actions: AS1_ACTIONS("enemy:left"),
      hpDeltas: { "enemy:left": -901 },
      effectsRemoved: [STEALTH_CONSUMED],
      resources: [
        ...AS1_SELF_RESOURCES,
        { unitId: "enemy:left", resource: "AP", delta: -2 },
        { unitId: "enemy:left", resource: "PP", delta: -2 },
      ],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent:
      "(ステルス: 先頭以外): 抽選で先頭に来なかったステルス所持者のステルスは、発動条件の敵数カウントでも消費されない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    board: { enemies: FRONT_STEALTH_ENEMIES },
    random: drawsStartingWith(0.99, 0.99),
    expected: {
      actions: AS1_ACTIONS("enemy:back"),
      hpDeltas: { "enemy:back": -901 },
      resources: [
        ...AS1_SELF_RESOURCES,
        { unitId: "enemy:back", resource: "AP", delta: -2 },
        { unitId: "enemy:back", resource: "PP", delta: -2 },
      ],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1",
    intent: "(PS2): スキル威力+7.5が乗る（180.2→187.7）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS1" },
    precedingActions: SKILL_POWER_UP_PRECEDING,
    expected: {
      actions: AS1_ACTIONS("enemy:back"),
      // 500×1.877 = 938.5 → 938
      hpDeltas: { "enemy:back": -938 },
      resources: [
        ...AS1_SELF_RESOURCES,
        { unitId: "enemy:back", resource: "AP", delta: -2 },
        { unitId: "enemy:back", resource: "PP", delta: -2 },
      ],
      cooldowns: AS1_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS2",
    intent: "敵単体に威力84.8でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: { "enemy:front": -424 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS2",
    intent: "(PS2): スキル威力+7.5が乗る（84.8→92.3）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_AS2" },
    precedingActions: SKILL_POWER_UP_PRECEDING,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      // 500×0.923 = 461.5 → 461
      hpDeltas: { "enemy:front": -461 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent:
      "自身が敵からアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に威力109.2でEN反撃し、1行動の間対象の与ダメージを20%減少させるデバフを付与する（重複可）",
    board: SOLO,
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: PS1_TRIGGER,
    },
    expected: {
      actions: PS1_ACTIONS,
      hpDeltas: { "enemy:front": -546 },
      effectsApplied: [PS1_EFFECT],
      ...PS1_SELF_CHANGES,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent: "(PS2): 反撃にもスキル威力+7.5が乗る（109.2→116.7）",
    board: SOLO,
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: PS1_TRIGGER,
    },
    precedingActions: SKILL_POWER_UP_PRECEDING,
    expected: {
      actions: PS1_ACTIONS,
      // 500×1.167 = 583.5 → 583
      hpDeltas: { "enemy:front": -583 },
      effectsApplied: [PS1_EFFECT],
      ...PS1_SELF_CHANGES,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent: "(不成立: 他の味方): 自身以外の味方が攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent: "(不成立: スキル種別): EXスキルによる攻撃では発動しない",
    board: SOLO,
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "EX" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent: "(不成立: スキル種別): パッシブスキルによる攻撃では発動しない",
    board: SOLO,
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "PS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
    intent: "(不成立: クールタイム): クールタイム中は条件を満たしても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS1",
      trigger: PS1_TRIGGER,
    },
    board: {
      ...SOLO,
      subject: { state: { cooldowns: { [PS1]: { unit: "ACTION", remaining: 1 } } } },
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS2",
    intent: "ターン開始時に発動。1ターンの間、自身のスキル威力を7.5上昇させる（解除不可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      turnNumber: 2,
    },
    expected: {
      actions: [{ effectActionDefinitionId: SKILL_POWER_UP, targets: ["ally:subject"] }],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: SKILL_POWER_UP,
          magnitude: 0.075,
          timeLimit: { unit: "TURN", count: 1, countGrantTurn: true },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS2",
    intent: "(不成立: 1ターン目): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_SKYWING_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      turnNumber: 1,
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_CHIYURU_SKYWING_TEX (【穹に閃く探求の学識】月ヶ瀬ちゆる・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIYURU-SKYWING-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIYURU-SKYWING-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIYURU-SKYWING-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-CHIYURU-SKYWING-TEX-004 [R-ACT-02]: AS1は生存している敵が3体以上なら選ばれ、2体以下なら行動選択から外れてAS2へ送られる", () => {
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_CHIYURU_SKYWING_TEX_AS1",
    );
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { enemies: TWO_ENEMIES },
      }),
    ).toBe("SKL_CHIYURU_SKYWING_TEX_AS2");
    // 3体並んでいても1体が戦闘不能なら生存は2体で、AS1は外れる。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: {
          enemies: [
            ...TWO_ENEMIES,
            {
              id: "enemy:back",
              position: { column: "CENTER", row: "BACK" },
              state: { currentHp: 0 },
            },
          ],
        },
      }),
    ).toBe("SKL_CHIYURU_SKYWING_TEX_AS2");
  });

  it("IT-UNIT-CHIYURU-SKYWING-TEX-005 [R-EFF-06]: PS2のスキル威力上昇は付与したターンの終わりで失効する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, SKILL_POWER_UP_PRECEDING);
    const steps = observeEffectExpiry({
      units: granted,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: "ally:subject" }, { kind: "TURN_END" }],
    }).steps;
    expect(steps[0]?.remaining).toEqual({ [`ally:subject/${SKILL_POWER_UP}`]: 1 });
    expect(steps[1]?.remaining).toEqual({});
    expect(steps[1]?.expired?.map((entry) => entry.effectActionDefinitionId)).toEqual([
      SKILL_POWER_UP,
    ]);
  });

  it("IT-UNIT-CHIYURU-SKYWING-TEX-006 [R-EFF-04]: PS1の与ダメージ低下は対象の敵が次の行動を終えると失効する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const debuffed = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_CHIYURU_SKYWING_TEX_PS1_DMG_DOWN", target: "ENEMY" },
    ]);
    const key = "enemy:front/ACT_CHIYURU_SKYWING_TEX_PS1_DMG_DOWN";
    const steps = observeEffectExpiry({
      units: debuffed,
      definitions: board.definitions,
      steps: [
        { kind: "ACTION_END", actor: "ally:subject" },
        { kind: "ACTION_END", actor: "enemy:front" },
      ],
    }).steps;
    expect(steps[0]?.remaining).toEqual({ [key]: 1 });
    expect(steps[1]?.remaining).toEqual({});
  });

  it("IT-UNIT-CHIYURU-SKYWING-TEX-007 [R-ACT-02]: AS1+はクールタイム中なら行動選択から外れてAS2へ送られる", () => {
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: {
          subject: { state: { cooldowns: { [AS1]: { unit: "ACTION", remaining: 1 } } } },
        },
      }),
    ).toBe("SKL_CHIYURU_SKYWING_TEX_AS2");
  });

  it("IT-UNIT-CHIYURU-SKYWING-TEX-008 [R-EFF-09]: PS2+のスキル威力上昇は解除不可、PS1+の与ダメージ低下は解除可", () => {
    const dispellableOf = (effectActionDefinitionId: string): unknown =>
      (
        effectActionFrom(snapshot, effectActionDefinitionId).payload as unknown as {
          duration: { dispellable: unknown };
        }
      ).duration.dispellable;
    expect(dispellableOf(SKILL_POWER_UP)).toBe(false);
    expect(dispellableOf("ACT_CHIYURU_SKYWING_TEX_PS1_DMG_DOWN")).toBe(true);
  });
});
