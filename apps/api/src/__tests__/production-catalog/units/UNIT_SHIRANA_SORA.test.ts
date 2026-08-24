import { describe, expect, it } from "vitest";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import type { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
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
    // production定義のtriggerは `EVENT_PAYLOAD field: "damageType"` を読む。
    // R-ATM-03 #7（Issue #480）で攻撃前観測の payload が `damageTypes`（その対象へ
    // 向き得る全DAMAGE定義の型の集合）を持ち、`damageType` はその別名として
    // 集合のいずれかで比較が成立すれば真になったため、この trigger が成立する
    // ようになった（R-ATM実装前は payload に読む欄が無く一度も発動しなかった）。
    intent: "自身がENタイプの攻撃を受ける直前に発動。次に受けるENダメージを1回だけ75%軽減する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS2",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        damageTypes: ["EN"],
      }),
    },
    board: ENERGY_ATTACKER,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS2_GUARD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SHIRANA_SORA_PS2_GUARD",
          magnitude: -0.75,
          // R-EFF-07: 次に受ける攻撃1回だけへ乗る（「一度だけ」の実体）。
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SHIRANA_SORA_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SHIRANA_SORA_PS2",
    // R-ATM-03 #7の集合比較は「いずれかの要素で成立」であり、集合に EN を
    // 含まない攻撃（物理だけの攻撃）では成立しない。
    intent: "(不成立): 物理ダメージだけの攻撃を受ける直前では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS2",
      trigger: unitBeingAttacked({
        source: "enemy:front",
        target: "ally:subject",
        damageTypes: ["PHYSICAL"],
      }),
    },
    board: ENERGY_ATTACKER,
    expected: { activated: false },
  },
];

const UNREACHABLE_EFFECT_ACTION_IDS: readonly string[] = [];

const EX_SUBUNIT = "ACT_SHIRANA_SORA_EX_SUBUNIT";
const AS1_SUBUNIT = "ACT_SHIRANA_SORA_AS1_SUBUNIT";
const AS1_SUBUNIT_SPEED_DOWN = "ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN";

/** `SubUnitDamaged` payload のうち、R-SUB-01の吸収の意味を決める欄だけ。 */
function subUnitDamageOf(recorder: EventRecorder) {
  return recorder
    .getEvents()
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "SubUnitDamaged" }> =>
        event.eventType === "SubUnitDamaged",
    )
    .map((event) => ({
      unitId: String(event.payload.battleUnitId),
      subUnitDefinitionId: String(event.payload.subUnitDefinitionId),
      reason: event.payload.reason,
      before: event.payload.before,
      after: event.payload.after,
      absorbed: event.payload.absorbed,
    }));
}

