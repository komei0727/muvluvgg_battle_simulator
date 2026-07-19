import type {
  RuntimeCounterId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  applyCumulativeDamageThreshold,
  incrementRuntimeCounter,
  type RuntimeCounterMap,
} from "../model/runtime-counter-state.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export interface RuntimeCounterUpdateResult {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
  /** `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（`INCREMENT`では常に0）。観測用。 */
  readonly carry: number;
}

export interface RuntimeCounterMatchInput {
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
}

function matchesUpdateTrigger(
  update: RuntimeCounterUpdateDefinition,
  owner: BattleUnit,
  skillDefinitionId: SkillDefinitionId,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  const trigger = update.trigger;
  return (
    trigger.eventType === event.eventType &&
    trigger.category === event.category &&
    evaluateSourceSelector(trigger.sourceSelector, owner, event, unitsById) &&
    evaluateTargetSelector(trigger.targetSelector, owner, event, unitsById) &&
    evaluateTriggerCondition(trigger.condition, event, { owner, skillDefinitionId })
  );
}

function readNumberPayloadField(event: TriggerCandidateEvent, field: string): number {
  const value = event.payload[field];
  if (typeof value !== "number") {
    throw new DomainValidationError(
      "event.payload",
      `CUMULATIVE_DAMAGE_THRESHOLD requires a numeric "${field}" field on eventType "${event.eventType}", got ${typeof value}`,
    );
  }
  return value;
}

function applyUpdate(
  update: RuntimeCounterUpdateDefinition,
  counters: RuntimeCounterMap,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
): {
  readonly counters: RuntimeCounterMap;
  readonly before: number;
  readonly after: number;
  readonly carry: number;
} {
  if (update.kind === "INCREMENT") {
    const result = incrementRuntimeCounter(counters, update.counter, update.amount);
    return {
      counters: result.counters,
      before: result.change.before,
      after: result.change.after,
      carry: 0,
    };
  }
  const damageAmount = readNumberPayloadField(event, "hitPointDamage");
  const result = applyCumulativeDamageThreshold(
    counters,
    update.counter,
    damageAmount,
    owner.combatStats.maximumHp,
    update.maxHpRatio,
  );
  return {
    counters: result.counters,
    before: result.change.before,
    after: result.change.after,
    carry: result.counters[update.counter]?.carry ?? 0,
  };
}

/**
 * `R-EFF-11`/`08_ドメインイベント.md`「イベント発行と処理」#3: 対象イベントに
 * 対応する`counterUpdates`（M6最小実装、`SKILL_RUNTIME`スコープ、Issue #143）を
 * 検出し、決定的に更新する。呼び出し側はPS/Memory候補抽出より前に呼び出し、
 * 変化があった件数分だけ`RuntimeCounterChanged`を発行する。
 *
 * `Battle`／`BattleUnit`スコープはIssue #143の対象12行がいずれも
 * `SKILL_RUNTIME`スコープで表現できるため未実装とし、明示的に拒否する
 * （他の"basic"policyと同じ隔離方針）。
 */
export function detectRuntimeCounterUpdates(input: RuntimeCounterMatchInput): {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly RuntimeCounterUpdateResult[];
} {
  const { event, unitDefinitions, skillDefinitions } = input;
  const unitsById = new Map(input.units.map((u) => [u.battleUnitId, u] as const));
  const changes: RuntimeCounterUpdateResult[] = [];
  let workingUnits = input.units;

  for (const originalOwner of input.units) {
    if (isDefeated(originalOwner)) {
      continue;
    }
    const unitDefinition = unitDefinitions.get(originalOwner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${originalOwner.unitDefinitionId}" (battleUnitId "${originalOwner.battleUnitId}")`,
      );
    }
    for (const skillId of unitDefinition.passiveSkillDefinitionIds) {
      const skill = skillDefinitions.get(skillId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillId}"`,
        );
      }
      for (const update of skill.counterUpdates) {
        if (update.scope !== "SKILL_RUNTIME") {
          throw new DomainValidationError(
            "counterUpdates.scope",
            `scope "${update.scope}" is not supported yet (Issue #143 only implements SKILL_RUNTIME scope)`,
          );
        }
        if (!matchesUpdateTrigger(update, originalOwner, skillId, event, unitsById)) {
          continue;
        }
        const currentOwner = workingUnits.find((u) => u.battleUnitId === originalOwner.battleUnitId);
        if (currentOwner === undefined) {
          throw new DomainValidationError(
            "units",
            `battleUnitId "${originalOwner.battleUnitId}" disappeared while applying counterUpdates`,
          );
        }
        const existingCounters = currentOwner.skillCounters?.[skillId] ?? {};
        const applied = applyUpdate(update, existingCounters, currentOwner, event);
        if (applied.before === applied.after) {
          continue;
        }
        const updatedOwner: BattleUnit = {
          ...currentOwner,
          skillCounters: { ...currentOwner.skillCounters, [skillId]: applied.counters },
        };
        workingUnits = workingUnits.map((u) =>
          u.battleUnitId === updatedOwner.battleUnitId ? updatedOwner : u,
        );
        changes.push({
          ownerUnitId: originalOwner.battleUnitId,
          skillDefinitionId: skillId,
          counter: update.counter,
          before: applied.before,
          after: applied.after,
          carry: applied.carry,
        });
      }
    }
  }

  return { units: workingUnits, changes };
}
