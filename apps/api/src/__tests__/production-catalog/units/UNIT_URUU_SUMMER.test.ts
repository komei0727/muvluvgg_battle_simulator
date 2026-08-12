import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseCompleted,
  turnStarted,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_URUU_SUMMER`（【夏色シャイガール】波瀬うるう）のユニット単位production結合
 * テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 既存キャラクターの夏バリアントで、`characterId` は `UNIT_URUU_TIMID` と同じ
 * `CHAR_URUU_HASE` を共有する。
 *
 * 注目点は3つ。
 *
 * 1. AS「ENアタッカーに対して優先して発動する」は `filters: ROLE=EN_ATTACKER` と
 *    フィルタ無しの `fallback` の2段で表す。**優先**であって限定ではないため、
 *    盤面にENアタッカーが居る行と居ない行の両方を持つ。
 * 2. PS1「防御デバフは付与者が倒れると解除される」は、`AppliedEffect` 側に付与者の
 *    戦闘不能を判定する失効機構が無い（`removeOnSourceDefeated` は `APPLY_MARKER`
 *    専用）ため、Markerを`PARENT`・防御デバフを`CHILD`にした親子連動グループ
 *    （R-EFF-09）で表す。`-004` がそのカスケードを固定する。
 * 3. PS3は自身の編成列で腕が変わる（前列＝回避＋致死耐え／後列＝与ダメージ＋会心ダメージ）。
 *
 * 盤面は攻撃力1000・防御力500・現在HP5000/最大HP10000（`skill-behaviour.ts`）。
 * `SKILL_POWER` のダメージは `(1000 - 500) × power` の切り捨てになる。
 */

const UNIT_DEFINITION_ID = "UNIT_URUU_SUMMER";
const SHIOSAI = "MARKER_URUU_SUMMER_SHIOSAI";
const PS1_DEF_DOWN_MARKER = "MARKER_URUU_SUMMER_PS1_DEF_DOWN";

/**
 * ASの `ROLE=EN_ATTACKER` フィルタを実 `UnitDefinition` で成立させるため、相手役の
 * 1体だけを実CatalogのENアタッカー（同一キャラクターの既存バージョン）に差し替える。
 * スタンドイン定義はいずれも `PHYSICAL_ATTACKER` で、ロール条件を作り分けられない。
 */
const EN_ATTACKER_UNIT_ID = "UNIT_URUU_TIMID";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  EN_ATTACKER_UNIT_ID,
]);

/**
 * ENアタッカーは後列に1体だけ置き、前列の敵へ**より高い攻撃力**を持たせる。
 * `order: HIGHEST_ATTACK` だけで対象が決まっているなら enemy:front が選ばれるため、
 * ロールフィルタが先に効いていることを `unitIds` で判別できる。
 */
const ENEMIES_WITH_EN_ATTACKER: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    combatStats: { attack: 2000 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    unitDefinitionId: EN_ATTACKER_UNIT_ID,
  },
];

/** ENアタッカーが1体も居ない盤面。`fallback`（フィルタ無し）側の腕を引く。 */
const ENEMIES_WITHOUT_EN_ATTACKER: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    combatStats: { attack: 2000 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/**
 * ASの完了はPS1（「自身がアクティブスキルで攻撃した後に発動」）の契機でもあるため、
 * AS1を1回使う観測にはPS1の解決がそのまま連鎖して現れる。AS側の行が見たいのは
 * 「どの敵を選んだか」なので、連鎖分は共通の断片として切り出し、AS固有の差分だけを
 * 各行に残す。前列2体（enemy:front／enemy:left）はAS1の対象と独立に決まる。
 */
const PS1_CHAIN_ACTIONS = [
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DAMAGE", targets: ["enemy:front"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN_MARKER", targets: ["enemy:front"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN", targets: ["enemy:front"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DAMAGE", targets: ["enemy:left"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN_MARKER", targets: ["enemy:left"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN", targets: ["enemy:left"] },
  { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_SELF_DMG_DOWN", targets: ["ally:subject"] },
] as const;

const PS1_CHAIN_EFFECTS = [
  {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_SELF_DMG_DOWN",
    magnitude: -0.25,
    timeLimit: { unit: "ACTION", count: 1 },
  },
  {
    unitId: "enemy:front",
    effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN",
    magnitude: -0.15,
    timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
  },
  {
    unitId: "enemy:left",
    effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN",
    magnitude: -0.15,
    timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
  },
] as const;

const PS1_CHAIN_MARKERS = [
  { unitId: "enemy:front", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
  { unitId: "enemy:left", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
] as const;

const PS1_CHAIN_COOLDOWNS = [
  { unitId: "ally:subject", skillDefinitionId: "SKL_URUU_SUMMER_PS1", remaining: 1 },
] as const;

/** (SKL_ID, raw原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_URUU_SUMMER_EX",
    intent: "最も近い位置にいる敵単体、および対象に隣接する敵に対して威力265で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_SUMMER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_EX_DAMAGE", targets: ["enemy:back"] },
      ],
      // (1000-500)×2.65=1325。基準は最も近い enemy:front で、上下左右1マスの
      // enemy:left（同列前列の左隣）と enemy:back（真後ろ）が隣接に入る。
      hpDeltas: { "enemy:front": -1325, "enemy:left": -1325, "enemy:back": -1325 },
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_AS1",
    intent:
      "最も攻撃力の高い敵単体に威力234で攻撃する。このスキルはENアタッカーに対して優先して発動する。また対象に「潮騒」を1つ付与し、さらに自身に対し「潮騒」を所持している相手からの被ダメージを50％減少する効果（解除不可）を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_SUMMER_AS1" },
    board: { enemies: ENEMIES_WITH_EN_ATTACKER },
    expected: {
      // 攻撃力2000の enemy:front ではなく、ENアタッカーの enemy:back が選ばれる。
      // ASの完了はPS1（「自身がアクティブスキルで攻撃した後に発動」）の契機でも
      // あるため、同じ観測にPS1の前列2体攻撃と防御デバフまで連鎖して現れる。
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_MARKER_SHIOSAI",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      hpDeltas: { "enemy:back": -1170, "enemy:front": -507, "enemy:left": -507 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        ...PS1_CHAIN_EFFECTS,
      ],
      markers: [...PS1_CHAIN_MARKERS, { unitId: "enemy:back", markerId: SHIOSAI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: PS1_CHAIN_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_AS1",
    intent:
      "(ENアタッカー不在): 「優先して発動する」であって限定ではないため、最も攻撃力の高い敵へ発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_SUMMER_AS1" },
    board: { enemies: ENEMIES_WITHOUT_EN_ATTACKER },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_MARKER_SHIOSAI",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      // enemy:front はAS1（1170）とPS1（507）の両方を受ける。
      hpDeltas: { "enemy:front": -1677, "enemy:left": -507 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        ...PS1_CHAIN_EFFECTS,
      ],
      markers: [
        { unitId: "enemy:front", markerId: SHIOSAI, stackCount: 1 },
        { unitId: "enemy:front", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
        { unitId: "enemy:left", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: PS1_CHAIN_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_AS1",
    intent: "既に対象が「潮騒」を所持している場合は新たに付与を行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_URUU_SUMMER_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          combatStats: { attack: 2000 },
          markers: [{ markerId: SHIOSAI }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // `stack.policy: KEEP_EXISTING` のため「潮騒」の段数が増えず、`markers` の
      // 差分にはPS1が配る防御デバフ用Markerしか現れない。
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_MARKER_SHIOSAI",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      hpDeltas: { "enemy:front": -1677, "enemy:left": -507 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_AS1_DMG_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        ...PS1_CHAIN_EFFECTS,
      ],
      markers: PS1_CHAIN_MARKERS,
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: PS1_CHAIN_COOLDOWNS,
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。前列優先で敵2体に威力101.4で攻撃し、自身が1回行動を終えるまでの間対象の防御力を15％減少させる（重複可）。さらに自身に対して1行動の間、被ダメージを25％減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_URUU_SUMMER_AS1",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN_MARKER",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN_MARKER",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_SELF_DMG_DOWN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "enemy:front": -507, "enemy:left": -507 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_SELF_DMG_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS1_DEF_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
        { unitId: "enemy:left", markerId: PS1_DEF_DOWN_MARKER, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_URUU_SUMMER_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS1",
    intent: "(不成立): EXスキルの使用後には発動しない（「アクティブスキルで攻撃した後」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_URUU_SUMMER_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS2",
    intent:
      "他の味方が敵に倒された際に発動。自身の攻撃力を1行動の間30%上昇させ（重複可）、EXゲージを2加算し、1行動の間与ダメージを15%増加させるバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS2",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
      triggeredBy: "enemy:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS2_EX_GAIN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS2_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS2_DMG_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // PS使用のPP消費で+1（R-ACT-03）、スキル自身のEX加算で+2。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS2",
    intent: "(不成立): 自身が倒された場合は発動しない（「他の味方が」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS2",
      trigger: unitDefeated({ unit: "ally:subject", defeatedBy: "enemy:front" }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS3",
    intent:
      "ターン開始時に発動。自身が前列に編成されていた場合、自身に対して75％の確率で3ヒットまで攻撃を回避するバフと、致死ダメージを1ヒットまでHP1で耐えるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_EVASION", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_EVASION",
          magnitude: 0,
          timeLimit: { unit: "TURN", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "TURN", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_URUU_SUMMER_PS3",
    intent:
      "自身が後列に編成されていた場合、自身に対し与ダメージを10％増加させるバフを付与し（重複可）、会心ダメージを15％上昇させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS3",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { subject: { position: { column: "RIGHT", row: "BACK" } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_CRIT_DAMAGE_UP",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_URUU_SUMMER_PS3_CRIT_DAMAGE_UP",
          magnitude: 0.15,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_URUU_SUMMER (【夏色シャイガール】波瀬うるう)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-URUU-SUMMER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-URUU-SUMMER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-URUU-SUMMER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-URUU-SUMMER-004 (R-EFF-09, R-EFF-10): PS1の防御デバフは付与者が倒れると同時に解除される", () => {
    // 「防御デバフは付与者が倒れると解除される」を、Markerを親・`APPLY_STAT_MOD` を
    // 子にした親子連動グループで表している。`AppliedEffect` 単体では付与者の戦闘
    // 不能を判定できない（`removeOnSourceDefeated` は `APPLY_MARKER` 専用）ため、
    // カスケードが本当に働くことは実 `MarkerRemoved` 経路でしか確かめられない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_URUU_SUMMER_PS1",
    });
    const afterPs1 = chain.fire(
      skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_URUU_SUMMER_AS1",
      }),
      board.units,
    );
    const debuffed = afterPs1.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(debuffed.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toContain(
      "ACT_URUU_SUMMER_PS1_DEF_DOWN",
    );
    expect(debuffed.markerStates.map((marker) => marker.markerId)).toEqual([PS1_DEF_DOWN_MARKER]);

    // 付与者（うるう）が倒れると、親Markerが `SOURCE_DEFEATED` で解除され、
    // 同じ `linkedEffectGroupId` を持つ防御デバフも連動して失効する。
    const afterDefeat = chain.fire(
      unitDefeated({ unit: "ally:subject", defeatedBy: "enemy:front" }),
      afterPs1.map((unit) =>
        unit.battleUnitId === "ally:subject" ? { ...unit, currentHp: 0, isAlive: false } : unit,
      ),
    );
    const cleared = afterDefeat.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(cleared.markerStates).toEqual([]);
    expect(cleared.appliedEffects.map((effect) => effect.effectActionDefinitionId)).not.toContain(
      "ACT_URUU_SUMMER_PS1_DEF_DOWN",
    );
  });
});
