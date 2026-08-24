import {
  findBlockingImmunity,
  rejectEffectApplication,
} from "../../effects/effect-immunity-service.js";
import {
  evaluateFormula,
  damageResultsFor,
  type FormulaEvaluationContext,
} from "../../skill/formula-evaluator.js";
import { requireUnit } from "../action-resolution-shared.js";
import type { EffectActionApplication } from "../../skill/skill-resolution-service.js";
import type { AppliedEffect } from "../../model/applied-effect.js";
import type { EffectActionDefinition } from "../../../catalog/definitions/effect-action-definition.js";
import type { FormulaDefinition } from "../../../catalog/definitions/formula-definition.js";
import type { StatusKind } from "../../../catalog/definitions/catalog-enums.js";
import type { DomainEventId } from "../../../shared/event-ids.js";
import type { BattleDomainEvent, EffectActionResultKind } from "../../events/domain-event.js";
import type { BattleUnit } from "../../model/battle-unit.js";
import {
  eventContextOf,
  findActorUnit,
  grantSourceOf,
  type EffectActionGroupContext,
  type EffectResolutionStep,
  type UnitsBox,
} from "./effect-action-group-context.js";

/** `EffectActionDefinition`が取りうるkindの全集合。ハンドラ網羅を型で強制するキーになる。 */
export type EffectActionKind = EffectActionDefinition["kind"];

/**
 * 1つの`EffectActionApplication`（対象1件×EffectAction1件）を適用した結果。
 * ディスパッチャ（`effect-action-group-resolver.ts`の
 * `resolveOneEffectActionApplication`）がこれを`EffectActionCompleted`と
 * `OneApplicationResult`へそのまま写す。
 */
export interface EffectActionOutcome {
  readonly resultKind: EffectActionResultKind;
  /** 実際に処理したヒット・適用の数。 */
  readonly resolvedCount: number;
  /** 使用者戦闘不能で処理し切れずに残ったヒット数（中断を起こさないkindは常に0）。 */
  readonly interruptedCount: number;
  /** このapplicationで実際に適用された会心ヒット数（DAMAGE以外は常に0）。 */
  readonly criticalHitCount: number;
  /**
   * `EffectActionCompleted.parentEventId`が指すべきイベント。`EffectActionStarting`
   * 固定ではなく、そのkindが実際に記録した最後のイベント（`DamageApplied`/
   * `UnitDefeated`/`CooldownCompleted`等）である必要がある。
   */
  readonly lastEventId: DomainEventId;
}

/**
 * `EffectActionCompleted`と同じ`EFFECT_RESOLVED`へ含める「内部イベント」の管理。
 *
 * PS自身のEffectSequence解決（`context.onFactEventForPassiveChain`未指定）では、
 * ヒット単位フックが働かない代わりに各kindが発行した内部イベント
 * （`EffectApplied`/`HitConfirmed`〜`DamageApplied`等）を`EffectActionCompleted`と
 * 同じ`EFFECT_RESOLVED`へまとめて含める — これらを契機とする子PSが、呼び出し元が
 * 次のEffectActionへ進む前に完全に解決されるようにするためである。AS/EX・チャージ
 * 解放（`onFactEventForPassiveChain`指定あり）では同じイベントを既にヒット単位で
 * 同期解決済みのため、二重処理を避けて`innerEvents`は常に空になる。
 *
 * DAMAGE/HEALのカスケードやREMOVE_*の逐次通知のように、ハンドラ自身が途中で
 * 通知（またはdriverへ`yield`）した分は捕捉位置を前進させ、一括捕捉から除く。
 */
