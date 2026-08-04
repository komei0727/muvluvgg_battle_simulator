import { grantEffect } from "../../effects/effect-grant-service.js";
import { grantStunStatus } from "../../effects/stun-grant-service.js";
import { grantFreezeStatus } from "../../effects/freeze-grant-service.js";
import { requireUnit } from "../action-resolution-shared.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { StatusKind } from "../../../catalog/definitions/catalog-enums.js";
import type { AppliedEffect } from "../../model/applied-effect.js";
import type { DomainEventId } from "../../../shared/event-ids.js";
import {
  findImmunityBlock,
  recordImmunityRejection,
  settledOutcome,
  type EffectActionHandlerInput,
  type EffectActionResolution,
  type SteppedEffectActionHandler,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf } from "./effect-action-group-context.js";
import { buildConsumeEffectDurationHooks } from "./effect-duration-consumption.js";

/**
 * `APPLY_STATUS`の`status`のうち、resolverが実効処理まで配線済みのもの。この許可リストは
 * Capability経由ではなくここでハードコードしており、未配線のstatusを「付与だけされて何も
 * 起きない」silent partial implementationへ退行させないための門である。
 *
 * DMG-003A（`CRITICAL_GUARANTEE`/`CRITICAL_PREVENTION`、R-CRT-03）が最後の2種を配線した
 * ため、現時点では`StatusKind`の全値が`true`である。`Record`で網羅を要求しているのは
 * そのためで、`StatusKind`へ新しい値を足したときにここがコンパイルエラーになり、実効処理の
 * 配線漏れに気付ける。
 */
const SUPPORTED_APPLY_STATUS_KINDS: Readonly<Record<StatusKind, true>> = {
  STEALTH: true,
  STUN: true,
  EVASION: true,
  BLIND: true,
  DAMAGE_IMMUNITY: true,
  FREEZE: true,
  HIT_EVASION: true,
  GUARANTEED_HIT: true,
  CRITICAL_GUARANTEE: true,
  CRITICAL_PREVENTION: true,
  CONFUSION: true,
  DAMAGE_TO_HEAL: true,
};

/**
 * 保持者の攻撃側（OUTGOING）にだけ働くstatusは、被効果側のfield
 * （`appliesTo.incomingActionKinds`・`damageThreshold`・`damageAmplificationOnBreak`）を
 * 解釈する余地がない。付与確率もこれらの経路が参照しないため、1未満を受け取ると
 * 「必ず付与される状態」へ黙って退行する。該当のproduction定義はいずれもこれらを
 * 宣言しないため、未対応として明確に失敗させ、silent partial implementationへ
 * 退行させない。
 */
function rejectUnsupportedOutgoingStatusFields(
  input: EffectActionHandlerInput<"APPLY_STATUS">,
  status: StatusKind,
  rule: string,
  options: { readonly probabilityMustBeOne: boolean },
): void {
  const payload = input.effectAction.payload;
  const declaresIncomingFields =
    payload.appliesTo !== undefined ||
    payload.damageThreshold !== undefined ||
    payload.damageAmplificationOnBreak !== undefined;
  const declaresPartialProbability =
    options.probabilityMustBeOne && payload.probability !== undefined && payload.probability < 1;
  if (!declaresIncomingFields && !declaresPartialProbability) {
    return;
  }
  throw new DomainValidationError(
    "effectActionDefinitionId",
    `APPLY_STATUS status "${status}" with appliesTo/damageThreshold/damageAmplificationOnBreak${
      options.probabilityMustBeOne ? " or probability < 1" : ""
    } is not supported (${rule})`,
  );
}

/** R-STS-03/04が要求する未対応fieldの門。上記のOUTGOING系とはメッセージだけが異なる。 */
function rejectUnsupportedStunFields(input: EffectActionHandlerInput<"APPLY_STATUS">): void {
  const payload = input.effectAction.payload;
  if (
    payload.appliesTo !== undefined ||
    payload.damageThreshold !== undefined ||
    payload.damageAmplificationOnBreak !== undefined ||
    (payload.probability !== undefined && payload.probability < 1)
  ) {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      'APPLY_STATUS status "STUN" with appliesTo/damageThreshold/damageAmplificationOnBreak or probability < 1 is not yet supported (R-STS-03/04 scope; production STUN definitions only use an omitted or 1 probability)',
    );
  }
}

/**
 * R-EFF-03: 免疫がこの状態付与をブロックした場合の経路。R-EFF-07「STATUS_BLOCKED は、
 * 効果ownerへの状態付与が無効化された時点で消費する」により、拒否の後に対象が保持する
 * `STATUS_BLOCKED`消費条件付き効果の消費が続く（`duration-expiry-service.ts`と同じ
 * 「消費0で即時失効」規約）。この追加の状態遷移があるため、他kindが共有する
 * `rejectIfImmune`ではなくこの専用経路を通る。
 */
