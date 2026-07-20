import { describe, expect, it } from "vitest";
import {
  collectResolutionScopeResets,
  detectRuntimeCounterUpdates,
} from "./runtime-counter-matcher.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { RuntimeCounterUpdateDefinitionInput } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { createRuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  unitDefinitionId: UnitDefinitionId,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

function unitDefinitionOf(
  id: UnitDefinitionId,
  passiveSkillDefinitionIds: readonly SkillDefinitionId[],
): UnitDefinition {
  return {
    unitDefinitionId: id,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds,
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: {
      displayName: "Test Unit",
      characterName: "Test Character",
      characterId: "CHAR_TEST",
      affiliations: [],
      tags: [],
    },
  };
}

function passiveSkillOf(
  id: string,
  counterUpdates: readonly RuntimeCounterUpdateDefinitionInput[],
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType: "TurnStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
      },
    ],
    counterUpdates: counterUpdates.map((c, i) =>
      createRuntimeCounterUpdateDefinition(c, `counterUpdates[${i}]`),
    ),
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
  };
}

const UNIT_DEF_A = createUnitDefinitionId("UNIT_A");

function critEvent(sourceUnitId: BattleUnit["battleUnitId"]): TriggerCandidateEvent {
  return {
    eventType: "CriticalCheckResolved",
    category: "FACT",
    sourceUnitId,
    payload: { result: true },
  };
}

function damageEvent(
  sourceUnitId: BattleUnit["battleUnitId"],
  targetUnitId: BattleUnit["battleUnitId"],
  hitPointDamage: number,
): TriggerCandidateEvent {
  return {
    eventType: "DamageApplied",
    category: "FACT",
    sourceUnitId,
    targetUnitIds: [targetUnitId],
    payload: { hitPointDamage },
  };
}

