import type { SkillDefinitionId, UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { sortPassiveCandidates } from "./passive-candidate-order.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import type { PassiveActivationGuard } from "./passive-activation-guard.js";
import { hasActivated } from "./passive-activation-guard.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export interface PassiveTriggerMatchInput {
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  readonly activationGuard: PassiveActivationGuard;
  /**
   * `RESOLUTION_PHASE`（Issue #144、TRIGGER_EXCLUSION_TIMING）が参照する、
   * 現在の解決スコープのroot/ancestorイベントが属するBattle/Turn phase。
   * 呼び出し側（`PassiveActivationRuntime`等）が1解決スコープにつき1回だけ
   * 決める。行動中など通常の解決スコープでは`undefined`。
   */
  readonly resolutionPhase?: ResolutionPhase;
}

function findMatchingTrigger(
  skill: SkillDefinition,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
  resolutionPhase: ResolutionPhase | undefined,
): TriggerDefinition | undefined {
  return skill.triggers.find(
    (trigger) =>
      trigger.eventType === event.eventType &&
      trigger.category === event.category &&
      evaluateSourceSelector(trigger.sourceSelector, owner, event, unitsById) &&
      evaluateTargetSelector(trigger.targetSelector, owner, event, unitsById) &&
      evaluateTriggerCondition(trigger.condition, event, {
        owner,
        skillDefinitionId: skill.skillDefinitionId,
        getUnit: (id) => unitsById.get(id),
        ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
      }),
  );
}

/**
 * R-PS-01「発動タイミング照合」: Domain Eventへ、戦闘可能な全ユニットが持つPSの
 * `TriggerDefinition`を照合し、条件を満たしたものを同じイベントの候補グループに
 * する。`eventType`ごとの分岐を持たず、`TriggerDefinition`が宣言する値と
 * `event.eventType`/`category`の一致だけで判定する。
 *
 * `08_ドメインイベント.md`「候補抽出」#1・#2・#4を実装する（#5「同時発動制限」は
 * #21のスコープ）。`SkillDefinition.activationCondition`（「Skill使用可否」、
 * `05_ドメインモデル.md`のSkillDefinition表）も`trigger.condition`と同じ評価器で
 * 満たされている場合だけ候補にする。返り値は`sortPassiveCandidates`により
 * R-PS-02/R-PS-08で順序付け済みで、入力の`units`配列順には依存しない。
 */
export function detectPassiveCandidates(input: PassiveTriggerMatchInput): PassiveCandidateGroup {
  const { event, units, unitDefinitions, skillDefinitions, activationGuard, resolutionPhase } =
    input;
  const unitsById = new Map(units.map((unit) => [unit.battleUnitId, unit] as const));
  const candidates: PassiveCandidate[] = [];

  for (const owner of units) {
    if (isDefeated(owner) || owner.charge !== undefined) {
      continue;
    }
    const unitDefinition = unitDefinitions.get(owner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${owner.unitDefinitionId}" (battleUnitId "${owner.battleUnitId}")`,
      );
    }
    unitDefinition.passiveSkillDefinitionIds.forEach((skillDefinitionId, definitionIndex) => {
      if (hasActivated(activationGuard, owner.battleUnitId, skillDefinitionId)) {
        return;
      }
      const skill = skillDefinitions.get(skillDefinitionId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillDefinitionId}"`,
        );
      }
      const trigger = findMatchingTrigger(skill, owner, event, unitsById, resolutionPhase);
      if (
        trigger !== undefined &&
        evaluateTriggerCondition(skill.activationCondition, event, {
          owner,
          skillDefinitionId: skill.skillDefinitionId,
          getUnit: (id) => unitsById.get(id),
          ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
        })
      ) {
        candidates.push({ unit: owner, skillDefinition: skill, trigger, definitionIndex });
      }
    });
  }

  return sortPassiveCandidates(candidates);
}
