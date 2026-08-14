import { describe, expect, it } from "vitest";
import { projectUnitBattleSummaries } from "./unit-battle-summary-projector.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type {
  BattleStateSnapshot,
  BattleUnitRosterEntry,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");
const ATTACKER = createBattleUnitId("ally:1");
const HEALER = createBattleUnitId("ally:2");
const DEFENDER = createBattleUnitId("enemy:1");

const COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0,
  affinityBonus: 0,
};

function rosterEntry(
  battleUnitId: BattleUnitRosterEntry["battleUnitId"],
  side: BattleUnitRosterEntry["side"],
  column: 0 | 1 | 2,
): BattleUnitRosterEntry {
  return {
    battleUnitId,
    unitDefinitionId: createUnitDefinitionId("UNIT_TEST"),
    side,
    position: { column: column === 0 ? "LEFT" : column === 1 ? "CENTER" : "RIGHT", row: "FRONT" },
    globalCoordinate: { x: column, y: side === "ALLY" ? 3 : 0 },
    combatStats: COMBAT_STATS,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  };
}

const ROSTER: readonly BattleUnitRosterEntry[] = [
  rosterEntry(ATTACKER, "ALLY", 0),
  rosterEntry(HEALER, "ALLY", 1),
  rosterEntry(DEFENDER, "ENEMY", 0),
];

/** `hp`だけを差し替えた最終状態。集計対象のイベント列とは独立に与える。 */
function finalStateWith(
  hpByUnit: Readonly<Record<string, number>>,
  maximumHpByUnit: Readonly<Record<string, number>> = {},
): BattleStateSnapshot {
  const units: Record<string, unknown> = {};
  for (const entry of ROSTER) {
    const maximumHp = maximumHpByUnit[entry.battleUnitId] ?? COMBAT_STATS.maximumHp;
    units[entry.battleUnitId] = {
      hp: hpByUnit[entry.battleUnitId] ?? COMBAT_STATS.maximumHp,
      ap: 0,
      pp: 0,
      extraGauge: 0,
      maximumAp: 3,
      maximumPp: 3,
      maximumExtraGauge: 100,
      combatStats: { ...COMBAT_STATS, maximumHp },
      baseCombatStats: { ...COMBAT_STATS, maximumHp },
    };
  }
  return {
    status: "COMPLETED",
    currentTurn: 1,
    units: units as BattleStateSnapshot["units"],
  };
}

const FULL_HP_FINAL_STATE = finalStateWith({});

interface DamageAppliedOverrides {
  readonly sourceUnitId?: BattleUnitRosterEntry["battleUnitId"];
  readonly targetUnitId?: BattleUnitRosterEntry["battleUnitId"];
  readonly calculatedDamage?: number;
  readonly typedShieldAbsorbed?: number;
  readonly untypedShieldAbsorbed?: number;
  readonly subUnitAbsorbed?: number;
  readonly discardedDamage?: number;
  readonly hitPointDamage?: number;
  readonly isReflectedDamage?: true;
  readonly isLinkedDamage?: true;
}

function recordDamageApplied(recorder: EventRecorder, overrides: DamageAppliedOverrides): void {
  const hitPointDamage = overrides.hitPointDamage ?? 10;
  const targetUnitId = overrides.targetUnitId ?? DEFENDER;
  recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    ...(overrides.sourceUnitId !== undefined ? { sourceUnitId: overrides.sourceUnitId } : {}),
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST"),
      hitIndex: 1,
      targetUnitId,
      calculatedDamage: overrides.calculatedDamage ?? hitPointDamage,
      hpDirectDamage: 0,
      typedShieldAbsorbed: overrides.typedShieldAbsorbed ?? 0,
      untypedShieldAbsorbed: overrides.untypedShieldAbsorbed ?? 0,
      subUnitAbsorbed: overrides.subUnitAbsorbed ?? 0,
      discardedDamage: overrides.discardedDamage ?? 0,
      hitPointDamage,
      hpBefore: 100,
      hpAfter: 100 - hitPointDamage,
      defeated: false,
      ...(overrides.isReflectedDamage !== undefined
        ? { isReflectedDamage: overrides.isReflectedDamage }
        : {}),
      ...(overrides.isLinkedDamage !== undefined
        ? { isLinkedDamage: overrides.isLinkedDamage }
        : {}),
    },
  });
}

interface ContinuousDamageOverrides {
  readonly sourceUnitId?: BattleUnitRosterEntry["battleUnitId"];
  readonly sourceSide?: BattleUnitRosterEntry["side"];
  readonly targetUnitId?: BattleUnitRosterEntry["battleUnitId"];
  readonly calculatedDamage?: number;
  readonly typedShieldAbsorbed?: number;
  readonly discardedDamage?: number;
  readonly hitPointDamage?: number;
}