export interface EffectActionEventCursor {
  /**
   * callback経路でのみ、未通知イベントをPS/Memory即時連鎖へ転送し
   * （`box.units`をその場で最新化する）、捕捉位置を前進させる。callback未指定の
   * 経路では何もしない — 同じイベントを{@link innerEvents}がdriverへ届けるためである。
   */
  notifyPending(): void;
  /**
   * 呼び先のサービスへcallbackを渡した場合に、そのサービスが既に通知済みのイベントを
   * 一括捕捉から除く。callback未指定の経路では何もしない — その経路では通知自体が
   * 起きておらず、{@link innerEvents}がまとめてdriverへ渡す責務を持つためである。
   */
  consumeNotifiedByCallee(): void;
  /** 未通知イベント列を取り出し、捕捉位置を前進させる（driverへ`yield`する経路用）。 */
  takePending(): readonly BattleDomainEvent[];
  /**
   * `yield`から再開した直後に、driverがその`yield`を処理する間にrecorderへ積んだ
   * イベント（＝既に候補解決まで済んでいる子連鎖）を一括捕捉から除く。
   *
   * `takePending`が捕捉位置を進めるのは`yield`**直前**のrecorder末尾までなので、
   * これを呼ばずに次のstepへ進むと、次の`takePending`または
   * {@link innerEvents}が子連鎖のイベントを拾い直し、同じイベントが2度
   * `resolveEvent`へ渡る。PS自身は発動済みGuard（R-PS-07）で表面化しないことが
   * あるが、1解決スコープ1回制限を持たないMemoryやイベントごとに走る
   * RuntimeCounter更新は二重に実行される。
   */
  consumeResolvedByDriver(): void;
  /** `EffectActionCompleted`と同じstepへ含める内部イベント（callback経路では常に空）。 */
  innerEvents(): readonly BattleDomainEvent[];
}

export function createEffectActionEventCursor(
  context: EffectActionGroupContext,
  box: UnitsBox,
): EffectActionEventCursor {
  let start = context.recorder.getEvents().length;
  const consume = (): void => {
    start = context.recorder.getEvents().length;
  };
  return {
    notifyPending: () => {
      const callback = context.onFactEventForPassiveChain;
      if (callback === undefined) {
        return;
      }
      for (const event of context.recorder.getEvents().slice(start)) {
        box.units = callback(event, box.units);
      }
      consume();
    },
    consumeNotifiedByCallee: () => {
      if (context.onFactEventForPassiveChain === undefined) {
        return;
      }
      consume();
    },
    takePending: () => {
      const pending = context.recorder.getEvents().slice(start);
      consume();
      return pending;
    },
    consumeResolvedByDriver: consume,
    innerEvents: () =>
      context.onFactEventForPassiveChain === undefined
        ? context.recorder.getEvents().slice(start)
        : [],
  };
}

/**
 * 1適用ぶんの入力一式（`effectAction`のkindを絞らない形）。全kindで同じ形の共通ヘルパ
 * （免疫ガード・Formula評価・Outcome組み立て）はこの型を受け取る。
 */
export interface EffectActionApplicationInput {
  readonly effectAction: EffectActionDefinition;
  readonly application: EffectActionApplication;
  readonly box: UnitsBox;
  readonly context: EffectActionGroupContext;
  /** このapplicationの`EffectActionStarting`。各kindが記録するイベントの親になる。 */
  readonly startingEventId: DomainEventId;
  /**
   * HEAL_DISTRIBUTE（M7-005）: 同じEffectStep内でこの
   * `effectActionDefinitionId`が適用される対象数。`HEAL`の
   * `payload.distribution: "EVEN"`と`MODIFY_RESOURCE`の`operation: DISTRIBUTE`
   * だけがこれを使い、総量を等分する。
   */
  readonly distributionShareCount: number;
  readonly cursor: EffectActionEventCursor;
}

/**
 * kind別ハンドラが受け取る、payloadを自分のkindへ絞り込んだ入力。interfaceの型引数では
 * なく交差型で表すのは、`Extract`（条件型）を型引数に含むinterfaceだとTypeScriptが変性を
 * 測定できず、絞り込んだ入力を{@link EffectActionApplicationInput}を取る共通ヘルパへ
 * 渡せなくなるためである。
 */
export type EffectActionHandlerInput<TKind extends EffectActionKind = EffectActionKind> = Omit<
  EffectActionApplicationInput,
  "effectAction"
> & {
  readonly effectAction: Extract<EffectActionDefinition, { readonly kind: TKind }>;
};

/**
 * kind別ハンドラの共通シグネチャ。`EffectResolutionStep`を`yield`できるのは、
 * DAMAGEの凍結カスケード・HEALの転送境界・APPLY_STATUSの消費失効のように、
 * 1つのEffectActionの内側でPS/Memory即時連鎖の境界が生じるkindのためである。
 */
