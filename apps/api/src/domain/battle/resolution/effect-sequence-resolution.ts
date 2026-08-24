import { expireEffects, expireEffectsSteps } from "../effects/duration-expiry-service.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { resolveDarkness } from "../combat/hit-policy.js";
import {
  findActorUnit,
  isActorDefeated,
  requireSkillDefinitionId,
  sourceEnvelopeOf,
  type EffectActionGroupContext,
  type EffectResolutionStep,
  type UnitsBox,
} from "./effect-action/effect-action-group-context.js";
import {
  resolveActionStepBody,
  resolveRawStep,
  type LastResultState,
  type StepWalkResult,
} from "./effect-step-resolution.js";

/**
 * Issue #217設計方針B: resolverの終了状態を判別可能unionにする。`COMPLETED`/
 * `INTERRUPTED`は、実際に解決が最後まで進んだか、使用者戦闘不能で解決を
 * 打ち切ったかという事実だけから決まり、`unresolvedEffectCount`の値からは
 * 決して導出しない（`INTERRUPTED`かつ`unresolvedEffectCount: 0`の組合せを
 * 正当な結果として許容する — 例えば`EffectStepStarting`自身が誘発した
 * PS/Memory連鎖で使用者が戦闘不能になり、そのstepのACTIONが1件も開始
 * されなかった場合）。
 */
export type EffectSequenceOutcome =
  | {
      readonly status: "COMPLETED";
      /** 実際に処理したヒット・適用の総数。 */
      readonly resolvedEffectCount: number;
    }
  | {
      readonly status: "INTERRUPTED";
      readonly reason: "ACTOR_DEFEATED";
      /** 使用者が戦闘不能になる前に到達し、実際に処理したヒット・適用の総数。 */
      readonly resolvedEffectCount: number;
      /**
       * Issue #217設計方針C（案1、厳密値のみを公開）: 中断が起きた時点で実際に
       * 開いていたACTION適用一覧のうち、未処理のまま残った「効果単位」数の厳密値。
       * `countHits`（`application.hits.length`の合計）と同じ計数単位 —
       * DAMAGEは残りヒットごとに1、非DAMAGEは残りapplication（対象1件×
       * EffectAction1件、常にhits.length === 1）ごとに1として数える。
       * まだ開始していないstep・branch・iterationは、その内容を静的に
       * 見積もらず常に0として扱う（実行状態を二重に解釈する見積もり器を
       * 持たないための唯一の情報源）。
       */
      readonly unresolvedEffectCount: number;
    };

export interface EffectActionGroupsResult {
  readonly units: readonly BattleUnit[];
  readonly outcome: EffectSequenceOutcome;
}

/**
 * R-SHD-01第3項（DMG-004、Issue #194）: このEffectSequence
 * 解決で残量0のまま残ったシールドを、解決の最後に`SHIELD_DEPLETED`として失効させる。
 *
 * 対象になるのは付与時点で既に0だったシールド（Formula結果が負値・0、または
 * R-NUM-02の切り捨てで0）だけである — 吸収で枯渇した分は
 * `damage-application-service.ts`がプールごとにその場で失効させ、漸減で枯渇した分は
 * `action-completion.ts`が同じくその場で失効させるため、ここへは到達しない。
 *
 * 付与直後ではなく解決の最後に行うのは次の2点による。
 *
 * - R-EFF-09のカスケードは「その時点で存在するメンバー」しか収集できない。
 *   production例`SKL_LILY_SINGER_PS2`は同じACTION stepで`SHIELD`(PARENT)→
 *   `ATK_UP`(CHILD)の順に付与するため、付与直後に親を失効させるとCHILDがまだ
 *   存在せず、後から付与されたCHILDだけが親を失って残ってしまう
 * - PS/Memory自身のEffectSequence解決（`onFactEventForPassiveChain`未指定）では、
 *   `EffectApplied`はEffectAction完了時に`EFFECT_RESOLVED`としてdriverへ渡る。
 *   付与と同じEffectAction内で同期失効まで進めると、`EffectApplied`を契機とする
 *   PS/Memoryが「付与直後（シールドが存在する）」状態を一度も観測できない
 *
 * `stealthConsumptions`の失効（この関数の少し上）と同じ2経路の規約を持つ:
 * callbackがあればそれが除去1件ごとに通知し、無ければイベント列を
 * `EFFECT_RESOLVED`としてyieldしてdriverへ委ねる。
 */
