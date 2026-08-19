import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { effectKindKeyFromDefinitionId } from "../../domain/battle/model/applied-effect.js";
import type { AppliedEffect } from "../../domain/battle/model/applied-effect.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import { effectActionFrom } from "../fixtures/index.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";
import { seedRecorder } from "../fixtures/event-seed.js";
import { productionBoard, SUBJECT_ID, type BoardOverrides } from "./skill-behaviour.js";

/**
 * R-CRT-04（対象HP割合ダメージの会心不可）をユニット効果軸で見るためのハーネス。
 *
 * `-001` の振る舞い表はHP差分までしか見ず、`observeDamageProbe` は合成の
 * `SKILL_POWER` 定義を撃つため、どちらも「**実定義**の会心判定が何になったか」を
 * 表せない。ここは実 `DAMAGE` 定義をそのまま `applyDamageAction` へ通し、
 * `CriticalCheckResolved`／`DamageCalculated` が運んだ会心の結末を返す。
 *
 * 会心が起きうる条件へ盤面を倒す（会心率100%、さらに使用者が実効モードを
 * `GUARANTEED` へ押し上げる `CRITICAL_GUARANTEE` を保持）。この状態でも会心しない
 * ことが、規則が乱数でも状態効果でもなく**定義の形**で決まっていることを示す。
 */
const GUARANTEE_EFFECT_ID = "ACT_TEST_CRITICAL_GUARANTEE";

export interface TargetHpRatioCriticalObservation {
  /** `CriticalCheckResolved` が通知した実効会心モード。 */
  readonly criticalMode: string;
  readonly isCritical: boolean;
  /** `DamageCalculated` が確定値として運んだ会心倍率。 */
  readonly criticalMultiplier: number;
  /** この1ヒットが消費した乱数の本数。会心判定を行えば1本増える。 */
  readonly randomDraws: number;
}

export interface TargetHpRatioCriticalProbeOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly unitDefinitionId: string;
  readonly effectActionDefinitionId: string;
  /** 実定義の出どころ。`DamageEventContext` が要求する。 */
  readonly skillDefinitionId: string;
  /**
   * 使用者へ `CRITICAL_GUARANTEE` を持たせるか。既定 `true`。会心率100%だけでは
   * 実効モードが `NORMAL` のままなので、`false` にすると会心判定が乱数を1本消費する
   * （`randomDraws` の対照はこちらを使う）。
   */
  readonly attackerHoldsCriticalGuarantee?: boolean;
  readonly board?: BoardOverrides;
  /** 既定は `enemy:front`。 */
  readonly targetUnitId?: string;
  readonly battleId?: string;
}

function criticalGuarantee(holderId: BattleUnit["battleUnitId"]): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(GUARANTEE_EFFECT_ID);
  return {
    effectInstanceId: createEffectInstanceId("EFF_TEST_CRITICAL_GUARANTEE"),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: holderId,
    targetUnitId: holderId,
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "CRITICAL_GUARANTEE",
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

export function observeTargetHpRatioCritical(
  options: TargetHpRatioCriticalProbeOptions,
): TargetHpRatioCriticalObservation {
  const board = productionBoard(options.snapshot, options.unitDefinitionId, {
    ...options.board,
    combatStats: { criticalRate: 1, ...options.board?.combatStats },
  });
  const definition = effectActionFrom(options.snapshot, options.effectActionDefinitionId);
  if (definition.kind !== "DAMAGE") {
    throw new Error(`${options.effectActionDefinitionId} is not a DAMAGE EffectAction`);
  }

  const attacker: BattleUnit =
    options.attackerHoldsCriticalGuarantee === false
      ? board.subject
      : {
          ...board.subject,
          appliedEffects: [
            ...board.subject.appliedEffects,
            criticalGuarantee(board.subject.battleUnitId),
          ],
        };
  const units = board.units.map((unit) =>
    unit.battleUnitId === attacker.battleUnitId ? attacker : unit,
  );
  const targetUnitId = options.targetUnitId ?? "enemy:front";
  const target = units.find((unit) => String(unit.battleUnitId) === targetUnitId);
  if (target === undefined) {
    throw new Error(`target "${targetUnitId}" is not on the board`);
  }

  // 命中判定が何本消費するかは定義の`accuracy`次第なので、余裕を持った列を渡して
  // 実消費本数を数える（`assertFullyConsumed`では会心の1本を切り分けられない）。
  const random = new SequenceRandomSource(new Array<number>(16).fill(0.99));
  const seeded = seedRecorder(options.battleId ?? "B_CRT04_PROBE");
  applyDamageAction(
    attacker,
    [
      {
        targetUnitId: target.battleUnitId,
        effectActionDefinitionId: definition.effectActionDefinitionId,
        hitIndex: 1,
      },
    ],
    definition,
    units,
    random,
    {
      recorder: seeded.recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId: seeded.recorder.nextActionId(),
      skillUseId: seeded.recorder.nextSkillUseId(),
      resolutionScopeId: seeded.resolutionScopeId,
      rootEventId: seeded.rootEventId,
      parentEventId: seeded.rootEventId,
      skillDefinitionId: createSkillDefinitionId(options.skillDefinitionId),
    },
  );

  const events = seeded.recorder.getEvents();
  const criticalCheck = events.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "CriticalCheckResolved" }> =>
      event.eventType === "CriticalCheckResolved",
  );
  const calculated = events.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
      event.eventType === "DamageCalculated",
  );
  if (criticalCheck === undefined || calculated === undefined) {
    throw new Error("the probe hit did not reach a critical check / damage calculation");
  }

  return {
    criticalMode: String(criticalCheck.payload.mode),
    isCritical: criticalCheck.payload.result,
    criticalMultiplier: calculated.payload.criticalMultiplier,
    randomDraws: random.callCount,
  };
}

export { SUBJECT_ID };