function* rejectStatusApplication(
  input: EffectActionHandlerInput<"APPLY_STATUS">,
  blockingEffect: AppliedEffect,
): EffectActionResolution {
  const { context, box, application, cursor } = input;
  const status = input.effectAction.payload.status;
  const rejection = recordImmunityRejection(input, blockingEffect, status);
  box.units = rejection.units;

  const { consumeEffectDuration } = buildConsumeEffectDurationHooks(context);
  const consumptionGen = consumeEffectDuration(
    application.targetUnitId,
    "STATUS_BLOCKED",
    box.units,
    rejection.lastEventId,
  );
  // 消費より前に記録済みの`EffectApplicationRejected`は状態変更前に通知しておく。
  cursor.notifyPending();

  // 消費失効はステップ単位のgeneratorのため、ここでも1ステップずつ駆動する —
  // callbackがあればそのステップのイベントをその場で通知し、無ければ
  // `EFFECT_RESOLVED`としてyieldしてdriverへ委ねる。
  const callback = context.onFactEventForPassiveChain;
  let consumptionStep = consumptionGen.next();
  while (!consumptionStep.done) {
    box.units = consumptionStep.value.units;
    if (callback !== undefined) {
      for (const event of consumptionStep.value.events) {
        box.units = callback(event, box.units);
      }
      cursor.consumeNotifiedByCallee();
    } else {
      yield { kind: "EFFECT_RESOLVED", events: cursor.takePending() };
    }
    consumptionStep = consumptionGen.next(box.units);
  }
  const consumption = consumptionStep.value;
  box.units = consumption.units;
  return settledOutcome(input, consumption.lastEventId, "REJECTED");
}

/**
 * R-STS-02/R-SKL-05「付与時にチャージをキャンセルする」: STUN付与が実際に成立した
 * （新規付与、またはより長い残り回数への差し替え）対象が発動待ちのチャージを持つ場合、
 * その場でキャンセルする。既存STUNが新しい付与以上の残り回数で維持された場合
 * （`grantStunStatus`が`existing`をそのまま返す、実質no-op）はチャージへ触れない。
 */
function cancelChargeOnStun(
  input: EffectActionHandlerInput<"APPLY_STATUS">,
  lastEventId: DomainEventId,
): DomainEventId {
  const { context, box, application } = input;
  const stunnedTarget = requireUnit(box.units, application.targetUnitId);
  if (stunnedTarget.charge === undefined) {
    return lastEventId;
  }
  const charge = stunnedTarget.charge;
  const cancelled = context.recorder.record({
    eventType: "ChargeCancelled",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: stunnedTarget.battleUnitId,
    targetUnitIds: [stunnedTarget.battleUnitId],
    payload: {
      actorUnitId: stunnedTarget.battleUnitId,
      skillDefinitionId: charge.skill.skillDefinitionId,
      startedActionId: charge.startedActionId,
      reason: "STUN",
    },
    stateDelta: {
      units: {
        [stunnedTarget.battleUnitId]: {
          charge: {
            before: {
              skillDefinitionId: charge.skill.skillDefinitionId,
              startedActionId: charge.startedActionId,
            },
            after: undefined,
          },
        },
      },
    },
  });
  box.units = box.units.map((unit) => {
    if (unit.battleUnitId !== stunnedTarget.battleUnitId) {
      return unit;
    }
    const { charge: _charge, ...withoutCharge } = unit;
    return withoutCharge;
  });
  if (context.onFactEventForPassiveChain !== undefined) {
    box.units = context.onFactEventForPassiveChain(cancelled, box.units);
  }
  return cancelled.eventId;
}

/**
 * R-ACTN-03: `AppliedEffect.statusKind`を付与する。実効処理を持つstatus種別だけを
 * {@link SUPPORTED_APPLY_STATUS_KINDS}で許可し、未配線の種別は明確に拒否する
 * （`status`自体で判定する — `probability`/`appliesTo`/`damageThreshold`等の追加fieldの
 * 有無だけで判定すると、`ACT_CHIZURU_DOMESTIC_AS1_STUN`のように追加fieldを持たない定義が
 * 実効なしのまま`grantEffect`まで進んでしまうため）。
 *
 * R-EFF-03: 免疫拒否は「未対応status種別」の拒否より優先する — 対象が有効な免疫を持つなら、
 * そのstatus種別がまだ実効処理を持つかどうかに関係なく`EffectApplicationRejected`が
 * 正しい結果になる。
 *
 * 現行production定義は`stacking`相当の設定を持たない（`ApplyStatusPayload`自体に
 * `stacking`フィールドが無い）ため、`APPLY_STAT_MOD`と同じ理由で`duplicate: true`に
 * 固定する（Q-EFF-10「重複あり・重複なしのどちらも、効果インスタンスと効果期間を個別に
 * 保持する」）。R-STS-02の再付与規則（残り回数が長い方を一つだけ残す）を持つSTUNだけ
 * `grantStunStatus`（`stun-grant-service.ts`）へ、R-STS-03のFREEZEだけ
 * `grantFreezeStatus`へ分岐する。
 */
