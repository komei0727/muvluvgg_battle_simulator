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

/**
 * `UNIT_MERU_BESIDE_TEX`（【隣歩む想い】桃園める・戦術演習版）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）。プレイアブル版
 * `UNIT_MERU_BESIDE` との差分:
 *
 * - 「真心」は配置の行で効果が分かれず、常に回復量増加・被ダメージ減少・回避の組になる
 * - EX: シールドの付与先が自身になる。願い星は原文「自身を除く味方全体」だが、単騎の演習敵
 *   では自身へ付与する（Q-TEX-12、ユーザー確認済み）
 * - AS2: 「真心」の付与先が自身になる
 * - PS1: 契機が「自身がアクティブスキルで攻撃した後」になり、付与先は自身、EXゲージ加算は
 *   無条件になる。演習版のASはどちらも攻撃しないため、実戦闘では発動しない
 *
 * 単騎であるため、盤面は既定で味方を自身だけにする。
 */

const UNIT_DEFINITION_ID = "UNIT_MERU_BESIDE_TEX";
const MAGOKORO = "MARKER_MERU_BESIDE_TEX_MAGOKORO";
const MAGOKORO_TIMED = "MARKER_MERU_BESIDE_TEX_MAGOKORO_TIMED";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const SOLO: BoardOverrides = { allies: [] };

/** 「真心」1回分の定義ID。ID網羅監査がリテラルだけを数えるため、組み立てずに列挙する。 */
const MAGOKORO_IDS = {
  "": {
    marker: "ACT_MERU_BESIDE_TEX_MAGOKORO_MARKER",
    healUp: "ACT_MERU_BESIDE_TEX_MAGOKORO_HEAL_UP",
    dmgDown: "ACT_MERU_BESIDE_TEX_MAGOKORO_DMG_DOWN",
    evasion: "ACT_MERU_BESIDE_TEX_MAGOKORO_EVASION",
  },
  TIMED_: {
    marker: "ACT_MERU_BESIDE_TEX_MAGOKORO_TIMED_MARKER",
    healUp: "ACT_MERU_BESIDE_TEX_MAGOKORO_TIMED_HEAL_UP",
    dmgDown: "ACT_MERU_BESIDE_TEX_MAGOKORO_TIMED_DMG_DOWN",
    evasion: "ACT_MERU_BESIDE_TEX_MAGOKORO_TIMED_EVASION",
  },
} as const;

function magokoroActions(variant: "" | "TIMED_") {
  const ids = MAGOKORO_IDS[variant];
  return [ids.marker, ids.healUp, ids.dmgDown, ids.evasion].map((effectActionDefinitionId) => ({
    effectActionDefinitionId,
    targets: ["ally:subject"],
  }));
}

/** 「真心」の効果。回避は1行動・被ヒット2回、2行動版は他の効果も2行動で切れる。 */
function magokoroEffects(variant: "" | "TIMED_") {
  const ids = MAGOKORO_IDS[variant];
  const timeLimit = variant === "TIMED_" ? { timeLimit: { unit: "ACTION", count: 2 } } : {};
  return [
    {
      unitId: "ally:subject",
      effectActionDefinitionId: ids.healUp,
      magnitude: 0.1,
      ...timeLimit,
    },
    {
      unitId: "ally:subject",
      effectActionDefinitionId: ids.dmgDown,
      magnitude: -0.025,
      ...timeLimit,
    },
    {
      unitId: "ally:subject",
      effectActionDefinitionId: ids.evasion,
      magnitude: 0,
      timeLimit: { unit: "ACTION", count: 1 },
      consumption: { kind: "INCOMING_HIT", maxCount: 2 },
      statusKind: "EVASION",
    },
  ];
}

/** HPが50%未満（40%）の自身。 */
const WOUNDED: BoardOverrides = { allies: [], subject: { state: { currentHp: 4000 } } };