function recordContinuousDamageApplied(
  recorder: EventRecorder,
  overrides: ContinuousDamageOverrides,
): void {
  const hitPointDamage = overrides.hitPointDamage ?? 5;
  const targetUnitId = overrides.targetUnitId ?? DEFENDER;
  recorder.record({
    eventType: "ContinuousDamageApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    ...(overrides.sourceUnitId !== undefined ? { sourceUnitId: overrides.sourceUnitId } : {}),
    ...(overrides.sourceSide !== undefined ? { sourceSide: overrides.sourceSide } : {}),
    targetUnitIds: [targetUnitId],
    payload: {
      effectInstanceId: createEffectInstanceId("eff-1"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_DOT"),
      continuousDamageKind: "FIXED",
      damageType: "PHYSICAL",
      targetUnitId,
      snapshotAttack: 10,
      formulaResult: hitPointDamage,
      burnStackMultiplier: 1,
      cappedBySnapshotAttack: false,
      calculatedDamage: overrides.calculatedDamage ?? hitPointDamage,
      typedShieldAbsorbed: overrides.typedShieldAbsorbed ?? 0,
      untypedShieldAbsorbed: 0,
      subUnitAbsorbed: 0,
      discardedDamage: overrides.discardedDamage ?? 0,
      hitPointDamage,
      hpBefore: 100,
      hpAfter: 100 - hitPointDamage,
      defeated: false,
    },
  });
}

function recordHealApplied(
  recorder: EventRecorder,
  input: {
    readonly sourceUnitId: BattleUnitRosterEntry["battleUnitId"];
    readonly targetUnitId: BattleUnitRosterEntry["battleUnitId"];
    readonly healAmount: number;
    readonly appliedAmount: number;
    readonly transferredAmount?: number;
  },
): void {
  const transferredAmount = input.transferredAmount ?? 0;
  recorder.record({
    eventType: "HealApplied",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    sourceUnitId: input.sourceUnitId,
    targetUnitIds: [input.targetUnitId],
    payload: {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_HEAL"),
      sourceUnitId: input.sourceUnitId,
      targetUnitId: input.targetUnitId,
      formulaResult: input.healAmount,
      distributionShareCount: 1,
      healingModifierMultiplier: 1,
      healAmount: input.healAmount,
      transferredAmount,
      appliedAmount: input.appliedAmount,
      discardedAmount: input.healAmount - transferredAmount - input.appliedAmount,
      hpBefore: 50,
      hpAfter: 50 + input.appliedAmount,
    },
  });
}

function recordHealingTransferred(
  recorder: EventRecorder,
  input: {
    readonly sourceUnitId: BattleUnitRosterEntry["battleUnitId"];
    readonly fromUnitId: BattleUnitRosterEntry["battleUnitId"];
    readonly toUnitId: BattleUnitRosterEntry["battleUnitId"];
    readonly transferredAmount: number;
    readonly appliedAmount: number;
  },
): void {
  recorder.record({
    eventType: "HealingTransferred",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    sourceUnitId: input.sourceUnitId,
    targetUnitIds: [input.toUnitId],
    payload: {
      effectInstanceId: createEffectInstanceId("eff-link"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST_HEAL_LINK"),
      fromUnitId: input.fromUnitId,
      toUnitId: input.toUnitId,
      transferRate: 0.5,
      transferredAmount: input.transferredAmount,
      appliedAmount: input.appliedAmount,
      discardedAmount: input.transferredAmount - input.appliedAmount,
      hpBefore: 40,
      hpAfter: 40 + input.appliedAmount,
    },
  });
}

function summaryOf(
  summaries: ReturnType<typeof projectUnitBattleSummaries>,
  battleUnitId: BattleUnitRosterEntry["battleUnitId"],
): (typeof summaries)[number] {
  const found = summaries.find((summary) => summary.battleUnitId === battleUnitId);
  expect(found, `no summary for ${battleUnitId}`).toBeDefined();
  return found!;
}

function project(events: readonly BattleDomainEvent[], finalState = FULL_HP_FINAL_STATE) {
  return projectUnitBattleSummaries(events, finalState, ROSTER);
}

describe("projectUnitBattleSummaries", () => {
  it("UT-UNIT-SUMMARY-001 (10_API設計.md「集計セマンティクス」): sums hitPointDamage from DamageApplied and ContinuousDamageApplied into the attacker's damageDealt and the target's damageTaken, ignoring shield/sub-unit absorption and the overkill discard", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    // calculatedDamage 40 のうち、HPへ届いたのは 10 だけ。残りは
    // シールド20・サブユニット5・HPクランプ破棄5 が吸収する。
    recordDamageApplied(recorder, {
      sourceUnitId: ATTACKER,
      calculatedDamage: 40,
      typedShieldAbsorbed: 12,
      untypedShieldAbsorbed: 8,
      subUnitAbsorbed: 5,
      discardedDamage: 5,
      hitPointDamage: 10,
    });
    // 継続ダメージも同じ規約で合算する（DoTだけ落ちるのがUI集計の既知の欠落）。
    recordContinuousDamageApplied(recorder, {
      sourceUnitId: ATTACKER,
      calculatedDamage: 9,
      typedShieldAbsorbed: 2,
      discardedDamage: 1,
      hitPointDamage: 6,
    });

    const summaries = project(recorder.getEvents());

    expect(summaryOf(summaries, ATTACKER).damageDealt).toBe(16);
    expect(summaryOf(summaries, ATTACKER).damageTaken).toBe(0);
    expect(summaryOf(summaries, DEFENDER).damageTaken).toBe(16);
    expect(summaryOf(summaries, DEFENDER).damageDealt).toBe(0);
  });

  it("UT-UNIT-SUMMARY-002 (R-MEM-04): a ContinuousDamageApplied without a sourceUnitId counts only as damageTaken and is attributed to no unit's damageDealt", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordContinuousDamageApplied(recorder, {
      // Memory由来の継続ダメージは付与者ユニットを持たず陣営だけを持つ。
      sourceSide: "ALLY",
      hitPointDamage: 7,
    });

    const summaries = project(recorder.getEvents());

    expect(summaryOf(summaries, DEFENDER).damageTaken).toBe(7);
    expect(summaries.map((summary) => summary.damageDealt)).toEqual([0, 0, 0]);
  });

  it("UT-UNIT-SUMMARY-003 (R-INT-03／R-LNK-03): reflected and linked damage arrive as DamageApplied and count toward the envelope sourceUnitId's damageDealt without any extra rule", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    // 元ダメージ: ATTACKER -> DEFENDER。
    recordDamageApplied(recorder, {
      sourceUnitId: ATTACKER,
      targetUnitId: DEFENDER,
      hitPointDamage: 20,
    });
    // 反射: DEFENDER が保持する反射効果で ATTACKER が受ける。
    recordDamageApplied(recorder, {
      sourceUnitId: DEFENDER,
      targetUnitId: ATTACKER,
      hitPointDamage: 4,
      isReflectedDamage: true,
    });
    // リンク: DEFENDER 起点のリンクで HEALER が受ける。
    recordDamageApplied(recorder, {
      sourceUnitId: DEFENDER,
      targetUnitId: HEALER,
      hitPointDamage: 3,
      isLinkedDamage: true,
    });

    const summaries = project(recorder.getEvents());

    expect(summaryOf(summaries, ATTACKER).damageDealt).toBe(20);
    expect(summaryOf(summaries, ATTACKER).damageTaken).toBe(4);
    expect(summaryOf(summaries, DEFENDER).damageDealt).toBe(7);
    expect(summaryOf(summaries, DEFENDER).damageTaken).toBe(20);
    expect(summaryOf(summaries, HEALER).damageTaken).toBe(3);
  });

  it("UT-UNIT-SUMMARY-004 (R-HEAL-01／R-HEAL-04): healingDone sums the actually-applied HP gain of HealApplied and HealingTransferred onto the healer, not the requested amount and not the link holder", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    // 要求30のうち、転送10・実回復12・最大HP超過で破棄8。
    recordHealApplied(recorder, {
      sourceUnitId: HEALER,
      targetUnitId: ATTACKER,
      healAmount: 30,
      transferredAmount: 10,
      appliedAmount: 12,
    });
    // 転送10のうち、転送先で実際に増えたのは9。回復者は転送元(ATTACKER)ではなくHEALER。
    recordHealingTransferred(recorder, {
      sourceUnitId: HEALER,
      fromUnitId: ATTACKER,
      toUnitId: DEFENDER,
      transferredAmount: 10,
      appliedAmount: 9,
    });

    const summaries = project(recorder.getEvents());

    expect(summaryOf(summaries, HEALER).healingDone).toBe(21);
    expect(summaryOf(summaries, ATTACKER).healingDone).toBe(0);
    expect(summaryOf(summaries, DEFENDER).healingDone).toBe(0);
  });

  it("UT-UNIT-SUMMARY-005 (10_API設計.md「UnitBattleSummaryResponse」): finalHp/maximumHp/combatStatus come from finalState, so a unit at 0 HP reports finalHp 0 and DEFEATED", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordDamageApplied(recorder, { sourceUnitId: ATTACKER, hitPointDamage: 100 });

    const summaries = project(
      recorder.getEvents(),
      finalStateWith({ [DEFENDER]: 0, [ATTACKER]: 42 }, { [ATTACKER]: 120 }),
    );

    expect(summaryOf(summaries, DEFENDER).finalHp).toBe(0);
    expect(summaryOf(summaries, DEFENDER).combatStatus).toBe("DEFEATED");
    expect(summaryOf(summaries, DEFENDER).maximumHp).toBe(100);
    expect(summaryOf(summaries, ATTACKER).finalHp).toBe(42);
    expect(summaryOf(summaries, ATTACKER).combatStatus).toBe("ACTIVE");
    // HP上限は戦闘中に動くため、開始時点のrosterではなくfinalStateの実効値を返す。
    expect(summaryOf(summaries, ATTACKER).maximumHp).toBe(120);
  });

  it("UT-UNIT-SUMMARY-006 (10_API設計.md「UnitBattleSummaryResponse」): returns one row per roster entry in roster order with side, including units that never appear in any event", () => {
    const summaries = project([]);

    expect(summaries).toEqual([
      {
        battleUnitId: ATTACKER,
        side: "ALLY",
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
      {
        battleUnitId: HEALER,
        side: "ALLY",
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
      {
        battleUnitId: DEFENDER,
        side: "ENEMY",
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
    ]);
  });
});