export const resolveApplyStatus: SteppedEffectActionHandler<"APPLY_STATUS"> = function* (input) {
  const { context, box, application, effectAction, startingEventId, cursor } = input;
  const status = effectAction.payload.status;

  const blockingImmunity = findImmunityBlock(input, 0, status);
  if (blockingImmunity !== undefined) {
    return yield* rejectStatusApplication(input, blockingImmunity);
  }

  if (SUPPORTED_APPLY_STATUS_KINDS[status] !== true) {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `APPLY_STATUS status "${status}" is not supported by this resolver (each status kind requires its own runtime behavior)`,
    );
  }
  if (status === "CRITICAL_GUARANTEE" || status === "CRITICAL_PREVENTION") {
    // R-CRT-03（DMG-003A）: 会心保証・会心不可はどちらも保持者の攻撃側に働く効果であり、
    // production定義（`ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE`は`probability`省略、
    // `ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION`・
    // `ACT_ANIS_TROUBLEMAKER_PS2_CRIT_PREVENTION`は`probability: 1`）はいずれも
    // 未対応fieldを宣言しない。
    rejectUnsupportedOutgoingStatusFields(
      input,
      status,
      "R-CRT-03 applies to the holder's outgoing attacks; production critical status definitions declare none of them",
      { probabilityMustBeOne: true },
    );
  }
  if (status === "CONFUSION" || status === "DAMAGE_TO_HEAL") {
    // R-CFS-01/02・R-DTH-01（DMG-009）: 混乱・幻惑も保持者の攻撃側に働く効果である。
    // production定義（`ACT_OLGA_VETERAN_EX_CONFUSION`・`ACT_TATIANA_SAGE_AS1_DAZZLE`）は
    // いずれも該当しない。
    rejectUnsupportedOutgoingStatusFields(
      input,
      status,
      "R-CFS-01/R-DTH-01 apply to the holder's outgoing attacks; production confusion/damage-to-heal definitions declare none of them",
      { probabilityMustBeOne: true },
    );
  }
  if (status === "GUARANTEED_HIT") {
    // R-HIT-05（M7-018）: 必中付与は使用者側の効果であり、production定義
    // （`ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT`）は未対応fieldを持たない。
    // 付与確率はこの経路が解釈できるため、1未満でも拒否しない。
    rejectUnsupportedOutgoingStatusFields(
      input,
      status,
      "R-HIT-05 applies to the holder's outgoing attacks; production GUARANTEED_HIT definitions declare none of them",
      { probabilityMustBeOne: false },
    );
  }
  if (status === "STUN") {
    rejectUnsupportedStunFields(input);
  }

  // R-HIT-02（M7-004）: EVASIONは判定時（`hit-policy.ts`の`resolveEvasion`）に
  // `probability`/`appliesTo`を参照するため、Catalog payloadの残りfieldを
  // `AppliedEffect.statusDetails`として保持する。
  // R-CFS-02／R-DTH-01（DMG-009）: 混乱倍率・基礎ダメージ差し替え率・回復変換率は、
  // 付与時ではなく`damage-application-service.ts`（combat層）が読む。`damageThreshold`と
  // 同じ理由でインスタンス側へ運ぶ。
  const payload = effectAction.payload;
  const statusDetails =
    payload.probability !== undefined ||
    payload.appliesTo !== undefined ||
    payload.damageAmplificationOnBreak !== undefined ||
    payload.damageThreshold !== undefined ||
    payload.confusion !== undefined ||
    payload.damageToHeal !== undefined
      ? {
          ...(payload.probability !== undefined ? { probability: payload.probability } : {}),
          ...(payload.appliesTo !== undefined ? { appliesTo: payload.appliesTo } : {}),
          ...(payload.damageAmplificationOnBreak !== undefined
            ? { damageAmplificationOnBreak: payload.damageAmplificationOnBreak }
            : {}),
          ...(payload.damageThreshold !== undefined
            ? { damageThreshold: payload.damageThreshold }
            : {}),
          ...(payload.confusion !== undefined ? { confusion: payload.confusion } : {}),
          ...(payload.damageToHeal !== undefined ? { damageToHeal: payload.damageToHeal } : {}),
        }
      : undefined;

  const grantContext = eventContextOf(context);
  const grantRequest = {
    definition: effectAction,
    ...grantSourceOf(context),
    targetUnitId: application.targetUnitId,
    duplicate: true,
    magnitude: 0,
    statusKind: status,
    ...(statusDetails !== undefined ? { statusDetails } : {}),
    durationDefinition: payload.duration,
  };
  const grantResult =
    status === "STUN"
      ? grantStunStatus(grantContext, box.units, grantRequest, startingEventId)
      : status === "FREEZE"
        ? grantFreezeStatus(grantContext, box.units, grantRequest, startingEventId)
        : grantEffect(grantContext, box.units, grantRequest, startingEventId);
  box.units = grantResult.units;
  cursor.notifyPending();

  const lastEventId =
    status === "STUN"
      ? cancelChargeOnStun(input, grantResult.lastEventId)
      : grantResult.lastEventId;
  return settledOutcome(input, lastEventId, "APPLIED");
};
