import { describe, expect, it } from "vitest";
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
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, turnStarted } from "../../../testing/production-unit/trigger-events.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import {
  applyPrecedingActions,
  productionBoard,
} from "../../../testing/production-unit/skill-behaviour.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_MERU_BESIDE`（【隣歩む想い】桃園める）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」、Issue #701）。
 *
 * 「真心」は付与時点の対象の行で効果が分かれ、EX/AS2/PS2経由（戦闘終了まで・解除不可）と
 * PS1経由（2行動）で別Markerになる。1つのMarkerは1つのDurationしか持てず（R-EFF-10）、
 * 期間なしと2行動を同じMarkerへ積むと期間が破綻するためである。「真心状態」の判定は
 * 常に両Markerのいずれかを持つかで読む。
 */

const UNIT_DEFINITION_ID = "UNIT_MERU_BESIDE";
const MAGOKORO = "MARKER_MERU_BESIDE_MAGOKORO";
const MAGOKORO_TIMED = "MARKER_MERU_BESIDE_MAGOKORO_TIMED";

/**
 * 「真心」が解除スキルで消えないことは、実 production の解除定義
 * （`ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF`、BUFFを上限なしで解除）を借りて実解除経路で確かめる。
 */
const BUFF_REMOVAL_SOURCE_UNIT_ID = "UNIT_NOEL_RUMBLE";
const BUFF_REMOVAL = "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  BUFF_REMOVAL_SOURCE_UNIT_ID,
]);

/** 前列（自身・ally:front）に付く「真心」の効果。evasionは1行動・被ヒット2回。 */
function frontMagokoroEffects(unitId: string) {
  return [
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_HEAL_UP",
      magnitude: 0.1,
    },
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_DMG_DOWN",
      magnitude: -0.025,
    },
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION",
      magnitude: 0,
      timeLimit: { unit: "ACTION", count: 1 },
      consumption: { kind: "INCOMING_HIT", maxCount: 2 },
      statusKind: "EVASION",
    },
  ];
}

/** 後列（ally:back）に付く「真心」の効果。必中は与ヒット2回で消費する。 */
function backMagokoroEffects(unitId: string) {
  return [
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_CRIT_DMG_UP",
      magnitude: 0.0625,
    },
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_DMG_UP",
      magnitude: 0.1,
    },
    {
      unitId,
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT",
      magnitude: 0,
      consumption: { kind: "OUTGOING_HIT", maxCount: 2 },
      statusKind: "GUARANTEED_HIT",
    },
  ];
}

function frontMagokoroActions(target: string) {
  return [
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_MARKER", targets: [target] },
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_HEAL_UP", targets: [target] },
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_DMG_DOWN", targets: [target] },
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION", targets: [target] },
  ];
}

function backMagokoroActions(target: string) {
  return [
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_MARKER", targets: [target] },
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_CRIT_DMG_UP", targets: [target] },
    { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_DMG_UP", targets: [target] },
    {
      effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT",
      targets: [target],
    },
  ];
}

/** EXの敵側・味方側の「最も残りHPの少ない」を既定の同率から外す盤面。 */
const EX_BOARD: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 3000 } },
  ],
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 2000 } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** AS1: HP50%未満の味方（ally:front、40%）がいる盤面。 */
const AS1_WOUNDED_BOARD: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 4000 } },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** AS2: 累計与ダメージは自身が最大だが、自身以外を優先して後列の味方を選ぶ盤面。 */
const AS2_DAMAGE_BOARD: BoardOverrides = {
  subject: { state: { cumulativeDamageDealt: 5000 } },
  allies: [
    {
      id: "ally:front",
      position: { column: "LEFT", row: "FRONT" },
      state: { cumulativeDamageDealt: 100 },
    },
    {
      id: "ally:back",
      position: { column: "CENTER", row: "BACK" },
      state: { cumulativeDamageDealt: 900 },
    },
  ],
};

