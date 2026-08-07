import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { createHitPoint } from "../../domain/battle/model/resource-gauge.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * DMG-009（Issue #193、R-CFS-01／R-CFS-02／R-DTH-01、`CAP_CONFUSION`／
 * `CAP_DAMAGE_TO_HEAL`）: production Catalogの混乱・幻惑定義を実カタログから
 * 無改変で読み込み、実ライフサイクル（`resolveSkillUse`→
 * `effect-action-group-resolver.ts`の付与→`skill-resolution-service.ts`の対象
 * 振り替え→`damage-application-service.ts`の混乱倍率・回復変換）で近似なしに
 * 解決できることを検証する。
 *
 * - `ACT_OLGA_VETERAN_EX_CONFUSION`（`SKL_OLGA_VETERAN_EX`「鉄の女」、敵全体へ1行動）
 * - `ACT_TATIANA_SAGE_AS1_DAZZLE`（`SKL_TATIANA_SAGE_AS1`「遅効の毒針」）
 *
 * 混乱・幻惑を**受けた側**が実際に攻撃する場面は、production定義そのものでは
 * 相手側のスキル構成に依存してしまうため、`damage-link-production-catalog.test.ts`
 * と同じ方針で最小限の合成AS（1ヒットの単体攻撃）で観測する。付与側は
 * production定義のスキルそのものを使う。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const OLGA_UNIT_ID = "UNIT_OLGA_VETERAN";
const TATIANA_UNIT_ID = "UNIT_TATIANA_SAGE";
const TEST_UNIT_ID = "UNIT_TEST_CONFUSION";

const OLGA_EX_SKILL_ID = "SKL_OLGA_VETERAN_EX";
const OLGA_CONFUSION_ID = "ACT_OLGA_VETERAN_EX_CONFUSION";
const TATIANA_AS1_SKILL_ID = "SKL_TATIANA_SAGE_AS1";
const TATIANA_DAZZLE_ID = "ACT_TATIANA_SAGE_AS1_DAZZLE";
const ATTACK_EFFECT_ID = "ACT_TEST_CONFUSION_ATTACK";
const ATTACK_SKILL_ID = "SKL_TEST_CONFUSION_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
// 攻撃力100・防御力0で「通常100ダメージ」を基準に混乱倍率・回復変換を観測する。
const COMBAT_STATS = { maximumHp: 1000, attack: 100, defense: 0 };

/** AP・EXゲージを満タンにし、EX/ASをどちらも即時使用できる状態で組む。 */
function readyUnit(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  combatStats: Partial<CombatStats> = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position,
    combatStats: { ...COMBAT_STATS, ...combatStats },
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp, currentExtraGauge: LIMITS.maximumExtraGauge },
  });
}

/**
 * 敵全体を1ヒットずつ殴る最小限の合成AS。混乱の観測対象になる。
 *
 * `count: "ALL"`にしているのは、R-CFS-01の反転で候補が「使用者自身を含む自陣営」に
 * なるためである。R-TGT-02のデフォルト順は使用者からのマンハッタン距離が昇順であり、
 * 距離0の使用者自身が常に先頭に来るので、`count: 1`では反転の結果が必ず自傷になり、
 * 「味方も巻き込む」という振り替えの本質を観測できない。
 */
function singleEnemyAttackSkill(): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: "ALL",
    filters: [],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId(ATTACK_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: ATTACK_SKILL_ID, tags: [] },
  };
}

function singleHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly skill: (id: string) => SkillDefinition;
}

function fixture(unitIds: readonly string[]): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);
  const attack = singleHitAttack();
  const definitions = definitionsWith(snapshot, {
    units: [testUnitDefinition(TEST_UNIT_ID, { baseStats: COMBAT_STATS })],
    skills: [singleEnemyAttackSkill()],
    overrides: {
      effectActions: new Map([
        ...snapshot.effectActions,
        [attack.effectActionDefinitionId, attack],
      ]),
    },
  });
  return {
    definitions,
    recorder: new EventRecorder(createBattleId("B_1")),
    skill: (id) => {
      const found = definitions.skillDefinitions.get(createSkillDefinitionId(id));
      if (found === undefined) {
        throw new Error(`skill "${id}" is missing from the production Catalog snapshot`);
      }
      return found;
    },
  };
}

