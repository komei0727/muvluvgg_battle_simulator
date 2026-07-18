import type { BattleUnit } from "../model/battle-unit.js";
import { manipulateCooldown } from "../model/cooldown-state.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ApplyCooldownManipulationActionResult {
  readonly units: readonly BattleUnit[];
  /** R-SKL-09: 対象スキルがREADY(no-op)で`CooldownReduced`を発行しなかった場合は`false`。 */
  readonly changed: boolean;
  /**
   * PR #142レビュー[P2]: 実際に記録された最後のイベントID（`CooldownReduced`、
   * `after === 0`なら続く`CooldownCompleted`）。`changed`が`false`の場合は
   * `context.parentEventId`のまま変化しない。
   */
  readonly lastEventId: DomainEventId;
}

/** `CooldownReduced`/`CooldownCompleted`が共有する因果関係コンテキスト。 */
export interface CooldownManipulationEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  /** CTを操作するスキルの使用者（自然減算時の`sourceUnitId`と同じ役割）。 */
  readonly sourceUnitId: BattleUnitId;
  /** R-SKL-06 #5: `CooldownReduced`/`CooldownCompleted`確定直後にPS即時連鎖を解決するフック（`applyDamageAction`と同じ役割）。未指定ならPS解決を行わない。 */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

function findUnit(
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
  id: BattleUnitId,
  path: string,
): BattleUnit {
  const unit = units.get(id);
  if (unit === undefined) {
    throw new DomainValidationError(path, `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

/**
 * Issue #129 `COOLDOWN_MANIPULATION`: 対象BattleUnit自身の`CooldownMap`に対して
 * RESET/REDUCEを適用する。`recordActionCompletion`（自然減算）が発行する
 * `CooldownReduced`/`CooldownCompleted`と同じイベント形・`StateDelta`形を使う
 * ことで、`state-delta-reducer.ts`が原因を区別せずに再生できるようにする。
 * READY/未登録スキルへの操作は`manipulateCooldown`がno-opとして扱い、
 * イベントを発行しない。
 */
export function applyCooldownManipulationAction(
  hits: readonly ResolvedEffectApplication[],
  action: Extract<EffectActionDefinition, { kind: "COOLDOWN_MANIPULATION" }>,
  units: readonly BattleUnit[],
  context: CooldownManipulationEventContext,
): ApplyCooldownManipulationActionResult {
  let working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  let lastEventId = context.parentEventId;
  let changed = false;

  function chain(event: BattleDomainEvent): void {
    if (context.onFactEventForPassiveChain === undefined) {
      return;
    }
    const updatedUnits = context.onFactEventForPassiveChain(event, Array.from(working.values()));
    working = new Map(updatedUnits.map((unit) => [unit.battleUnitId, unit]));
  }

  for (const hit of hits) {
    const target = findUnit(working, hit.targetBattleUnitId, "hits[].targetBattleUnitId");
    const result = manipulateCooldown(
      target.cooldowns,
      action.payload.targetSkillDefinitionId,
      action.payload.operation,
      action.payload.amount,
    );
    if (result.change === undefined) {
      continue;
    }
    changed = true;
    const change = result.change;
    working.set(target.battleUnitId, { ...target, cooldowns: result.cooldowns });

    const reduced = context.recorder.record({
      eventType: "CooldownReduced",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.sourceUnitId,
      targetUnitIds: [target.battleUnitId],
      payload: {
        actorUnitId: target.battleUnitId,
        skillDefinitionId: change.skillDefinitionId,
        unit: change.unit,
        before: change.before,
        after: change.after,
      },
      stateDelta: {
        units: {
          [target.battleUnitId]: {
            cooldowns: {
              [change.skillDefinitionId]: {
                unit: change.unit,
                before: change.before,
                after: change.after,
              },
            },
          },
        },
      },
    });
    lastEventId = reduced.eventId;
    chain(reduced);

    if (change.after === 0) {
      const completed = context.recorder.record({
        eventType: "CooldownCompleted",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        sourceUnitId: context.sourceUnitId,
        targetUnitIds: [target.battleUnitId],
        payload: {
          actorUnitId: target.battleUnitId,
          skillDefinitionId: change.skillDefinitionId,
          unit: change.unit,
        },
      });
      lastEventId = completed.eventId;
      chain(completed);
    }
  }

  return { units: units.map((unit) => working.get(unit.battleUnitId)!), changed, lastEventId };
}