/** PS2: 攻撃力が最も高い味方を後列の ally:back にする盤面。 */
function highestAttackBackAlly(markers?: readonly { markerId: string }[]): BoardOverrides {
  return {
    allies: [
      { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
      {
        id: "ally:back",
        position: { column: "CENTER", row: "BACK" },
        combatStats: { attack: 2000 },
        ...(markers === undefined ? {} : { markers }),
      },
    ],
  };
}

const PS1_TRIGGER = realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" });

const PS1_EXPECTED_ACTIONS = [
  { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_MARKER", targets: ["ally:front"] },
  {
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP",
    targets: ["ally:front"],
  },
  {
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_DMG_DOWN",
    targets: ["ally:front"],
  },
  {
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_EVASION",
    targets: ["ally:front"],
  },
  { effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_ATK_UP", targets: ["ally:front"] },
];

const PS1_EXPECTED_EFFECTS = [
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP",
    magnitude: 0.1,
    timeLimit: { unit: "ACTION", count: 2 },
  },
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_DMG_DOWN",
    magnitude: -0.025,
    timeLimit: { unit: "ACTION", count: 2 },
  },
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_EVASION",
    magnitude: 0,
    timeLimit: { unit: "ACTION", count: 1 },
    consumption: { kind: "INCOMING_HIT", maxCount: 2 },
    statusKind: "EVASION",
  },
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_ATK_UP",
    magnitude: 0.15,
    timeLimit: { unit: "ACTION", count: 1 },
  },
];