/** ヒットごとの `DamageCalculated`。追加ダメージは自分の定義IDで1件ずつ現れる。 */
function damageCalculationsOf(recorder: EventRecorder) {
  return recorder
    .getEvents()
    .filter(
      (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
        event.eventType === "DamageCalculated",
    )
    .map((event) => ({
      effectActionDefinitionId: String(event.payload.effectActionDefinitionId),
      damageType: event.payload.damageType,
      skillPower: event.payload.skillPower,
      finalDamage: event.payload.finalDamage,
    }));
}

function unitIn(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  return units.find((unit) => unit.battleUnitId === battleUnitId)!;
}

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

  it("IT-UNIT-SHIRANA-SORA-004 [R-SUB-01] (R-SUB-01/R-SHD-03): EXが配る「子機Ⅱ」は**以後に飛んでくる攻撃**を耐久力で吸収し、シールドの後・HPの前に入る。振り分け5欄の合計は常に計算ダメージと一致し、耐久力を超えた分だけがHPへ抜けて枯渇したインスタンスはその場で失効する", () => {
    // `-001` のEX行は付与そのもの（`magnitude: 3500`＝最大HP×35%・3行動）までを
    // 固定する。吸収は別のスキル使用（＝相手の攻撃）に属するため、スキル使用1回の
    // 観測には載らない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const guarded = applyPrecedingActions(board, [
      { effectActionDefinitionId: EX_SUBUNIT, target: "SELF" },
    ]);
    const strike = (units: readonly BattleUnit[], power: number, battleId: string) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        power,
        battleId,
      });

    // 攻撃力1000 - 防御力500 = 500。耐久力3500が全量を受け、HPは1点も減らない。
    const absorbed = strike(guarded, 1, "B_SHIRANA_SUBUNIT_ABSORB");
    expect(absorbed.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 500,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 500,
        hitPointDamage: 0,
        discardedDamage: 0,
      },
    ]);
    expect(absorbed.hpDeltas).toEqual({});
    // 減少はインスタンス単位で通知され、`absorbed` は `before - after` と一致する。
    expect(subUnitDamageOf(absorbed.recorder)).toEqual([
      {
        unitId: "ally:subject",
        subUnitDefinitionId: EX_SUBUNIT,
        reason: "DAMAGE_ABSORPTION",
        before: 3500,
        after: 3000,
        absorbed: 500,
      },
    ]);

    // 残り3000を超える一撃（500×8＝4000）は、3000を吸って残り1000がHPへ抜ける。
    const overflowed = strike(absorbed.units, 8, "B_SHIRANA_SUBUNIT_OVERFLOW");
    expect(overflowed.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 4000,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 3000,
        hitPointDamage: 1000,
        discardedDamage: 0,
      },
    ]);
    expect(overflowed.hpDeltas).toEqual({ "ally:subject": -1000 });
    expect(overflowed.expirations).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: EX_SUBUNIT,
        reason: "SUBUNIT_DEPLETED",
        cascaded: false,
      },
    ]);
    expect(
      unitIn(overflowed.units, "ally:subject").appliedEffects.filter(
        (effect) => effect.effectActionDefinitionId === EX_SUBUNIT,
      ),
    ).toEqual([]);

    // 公開差分だけを当て直した状態を、スナップショット全体で突き合わせる。残耐久力
    // （`EffectSnapshot.subUnit`）のStateDeltaが欠ければここで落ちる。
    expect(
      reconstruct(
        initialSnapshotFor(absorbed.units, { include: ["effects"] }),
        overflowed.recorder,
      ),
    ).toEqual(initialSnapshotFor(overflowed.units, { include: ["effects"] }));
  });

  it("IT-UNIT-SHIRANA-SORA-005 [R-SUB-02] (R-SUB-02): AS1が配る「子機Ⅰ」は**以後の自分の攻撃**へ保持数ぶんの追加ENダメージを1ヒットずつ足し、対象へ行動速度デバフを重ねて付与する（重複可）。追加ダメージのタイプは契機の攻撃ではなく定義の宣言で決まる", () => {
    // `-001` のPS1行（子機Ⅰ保持下）は1つ保持での追加ダメージと1件のデバフまでを
    // 固定する。**保持数だけ追加ヒットが増えること**と、そのデバフが `STACKABLE`
    // （原文「重複可」）であることは、2つ保持した1発でしか差が出ない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const armed = applyPrecedingActions(board, [
      { effectActionDefinitionId: AS1_SUBUNIT, target: "SELF" },
      { effectActionDefinitionId: AS1_SUBUNIT, target: "SELF" },
    ]);
    const observed = observeLifecycleDamageProbe({
      definitions: board.definitions,
      units: armed,
      attackerUnitId: "ally:subject",
      targetUnitId: "enemy:front",
      power: 1,
      // 追加ダメージが契機の攻撃タイプを引き継ぐのではなく、定義の `EN` を使うこと
      // を見るため、契機側は既定の `PHYSICAL` のままにする。
      battleId: "B_SHIRANA_SUBUNIT_ADDITIONAL",
    });

    // 追加ダメージ = 所持者の攻撃力1000 + 付与者の付与時攻撃力1000 × 31.2%
    //              - 対象の防御力500 = 812（防御力減衰を経由しない）。
    expect(damageCalculationsOf(observed.recorder)).toEqual([
      {
        effectActionDefinitionId: "ACT_TEST_DAMAGE_PROBE",
        damageType: "PHYSICAL",
        skillPower: 1,
        finalDamage: 500,
      },
      {
        effectActionDefinitionId: AS1_SUBUNIT,
        damageType: "EN",
        skillPower: 812,
        finalDamage: 812,
      },
      {
        effectActionDefinitionId: AS1_SUBUNIT,
        damageType: "EN",
        skillPower: 812,
        finalDamage: 812,
      },
    ]);
    expect(observed.hpDeltas).toEqual({ "enemy:front": -(500 + 812 + 812) });

    // 付随デバフはEffectAction群の解決器ではなく付与フックから直接適用されるため、
    // `STACKABLE` なら保持数ぶんのインスタンスが並ぶ。
    const struck = unitIn(observed.units, "enemy:front");
    expect(
      struck.appliedEffects
        .filter((effect) => effect.effectActionDefinitionId === AS1_SUBUNIT_SPEED_DOWN)
        .map((effect) => effect.magnitude),
    ).toEqual([-20, -20]);
    // 実効行動速度にも2件ぶんが乗る（盤面既定の100から-40）。
    expect(struck.combatStats.actionSpeed).toBe(60);
  });
});