function useSkill(
  actor: BattleUnit,
  skill: SkillDefinition,
  effectiveActionType: "AS" | "EX",
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  actionSequence: number,
): readonly BattleUnit[] {
  return resolveSkillUse(
    actor,
    skill,
    effectiveActionType,
    effectiveActionType,
    units,
    definitions,
    noMissNoCrit(),
    recorder,
    1,
    0,
    createActionId(`B_1:action:${actionSequence}`),
    recorder.nextResolutionScopeId(),
  ).units;
}

describe("production Catalog confusion (DMG-009, Issue #193, R-CFS-01 / R-CFS-02)", () => {
  it("IT-CAP-CONFUSION-PROD-001: the real SKL_OLGA_VETERAN_EX applies CONFUSION to every enemy as a DEBUFF-only status, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const { definitions, recorder, skill } = fixture([OLGA_UNIT_ID]);
    const olga = readyUnit("ally:olga", OLGA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" });
    const enemyA = readyUnit("enemy:a", TEST_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" });
    const enemyB = readyUnit("enemy:b", TEST_UNIT_ID, "ENEMY", { column: "RIGHT", row: "BACK" });

    const after = useSkill(
      olga,
      skill(OLGA_EX_SKILL_ID),
      "EX",
      [olga, enemyA, enemyB],
      definitions,
      recorder,
      1,
    );

    // raw原文「敵全体に1行動の混乱を付与する」。
    for (const enemyId of [enemyA.battleUnitId, enemyB.battleUnitId]) {
      const confused = after.find((u) => u.battleUnitId === enemyId)!;
      expect(confused.appliedEffects).toHaveLength(1);
      const effect = confused.appliedEffects[0]!;
      expect(effect).toMatchObject({
        effectActionDefinitionId: OLGA_CONFUSION_ID,
        statusKind: "CONFUSION",
      });
      // raw原文「ダメージは30%減少する」「攻撃力×10%の値を使用し」。
      expect(effect.statusDetails?.confusion).toEqual({
        damageReductionRate: 0.3,
        lowAttackBaseDamageRate: 0.1,
      });
      // R-CFS-01/R-DTH-01: 定義済み状態異常ではないため`STATUS`を持たない。
      expect([...effect.categories]).toEqual(["DEBUFF"]);
    }

    const applied = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "EffectApplied" &&
          (e.payload as { targetUnitId: string }).targetUnitId === enemyA.battleUnitId,
      ) as Extract<BattleDomainEvent, { eventType: "EffectApplied" }>;
    expect(applied.payload).toMatchObject({ effectKind: "APPLY_STATUS" });
    const reduced = applyStateDelta(
      initialSnapshotFor([enemyA], { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[enemyA.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: OLGA_CONFUSION_ID,
      statusKind: "CONFUSION",
      statusDetails: { confusion: { damageReductionRate: 0.3, lowAttackBaseDamageRate: 0.1 } },
    });
  });

  it("IT-CAP-CONFUSION-PROD-002 (R-CFS-01 / R-CFS-02, real lifecycle wiring): a unit confused by the real definition attacks its own side for 30% less", () => {
    const { definitions, recorder, skill } = fixture([OLGA_UNIT_ID]);
    const olga = readyUnit("ally:olga", OLGA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" });
    // 混乱する側（敵陣営）。攻撃力100・防御力0の合成ユニット同士なので、
    // 通常なら100ダメージ、混乱倍率0.7で70ダメージになる。
    const confusedAttacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const sameSideVictim = readyUnit("enemy:victim", TEST_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const confusedUnits = useSkill(
      olga,
      skill(OLGA_EX_SKILL_ID),
      "EX",
      [olga, confusedAttacker, sameSideVictim],
      definitions,
      recorder,
      1,
    );

    const eventsBeforeAttack = recorder.getEvents().length;
    const afterAttack = useSkill(
      confusedUnits.find((u) => u.battleUnitId === confusedAttacker.battleUnitId)!,
      skill(ATTACK_SKILL_ID),
      "AS",
      confusedUnits,
      definitions,
      recorder,
      2,
    );
    const newEvents = recorder.getEvents().slice(eventsBeforeAttack);

    // R-CFS-01: `side: ENEMY`のbindingが反転し、本来の対象（オルガ）ではなく
    // 自陣営が殴られる。R-TGT-02のデフォルト順どおり距離0の使用者自身が先頭になる。
    const calculated = newEvents.filter((e) => e.eventType === "DamageCalculated");
    expect(calculated.map((e) => (e.payload as { targetUnitId: string }).targetUnitId)).toEqual([
      confusedAttacker.battleUnitId,
      sameSideVictim.battleUnitId,
    ]);
    for (const event of calculated) {
      expect(event.payload).toMatchObject({
        // R-CFS-02: 混乱倍率は与ダメージ倍率とは別枠で公開する。
        confusionDamageMultiplier: 0.7,
        finalDamage: 70,
      });
    }
    // 本来の対象だったオルガには1ダメージも通らない。
    expect(afterAttack.find((u) => u.battleUnitId === olga.battleUnitId)!.currentHp).toBe(
      olga.currentHp,
    );
    expect(afterAttack.find((u) => u.battleUnitId === sameSideVictim.battleUnitId)!.currentHp).toBe(
      1000 - 70,
    );
  });

  it("IT-CAP-CONFUSION-PROD-003 (R-CFS-02): a confused attacker whose attack is at or below the effective defense falls back to attack x 10%", () => {
    const { definitions, recorder, skill } = fixture([OLGA_UNIT_ID]);
    const olga = readyUnit("ally:olga", OLGA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" });
    const confusedAttacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    // 防御力100 = 攻撃力100（境界: R-CFS-02は「以下」で差し替える）。
    const toughVictim = readyUnit(
      "enemy:victim",
      TEST_UNIT_ID,
      "ENEMY",
      { column: "CENTER", row: "FRONT" },
      { defense: 100 },
    );

    const confusedUnits = useSkill(
      olga,
      skill(OLGA_EX_SKILL_ID),
      "EX",
      [olga, confusedAttacker, toughVictim],
      definitions,
      recorder,
      1,
    );
    const eventsBeforeAttack = recorder.getEvents().length;
    useSkill(
      confusedUnits.find((u) => u.battleUnitId === confusedAttacker.battleUnitId)!,
      skill(ATTACK_SKILL_ID),
      "AS",
      confusedUnits,
      definitions,
      recorder,
      2,
    );

    const calculated = recorder
      .getEvents()
      .slice(eventsBeforeAttack)
      .filter((e) => e.eventType === "DamageCalculated");
    // 防御力0の使用者自身: 差分100 × 混乱倍率0.7 = 70（通常の基礎ダメージ）。
    expect(calculated[0]!.payload).toMatchObject({
      targetUnitId: confusedAttacker.battleUnitId,
      finalDamage: 70,
    });
    // 防御力100の味方: 基礎ダメージ 100 * 0.1 = 10、混乱倍率 0.7 → 7
    // （差し替えが無ければ差分0 → R-DMG-02の最低1ダメージになる）。
    expect(calculated[1]!.payload).toMatchObject({
      targetUnitId: toughVictim.battleUnitId,
      finalDamage: 7,
    });
  });
});

describe("production Catalog damage-to-heal (DMG-009, Issue #193, R-DTH-01)", () => {
  it("IT-CAP-DAMAGE-TO-HEAL-PROD-001: the real SKL_TATIANA_SAGE_AS1 applies DAMAGE_TO_HEAL to its target, matching Domain Event / StateDelta / independent-Reducer expectations", () => {
    const { definitions, recorder, skill } = fixture([TATIANA_UNIT_ID]);
    const tatiana = readyUnit("ally:tatiana", TATIANA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const victim = readyUnit("enemy:victim", TEST_UNIT_ID, "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });

    const after = useSkill(
      tatiana,
      skill(TATIANA_AS1_SKILL_ID),
      "AS",
      [tatiana, victim],
      definitions,
      recorder,
      1,
    );

    const dazzled = after.find((u) => u.battleUnitId === victim.battleUnitId)!;
    const dazzle = dazzled.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === TATIANA_DAZZLE_ID,
    )!;
    // raw原文「1行動の幻惑を付与する」「回復値は本来ダメージ値の70％となる」。
    expect(dazzle).toMatchObject({ statusKind: "DAMAGE_TO_HEAL" });
    expect(dazzle.statusDetails?.damageToHeal).toEqual({ healRate: 0.7 });
    expect([...dazzle.categories]).toEqual(["DEBUFF"]);

    const applied = recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "EffectApplied" &&
          (e.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            TATIANA_DAZZLE_ID,
      ) as Extract<BattleDomainEvent, { eventType: "EffectApplied" }> | undefined;
    expect(applied).toBeDefined();
    const reduced = applyStateDelta(
      initialSnapshotFor([victim], { status: "READY" }),
      applied!.stateDelta!,
    );
    expect(
      reduced.units[victim.battleUnitId]!.effects!.find(
        (effect) => effect.effectDefinitionId === TATIANA_DAZZLE_ID,
      ),
    ).toMatchObject({
      statusKind: "DAMAGE_TO_HEAL",
      statusDetails: { damageToHeal: { healRate: 0.7 } },
    });
  });

  it("IT-CAP-DAMAGE-TO-HEAL-PROD-002 (R-DTH-01, real lifecycle wiring): a unit dazzled by the real definition heals its would-be victim instead of damaging it", () => {
    const { definitions, recorder, skill } = fixture([TATIANA_UNIT_ID]);
    const tatiana = readyUnit("ally:tatiana", TATIANA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "BACK",
    });
    const dazzledAttacker = readyUnit("enemy:attacker", TEST_UNIT_ID, "ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });

    const afterGrant = useSkill(
      tatiana,
      skill(TATIANA_AS1_SKILL_ID),
      "AS",
      [tatiana, dazzledAttacker],
      definitions,
      recorder,
      1,
    );
    // タチアナ自身が半端なHPで観測できるよう、変換の対象になる側を減らしておく。
    const woundedTatiana = {
      ...afterGrant.find((u) => u.battleUnitId === tatiana.battleUnitId)!,
      currentHp: createHitPoint(100, 1000),
    };
    const units = afterGrant.map((u) =>
      u.battleUnitId === tatiana.battleUnitId ? woundedTatiana : u,
    );

    const eventsBeforeAttack = recorder.getEvents().length;
    const afterAttack = useSkill(
      units.find((u) => u.battleUnitId === dazzledAttacker.battleUnitId)!,
      skill(ATTACK_SKILL_ID),
      "AS",
      units,
      definitions,
      recorder,
      2,
    );
    const newEvents = recorder.getEvents().slice(eventsBeforeAttack);

    expect(newEvents.filter((e) => e.eventType === "DamageApplied")).toHaveLength(0);
    const converted = newEvents.find((e) => e.eventType === "DamageConvertedToHeal")!;
    // 攻撃力100・防御力0のタチアナへ本来100ダメージ → floor(100 * 0.7) = 70回復
    expect(converted.payload).toMatchObject({
      targetUnitId: tatiana.battleUnitId,
      calculatedDamage: 100,
      healRate: 0.7,
      healAmount: 70,
      appliedHeal: 70,
      hpBefore: 100,
      hpAfter: 170,
    });
    expect(afterAttack.find((u) => u.battleUnitId === tatiana.battleUnitId)!.currentHp).toBe(170);

    // HP変化のStateDeltaはこのイベントだけが持ち、独立Reducerがそのまま復元できる。
    const reduced = applyStateDelta(
      initialSnapshotFor([woundedTatiana], { status: "READY" }),
      converted.stateDelta!,
    );
    expect(reduced.units[tatiana.battleUnitId]!.hp).toBe(170);
  });
});