function* sweepDepletedShields(
  box: UnitsBox,
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
): Generator<EffectResolutionStep, DomainEventId, void> {
  // R-SUB-01（DMG-005、Issue #190）: 耐久力0で付与されたサブユニットもまったく
  // 同じ理由でここへ含める（吸収で枯渇した分は`damage-application-service.ts`が
  // その場で失効させるため到達しない）。
  const seeds = box.units.flatMap((unit) =>
    unit.appliedEffects
      .filter(
        (effect) =>
          (effect.shield !== undefined && effect.shield.remaining <= 0) ||
          (effect.subUnit !== undefined && effect.subUnit.durability <= 0),
      )
      .map((effect) => ({
        battleUnitId: unit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        reason:
          effect.shield !== undefined
            ? ("SHIELD_DEPLETED" as const)
            : ("SUBUNIT_DEPLETED" as const),
      })),
  );
  if (seeds.length === 0) {
    return parentEventId;
  }
  // 除去1件ごとに`EFFECT_RESOLVED`として`yield`し、driver
  // （AS/EX・チャージ解放は`applyEffectActionGroups`、PS/Memory自身の解決は
  // `passive-activation-service.ts`の`driveActivation`）に即時連鎖の解決を委ねる。
  // `expireEffects`（同期wrapper）はステップを読み捨てるだけで通知しないため、
  // ここでcallbackを渡しても連鎖は起きず、driverの`units`も更新されない。
  const steps = expireEffectsSteps(
    {
      recorder: context.recorder,
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      rootEventId: context.rootEventId,
    },
    box.units,
    seeds,
    context.definitions.effectActions,
    parentEventId,
  );
  let step = steps.next();
  while (!step.done) {
    // driverが`box.units`を書き換える前に、このステップ時点の状態を反映しておく。
    box.units = step.value.units;
    yield { kind: "EFFECT_RESOLVED", events: step.value.events };
    step = steps.next(box.units);
  }
  box.units = step.value.units;
  return step.value.lastEventId;
}

/**
 * R-SKL-01〜R-SKL-08を通じた`EffectSequence`解決のトップレベルgenerator。
 * `plan.steps`を定義順に解決し、`ActionStepPlan`（既定計画済みACTION）は
 * `resolveActionStepBody`へ、`DeferredStepPlan`（BRANCH/RANDOM_BRANCH/REPEAT、
 * またはLAST_RESULT/LAST_*_TARGETSに依存するACTION）は`resolveRawStep`へ
 * それぞれ委譲する。戻り値は`EffectSequenceOutcome`（Issue #217設計方針B）—
 * `COMPLETED`/`INTERRUPTED`は解決が実際に最後まで進んだか、使用者戦闘不能で
 * 打ち切ったかという事実だけから決まり、`unresolvedEffectCount`の値からは
 * 決して導出しない。
 *
 * PSの`EffectSequence`自身の解決（`passive-activation-service.ts`）
 * はこのgeneratorへ`yield*`委譲することで、`resolvePassiveChain`の
 * `driveActivation`が管理する共有state（PassiveResolutionStack・深度Guard・
 * 効果解決数Guard・`interruptedCandidates`）へ正しく参加する。「親A→子PS→親B」
 * の順序（R-PS-06）と、深度/効果解決数Guardのnesting全体での一貫性の両方を
 * 満たすには、PSの`EffectSequence`自身の解決を`resolvePassiveChain`と切り離した
 * 別経路（同期callbackや、独立した`resolvePassiveChain`の再帰呼び出し）で
 * 行ってはならない — 後者は各呼び出しがstack/depth/effectsResolvedを
 * ゼロから開始してしまい、Guardが実効的にnesting全体を見なくなる。
 */
