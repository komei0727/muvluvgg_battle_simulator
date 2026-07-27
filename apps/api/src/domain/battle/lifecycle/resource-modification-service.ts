import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
  truncateFraction,
} from "../model/resource-gauge.js";
import { evaluateFormula, lastDamageResultsFor } from "../skill/formula-evaluator.js";
import type { LastDamageResultRegistry } from "../skill/formula-evaluator.js";
import {
  recordResourceChangeIfAny,
  type ResourceChangeRecordContext,
} from "./action-resolution-shared.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ResourceKind } from "../../catalog/definitions/catalog-enums.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DomainEventId } from "../../shared/event-ids.js";

export interface ModifyResourceEventContext extends ResourceChangeRecordContext {
  readonly parentEventId: DomainEventId;
  readonly sourceUnitId: BattleUnitId;
  readonly lastDamageResults?: LastDamageResultRegistry;
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface ApplyModifyResourceActionResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly resolvedCount: number;
  /** いずれかのhitで実際に値が変化した（`ResourceChanged`を1件以上発行した）場合`true`。 */
  readonly changed: boolean;
}

function findUnit(units: readonly BattleUnit[], id: BattleUnitId, path: string): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError(path, `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

function currentValueOf(unit: BattleUnit, resource: ResourceKind): number {
  switch (resource) {
    case "AP":
      return unit.currentAp;
    case "PP":
      return unit.currentPp;
    case "EX_GAUGE":
      return unit.currentExtraGauge;
    case "HP":
      return unit.currentHp;
  }
}

function maxValueOf(unit: BattleUnit, resource: ResourceKind): number {
  switch (resource) {
    case "AP":
      return unit.maximumAp;
    case "PP":
      return unit.maximumPp;
    case "EX_GAUGE":
      return unit.maximumExtraGauge;
    case "HP":
      return truncateFraction(unit.combatStats.maximumHp);
  }
}

function withUpdatedResource(unit: BattleUnit, resource: ResourceKind, value: number): BattleUnit {
  switch (resource) {
    case "AP":
      return { ...unit, currentAp: createActionPoint(value, unit.maximumAp) };
    case "PP":
      return { ...unit, currentPp: createPassivePoint(value, unit.maximumPp) };
    case "EX_GAUGE":
      return { ...unit, currentExtraGauge: createExtraGauge(value, unit.maximumExtraGauge) };
    case "HP":
      return {
        ...unit,
        currentHp: createHitPoint(value, truncateFraction(unit.combatStats.maximumHp)),
      };
  }
}

/**
 * R-ACTN-02「MODIFY_RESOURCE は対象リソースへ整数化済みFormula結果を適用し、
 * 0以上かつ現在最大値以下に丸める」＋M7-002（Issue #185、HP_DIRECT_COST）:
 * `resource: HP`を対象にでき、防御力・会心などの通常ダメージ処理
 * （`combat/damage-application-service.ts`）を経由せずHPを直接増減する。
 * `operation: DISTRIBUTE`（対象間で分配）は未実装 — production利用は1件のみ
 * （`UNIT_SUIRAN_CHAOS`、本Issueのスコープ外）で、複数対象への分配ロジックは
 * 別途設計が必要なため、明確な`DomainValidationError`で拒否する。
 * `RESOURCE_GAIN_MOD`（`APPLY_RESOURCE_GAIN_MOD`）は「リソース獲得量」
 * （R-ACT-03のAP/PP消費起因のEXゲージ増加）だけを対象にし、`MODIFY_RESOURCE`
 * には適用しない（`baseDelta`は常に`delta`と一致する）。
 */
export function applyModifyResourceAction(
  hits: readonly ResolvedEffectApplication[],
  actor: BattleUnit,
  action: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE" }>,
  units: readonly BattleUnit[],
  context: ModifyResourceEventContext,
): ApplyModifyResourceActionResult {
  if (action.payload.operation === "DISTRIBUTE") {
    throw new DomainValidationError(
      "effectAction.payload.operation",
      'MODIFY_RESOURCE operation "DISTRIBUTE" is not yet supported (M7-002/Issue #185 scope: ADD/SET/SET_TO_MAX only)',
    );
  }

  let working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  let lastEventId = context.parentEventId;
  let resolvedCount = 0;
  let changed = false;

  function chain(event: BattleDomainEvent): void {
    if (context.onFactEventForPassiveChain === undefined) {
      return;
    }
    const updatedUnits = context.onFactEventForPassiveChain(event, Array.from(working.values()));
    working = new Map(updatedUnits.map((unit) => [unit.battleUnitId, unit]));
  }

  for (const hit of hits) {
    const target = findUnit(
      Array.from(working.values()),
      hit.targetBattleUnitId,
      "hits[].targetBattleUnitId",
    );
    const resource = action.payload.resource;
    const before = currentValueOf(target, resource);
    const currentMax = maxValueOf(target, resource);

    const rawValue =
      action.payload.operation === "SET_TO_MAX"
        ? currentMax
        : (() => {
            const formulaResult = evaluateFormula(action.payload.formula, {
              skillSource: actor,
              target,
              allUnits: Array.from(working.values()),
              ...(context.lastDamageResults !== undefined
                ? {
                    lastResults: lastDamageResultsFor(
                      context.lastDamageResults,
                      actor.battleUnitId,
                    ),
                  }
                : {}),
            });
            return action.payload.operation === "ADD" ? before + formulaResult : formulaResult;
          })();

    const min = action.payload.bounds?.min ?? 0;
    const maxBound =
      action.payload.bounds === undefined || action.payload.bounds.max === "CURRENT_MAX"
        ? currentMax
        : action.payload.bounds.max;
    const after = truncateFraction(Math.min(maxBound, Math.max(min, rawValue)));

    resolvedCount += 1;
    if (after === before) {
      continue;
    }
    changed = true;

    const wasDefeatedBefore = isDefeated(target);
    const updatedTarget = withUpdatedResource(target, resource, after);
    working.set(target.battleUnitId, updatedTarget);

    lastEventId = recordResourceChangeIfAny(
      context,
      target.battleUnitId,
      resource,
      before,
      after,
      after - before,
      "EFFECT_ACTION",
      lastEventId,
      lastEventId,
    );
    const resourceChangedEvent = context.recorder
      .getEvents()
      .find((event) => event.eventId === lastEventId)!;
    chain(resourceChangedEvent);

    if (resource === "HP" && !wasDefeatedBefore && isDefeated(updatedTarget)) {
      const unitDefeated = context.recorder.record({
        eventType: "UnitDefeated",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: context.sourceUnitId,
        targetUnitIds: [target.battleUnitId],
        payload: { unitId: target.battleUnitId, causeEventId: lastEventId },
      });
      lastEventId = unitDefeated.eventId;
      chain(unitDefeated);
    }
  }

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    lastEventId,
    resolvedCount,
    changed,
  };
}
