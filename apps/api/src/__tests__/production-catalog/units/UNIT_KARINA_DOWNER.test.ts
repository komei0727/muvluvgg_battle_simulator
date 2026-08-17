import { describe, expect, it } from "vitest";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import { loadProductionSnapshot, skillFrom, unitFrom } from "../../../testing/fixtures/index.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../../testing/production-unit/passive-activation.js";
import { observeExGaugeGain } from "../../../testing/production-unit/resource-gain.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  turnCompleting,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";
import { repeatedStatModGrant } from "../../../testing/production-unit/stat-mod-stacking.js";

/**
 * `UNIT_KARINA_DOWNER`（【ダウナーギャルな副委員長】カリナ・ジェンティーレ）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_KARINA_DOWNER";

/**
 * PS2が配る獲得量増加が効いたかどうかは、**補正を受けた味方が自分の行動で得る
 * EXゲージ**にしか現れない。基礎量はR-ACT-03より消費APと同量なので、AP2消費の実AS
 * （`SKL_SENKA_SCHEMER_AS1`）を持つユニットだけを併せて読み込み、+50%が切り捨てで
 * 消えない大きさにする。`-002`／`-003` はこのユニットのSkill・EffectAction閉包だけを
 * 見るため、閉包の判定には影響しない。
 */
const EX_EARNER_UNIT_ID = "UNIT_SENKA_SCHEMER";
const EX_EARNER_AS_ID = "SKL_SENKA_SCHEMER_AS1";
/** 実 `catalog/` の消費AP。そのまま基礎EXゲージ獲得量になる。 */
const EX_EARNER_AS_COST = 2;
const EX_GAIN_UP = "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  EX_EARNER_UNIT_ID,
]);

const KEIBO = "MARKER_KEIBO";

/** 「警棒」ではない実在のMarker。`MARKER_COUNT_SCALE` が `markerId` を見ている対照。 */
const OTHER_MARKER = "MARKER_FEE_BATH_FLUSH";

/** EXゲージを持つ敵。0のままでは「EXゲージを1削る」が下限で消えて観測に載らない。 */
const ENEMIES_WITH_EX_GAUGE: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentExtraGauge: 3 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentExtraGauge: 3 } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { currentExtraGauge: 3 },
  },
];

/**
 * 「警棒」の所持数だけを変えた敵。増加率が段数に比例し3つで頭打ちになること、
 * および**別のMarkerは何段持っていても寄与しない**ことを見る。
 */
const ENEMIES_WITH_KEIBO: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    markers: [{ markerId: KEIBO, stackCount: 2 }],
  },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: KEIBO, stackCount: 5 }],
  },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    markers: [{ markerId: OTHER_MARKER, stackCount: 3 }],
  },
];

/** HP割合だけを変えた敵。「HPが多いほど高い効果」が線形に効くことを見る。 */
const ENEMIES_BY_HP_RATIO: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 10000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 5000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_EX",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対して威力124.8で攻撃し、2行動の間、行動時に攻撃力×7.5%の継続ダメージを受けるデバフを付与する。さらに2行動の間対象の攻撃力を30%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_EX" },
    expected: {
      // 最も近い敵は敵前列中央。隣接（上下左右）は enemy:left と enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -624,
        "enemy:left": -624,
        "enemy:back": -624,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          // 継続ダメージ量は付与時に付与者の攻撃力からsnapshotする（R-DOT-01）。
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS1",
    intent: "敵全体に威力53で攻撃し、EXゲージを1削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS1" },
    board: { enemies: ENEMIES_WITH_EX_GAUGE },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -265,
        "enemy:left": -265,
        "enemy:back": -265,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:left", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KARINA_DOWNER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS1",
    intent:
      "この攻撃によるダメージは、対象に付与されている「警棒」1つにつき15%増加する(最大3つまで)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS1" },
    board: { enemies: ENEMIES_WITH_KEIBO },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:left"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:back"],
          resultKind: "SKIPPED",
        },
      ],
      // 265 の +30%（2つ）／+45%（5つは3つで頭打ち）／別Markerを3つ持つ敵は増加なし。
      hpDeltas: {
        "enemy:front": -344,
        "enemy:left": -384,
        "enemy:back": -265,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KARINA_DOWNER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS2",
    intent:
      "自身から最も遠い位置にいる敵単体に威力140.4で攻撃し、2行動の間攻撃力を10%低下させる(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS2" },
    expected: {
      // 前列中央の自身から最も遠いのは敵後列。
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_ATKDOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -702 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_ATKDOWN",
          magnitude: -0.1,
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
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent:
      "他の味方が後列の敵にアクティブスキルで攻撃される前に発動。自身に対しこの行動内で受けるデバフを無効にする効果を付与した後、攻撃してくる敵単体に対して「警棒」を1つ付与してこの行動内の攻撃力を25%低下させ(重複可)、行動が終了するまでの間攻撃を自身に引き寄せ肩代わりする。さらに後列の敵に対し、3行動の間攻撃力を10%低下させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_MARK_ATTACKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_COVER", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN",
          targets: ["enemy:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          // 肩代わり率（`damageShareRate`）がそのまま`magnitude`へ載る。
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_COVER",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      markers: [{ unitId: "enemy:back", markerId: KEIBO, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): 前列の敵からの攻撃では発動しない（「後列の敵に」攻撃される場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): 自身が攻撃される場合は発動しない（「他の味方が」攻撃される場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:subject", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): EXスキルで攻撃される場合は発動しない（「アクティブスキルで」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "EX" }),
      triggeredBy: "enemy:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): このスキルは自身のHPが40%未満の場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    board: { subject: { state: { currentHp: 3999 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS2",
    intent:
      "ターン終了時に発動。敵全体に対し、次の攻撃での与ダメージを最高30%低下させるデバフを付与する(重複可)。このデバフは対象のHPが多いほど高い効果を発揮する。さらに味方全体に対し、1行動の間得られるEXゲージを50%増加させるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS2",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: ENEMIES_BY_HP_RATIO },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        // 満HP（10000/10000）で上限の-30%、半分で-15%、2割で-6%。
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.15,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.06,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_EX",
    intent: "同上: 敵が1体だけで隣接対象がいなくてもEXは発動する（発動不能ならEXゲージを全量失う）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_EX", actionType: "EX" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -624,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: {
            unit: "ACTION",
            count: 2,
          },
        },
      ],
    },
  },
];