export type EffectActionResolution = Generator<EffectResolutionStep, EffectActionOutcome, void>;

/**
 * PS/Memory即時連鎖の境界を内側に持たないkindのハンドラ。適用は`box.units`の
 * 書き換えとイベント記録だけで完結し、駆動側への`yield`を必要としない。
 */
export type EffectActionHandler<TKind extends EffectActionKind> = (
  input: EffectActionHandlerInput<TKind>,
) => EffectActionOutcome;

/**
 * 1つのEffectActionの内側で連鎖境界が生じるkind（DAMAGEの凍結カスケード・HEALの
 * 転送境界・APPLY_STATUSの消費失効）のハンドラ。
 */
export type SteppedEffectActionHandler<TKind extends EffectActionKind> = (
  input: EffectActionHandlerInput<TKind>,
) => EffectActionResolution;

/**
 * R-EFF-09「各インスタンスの失効イベントは次のインスタンスへ進む前にPS/Memoryの
 * 即時連鎖へ渡す」を、**評価経路を問わず**同じ粒度で満たす共通driver。
 *
 * callbackがある経路（AS/EX・チャージ解放）はそのステップのイベントをその場で
 * 同期通知し、無い経路（PS自身のEffectSequence解決）は`EFFECT_RESOLVED`として
 * driverへ`yield`する — 後者は新しい`resolvePassiveChain`を起こせない（進行中の
 * guard/stackを上書きしてしまう）ため、`resolvePassiveChain`自身に1ステップずつ
 * 解決させる。まとめて除去してからイベント列を渡すと、経路によって同じ除去で
 * PSが発動したりしなかったりする差が生まれる。
 */
export function* driveRemovalSteps<TResult extends { readonly units: readonly BattleUnit[] }>(
  input: EffectActionApplicationInput,
  steps: Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    TResult,
    readonly BattleUnit[] | undefined
  >,
): Generator<EffectResolutionStep, TResult, void> {
  const { context, box, cursor } = input;
  const callback = context.onFactEventForPassiveChain;
  let step = steps.next();
  while (!step.done) {
    box.units = step.value.units;
    if (callback !== undefined) {
      for (const event of step.value.events) {
        box.units = callback(event, box.units);
      }
      cursor.consumeNotifiedByCallee();
    } else {
      yield { kind: "EFFECT_RESOLVED", events: cursor.takePending() };
      // 再開時点のrecorder末尾までは、driverがこの`yield`で既に解決した子連鎖。
      // 次stepの`takePending`／EffectAction終了時の`innerEvents`が拾い直さないよう捨てる。
      cursor.consumeResolvedByDriver();
    }
    step = steps.next(box.units);
  }
  box.units = step.value.units;
  return step.value;
}

/**
 * 中断を起こさないkindの共通結果。これらは`application.hits`の全件を処理し切る
 * （非DAMAGEのapplicationは常に`hits.length === 1`）。
 */
export function settledOutcome(
  input: EffectActionApplicationInput,
  lastEventId: DomainEventId,
  resultKind: EffectActionResultKind,
): EffectActionOutcome {
  return {
    resultKind,
    resolvedCount: input.application.hits.length,
    interruptedCount: 0,
    criticalHitCount: 0,
    lastEventId,
  };
}

/**
 * 状態を一切変えずに終わるkind分岐（重複上限到達・対象がMarkerを未所持・
 * リンク先0件など）の共通結果。親は`EffectActionStarting`のままである。
 */
export function skippedOutcome(input: EffectActionApplicationInput): EffectActionOutcome {
  return settledOutcome(input, input.startingEventId, "SKIPPED");
}

/**
 * `APPLY_STAT_MOD`と同じ評価規約でFormulaを付与時点に一度だけ評価するための共通スコープ。
 * R-MEM-04: Memory由来の解決は使用者を持たないため、`SKILL_SOURCE`/`lastResults`を
 * 要求しないFormulaだけが評価できる（要求するものは`FormulaEvaluator`が明確に拒否する）。
 * `lastResults`（R-SKL-08）は`context.damageResults`（呼び出し側が1解決スコープごとに
 * 新規生成する共有registry）から使用者自身の直前DAMAGE結果と、`context.skillUseId`が
 * 識別するEffectSequence解決の累計DAMAGE結果（`SUM_*`、G-10）を取り出す。
 */