describe("detectRuntimeCounterUpdates", () => {
  it("UT-RCOUNTER-M-001 (RUNTIME_COUNTER_MODULO): increments a skill's own SKILL_RUNTIME counter when its trigger matches", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_CRIT",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_CRIT",
        before: 0,
        after: 1,
        carry: 0,
        carryBefore: 0,
        valueChanged: true,
      },
    ]);
    expect(
      result.units[0]?.skillCounters?.[skill.skillDefinitionId]?.["RUNTIME_COUNTER_CRIT" as never],
    ).toEqual({
      value: 1,
      carry: 0,
    });
  });

  it("UT-RCOUNTER-M-002: accumulates across repeated matching events (N-th crossing reachable via modulo on the resulting value)", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_CRIT",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const first = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });
    const second = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: first.units,
      unitDefinitions,
      skillDefinitions,
    });

    expect(second.changes[0]).toEqual({
      ownerUnitId: owner.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
      counter: "RUNTIME_COUNTER_CRIT",
      before: 1,
      after: 2,
      carry: 0,
      carryBefore: 0,
      valueChanged: true,
    });
  });

  it("UT-RCOUNTER-M-003: a SELF-scoped counterUpdates trigger only updates the unit that was actually the event source, not every unit owning the same skill", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_CRIT",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const other = unit("U2", "ALLY", { row: "FRONT", column: "CENTER" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(other.battleUnitId),
      units: [owner, other],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes).toEqual([
      {
        ownerUnitId: other.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_CRIT",
        before: 0,
        after: 1,
        carry: 0,
        carryBefore: 0,
        valueChanged: true,
      },
    ]);
  });

  it("UT-RCOUNTER-M-004: skips defeated owners", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_CRIT",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A, {
      currentHp: 0,
    });
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes).toEqual([]);
  });

  it("UT-RCOUNTER-M-005 (CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER): accumulates cumulative damage taken as a max-HP-ratio threshold count", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_DMG",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
        },
        maxHpRatio: 0.4,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const enemy = unit("E1", "ENEMY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: damageEvent(enemy.battleUnitId, owner.battleUnitId, 105),
      units: [owner, enemy],
      unitDefinitions,
      skillDefinitions,
    });

    // maximumHp 100 * 0.4 = threshold 40; 105 / 40 = 2 crossings, remainder 25
    expect(result.changes).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_DMG",
        before: 0,
        after: 2,
        carry: 25,
        carryBefore: 0,
        valueChanged: true,
      },
    ]);
  });

  it("UT-RCOUNTER-M-006 (review re-fix [P2]): still reports a change when the accumulated damage stays below the threshold, because the internal carry changed even though the public value did not (before === after but carry moved from 0 to 10)", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_DMG",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
        },
        maxHpRatio: 0.4,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const enemy = unit("E1", "ENEMY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: damageEvent(enemy.battleUnitId, owner.battleUnitId, 10),
      units: [owner, enemy],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_DMG",
        before: 0,
        after: 0,
        carry: 10,
        carryBefore: 0,
        valueChanged: false,
      },
    ]);
  });

  it("UT-RCOUNTER-M-006b (review re-fix [P2]): reports no change at all when neither the value nor the carry moved (trigger did not match / 0 damage)", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_DMG",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
        },
        maxHpRatio: 0.4,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const enemy = unit("E1", "ENEMY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: damageEvent(enemy.battleUnitId, owner.battleUnitId, 0),
      units: [owner, enemy],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes).toEqual([]);
  });

  it("UT-RCOUNTER-M-008 (review fix): the carry is persisted into the returned units even when it does not yet cross a threshold, so a later update can pick up where it left off", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "CUMULATIVE_DAMAGE_THRESHOLD",
        counter: "RUNTIME_COUNTER_DMG",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ENEMY",
          targetSelector: "SELF",
        },
        maxHpRatio: 0.4,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const enemy = unit("E1", "ENEMY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const first = detectRuntimeCounterUpdates({
      event: damageEvent(enemy.battleUnitId, owner.battleUnitId, 30),
      units: [owner, enemy],
      unitDefinitions,
      skillDefinitions,
    });
    // レビュー再レビュー[P2]: valueは変わらない(0->0)がcarryが0->30へ変化した
    // ため、この更新自体もchangeとして報告される。
    expect(first.changes).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_DMG",
        before: 0,
        after: 0,
        carry: 30,
        carryBefore: 0,
        valueChanged: false,
      },
    ]);
    const ownerAfterFirst = first.units.find((u) => u.battleUnitId === owner.battleUnitId);
    expect(
      ownerAfterFirst?.skillCounters?.[skill.skillDefinitionId]?.["RUNTIME_COUNTER_DMG" as never],
    ).toEqual({ value: 0, carry: 30 });

    // carry 30 + 15 = 45 >= 40 threshold: one crossing, remainder 5.
    const second = detectRuntimeCounterUpdates({
      event: damageEvent(enemy.battleUnitId, owner.battleUnitId, 15),
      units: first.units,
      unitDefinitions,
      skillDefinitions,
    });
    expect(second.changes).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_DMG",
        before: 0,
        after: 1,
        carry: 5,
        carryBefore: 30,
        valueChanged: true,
      },
    ]);
  });

  it("UT-RCOUNTER-M-007: rejects a BATTLE-scoped counterUpdates entry as not yet supported (defense-in-depth; Catalog validation already rejects this scope before it can reach here, per UT-CAT-RCU-011)", () => {
    // `createRuntimeCounterUpdateDefinition` (Catalog layer) now rejects
    // BATTLE/BATTLE_UNIT scope outright, so a BATTLE-scoped entry can no
    // longer be constructed via `passiveSkillOf`. Build it directly to
    // exercise the matcher's own defensive check.
    const skill = passiveSkillOf("SKL_PS1", []);
    const skillWithBattleScopedCounter: SkillDefinition = {
      ...skill,
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: "RUNTIME_COUNTER_BATTLE",
          scope: "BATTLE",
          trigger: {
            eventType: "CriticalCheckResolved",
            category: "FACT",
            sourceSelector: "SELF",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
        },
      ] as never,
    };
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skillWithBattleScopedCounter.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([
      [skillWithBattleScopedCounter.skillDefinitionId, skillWithBattleScopedCounter],
    ]);

    expect(() =>
      detectRuntimeCounterUpdates({
        event: critEvent(owner.battleUnitId),
        units: [owner],
        unitDefinitions,
        skillDefinitions,
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-RCOUNTER-M-012 (review re-re-fix [P2]): multiple counterUpdates definitions matching the same event and targeting the same counter are all applied, in array order, not collapsed into one", () => {
    const skill = passiveSkillOf("SKL_PS_DUP_COUNTER", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_DUP",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_DUP",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 2,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes.map((c) => ({ before: c.before, after: c.after }))).toEqual([
      { before: 0, after: 1 },
      { before: 1, after: 3 },
    ]);
    expect(
      result.units[0]?.skillCounters?.[skill.skillDefinitionId]?.["RUNTIME_COUNTER_DUP" as never],
    ).toEqual({ value: 3, carry: 0 });
  });

  it("UT-RCOUNTER-M-013 (review re-re-fix [P2]): the matched set is fixed from the state passed in, not re-evaluated after an earlier entry's own effect — a later entry that only becomes newly-true is not retroactively added", () => {
    const skill = passiveSkillOf("SKL_PS_NO_RETRO_MATCH", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_NO_RETRO_A",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
      {
        // このcounterUpdates自体はCriticalCheckResolvedにマッチするが、
        // conditionが「counterAが既に1」を要求する。マッチング確定時点
        // (このイベント到着直後、上のentryもまだ未適用)ではAは0なので
        // 不一致のはずである。
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_NO_RETRO_C",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "RUNTIME_COUNTER",
            counter: "RUNTIME_COUNTER_NO_RETRO_A",
            op: "EQ",
            value: 1,
          },
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    // 修正前（毎回`this.units`から再検出する方式）だと、1件目の適用で
    // counterAが1になった後の再検出でこの2件目が新たに一致してしまう
    // （遡及的な追加）。マッチングを1回だけ確定する現在の実装ではこの
    // 2件目は最後まで一致しない。
    expect(result.changes.map((c) => c.counter)).toEqual(["RUNTIME_COUNTER_NO_RETRO_A"]);
    expect(
      result.units[0]?.skillCounters?.[skill.skillDefinitionId]?.[
        "RUNTIME_COUNTER_NO_RETRO_C" as never
      ],
    ).toBeUndefined();
  });

  it("UT-RCOUNTER-M-014 (review re-re-fix [P2]): an entry that matched against the state passed in is still applied even though an earlier entry in the same batch already changed the state its condition read", () => {
    const skill = passiveSkillOf("SKL_PS_NO_VANISH_MATCH", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_NO_VANISH_A",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
      {
        // マッチング確定時点(counterAはまだ0)ではconditionが真なので一致する。
        // 1件目の適用でcounterAが1になっても、この2件目は消えてはならない。
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_NO_VANISH_E",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: {
            kind: "RUNTIME_COUNTER",
            counter: "RUNTIME_COUNTER_NO_VANISH_A",
            op: "EQ",
            value: 0,
          },
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const result = detectRuntimeCounterUpdates({
      event: critEvent(owner.battleUnitId),
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(result.changes.map((c) => c.counter)).toEqual([
      "RUNTIME_COUNTER_NO_VANISH_A",
      "RUNTIME_COUNTER_NO_VANISH_E",
    ]);
    expect(
      result.units[0]?.skillCounters?.[skill.skillDefinitionId]?.[
        "RUNTIME_COUNTER_NO_VANISH_E" as never
      ],
    ).toEqual({ value: 1, carry: 0 });
  });
});

describe("collectResolutionScopeResets (review fix [P2])", () => {
  it("UT-RCOUNTER-M-009: finds a counter declared with resetScope: RESOLUTION_SCOPE that currently holds a value", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SCOPED",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
        resetScope: "RESOLUTION_SCOPE",
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A, {
      skillCounters: {
        [skill.skillDefinitionId]: { RUNTIME_COUNTER_SCOPED: { value: 2, carry: 0 } },
      },
    } as never);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const resets = collectResolutionScopeResets({
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(resets).toEqual([
      {
        ownerUnitId: owner.battleUnitId,
        skillDefinitionId: skill.skillDefinitionId,
        counter: "RUNTIME_COUNTER_SCOPED",
      },
    ]);
  });

  it("UT-RCOUNTER-M-010: does not report a counter that has no resetScope (persists for the whole battle)", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_PERSISTENT",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A, {
      skillCounters: {
        [skill.skillDefinitionId]: { RUNTIME_COUNTER_PERSISTENT: { value: 2, carry: 0 } },
      },
    } as never);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const resets = collectResolutionScopeResets({
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(resets).toEqual([]);
  });

  it("UT-RCOUNTER-M-011: does not report a resetScope counter that has no current value yet", () => {
    const skill = passiveSkillOf("SKL_PS1", [
      {
        kind: "INCREMENT",
        counter: "RUNTIME_COUNTER_SCOPED",
        scope: "SKILL_RUNTIME",
        trigger: {
          eventType: "CriticalCheckResolved",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
        },
        amount: 1,
        resetScope: "RESOLUTION_SCOPE",
      },
    ]);
    const owner = unit("U1", "ALLY", { row: "FRONT", column: "LEFT" }, UNIT_DEF_A);
    const unitDefinitions = new Map([
      [UNIT_DEF_A, unitDefinitionOf(UNIT_DEF_A, [skill.skillDefinitionId])],
    ]);
    const skillDefinitions = new Map([[skill.skillDefinitionId, skill]]);

    const resets = collectResolutionScopeResets({
      units: [owner],
      unitDefinitions,
      skillDefinitions,
    });

    expect(resets).toEqual([]);
  });
});
