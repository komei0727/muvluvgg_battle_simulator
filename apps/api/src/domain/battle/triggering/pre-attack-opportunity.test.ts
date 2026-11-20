import { describe, expect, it } from "vitest";
import {
  resolvePassiveChain,
  resolvePreAttackObservations,
  type PassiveActivationStep,
  type PassiveChainDependencies,
} from "./resolve-passive-chain.js";
import { createEmptyPassiveActivationGuard, hasActivated } from "./passive-activation-guard.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { aggregatePreAttackCandidates } from "./pre-attack-opportunity.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const GENEROUS_LIMITS = {
  maxPassiveDepth: 10,
  maxEffectsPerScope: 10,
  maxEffectRuntimeCounterDepth: 10,
};

function unit(id: string, actionSpeed: number, currentPp = 3): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      subAffinityBonus: 0.15,
    },
  };
  return { ...createBattleUnit(member, "ALLY", LIMITS), currentPp };
}

function skillOf(
  id: string,
  traits: {
    readonly simultaneousActivationLimited?: boolean;
    readonly priorityAttack?: boolean;
  } = {},
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType: "ANY",
        category: "TIMING",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
      },
    ],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: traits.priorityAttack ?? false,
      simultaneousActivationLimited: traits.simultaneousActivationLimited ?? false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: id, tags: [] },
  };
}

function candidateOf(battleUnit: BattleUnit, skill: SkillDefinition): PassiveCandidate {
  return {
    unit: battleUnit,
    skillDefinition: skill,
    trigger: skill.triggers[0]!,
    definitionIndex: 0,
  };
}

function observation(targetUnitId: string): TriggerCandidateEvent {
  return {
    eventType: "UnitBeingAttacked",
    category: "TIMING",
    targetUnitIds: [createBattleUnitId(targetUnitId)],
    payload: { targetUnitId },
  };
}

function rootEvent(eventType: string): TriggerCandidateEvent {
  return { eventType, category: "FACT", payload: {} };
}

/**
 * 候補検出を`candidatesOf`の対応表で固定し、発動順と各発動の契機イベントを記録する依存。
 * `stepsOf`が返すstep列を発動ごとに差し出す（未指定は効果なし）。
 */
function dependencies(options: {
  readonly units: readonly BattleUnit[];
  readonly candidatesOf: ReadonlyMap<TriggerCandidateEvent, PassiveCandidateGroup>;
  readonly stepsOf?: (skillId: string) => readonly PassiveActivationStep[];
  readonly interruptedSkillIds?: readonly string[];
}): {
  readonly deps: PassiveChainDependencies;
  readonly activations: { readonly skillId: string; readonly event: TriggerCandidateEvent }[];
} {
  const activations: { skillId: string; event: TriggerCandidateEvent }[] = [];
  const unitsById = new Map<BattleUnitId, BattleUnit>(
    options.units.map((candidate) => [candidate.battleUnitId, candidate]),
  );
  const deps: PassiveChainDependencies = {
    detectCandidates: (event) => options.candidatesOf.get(event) ?? [],
    getCurrentUnit: (id) => unitsById.get(id)!,
    activate: function* (candidate, event) {
      const skillId = candidate.skillDefinition.skillDefinitionId as string;
      activations.push({ skillId, event });
      for (const step of options.stepsOf?.(skillId) ?? []) {
        yield step;
      }
      return { interrupted: options.interruptedSkillIds?.includes(skillId) ?? false };
    },
    limits: GENEROUS_LIMITS,
  };
  return { deps, activations };
}

describe("aggregatePreAttackCandidates", () => {
  it("UT-R-ATM-03-012 [R-ATM-03]: 同じユニット・PSが複数対象に一致しても1件にまとめ、最初に一致した観測を契機にする", () => {
    const fast = unit("FAST", 30);
    const slow = unit("SLOW", 10);
    const fastCover = candidateOf(fast, skillOf("SKL_FAST"));
    const slowCover = candidateOf(slow, skillOf("SKL_SLOW"));
    const first = observation("T1");
    const second = observation("T2");

    const aggregated = aggregatePreAttackCandidates([
      { event: first, candidates: [slowCover] },
      { event: second, candidates: [fastCover, { ...slowCover }] },
    ]);

    expect(aggregated.candidates.map((c) => c.skillDefinition.skillDefinitionId)).toEqual([
      "SKL_FAST",
      "SKL_SLOW",
    ]);
    expect(aggregated.triggerEventOf.get(aggregated.candidates[0]!)).toBe(second);
    expect(aggregated.triggerEventOf.get(aggregated.candidates[1]!)).toBe(first);
  });
});