export function* resolveEffectSequencePlan(
  plan: EffectSequencePlan,
  box: UnitsBox,
  incomingContext: EffectActionGroupContext,
): Generator<EffectResolutionStep, EffectActionGroupsResult, void> {
  // R-LNK-01/02（DMG-007、Issue #187）: `APPLY_DAMAGE_LINK.linkTo`の`BINDING`は
  // 付与時点でリンク先ユニットへ解決する必要があるが、EffectAction単位の解決
  // （`resolveOneEffectActionApplication`）は`EffectSequencePlan`を受け取らない。
  // 呼び出し側すべてに解決済みbindingの引き回しを強いる代わりに、この入口で
  // contextへ載せ替えて以降の全経路へ届ける。
  const context: EffectActionGroupContext = {
    ...incomingContext,
    resolvedBindings: plan.resolvedBindings,
  };
  const lastResultState: LastResultState = {
    lastActionTargetUnitIds: [],
    lastDamagedTargetUnitIds: [],
  };
  let lastEventId = context.parentEventId;
  let resolvedCount = 0;

  // R-HIT-03/R-STS-04（M7-004、Issue #183）: スキル使用ごとに1回、使用者
  // （`context.actorUnitId`、AS/EXの実行者・PSの所有者どちらも同じ`SkillUseId`単位）
  // に付与された暗闇を判定する。命中判定より前、対象選択・step解決より前で
  // 一括判定する — いずれか一つでもMISSになれば、このEffectSequence全体の
  // step解決を一切開始しない（「MISSの場合、対象へのダメージと効果を適用
  // しない」、DAMAGE以外のEffectActionも含む）。必中を持つスキルにも適用する
  // （`accuracyMode`を一切参照しない — 呼び出し元のACTION step条件によらず
  // 一律に適用する）。
  // R-MEM-04（Issue #179）: Memory由来の解決には暗闇を持ちうる使用者が存在しない
  // （暗闇は使用者へ付与された`AppliedEffect`から判定するため、判定対象そのものが
  // 無い）。判定自体を行わず、常に命中として扱う。
  const actorForDarkness = findActorUnit(context, box);
  const darkness =
    actorForDarkness === undefined
      ? { checks: [] as const, missed: false }
      : resolveDarkness(actorForDarkness, context.random);
  if (darkness.checks.length > 0) {
    const innerEventsStart = context.recorder.getEvents().length;
    for (const check of darkness.checks) {
      const blindnessCheckResolved = context.recorder.record({
        eventType: "BlindnessCheckResolved",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        ...sourceEnvelopeOf(context),
        payload: {
          effectActionDefinitionId: check.effectActionDefinitionId,
          effectInstanceId: check.effectInstanceId,
          probability: check.probability,
          missed: check.missed,
        },
      });
      lastEventId = blindnessCheckResolved.eventId;
    }
    if (darkness.missed) {
      const skillMissed = context.recorder.record({
        eventType: "SkillMissed",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        ...sourceEnvelopeOf(context),
        payload: {
          skillDefinitionId: requireSkillDefinitionId(context),
          missedByEffectInstanceIds: darkness.checks
            .filter((check) => check.missed)
            .map((check) => check.effectInstanceId),
        },
      });
      lastEventId = skillMissed.eventId;
    }
    // ステルス消費と同じ理由（`onFactEventForPassiveChain`未指定 =
    // PS自身のEffectSequenceが`yield*`委譲されている経路）:
    // `BlindnessCheckResolved`/`SkillMissed`もFACTイベントとしてPS/Memory即時
    // 連鎖の契機になり得るため、同じ二分岐でdriverへ委ねる。
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    } else {
      const innerEvents = context.recorder.getEvents().slice(innerEventsStart);
      yield { kind: "EFFECT_RESOLVED", events: innerEvents };
    }
    if (darkness.missed) {
      return { units: box.units, outcome: { status: "COMPLETED", resolvedEffectCount: 0 } };
    }
  }

  // R-TGT-08「ステルス」（TGT-004、Issue #167）: targetBindings解決時に第一優先
  // 対象として選ばれ候補順の末尾へ移動されたStealth所持者（`AppliedEffect.
  // statusKind === "STEALTH"`）を、実際のstep解決を始める前に一括で消費する
  // （`EffectExpired`/reason:"CONSUMPTION"）。フェーズ2でMarkerState＋
  // `removeMarkers`からAppliedEffect＋`expireEffects`へ移行 — 後者は
  // `linkedEffectGroupId`カスケード・CombatStat再計算も自動で扱うため、
  // production Catalogが将来Stealthをlinked groupの一員として付与する場合も
  // 追加配線なしでR-EFF-09のカスケードが働く。
  // `context.onFactEventForPassiveChain`が未指定の場合
  // （PS自身のEffectSequenceが`passive-activation-service.ts`から`yield*`で
  // 委譲されている経路）は、同期callbackで子PS連鎖を駆動できないため、
  // 消費で発生したイベント列を他のEffectAction内部イベントと同様
  // `EFFECT_RESOLVED`としてyieldし、`resolvePassiveChain`/`driveActivation`側の
  // driverに子PS連鎖の処理を委ねる。`box`は共有可変オブジェクトのため、
  // yieldで一時停止している間にdriverが`box.units`を書き換えれば、
  // resume後の後続処理は自然に最新の`units`を参照する。
  // callbackを持つ経路では、通知は`expireEffects`が
  // 1インスタンスの失効ごとに行う（R-EFF-09カスケードで巻き込まれた
  // 子効果・子Markerを含む）。callback未指定の経路は上記のとおりdriverへ委ねる。
  if (plan.stealthConsumptions.length > 0) {
    const innerEventsStart = context.recorder.getEvents().length;
    const expiry = expireEffects(
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
      box.units,
      plan.stealthConsumptions.map((consumption) => ({
        battleUnitId: consumption.battleUnitId,
        effectInstanceId: consumption.effectInstanceId,
        reason: "CONSUMPTION",
      })),
      context.definitions.effectActions,
      lastEventId,
    );
    box.units = expiry.units;
    lastEventId = expiry.lastEventId;
    if (context.onFactEventForPassiveChain === undefined) {
      const innerEvents = context.recorder.getEvents().slice(innerEventsStart);
      if (innerEvents.length > 0) {
        yield { kind: "EFFECT_RESOLVED", events: innerEvents };
      }
    }
  }

  // 中断で抜けた場合の未解決数。`undefined`なら最後まで解決し切ったことを表す。
  // 中断の`return`を分岐ごとに書くと、step間で中断した
  // 経路（前のstepの最後のEffectActionで使用者が戦闘不能になり、後続stepが
  // 残っている場合）だけ`sweepDepletedShields`を通らず、残量0シールドが
  // `EffectExpired`なしで永続していた。全ての終了経路が必ず掃除を通るよう、
  // ループからは`break`だけで抜けて後始末と`return`を1か所に集約する。
  let interruptedUnresolvedCount: number | undefined;

  for (const step of plan.steps) {
    if (isActorDefeated(context, box)) {
      interruptedUnresolvedCount = 0;
      break;
    }

    const result: { readonly lastEventId: DomainEventId; readonly walkResult: StepWalkResult } =
      step.planKind === "ACTION_PLAN"
        ? yield* resolveActionStepBody(
            step.stepIndex,
            step.conditionKind,
            step.satisfied,
            step.actions,
            step.applications,
            box,
            context,
            lastResultState,
            lastEventId,
          )
        : yield* resolveRawStep(
            step.stepIndex,
            step.definition,
            box,
            context,
            plan,
            lastResultState,
            lastEventId,
          );

    lastEventId = result.lastEventId;
    resolvedCount += result.walkResult.resolvedCount;

    if (result.walkResult.interrupted) {
      interruptedUnresolvedCount = result.walkResult.unresolvedCount;
      break;
    }
  }

  // 正常終了・中断のどちらでも掃除する。付与自体は確定済みの状態変更であり、
  // 残量0のまま残せば期間満了まで居座る（R-SKL-01「解決済みの効果を巻き戻さない」
  // には反しない — 巻き戻しではなく、成立済みの個別消滅条件の実行である）。
  yield* sweepDepletedShields(box, context, lastEventId);

  return interruptedUnresolvedCount !== undefined
    ? {
        units: box.units,
        outcome: {
          status: "INTERRUPTED",
          reason: "ACTOR_DEFEATED",
          resolvedEffectCount: resolvedCount,
          unresolvedEffectCount: interruptedUnresolvedCount,
        },
      }
    : { units: box.units, outcome: { status: "COMPLETED", resolvedEffectCount: resolvedCount } };
}