const PS1_SELF_RESOURCES = [
  { unitId: "ally:subject", resource: "PP", delta: -1 },
  { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
] as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MERU_BESIDE_EX",
    intent:
      "最も残HPの少ない敵単体に威力109.2でEN攻撃し、最も残りHPの少ない味方単体に対して与えたダメージの125%分のシールドを付与し、さらに自身を除く味方全体にサブユニット「願い星」を１つずつ付与する。「願い星」はこの攻撃で与えたダメージの125%分のHPを持ち、攻撃時に攻撃力×10%のダメージを追加する。加えて自身に対して「真心」を１つ付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_EX" },
    board: EX_BOARD,
    expected: {
      // (攻撃力1000 − 防御力500) × 1.092 = 546。シールド・願い星の耐久は 546 × 1.25 = 682.5 → 682。
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD", targets: ["ally:back"] },
        // サブユニットは対象ごとに独立したインスタンスとして付与されるため、対象ごとに観測される。
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SUBUNIT", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SUBUNIT", targets: ["ally:back"] },
        ...frontMagokoroActions("ally:subject"),
      ],
      hpDeltas: { "enemy:left": -546 },
      effectsApplied: [
        ...frontMagokoroEffects("ally:subject"),
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SUBUNIT",
          magnitude: 682,
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD",
          magnitude: 682,
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SUBUNIT",
          magnitude: 682,
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_EX",
    intent: "(分岐): 自身以外の味方がいなくても発動し、シールドは自身へ、願い星は付与されない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_EX" },
    board: { allies: [] },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD", targets: ["ally:subject"] },
        ...frontMagokoroActions("ally:subject"),
      ],
      hpDeltas: { "enemy:front": -546 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD",
          magnitude: 682,
        },
        ...frontMagokoroEffects("ally:subject"),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_EX",
    intent: "(分岐): 後列に編成されていた場合、自身の「真心」は後列の効果になる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_EX" },
    board: { subject: { position: { column: "RIGHT", row: "BACK" } }, allies: [] },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD", targets: ["ally:subject"] },
        ...backMagokoroActions("ally:subject"),
      ],
      hpDeltas: { "enemy:front": -546 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_EX_SHIELD",
          magnitude: 682,
        },
        ...backMagokoroEffects("ally:subject"),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS1",
    intent:
      "最も残りHPの少ない味方単体に対し、自身が１回行動を終えるまでの間、攻撃力×125%のシールドを付与する。シールドは自身が倒されると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS1" },
    board: AS1_WOUNDED_BOARD,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS1",
    intent: "さらに対象が「真心」状態の場合、EXゲージを1加算する（加算先はシールドを付与した味方）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS1" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 4000 },
          markers: [{ markerId: MAGOKORO }],
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_EX_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS1",
    intent: "(分岐): PS1由来（2行動）の「真心」も「真心」状態として EXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS1" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 4000 },
          markers: [{ markerId: MAGOKORO_TIMED }],
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_EX_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS1",
    intent: "HPが50%未満の味方がいない場合、このスキルは発動しない（既定盤面は全員ちょうど50%）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS1" },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS2",
    intent:
      "自身の攻撃力を１行動の間5%低下させ（重複可）、自信以外を優先し、最も累計ダメージの多い味方単体に「真心」を１つ付与する（後列の味方には後列の効果）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS2" },
    board: AS2_DAMAGE_BOARD,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          targets: ["ally:subject"],
        },
        ...backMagokoroActions("ally:back"),
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...backMagokoroEffects("ally:back"),
      ],
      markers: [{ unitId: "ally:back", markerId: MAGOKORO, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS2",
    intent: "(分岐): 自身以外の味方がいなければ自身に「真心」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS2" },
    board: { allies: [] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          targets: ["ally:subject"],
        },
        ...frontMagokoroActions("ally:subject"),
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...frontMagokoroEffects("ally:subject"),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_AS2",
    intent: "(累積): 既に「真心」を持つ味方へ重ねると「真心」が2つになり、効果も2件目が付く",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_AS2" },
    board: {
      allies: [
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { cumulativeDamageDealt: 900 },
          markers: [{ markerId: MAGOKORO }],
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          targets: ["ally:subject"],
        },
        ...backMagokoroActions("ally:back"),
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_AS2_SELF_ATK_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...backMagokoroEffects("ally:back"),
      ],
      markers: [{ unitId: "ally:back", markerId: MAGOKORO, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS1",
    intent:
      "他の味方がアクティブスキルで攻撃した後に発動。攻撃した味方単体に2行動の「真心」を付与し、１行動の間攻撃力を15%上昇させる（重複可）",
    use: { kind: "PASSIVE", skillDefinitionId: "SKL_MERU_BESIDE_PS1", trigger: PS1_TRIGGER },
    expected: {
      actions: PS1_EXPECTED_ACTIONS,
      effectsApplied: PS1_EXPECTED_EFFECTS,
      markers: [{ unitId: "ally:front", markerId: MAGOKORO_TIMED, stackCount: 1 }],
      resources: [...PS1_SELF_RESOURCES],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS1",
    intent: "さらに対象の味方がシャイ属性だった場合、EXゲージを１加算する",
    use: { kind: "PASSIVE", skillDefinitionId: "SKL_MERU_BESIDE_PS1", trigger: PS1_TRIGGER },
    board: {
      allies: [
        { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SHY" },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        ...PS1_EXPECTED_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_EX_UP", targets: ["ally:front"] },
      ],
      effectsApplied: PS1_EXPECTED_EFFECTS,
      markers: [{ unitId: "ally:front", markerId: MAGOKORO_TIMED, stackCount: 1 }],
      resources: [...PS1_SELF_RESOURCES, { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS1",
    intent: "(R-ATR-04): メイン属性が不一致でもサブ属性がシャイ属性ならEXゲージを１加算する",
    use: { kind: "PASSIVE", skillDefinitionId: "SKL_MERU_BESIDE_PS1", trigger: PS1_TRIGGER },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { subAttribute: "SHY" },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        ...PS1_EXPECTED_ACTIONS,
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_EX_UP", targets: ["ally:front"] },
      ],
      effectsApplied: PS1_EXPECTED_EFFECTS,
      markers: [{ unitId: "ally:front", markerId: MAGOKORO_TIMED, stackCount: 1 }],
      resources: [...PS1_SELF_RESOURCES, { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS1",
    intent: "(分岐): EXスキルでの攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "EX" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS1",
    intent: "(分岐): 自身のアクティブスキルでの攻撃では発動しない（他の味方に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS2",
    intent:
      "ターン開始時に発動。最も攻撃力が高い味方のEXゲージを１加算する。さらに対象が「真心」状態でない場合「真心」を１つ付与する（後列の味方には後列の効果）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: highestAttackBackAlly(),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_EX_UP", targets: ["ally:back"] },
        ...backMagokoroActions("ally:back"),
      ],
      effectsApplied: backMagokoroEffects("ally:back"),
      markers: [{ unitId: "ally:back", markerId: MAGOKORO, stackCount: 1 }],
      resources: [
        // PP消費量と同量だけEXゲージが増える（R-PS-05 #2）。
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "ally:back", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS2",
    intent: "対象が「真心」状態の場合、攻撃力×100%のシールドを付与する（「真心」は増えない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: highestAttackBackAlly([{ markerId: MAGOKORO }]),
    expected: {
      // シールド量はスキル使用者（める）の攻撃力1000 × 100%。
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_EX_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_SHIELD", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_SHIELD",
          magnitude: 1000,
        },
      ],
      resources: [
        // PP消費量と同量だけEXゲージが増える（R-PS-05 #2）。
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "ally:back", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_PS2",
    intent: "(分岐): PS1由来（2行動）の「真心」状態でもシールド側になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: highestAttackBackAlly([{ markerId: MAGOKORO_TIMED }]),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_EX_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_SHIELD", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_PS2_SHIELD",
          magnitude: 1000,
        },
      ],
      resources: [
        // PP消費量と同量だけEXゲージが増える（R-PS-05 #2）。
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "ally:back", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

/** 「真心」由来の定義。解除不可バフ扱い（ユーザー確認済みの解釈）。 */
const MAGOKORO_EFFECT_ACTION_IDS = [
  "MAGOKORO_MARKER",
  "MAGOKORO_FRONT_HEAL_UP",
  "MAGOKORO_FRONT_DMG_DOWN",
  "MAGOKORO_FRONT_EVASION",
  "MAGOKORO_BACK_CRIT_DMG_UP",
  "MAGOKORO_BACK_DMG_UP",
  "MAGOKORO_BACK_GUARANTEED_HIT",
].flatMap((suffix) => [
  `ACT_MERU_BESIDE_${suffix}`,
  `ACT_MERU_BESIDE_${suffix.replace("MAGOKORO_", "MAGOKORO_TIMED_")}`,
]);

function durationOf(effectActionDefinitionId: string): {
  readonly dispellable: boolean;
  readonly timeLimit?: { readonly unit: string; readonly count: number };
  readonly linkedEffectGroupRole?: string;
} {
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  return (definition.payload as { duration: ReturnType<typeof durationOf> }).duration;
}

describe("production Catalog UNIT_MERU_BESIDE (【隣歩む想い】桃園める)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MERU-BESIDE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MERU-BESIDE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MERU-BESIDE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
    // PS1由来（2行動）の後列側は、PS1の契機を作れる後列の味方の盤面が要るため別に確認する
    // （IT-UNIT-MERU-BESIDE-005）。
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([
      "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_CRIT_DMG_UP",
      "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_DMG_UP",
      "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_GUARANTEED_HIT",
    ]);
  });

  it("IT-UNIT-MERU-BESIDE-004: every 「真心」-derived definition is non-dispellable; only the battle-long variant links its buffs to the Marker, the PS1 variant expires after 2 actions", () => {
    const durations = Object.fromEntries(
      MAGOKORO_EFFECT_ACTION_IDS.map((id) => [id, durationOf(id)]),
    );
    expect(Object.values(durations).every((duration) => duration.dispellable === false)).toBe(true);
    expect(durations["ACT_MERU_BESIDE_MAGOKORO_MARKER"]).toEqual({
      dispellable: false,
      linkedEffectGroupId: "MERU_BESIDE_MAGOKORO_LINK",
      linkedEffectGroupRole: "PARENT",
    });
    expect(durations["ACT_MERU_BESIDE_MAGOKORO_TIMED_MARKER"]).toEqual({
      dispellable: false,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 2 },
    });
  });

  it("IT-UNIT-MERU-BESIDE-006: AS1's shield lasts until the caster finishes one action and is removed when the caster is defeated", () => {
    expect(durationOf("ACT_MERU_BESIDE_AS1_SHIELD")).toEqual({
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
      removeOnSourceDefeated: true,
    });
  });

  it("IT-UNIT-MERU-BESIDE-005: PS1 grants the back-row 「真心」 (2 actions) to a back-row ally that attacked with an Active Skill", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_MERU_BESIDE_PS1",
          trigger: realDamage({ from: "ally:back", to: "enemy:front", skillType: "AS" }),
        },
      }),
    ).toEqual({
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_MARKER",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_CRIT_DMG_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_DMG_UP",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_GUARANTEED_HIT",
          targets: ["ally:back"],
        },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_ATK_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_CRIT_DMG_UP",
          magnitude: 0.0625,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_DMG_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_BACK_GUARANTEED_HIT",
          magnitude: 0,
          consumption: { kind: "OUTGOING_HIT", maxCount: 2 },
          statusKind: "GUARANTEED_HIT",
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:back", markerId: MAGOKORO_TIMED, stackCount: 1 }],
      resources: [...PS1_SELF_RESOURCES],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_PS1", remaining: 1 },
      ],
    });
  });

  it("IT-UNIT-MERU-BESIDE-007 [R-HIT-02, R-HIT-04]: the front-row 「真心」 evasion evades at 50% per hit, is consumed only by the hits it actually evades, and expires after evading two", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const holding = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION", target: "SELF" },
    ]);
    const attacked = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: holding,
      attackerUnitId: "enemy:front",
      targetUnitId: "ally:subject",
      hitCount: 4,
      accuracy: "NORMAL",
      // 回避は `next() < 0.5` で成立する。1ヒット目成立、2ヒット目不成立、3ヒット目成立、
      // 4ヒット目は回避効果が失効済みのため抽選自体が起きない。
      random: new SequenceRandomSource([0.1, 0.9, 0.1]),
      battleId: "B_MERU_EVASION",
    });

    expect(attacked.hits).toEqual([
      { hitIndex: 1, result: "EVADED", evadedBy: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION" },
      { hitIndex: 2, result: "CONFIRMED" },
      { hitIndex: 3, result: "EVADED", evadedBy: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION" },
      { hitIndex: 4, result: "CONFIRMED" },
    ]);
    expect(attacked.consumptions).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION",
        kind: "INCOMING_HIT",
        before: 2,
        after: 1,
      },
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION",
        kind: "INCOMING_HIT",
        before: 1,
        after: 0,
      },
    ]);
    expect(attacked.expirations).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION",
        reason: "CONSUMPTION",
        cascaded: false,
      },
    ]);
  });

  it("IT-UNIT-MERU-BESIDE-008 [R-HIT-05, R-EFF-07]: the back-row 「真心」 guaranteed hit makes the holder's first two confirmed hits ignore evasion, is consumed per outgoing hit, and the third hit can be evaded again", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const holding = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT", target: "SELF" },
      // 攻撃される側に回避を持たせ、必中が実際に回避を止めたことを観測できるようにする。
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION", target: "ENEMY" },
    ]);
    const attacked = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: holding,
      attackerUnitId: "ally:subject",
      targetUnitId: "enemy:front",
      hitCount: 3,
      accuracy: "NORMAL",
      // 必中中の2ヒットは回避抽選自体が起きない。3ヒット目だけが抽選し、0.1で回避が成立する。
      random: new SequenceRandomSource([0.1]),
      battleId: "B_MERU_GUARANTEED_HIT",
    });

    expect(attacked.hits).toEqual([
      { hitIndex: 1, result: "CONFIRMED" },
      { hitIndex: 2, result: "CONFIRMED" },
      { hitIndex: 3, result: "EVADED", evadedBy: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION" },
    ]);
    expect(attacked.consumptions).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT",
        kind: "OUTGOING_HIT",
        before: 2,
        after: 1,
      },
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT",
        kind: "OUTGOING_HIT",
        before: 1,
        after: 0,
      },
      {
        unitId: "enemy:front",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_EVASION",
        kind: "INCOMING_HIT",
        before: 2,
        after: 1,
      },
    ]);
    expect(attacked.expirations).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT",
        reason: "CONSUMPTION",
        cascaded: false,
      },
    ]);
  });

  it("IT-UNIT-MERU-BESIDE-009 [R-EFF-04, R-EFF-10]: the PS1 「真心」 and its buffs expire at the end of the holder's second action, the front-row evasion after the first, while the battle-long 「真心」 stays", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const holding = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_MARKER", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_DMG_DOWN", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_EVASION", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_MARKER", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_FRONT_HEAL_UP", target: "SELF" },
    ]);
    const observation = observeEffectExpiry({
      definitions: board.definitions,
      units: holding,
      steps: [
        { kind: "ACTION_END", actor: "ally:subject" },
        { kind: "ACTION_END", actor: "ally:subject" },
      ],
      watchMarkers: ["ally:subject"],
      battleId: "B_MERU_TIMED_EXPIRY",
    });

    const timedExpiry = (effectActionDefinitionId: string) => ({
      unitId: "ally:subject",
      effectActionDefinitionId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
    expect(observation.steps).toEqual([
      {
        step: "ACTION_END(ally:subject)",
        // 回避は「1行動の間」。2行動版のバフは残り1。
        expired: [timedExpiry("ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_EVASION")],
        remaining: {
          "ally:subject/ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP": 1,
          "ally:subject/ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_DMG_DOWN": 1,
        },
        markers: {
          [`ally:subject/${MAGOKORO}`]: 1,
          [`ally:subject/${MAGOKORO_TIMED}`]: 1,
        },
      },
      {
        step: "ACTION_END(ally:subject)",
        expired: [
          timedExpiry("ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP"),
          timedExpiry("ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_DMG_DOWN"),
        ],
        remaining: {},
        // 2行動版のMarkerは2行動で消え、戦闘終了まで版のMarker（と期間を持たないバフ）は残る。
        markers: { [`ally:subject/${MAGOKORO}`]: 1 },
      },
    ]);
    expect(
      observation.units
        .find((unit) => unit.battleUnitId === "ally:subject")!
        .appliedEffects.map((effect) => effect.effectActionDefinitionId),
    ).toEqual(["ACT_MERU_BESIDE_MAGOKORO_FRONT_HEAL_UP"]);
  });

  it("IT-UNIT-MERU-BESIDE-010 [R-EFF-02]: a real buff removal (REMOVE_EFFECTS BUFF) strips an ordinary buff but leaves every 「真心」 Marker and buff in place", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const holding = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_MARKER", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_CRIT_DMG_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_DMG_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_BACK_GUARANTEED_HIT", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_MARKER", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_HEAL_UP", target: "SELF" },
      { effectActionDefinitionId: "ACT_MERU_BESIDE_MAGOKORO_TIMED_FRONT_EVASION", target: "SELF" },
      // 解除が実際に走ったことの対照: 解除可能な通常のバフ。
      { effectActionDefinitionId: "ACT_MERU_BESIDE_PS1_ATK_UP", target: "SELF" },
    ]);
    const removed = applyPrecedingActions({ ...board, units: holding }, [
      { effectActionDefinitionId: BUFF_REMOVAL, target: "SELF" },
    ]);
    const before = holding.find((unit) => unit.battleUnitId === "ally:subject")!;
    const after = removed.find((unit) => unit.battleUnitId === "ally:subject")!;

    expect(after.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual(
      before.appliedEffects
        .map((effect) => effect.effectActionDefinitionId)
        .filter((id) => id !== "ACT_MERU_BESIDE_PS1_ATK_UP"),
    );
    expect(before.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toContain(
      "ACT_MERU_BESIDE_PS1_ATK_UP",
    );
    expect(after.markerStates.map((marker) => [marker.markerId, marker.stackCount])).toEqual([
      [MAGOKORO, 1],
      [MAGOKORO_TIMED, 1],
    ]);
  });
});