describe("pre-attack opportunity resolution", () => {
  it("UT-R-PS-03-008 [R-PS-03, R-ATM-03]: 範囲攻撃の全対象を通して同時発動制限PSは1つだけ発動し、後の対象にだけ一致する速い候補が選ばれる", () => {
    const fast = unit("FAST", 30);
    const slow = unit("SLOW", 10);
    const free = unit("FREE", 5);
    const fastCover = candidateOf(
      fast,
      skillOf("SKL_FAST_COVER", { simultaneousActivationLimited: true }),
    );
    const slowCover = candidateOf(
      slow,
      skillOf("SKL_SLOW_COVER", { simultaneousActivationLimited: true }),
    );
    const unlimited = candidateOf(free, skillOf("SKL_UNLIMITED"));
    const first = observation("T1");
    const second = observation("T2");
    const { deps, activations } = dependencies({
      units: [fast, slow, free],
      candidatesOf: new Map([
        [first, [slowCover, unlimited]],
        [second, [fastCover, slowCover, unlimited]],
      ]),
    });

    const result = resolvePreAttackObservations(
      [first, second],
      createEmptyPassiveActivationGuard(),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(activations).toEqual([
      { skillId: "SKL_FAST_COVER", event: second },
      { skillId: "SKL_UNLIMITED", event: first },
    ]);
    if (result.ok) {
      // 除外した候補は発動済みとして記録しない。
      expect(
        hasActivated(
          result.activationGuard,
          slow.battleUnitId,
          slowCover.skillDefinition.skillDefinitionId,
        ),
      ).toBe(false);
    }
  });

  it("UT-R-PS-03-009 [R-PS-03, R-PS-04]: 選ばれた候補が発動直前確認で不成立なら、発動開始前に次の同時発動制限PSへ繰り上げる", () => {
    const fast = unit("FAST", 30, 0);
    const slow = unit("SLOW", 10);
    const fastCover = candidateOf(
      fast,
      skillOf("SKL_FAST_COVER", { simultaneousActivationLimited: true }),
    );
    const slowCover = candidateOf(
      slow,
      skillOf("SKL_SLOW_COVER", { simultaneousActivationLimited: true }),
    );
    const target = observation("T1");
    const { deps, activations } = dependencies({
      units: [fast, slow],
      candidatesOf: new Map([[target, [fastCover, slowCover]]]),
    });

    resolvePreAttackObservations([target], createEmptyPassiveActivationGuard(), deps);

    expect(activations.map((a) => a.skillId)).toEqual(["SKL_SLOW_COVER"]);
  });

  it("UT-R-PS-03-010 [R-PS-03]: 発動を開始した候補が中断しても、別の同時発動制限PSへは繰り上げない", () => {
    const fast = unit("FAST", 30);
    const slow = unit("SLOW", 10);
    const fastCover = candidateOf(
      fast,
      skillOf("SKL_FAST_COVER", { simultaneousActivationLimited: true }),
    );
    const slowCover = candidateOf(
      slow,
      skillOf("SKL_SLOW_COVER", { simultaneousActivationLimited: true }),
    );
    const target = observation("T1");
    const { deps, activations } = dependencies({
      units: [fast, slow],
      candidatesOf: new Map([[target, [fastCover, slowCover]]]),
      interruptedSkillIds: ["SKL_FAST_COVER"],
    });

    resolvePreAttackObservations([target], createEmptyPassiveActivationGuard(), deps);

    expect(activations.map((a) => a.skillId)).toEqual(["SKL_FAST_COVER"]);
  });

  it("UT-R-PS-07-006 [R-PS-07]: 同じトップレベルイベントから独立して発動した2つの攻撃PSには、同じ攻撃前PSがそれぞれ発動する", () => {
    const attackerA = unit("ATTACKER_A", 40);
    const attackerB = unit("ATTACKER_B", 30);
    const guardian = unit("GUARDIAN", 10);
    const attackA = candidateOf(attackerA, skillOf("SKL_ATTACK_A", { priorityAttack: true }));
    const attackB = candidateOf(attackerB, skillOf("SKL_ATTACK_B", { priorityAttack: true }));
    const cover = candidateOf(
      guardian,
      skillOf("SKL_COVER", { simultaneousActivationLimited: true }),
    );
    const turnStarted = rootEvent("TurnStarted");
    const observedByA = observation("T1");
    const observedByB = observation("T1");
    const { deps, activations } = dependencies({
      units: [attackerA, attackerB, guardian],
      candidatesOf: new Map([
        [turnStarted, [attackA, attackB]],
        [observedByA, [cover]],
        [observedByB, [cover]],
      ]),
      stepsOf: (skillId) =>
        skillId === "SKL_ATTACK_A"
          ? [{ kind: "PRE_ATTACK_OBSERVATIONS", events: [observedByA] }]
          : skillId === "SKL_ATTACK_B"
            ? [{ kind: "PRE_ATTACK_OBSERVATIONS", events: [observedByB] }]
            : [],
    });

    const result = resolvePassiveChain(turnStarted, createEmptyPassiveActivationGuard(), deps);

    expect(activations.map((a) => a.skillId)).toEqual([
      "SKL_ATTACK_A",
      "SKL_COVER",
      "SKL_ATTACK_B",
      "SKL_COVER",
    ]);
    if (result.ok) {
      // 反応スコープの記録は最も外側の反応スコープが閉じた時点で破棄され、
      // 解決スコープの発動済み集合へは残らない。
      expect(
        hasActivated(
          result.activationGuard,
          guardian.battleUnitId,
          cover.skillDefinition.skillDefinitionId,
        ),
      ).toBe(false);
    }
  });

  it("UT-R-PS-07-007 [R-PS-07]: 攻撃前PSから派生した反撃が同じPSへ戻る循環は発動させない", () => {
    const attacker = unit("ATTACKER", 40);
    const guardian = unit("GUARDIAN", 10);
    const counterer = unit("COUNTERER", 20);
    const attack = candidateOf(attacker, skillOf("SKL_ATTACK"));
    const cover = candidateOf(
      guardian,
      skillOf("SKL_COVER", { simultaneousActivationLimited: true }),
    );
    const counter = candidateOf(counterer, skillOf("SKL_COUNTER"));
    const root = rootEvent("ROOT");
    const firstObservation = observation("T1");
    const covered = rootEvent("COVERED");
    const counterObservation = observation("T1");
    const { deps, activations } = dependencies({
      units: [attacker, guardian, counterer],
      candidatesOf: new Map([
        [root, [attack]],
        [firstObservation, [cover]],
        [covered, [counter]],
        [counterObservation, [cover]],
      ]),
      stepsOf: (skillId) =>
        skillId === "SKL_ATTACK"
          ? [{ kind: "PRE_ATTACK_OBSERVATIONS", events: [firstObservation] }]
          : skillId === "SKL_COVER"
            ? [{ kind: "TIMING_EVENT", event: covered }]
            : [{ kind: "PRE_ATTACK_OBSERVATIONS", events: [counterObservation] }],
    });

    resolvePassiveChain(root, createEmptyPassiveActivationGuard(), deps);

    expect(activations.map((a) => a.skillId)).toEqual(["SKL_ATTACK", "SKL_COVER", "SKL_COUNTER"]);
  });

  it("UT-R-PS-07-008 [R-PS-07]: 行動中のAS/EXへの攻撃前PSは解決スコープへ記録し、同じ行動の後続の攻撃には発動しない", () => {
    const guardian = unit("GUARDIAN", 10);
    const follower = unit("FOLLOWER", 20);
    const cover = candidateOf(
      guardian,
      skillOf("SKL_COVER", { simultaneousActivationLimited: true }),
    );
    const followUp = candidateOf(follower, skillOf("SKL_FOLLOW_UP"));
    const asObservation = observation("T1");
    const completed = rootEvent("SkillUseCompleted");
    const followUpObservation = observation("T1");
    const { deps, activations } = dependencies({
      units: [guardian, follower],
      candidatesOf: new Map([
        [asObservation, [cover]],
        [completed, [followUp]],
        [followUpObservation, [cover]],
      ]),
      stepsOf: (skillId) =>
        skillId === "SKL_FOLLOW_UP"
          ? [{ kind: "PRE_ATTACK_OBSERVATIONS", events: [followUpObservation] }]
          : [],
    });

    const observed = resolvePreAttackObservations(
      [asObservation],
      createEmptyPassiveActivationGuard(),
      deps,
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) {
      return;
    }
    expect(
      hasActivated(
        observed.activationGuard,
        guardian.battleUnitId,
        cover.skillDefinition.skillDefinitionId,
      ),
    ).toBe(true);
    resolvePassiveChain(completed, observed.activationGuard, deps);

    expect(activations.map((a) => a.skillId)).toEqual(["SKL_COVER", "SKL_FOLLOW_UP"]);
  });
});