const PS1_TRIGGER = realDamage({ from: "ally:subject", to: "enemy:front", skillType: "AS" });

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_EX",
    intent:
      "最も残HPの少ない敵単体に威力109.2でEN攻撃し、自身に対して与えたダメージの125%分のシールドを付与し、さらに（単騎のため自身へ）サブユニット「願い星」を付与する。「願い星」はこの攻撃で与えたダメージの125%分のHPを持つ。加えて自身に対して「真心」を１つ付与する（解除不可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_EX" },
    board: {
      allies: [],
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 2000 },
        },
      ],
    },
    expected: {
      // (攻撃力1000 − 防御力500) × 1.092 = 546。シールド・願い星の耐久は 546 × 1.25 = 682.5 → 682。
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SUBUNIT", targets: ["ally:subject"] },
        ...magokoroActions(""),
      ],
      hpDeltas: { "enemy:left": -546 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SHIELD",
          magnitude: 682,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SUBUNIT",
          magnitude: 682,
        },
        ...magokoroEffects(""),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_EX",
    intent: "(境界): 後列に置かれても「真心」は同じ効果になる（行による分岐は無い）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_EX" },
    board: { allies: [], subject: { position: { column: "RIGHT", row: "BACK" } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SUBUNIT", targets: ["ally:subject"] },
        ...magokoroActions(""),
      ],
      hpDeltas: { "enemy:front": -546 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SHIELD",
          magnitude: 682,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_EX_SUBUNIT",
          magnitude: 682,
        },
        ...magokoroEffects(""),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1",
    intent:
      "最も残りHPの少ない味方単体（単騎のため自身）に対し、自身が１回行動を終えるまでの間、攻撃力×125%のシールドを付与する。シールドは自身が倒されると解除される",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1" },
    board: WOUNDED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1",
    intent: "さらに対象が「真心」状態の場合、EXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1" },
    board: {
      allies: [],
      subject: { state: { currentHp: 4000 }, markers: [{ markerId: MAGOKORO }] },
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_EX_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1",
    intent: "(分岐): PS1由来（2行動）の「真心」も「真心」状態としてEXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1" },
    board: {
      allies: [],
      subject: { state: { currentHp: 4000 }, markers: [{ markerId: MAGOKORO_TIMED }] },
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_EX_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS1_SHIELD",
          magnitude: 1250,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1",
    intent: "HPが50%未満の味方がいない場合、このスキルは発動しない（既定盤面の自身はちょうど50%）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS1" },
    board: SOLO,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS2",
    intent:
      "自身の攻撃力を１行動の間5%低下させ（重複可）、自身に「真心」を１つ付与する（解除不可）。「真心」はHP回復量を10%増加させ(重複可)、被ダメージを2.5%減少させ（重複可）、１行動の間２ヒットまで50%の確率で回避するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS2" },
    board: SOLO,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS2_SELF_ATK_DOWN",
          targets: ["ally:subject"],
        },
        ...magokoroActions(""),
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS2_SELF_ATK_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...magokoroEffects(""),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS2",
    intent: "(累積): 既に「真心」を持つ自身へ重ねると「真心」が2つになり、効果も2件目が付く",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_AS2" },
    board: { allies: [], subject: { markers: [{ markerId: MAGOKORO }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS2_SELF_ATK_DOWN",
          targets: ["ally:subject"],
        },
        ...magokoroActions(""),
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_AS2_SELF_ATK_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        ...magokoroEffects(""),
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。自身に2行動の「真心」を付与し、１行動の間攻撃力を15%上昇させ（重複可）、EXゲージを１加算する",
    use: { kind: "PASSIVE", skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1", trigger: PS1_TRIGGER },
    board: SOLO,
    expected: {
      actions: [
        ...magokoroActions("TIMED_"),
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS1_EX_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        ...magokoroEffects("TIMED_"),
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS1_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO_TIMED, stackCount: 1 }],
      // PP消費量と同量のEXゲージ（R-PS-05 #2）に、効果のEXゲージ+1が加わる。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1",
    intent: "(不成立): EXスキルでの攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1",
      trigger: realDamage({ from: "ally:subject", to: "enemy:front", skillType: "EX" }),
    },
    board: SOLO,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1",
    intent: "(不成立): 自身以外の攻撃では発動しない（プレイアブル版の「他の味方」契機は持たない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS1",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
    intent:
      "ターン開始時に発動。最も攻撃力が高い味方（単騎のため自身）のEXゲージを１加算する。さらに対象が「真心」状態でない場合「真心」を１つ付与する（解除不可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: SOLO,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_EX_UP", targets: ["ally:subject"] },
        ...magokoroActions(""),
      ],
      effectsApplied: magokoroEffects(""),
      markers: [{ unitId: "ally:subject", markerId: MAGOKORO, stackCount: 1 }],
      // PP消費量と同量のEXゲージ（R-PS-05 #2）に、効果のEXゲージ+1が加わる。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
    intent: "対象が「真心」状態の場合、攻撃力×100%のシールドを付与する（「真心」は増えない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: { allies: [], subject: { markers: [{ markerId: MAGOKORO }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_EX_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_SHIELD",
          magnitude: 1000,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
    intent: "(分岐): PS1由来（2行動）の「真心」状態でもシールド側になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_BESIDE_TEX_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
    },
    board: { allies: [], subject: { markers: [{ markerId: MAGOKORO_TIMED }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_EX_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MERU_BESIDE_TEX_PS2_SHIELD",
          magnitude: 1000,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
    },
  },
];

