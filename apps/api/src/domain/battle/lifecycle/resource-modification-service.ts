import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
  truncateFraction,
} from "../model/resource-gauge.js";
import { evaluateFormula, damageResultsFor } from "../skill/formula-evaluator.js";
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";
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
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import {
  requireResolveBreak,
  requiresBreakResolution,
  type ResolveBreakHook,
} from "../events/break-resolution.js";

export interface ModifyResourceEventContext extends ResourceChangeRecordContext {
  readonly parentEventId: DomainEventId;
  readonly sourceUnitId: BattleUnitId;
  readonly damageResults?: DamageResultRegistry;
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-TEX-03 #1: ブレイクの到達経路は「リソース操作等」を含む。演習状態がある場合、
   * `MODIFY_RESOURCE(resource: HP)`で敵のHPが0へ落ちたときも戦闘不能ではなく
   * ブレイクとして解決する。未指定なら通常戦闘。
   */
  readonly exercise?: ExerciseRuntime;
  /** `exercise`とセットで注入する`BreakResolutionService`（`damage-event-context.ts`と同じ契約）。 */
  readonly resolveBreak?: ResolveBreakHook;
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
 * M7-017（Issue #271、`CAP_RESOURCE_DISTRIBUTE`）: `operation: DISTRIBUTE`は
 * Formula評価結果を「対象間で分け合う総量」とみなし、`distributionShareCount`
 * （同一EffectStep内でこのEffectActionが実際に適用される対象数、
 * `effect-action-group-resolver.ts`が算出）で等分した値を`ADD`と同じ規約で
 * 現在値へ加算する。`HEAL`の`payload.distribution: "EVEN"`（M7-005、Issue #184）
 * のリソース版であり、端数は対象ごとに1回だけ切り捨てる（R-NUM-02）。
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
  /**
   * M7-017（Issue #271）: `operation: DISTRIBUTE`のときだけ使う分配数。
   * 既定の1は「分配相手が自分だけ」＝総量をそのまま加算する意味になる。
   * `HEAL`の`distributionShareCount`（`heal-application-service.ts`）と同じ契約。
   */
  distributionShareCount = 1,
): ApplyModifyResourceActionResult {
  if (!Number.isInteger(distributionShareCount) || distributionShareCount < 1) {
    throw new DomainValidationError(
      "distributionShareCount",
      `must be a positive integer, received ${distributionShareCount}`,
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
    const target = findUnit(Array.from(working.values()), hit.targetUnitId, "hits[].targetUnitId");
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
              // G-10／RES-003A（Issue #257）: `context.skillUseId`がこの
              // `MODIFY_RESOURCE`が属するEffectSequence解決を識別し、
              // `SUM_DAMAGE_*`の集計スコープになる。
              ...(context.damageResults !== undefined
                ? {
                    lastResults: damageResultsFor(
                      context.damageResults,
                      actor.battleUnitId,
                      context.skillUseId,
                    ),
                  }
                : {}),
            });
            if (action.payload.operation === "ADD") {
              return before + formulaResult;
            }
            // M7-017（Issue #271）: DISTRIBUTEはFormula結果を総量として等分し、
            // その取り分を現在値へ加算する。切り捨てはこの直後の`after`算出で
            // 一度だけ行う（R-NUM-02）。
            if (action.payload.operation === "DISTRIBUTE") {
              return before + formulaResult / distributionShareCount;
            }
            return formulaResult;
          })();

    const authoredMin = action.payload.bounds?.min ?? 0;
    const authoredMax =
      action.payload.bounds === undefined || action.payload.bounds.max === "CURRENT_MAX"
        ? currentMax
        : action.payload.bounds.max;
    // R-ACTN-02: Catalog上のboundsは常にリソースの実際の可動域[0, currentMax]と
    // 交差させる — Catalog作者が範囲外の値（負のmin、currentMaxを超えるmax）を
    // 指定しても、`createHitPoint`等の値オブジェクト不変条件違反で例外にせず、
    // 静かに実際の可動域内へ丸める。
    // minを下限0だけでclampすると、
    // 例えば`bounds: {min: 999, max: CURRENT_MAX}`（currentMax=100）のように、
    // min自体がcurrentMaxを超えるケースを捕捉できない。minも上限currentMaxで
    // clampする。
    const min = Math.min(currentMax, Math.max(authoredMin, 0));
    // minとmaxBoundを個別に[0, currentMax]と交差させる
    // だけでは、例えば`bounds: {min: 0, max: -1}`のように交差後もmaxBound < minという
    // 空区間になりうる（min=0のまま、maxBound=-1）。maxBoundをさらにminで底上げし、
    // 交差後の区間が常に空でないことを保証する。
    const maxBound = Math.max(min, Math.min(authoredMax, currentMax));
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
      // R-TEX-03 #1: 到達経路を問わないため、リソース操作によるHP0もブレイクへ回す。
      if (requiresBreakResolution(context.exercise, updatedTarget)) {
        const resolveBreak = requireResolveBreak(
          context.resolveBreak,
          "modifyResourceEventContext.resolveBreak",
        );
        const steps = resolveBreak(
          target.battleUnitId,
          units.map((unit) => working.get(unit.battleUnitId)!),
          lastEventId,
        );
        let step = steps.next();
        while (!step.done) {
          let stepUnits = step.value.units;
          if (context.onFactEventForPassiveChain !== undefined) {
            for (const event of step.value.events) {
              stepUnits = context.onFactEventForPassiveChain(event, stepUnits);
            }
          }
          step = steps.next(stepUnits);
        }
        for (const unit of step.value.units) {
          working.set(unit.battleUnitId, unit);
        }
        lastEventId = step.value.lastEventId;
        continue;
      }
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
