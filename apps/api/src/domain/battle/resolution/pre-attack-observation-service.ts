import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { PreAttackObservation } from "../skill/skill-resolution-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DamageType, SkillType } from "../../catalog/definitions/catalog-enums.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";

/** `UnitBeingAttacked`（R-ATM-03）1件を発行するのに必要な因果・識別情報。 */
export interface PreAttackObservationContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /** スキル種別へ帰属する経路（AS/EX・チャージ解放・PS）だけが持つ。 */
  readonly skillType?: SkillType;
  /** 攻撃側ユニット。使用者BattleUnitを持たないMemory（R-MEM-04）では`undefined`。 */
  readonly attackerUnitId?: BattleUnitId;
  /** Memory経路（`attackerUnitId`を持たない）が代わりに載せる発生源陣営。 */
  readonly sourceSide?: Side;
}

/**
 * R-ATM-03 #7: 前段フェーズまでに攻撃側が保持している追撃ライダー（R-FUP-01、
 * `isFollowUpAttack`）が追加するダメージ型を、各観測の`damageTypes`へ足し込む。
 *
 * ライダー自身の捕捉（`FollowUpAttackCapture`）はヒットが命中判定へ到達した時点で
 * 起きるため観測時にはまだ空である。観測時点で判定できる同じ集合＝保持者の
 * `AppliedEffect`から引き直す（捕捉と同じ`isFollowUpAttack`だけを見るため、
 * 実際に相乗りするライダーの集合と一致する）。攻撃側を持たない経路（Memory）と
 * ライダー0件の経路では`observations`をそのまま返す。
 */
export function withFollowUpRiderDamageTypes(
  observations: readonly PreAttackObservation[],
  attacker: BattleUnit | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
): readonly PreAttackObservation[] {
  if (attacker === undefined || observations.length === 0) {
    return observations;
  }
  const riderDamageTypes: DamageType[] = [];
  for (const effect of attacker.appliedEffects) {
    if (effect.isFollowUpAttack !== true) {
      continue;
    }
    const definition = effectActions.get(effect.effectActionDefinitionId);
    if (definition?.kind !== "APPLY_FOLLOW_UP_ATTACK") {
      continue;
    }
    const damageType = definition.payload.damage.damageType;
    if (!riderDamageTypes.includes(damageType)) {
      riderDamageTypes.push(damageType);
    }
  }
  if (riderDamageTypes.length === 0) {
    return observations;
  }
  return observations.map((observation) => ({
    targetUnitId: observation.targetUnitId,
    damageTypes: [
      ...observation.damageTypes,
      ...riderDamageTypes.filter((damageType) => !observation.damageTypes.includes(damageType)),
    ],
  }));
}

/**
 * R-ATM-03 #4: 発行の時点で戦闘不能である対象へは発行しない（`R-ACTN-01` #2と
 * 同じ扱い）。1回のスキル使用の観測はすべて記録してから候補解決するため、
 * 判定は観測を発行する直前の`units`で行う。
 */
export function shouldObserve(units: readonly BattleUnit[], targetUnitId: BattleUnitId): boolean {
  const target = units.find((unit) => unit.battleUnitId === targetUnitId);
  return target !== undefined && !isDefeated(target);
}

/** {@link emitPreAttackObservations}の結果。 */
export interface PreAttackObservationResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /**
   * R-ATM-03 #5: 観測の候補解決で使用者が戦闘不能になったため、効果処理フェーズへ
   * 進まないこと。呼び出し側はスキル使用を中断する。
   */
  readonly interrupted: boolean;
}

/**
 * R-ATM-03 #1〜#5: 前段フェーズの攻撃前観測を、同期callback経路（AS/EX使用・
 * チャージ解放）から駆動する。全対象の観測を発行順に記録してから、1回のスキル使用の
 * 発動機会としてまとめて候補解決へ渡す（`onPreAttackObservationsForPassiveChain`）。
 * 候補は全対象を通して集約・選択するため、観測の途中でPSを発動させない。
 *
 * PS/Memory自身のEffectSequence解決（generator経路）は同期callbackを呼べない
 * ため、この関数ではなく`recordPreAttackObservation`／`shouldObserve`を直接使い、
 * 進行中の`resolvePassiveChain`へ`PRE_ATTACK_OBSERVATIONS`としてyieldする。
 */
export function emitPreAttackObservations(
  context: PreAttackObservationContext,
  observations: readonly PreAttackObservation[],
  units: readonly BattleUnit[],
  attackerUnitId: BattleUnitId,
  /**
   * 追撃ライダー（R-FUP-01）の型を`damageTypes`へ足す場合にだけ渡す。捕捉を行うのは
   * AS/EXスキル使用とチャージ解放だけのため、PS・Memoryでは`undefined`を渡す。
   */
  followUpRiderEffectActions:
    | ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>
    | undefined,
  parentEventId: DomainEventId,
  onPreAttackObservationsForPassiveChain: (
    events: readonly BattleDomainEvent[],
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[],
): PreAttackObservationResult {
  let lastEventId = parentEventId;
  const withRiders =
    followUpRiderEffectActions === undefined
      ? observations
      : withFollowUpRiderDamageTypes(
          observations,
          units.find((unit) => unit.battleUnitId === attackerUnitId),
          followUpRiderEffectActions,
        );
  const recorded: BattleDomainEvent[] = [];
  for (const observation of withRiders) {
    if (!shouldObserve(units, observation.targetUnitId)) {
      continue;
    }
    const event = recordPreAttackObservation(context, observation, lastEventId);
    lastEventId = event.eventId;
    recorded.push(event);
  }
  if (recorded.length === 0) {
    return { units, lastEventId, interrupted: false };
  }
  const working = onPreAttackObservationsForPassiveChain(recorded, units);
  // R-ATM-03 #5: 使用者が戦闘不能になった場合だけ打ち切る。観測**対象**が
  // 戦闘不能になった場合は効果処理を続行する（DAMAGEの適用可否は
  // R-ACTN-01 #2が処理する）。
  const attacker = working.find((unit) => unit.battleUnitId === attackerUnitId);
  return {
    units: working,
    lastEventId,
    interrupted: attacker === undefined || isDefeated(attacker),
  };
}

/** R-ATM-03 #1: 1対象ぶんの攻撃前観測（`UnitBeingAttacked`）を記録する。 */
export function recordPreAttackObservation(
  context: PreAttackObservationContext,
  observation: PreAttackObservation,
  parentEventId: DomainEventId,
): BattleDomainEvent {
  return context.recorder.record({
    eventType: "UnitBeingAttacked",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    ...(context.attackerUnitId !== undefined ? { sourceUnitId: context.attackerUnitId } : {}),
    ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
    targetUnitIds: [observation.targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      targetUnitId: observation.targetUnitId,
      ...(context.skillType === undefined ? {} : { skillType: context.skillType }),
      damageTypes: observation.damageTypes,
    },
  });
}