const MAGOKORO_EFFECT_ACTION_IDS = [
  ...Object.values(MAGOKORO_IDS[""]),
  ...Object.values(MAGOKORO_IDS.TIMED_),
];

function durationOf(effectActionDefinitionId: string): Record<string, unknown> {
  const definition = effectActionFrom(snapshot, effectActionDefinitionId);
  return (definition.payload as unknown as { duration: Record<string, unknown> }).duration;
}

describe("production Catalog UNIT_MERU_BESIDE_TEX (【隣歩む想い】桃園める・戦術演習版)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MERU-BESIDE-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MERU-BESIDE-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MERU-BESIDE-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MERU-BESIDE-TEX-004 [R-EFF-09, R-EFF-10]: every 「真心」-derived definition is non-dispellable and linked to its own grant's Marker; the PS1 variant expires after 2 actions", () => {
    const durations = Object.fromEntries(
      MAGOKORO_EFFECT_ACTION_IDS.map((id) => [id, durationOf(id)]),
    );
    expect(Object.values(durations).every((duration) => duration["dispellable"] === false)).toBe(
      true,
    );
    expect(durations["ACT_MERU_BESIDE_TEX_MAGOKORO_MARKER"]).toEqual({
      dispellable: false,
      linkedEffectGroupId: "MERU_BESIDE_TEX_MAGOKORO_LINK",
      linkedEffectGroupRole: "PARENT",
      linkedEffectGroupScope: "SKILL_USE",
    });
    expect(durations["ACT_MERU_BESIDE_TEX_MAGOKORO_TIMED_MARKER"]).toEqual({
      dispellable: false,
      timeLimit: { unit: "ACTION", count: 2 },
      linkedEffectGroupId: "MERU_BESIDE_TEX_MAGOKORO_TIMED_LINK",
      linkedEffectGroupRole: "PARENT",
      linkedEffectGroupScope: "SKILL_USE",
    });
    for (const [id, duration] of Object.entries(durations)) {
      if (id.endsWith("_MARKER")) {
        continue;
      }
      expect(duration).toMatchObject({
        linkedEffectGroupId: id.includes("_TIMED_")
          ? "MERU_BESIDE_TEX_MAGOKORO_TIMED_LINK"
          : "MERU_BESIDE_TEX_MAGOKORO_LINK",
        linkedEffectGroupRole: "CHILD",
        linkedEffectGroupScope: "SKILL_USE",
      });
    }
  });

  it("IT-UNIT-MERU-BESIDE-TEX-005: AS1's shield lasts until the caster finishes one action and is removed when the caster is defeated", () => {
    expect(durationOf("ACT_MERU_BESIDE_TEX_AS1_SHIELD")).toEqual({
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
      removeOnSourceDefeated: true,
    });
  });
});