export function grantFormulaScope(input: EffectActionApplicationInput): FormulaEvaluationContext {
  const { context, box, application } = input;
  const actor = findActorUnit(context, box);
  return {
    ...(actor !== undefined ? { skillSource: actor } : {}),
    ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
    target: requireUnit(box.units, application.targetUnitId),
    allUnits: box.units,
    ...(actor !== undefined
      ? {
          lastResults: damageResultsFor(
            context.damageResults,
            actor.battleUnitId,
            context.skillUseId,
          ),
        }
      : {}),
  };
}

/** {@link grantFormulaScope}で`formula`を評価した付与時snapshot値。 */
export function evaluateGrantMagnitude(
  input: EffectActionApplicationInput,
  formula: FormulaDefinition,
): number {
  return evaluateFormula(formula, grantFormulaScope(input));
}

/**
 * R-EFF-03（M7-001B）: 対象が有効な`EFFECT_IMMUNITY`（この付与のカテゴリに一致するもの）を
 * 保持しているかを判定する。`statusKind`を渡すのは
 * `EFFECT_IMMUNITY_STATUS_GRANULARITY`（`immunity.statusKinds`）で状態種別まで
 * 絞り込む`APPLY_STATUS`だけである。
 */
export function findImmunityBlock(
  input: EffectActionApplicationInput,
  magnitude: number,
  statusKind?: StatusKind,
): AppliedEffect | undefined {
  return findBlockingImmunity(
    requireUnit(input.box.units, input.application.targetUnitId),
    {
      effectActionDefinitionId: input.application.effectActionDefinitionId,
      magnitude,
      ...(statusKind !== undefined ? { statusKind } : {}),
    },
    input.effectAction,
  );
}

/**
 * 免疫にブロックされた付与を`EffectApplicationRejected`として記録する
 * （`EffectApplied`もCombatStat再計算も行わない）。
 */
export function recordImmunityRejection(
  input: EffectActionApplicationInput,
  blockingEffect: AppliedEffect,
  statusKind?: StatusKind,
): { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId } {
  const { context, box, application, startingEventId } = input;
  return rejectEffectApplication(
    eventContextOf(context),
    box.units,
    {
      effectActionDefinitionId: application.effectActionDefinitionId,
      ...grantSourceOf(context),
      targetUnitId: application.targetUnitId,
      blockingEffect,
      ...(statusKind !== undefined ? { statusKind } : {}),
    },
    startingEventId,
  );
}

/**
 * `AppliedEffect`として新規付与する大半のkindが共有する免疫ガード。ブロックされた場合
 * だけ`REJECTED`のOutcomeを返し、通過した場合は`undefined`を返して呼び出し側の付与へ進む。
 *
 * `APPLY_STATUS`だけはこれを使わない — R-EFF-07「STATUS_BLOCKED は、効果ownerへの
 * 状態付与が無効化された時点で消費する」により、拒否の後に消費失効という追加の
 * 状態遷移が続くためである。
 */
export function rejectIfImmune(
  input: EffectActionApplicationInput,
  magnitude: number,
): EffectActionOutcome | undefined {
  const blockingImmunity = findImmunityBlock(input, magnitude);
  if (blockingImmunity === undefined) {
    return undefined;
  }
  const rejection = recordImmunityRejection(input, blockingImmunity);
  input.box.units = rejection.units;
  input.cursor.notifyPending();
  return settledOutcome(input, rejection.lastEventId, "REJECTED");
}

/**
 * 免疫を通過した付与本体の共通後処理。`grantEffect`/`applyMarker`等はヒット単位の
 * PS連鎖フックを持たないため、記録した`EffectApplied`/`EffectiveEffectChanged`/
 * `CombatStatChanged`をここで`onFactEventForPassiveChain`へ転送する（AS/EX経路のみ。
 * PS自身のEffectSequence解決経路では`innerEvents`が同じ役割を果たす）。
 */
export function completeGrant(
  input: EffectActionApplicationInput,
  granted: { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  resultKind: EffectActionResultKind = "APPLIED",
): EffectActionOutcome {
  input.box.units = granted.units;
  input.cursor.notifyPending();
  return settledOutcome(input, granted.lastEventId, resultKind);
}