describe("production Catalog UNIT_KARINA_DOWNER (【ダウナーギャルな副委員長】カリナ・ジェンティーレ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KARINA-DOWNER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KARINA-DOWNER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KARINA-DOWNER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-KARINA-DOWNER-004 (R-PS-01): PS2の実 `TurnCompleting` SELF/SELF trigger は、`battle.ts` の発行どおり `sourceUnitId`/`targetUnitIds` を持たないターン境界イベントに対して保持者自身で成立する", () => {
    // `TurnStarted`/`TurnCompleting` は特定のBattleUnitに帰属しないグローバル
    // イベントで、`battle.ts` はどちらの欄も設定せずに発行する。production Catalog
    // はそれでも「自身のターン終了時」を `SELF`/`SELF` で表す（`TurnStarted` 27件・
    // `TurnCompleting` 12件）ため、契機イベントに保持者を帰属させた形で候補検出を
    // 通すと、この39行が実戦闘では候補化されない状態を見逃す。
    const trigger = skillFrom(snapshot, "SKL_KARINA_DOWNER_PS2").triggers[0];
    expect(trigger).toMatchObject({
      eventType: "TurnCompleting",
      sourceSelector: "SELF",
      targetSelector: "SELF",
    });

    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_KARINA_TURN_END",
    });
    chain.fire(turnCompleting({ turnNumber: 1 }), board.units);

    const recorded = chain.eventsOfType("TurnCompleting")[0];
    expect(recorded).toBeDefined();
    expect(recorded!.sourceUnitId).toBeUndefined();
    expect(recorded!.targetUnitIds).toBeUndefined();
    expect(activatedPassiveSkillIds(chain)).toContain("SKL_KARINA_DOWNER_PS2");
  });

  it("IT-UNIT-KARINA-DOWNER-005 (R-INT-01 #1/#2): PS1が攻撃者へ付けた引き寄せは付与時点でカリナ自身へ焼き込まれ、その攻撃者が別の味方を名指しで殴っても防御側がカリナへ差し替わる", () => {
    // 引き寄せ・肩代わりは**付与とその効果が働く攻撃が別のスキル使用**である。
    // `-001` の振る舞い表はスキル使用1回を単位に取るため、付与された
    // `AppliedEffect` の `magnitude` までしか表せず、`redirectTo: SELF` が誰へ
    // 解決されたか・以後の1発がどこへ着弾するかを持てない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:back",
      battleId: "B_KARINA_REDIRECT",
    });
    const granted = chain.fire(
      unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      board.units,
    );
    expect(activatedPassiveSkillIds(chain)).toContain("SKL_KARINA_DOWNER_PS1");

    // `redirectTo: SELF` は付与時点で使用者（カリナ）へ解決して焼き込む。
    const attacker = granted.find((unit) => unit.battleUnitId === "enemy:back")!;
    const redirect = attacker.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_KARINA_DOWNER_PS1_REDIRECT",
    )!;
    expect(redirect.targetRedirect).toEqual({
      redirectToUnitId: "ally:subject",
      actionKinds: ["DAMAGE"],
    });
    // R-INT-01/02: 攻撃側が保持する介入状態はデバフに分類する。
    expect([...redirect.categories]).toEqual(["DEBUFF"]);

    const hit = observeDamageProbe({
      units: granted,
      attackerUnitId: "enemy:back",
      targetUnitId: "ally:front",
      battleId: "B_KARINA_REDIRECT_HIT",
    });

    // R-INT-01: 引き寄せ→肩代わりの順に評価する。肩代わりはredirect後の対象に対して
    // 評価するため、肩代わり者が引き寄せ先と同じカリナで `guardRate: 0` の
    // `ACT_KARINA_DOWNER_PS1_COVER` は防御側も量も動かさず、イベントも出さない。
    expect(hit.redirects).toEqual([
      {
        reason: "TARGET_REDIRECT",
        originalTargetUnitId: "ally:front",
        newTargetUnitId: "ally:subject",
        causeEffectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT",
      },
    ]);
    // 名指しした ally:front には1ダメージも入らない。攻撃力はPS1が同じ行動内で
    // 掛けた -25%（攻撃してきた敵）と -10%（後列の敵）ぶん下がっている。
    expect(hit.hpDeltas).toEqual({ "ally:subject": -150 });
  });

  it("IT-UNIT-KARINA-DOWNER-006 (R-EFF-04): PS1の「1行動の間」4件は`owner: BATTLE`で、保持者でも付与者でもない誰か1体の行動終了で揃って失効する。同じPSが配る`owner`省略の3行動デバフはその行動終了では動かない", () => {
    // 付与と `timeLimit: { unit: ACTION, count: 1, owner: BATTLE }` の宣言は
    // `-001` のPS1行が持つ。`BATTLE` は「誰の行動終了でも減る」ことでしか
    // `EFFECT_TARGET`／`EFFECT_SOURCE` と区別できず、それは保持者・付与者の
    // どちらでもないユニットの行動を跨がないと現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "enemy:back",
      battleId: "B_KARINA_BATTLE_OWNER",
    });
    const granted = chain.fire(
      unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      board.units,
    );
    expect(activatedPassiveSkillIds(chain)).toContain("SKL_KARINA_DOWNER_PS1");

    expect(
      observeEffectExpiry({
        units: granted,
        definitions: board.definitions,
        // 保持者は ally:subject と enemy:back、付与者はカリナ（ally:subject）。
        // ally:front はそのいずれでもない。
        steps: [
          { kind: "ACTION_END", actor: "ally:front" },
          { kind: "ACTION_END", actor: "enemy:back" },
        ],
        watch: [{ unitId: "enemy:back", stat: "attack" }],
      }).steps,
    ).toEqual([
      {
        step: "ACTION_END(ally:front)",
        // 「後列の敵の攻撃力を3行動の間10%低下」だけは `owner` を省略した
        // 既定の `EFFECT_TARGET` なので、保持者以外の行動終了では減らない。
        remaining: { "enemy:back/ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN": 3 },
        expired: [
          {
            unitId: "ally:subject",
            effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
          {
            unitId: "enemy:back",
            effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
          {
            unitId: "enemy:back",
            effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
          {
            unitId: "enemy:back",
            effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_COVER",
            reason: "TIME_LIMIT",
            cascaded: false,
          },
        ],
        // -25%（攻撃してきた敵）だけが巻き戻り、-10%（後列の敵）は残る（650 → 900）。
        stats: { "enemy:back/attack": 900 },
      },
      // 保持者自身の行動終了では既定 owner のデバフも減る。
      {
        step: "ACTION_END(enemy:back)",
        remaining: { "enemy:back/ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN": 2 },
      },
    ]);
  });

  it("IT-UNIT-KARINA-DOWNER-007 (R-DMG-01/R-NUM-04): AS1の1回のAOE解決は、対象ごとに**その対象自身**の「警棒」所持数からAction内追加ダメージ倍率を決める。`DamageCalculated` の集計欄が対象別に分かれ、別Markerは何段持っていても寄与しない", () => {
    // `-001` の行は所持数ごとのHP減少（265／344／384）までを固定する。R-DMG-01が
    // 定める倍率そのもの（`1 + 補正合計`）は `DamageCalculated` の集計欄にしかなく、
    // 「同じ1回の解決の中で対象ごとに分かれる」ことも合計値だけからは
    // 全員一律の倍率と区別できない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
      enemies: [
        { id: "enemy:none", position: { column: "CENTER", row: "FRONT" } },
        {
          id: "enemy:two",
          position: { column: "LEFT", row: "FRONT" },
          markers: [{ markerId: KEIBO, stackCount: 2 }],
        },
        {
          id: "enemy:five",
          position: { column: "RIGHT", row: "FRONT" },
          markers: [{ markerId: KEIBO, stackCount: 5 }],
        },
        {
          id: "enemy:other",
          position: { column: "CENTER", row: "BACK" },
          markers: [{ markerId: OTHER_MARKER, stackCount: 3 }],
        },
      ],
    });
    const recorder = new EventRecorder(createBattleId("B_KARINA_KEIBO"));
    resolveSkillUse(
      board.subject,
      skillFrom(snapshot, "SKL_KARINA_DOWNER_AS1"),
      "AS",
      "AS",
      board.units,
      board.definitions,
      new SequenceRandomSource(new Array<number>(32).fill(0.99)),
      recorder,
      1,
      1,
      createActionId("B_KARINA_KEIBO:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const multiplierByTarget: Record<string, number> = {};
    for (const event of recorder.getEvents()) {
      if (event.eventType !== "DamageCalculated") {
        continue;
      }
      multiplierByTarget[event.payload.targetUnitId] = event.payload.actionDamageMultiplier;
    }
    // raw原文「対象に付与されている「警棒」1つにつき15%増加する(最大3つまで)」。
    expect(multiplierByTarget).toEqual({
      "enemy:none": 1,
      "enemy:two": 1.3,
      "enemy:five": 1.45,
      "enemy:other": 1,
    });
  });

  it("IT-UNIT-KARINA-DOWNER-008 (R-ACT-03/G-05): PS2が配るEXゲージ獲得量増加は、**保持している味方の以後の行動**が得るEXゲージを1.5倍にする。基礎量そのもの（消費APと同量）は動かない", () => {
    // `-001` のPS2行は付与そのもの（`magnitude: 0.5`・1行動・味方全体）までを
    // 固定する。「獲得量が変わる」のは保持者の**次の行動**に属し、スキル使用1回の
    // 観測には載らない（`ActionStarted` を出すのは保持者自身の行動である）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const earn = (units: readonly BattleUnit[], battleId: string) => {
      const observed = observeExGaugeGain({
        units,
        definitions: board.definitions,
        skill: skillFrom(snapshot, EX_EARNER_AS_ID),
        actorUnitId: "ally:front",
        battleId,
      });
      return { gain: observed.gain, published: observed.published, modifiers: observed.modifiers };
    };

    // 補正を持たない同じASは消費AP分（2）をそのまま得る（R-ACT-03）。差の原因が
    // 獲得量増加だけであることは、この対照が無いと分からない。
    expect(earn(board.units, "B_KARINA_EX_GAIN_BASE")).toEqual({
      gain: { before: 0, after: EX_EARNER_AS_COST, gained: EX_EARNER_AS_COST },
      published: { baseDelta: EX_EARNER_AS_COST, delta: EX_EARNER_AS_COST, before: 0, after: 2 },
      modifiers: [],
    });

    // 前提アクションは使用者自身を除く最も近い味方（ally:front）へ入る。
    const buffed = applyPrecedingActions(board, [
      { effectActionDefinitionId: EX_GAIN_UP, target: "ALLY" },
    ]);
    expect(earn(buffed, "B_KARINA_EX_GAIN_UP")).toEqual({
      gain: { before: 0, after: 3, gained: 3 },
      // 基礎量は消費APのままで、公開される `delta` だけが1.5倍になる。
      published: { baseDelta: EX_EARNER_AS_COST, delta: 3, before: 0, after: 3 },
      modifiers: [{ effectActionDefinitionId: EX_GAIN_UP, magnitude: 0.5, instances: 1 }],
    });
  });

  it("IT-UNIT-KARINA-DOWNER-009 (Q-CAT-EFF-16, R-STA-03): EXの攻撃力30%低下は原文に「重複可」が無く重複しない — 2行動の効果が残っているうちにEXを撃ち直しても実効値は1件分にとどまる", () => {
    const { instanceCount, baseValue, effectiveValue } = repeatedStatModGrant({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
      target: "ENEMY",
      stat: "attack",
    });

    // `NON_STACKABLE` は付与そのものを止めず、合成側で同種グループの最強1件だけを
    // 選ぶ（R-EFF-05）。2件保持していても実効値は1件分にとどまる。
    expect(instanceCount).toBe(2);
    expect(effectiveValue).toBeCloseTo(baseValue * (1 - 0.3), 10);
  });
});
