import type { EffectActionGroupContext } from "../../domain/battle/resolution/effect-action-group-resolver.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { DomainEventId } from "../../domain/shared/event-ids.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { noMissNoCrit } from "./random.js";

export interface EffectActionGroupContextOptions {
  readonly actor: BattleUnit;
  readonly skillId: string;
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly rootEventId: DomainEventId;
  /** 省略時は命中・非会心へ倒す決定的乱数列（`noMissNoCrit`）。 */
  readonly random?: RandomSource;
  /** PS連鎖trigger情報など、標準形に無いフィールドを最後に重ねる。 */
  readonly extras?: Partial<EffectActionGroupContext>;
}

/**
 * `applyEffectActionGroups` 直呼びテストの標準context（ターン1・サイクル0、
 * seedイベントを根とする因果連鎖）。`skillUseId`/`actionScope` はrecorderから
 * 採番するため、この関数の呼び出し順がID列へ反映される。
 */
export function effectActionGroupContext(
  options: EffectActionGroupContextOptions,
): EffectActionGroupContext {
  return {
    definitions: options.definitions,
    actorUnitId: options.actor.battleUnitId,
    random: options.random ?? noMissNoCrit(),
    recorder: options.recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: options.recorder.nextSkillUseId(),
    actionScope: options.recorder.nextResolutionScopeId(),
    rootEventId: options.rootEventId,
    parentEventId: options.rootEventId,
    skillDefinitionId: createSkillDefinitionId(options.skillId),
    ...options.extras,
  };
}

/** 指定EffectActionの `EffectActionCompleted` が報告した対象IDを発生順に集める。 */
export function completedTargetIdsOf(
  recorder: EventRecorder,
  effectActionDefinitionId: string,
): readonly string[] {
  return recorder
    .getEvents()
    .filter(
      (event) =>
        event.eventType === "EffectActionCompleted" &&
        (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          effectActionDefinitionId,
    )
    .flatMap((event) => (event.payload as { targetUnitIds: readonly string[] }).targetUnitIds);
}
