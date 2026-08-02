import { activeStatusEffect, isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import { calculateDamage } from "./damage-calculator.js";
import { resolveCritical, type CriticalResult } from "./critical-policy.js";
import { composePiercing } from "./piercing-policy.js";
import {
  damageResultsFor,
  recordDamageResult,
  type DamageResultRegistry,
} from "../skill/formula-evaluator.js";
import type {
  DomainEventId,
  ActionId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import { resolveEffectiveAccuracyMode, resolveEvasion } from "./hit-policy.js";
import { resolveDamageImmunity } from "./damage-immunity-policy.js";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import { absorbFromShieldPool, emitShieldConsumed, shieldBypassedDamage } from "./shield-policy.js";
import {
  absorbFromNextSubUnit,
  emitSubUnitDamaged,
  subUnitAdditionalDamageSources,
  type SubUnitAdditionalDamageSource,
} from "./sub-unit-policy.js";
import { evaluateFormula } from "../skill/formula-evaluator.js";
import { createPercentage } from "../../shared/percentage.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type {
  AccuracyMode,
  ConsumptionKind,
  CriticalMode,
  DamageType,
} from "../../catalog/definitions/catalog-enums.js";
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface DamageHitOutcome {
  readonly targetBattleUnitId: BattleUnitId;
  readonly hitIndex: number;
  /** false when the hit was skipped instead of applied (target already defeated, or MISS). */
  readonly applied: boolean;
  readonly isCritical: boolean;
  readonly damage: number;
}

export interface ApplyDamageActionResult {
  readonly units: readonly BattleUnit[];
  readonly hits: readonly DamageHitOutcome[];
  /**
   * PR #141再レビュー[P2]: 使用者が戦闘不能になったことで未処理のまま残った
   * ヒット数。MISSや対象の戦闘不能による通常のスキップ（`DamageHitOutcome.applied`
   * が`false`になる別のケース）は含まない — 使用者(attacker)が戦闘不能になる
   * 前に到達したヒットは、命中/MISSに関わらず「解決済み」として数える。
   */
  readonly interruptedCount: number;
  /**
   * PR #289再々レビュー[P2]: 使用者の戦闘不能で未解決の効果を残したまま打ち切った
   * 場合`true`。`interruptedCount`とは別に持つ（HEALの`ApplyHealActionResult.
   * interrupted`と同じ理由）— R-SUB-02のサブユニット追加ヒットは`hits`に含まれない
   * ため、追加ヒットの解決中に使用者が戦闘不能になっても`interruptedCount`は0のまま
   * になり、そのままでは`effect-action-group-resolver.ts`が`EffectActionCompleted`を
   * `APPLIED`として発行して後続stepまで進んでしまう。
   */
  readonly interrupted: boolean;
  /**
   * PR #142レビュー[P2]: このEffectAction適用中に実際に記録された最後の
   * イベントID（最終ヒットの`DamageApplied`、致死なら`UnitDefeated`）。
   * 呼び出し側が`EffectActionCompleted.parentEventId`をこれへ設定することで、
   * イベントログの直接因果が実際の解決経路（`EffectActionStarting`固定では
   * ない）を表せるようにする。全ヒットがスキップ・中断されて何も記録されな
   * かった場合は`context.parentEventId`のまま変化しない。
   */
  readonly lastEventId: DomainEventId;
}

/** `applyDamageActionSteps`がyieldする1ステップ（記録済みイベント列と、その時点の`units`）。 */
export interface DamageStep {
  readonly events: readonly BattleDomainEvent[];
  readonly units: readonly BattleUnit[];
}

/** ヒットイベント（HitConfirmed〜UnitDefeated）が共有する因果関係コンテキスト。全て`ActionStarted`の解決スコープに属する。 */
export interface DamageEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  /** 各ヒットの直接の契機（`SkillUseStarted.eventId`）。ヒット同士は互いを親としない。 */
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /**
   * Issue #34: `DamageApplied`（および`UnitDefeated`）の確定直後にPS即時連鎖を
   * 同期的に解決するフック。呼び出し側（`lifecycle/`、Domain層のmodule境界に
   * より`combat/`自身は`triggering/`へ依存できない）が注入する。戻り値の
   * `units`をそのまま以後の`working`として使う。未指定ならPS解決を行わない
   * （R-SKL-06のACTION step単位の即時解決は#73のスコープで、本フックは
   * R-SKL-01/02が要求する「ヒットごとの直ちの解決」までを満たす）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-EFF-07: `ownerUnitId`が保持する`kind`一致の消費条件効果を1消費する
   * （`EffectConsumptionChanged`発行）。`onFactEventForPassiveChain`と同じ理由
   * （Domain層のmodule境界により`combat/`は`effects/`へ依存できない）で
   * 呼び出し側（`lifecycle/`）が注入する。未指定なら消費条件を評価しない。
   *
   * レビュー再々指摘[P1]（PR #209）: 消費回数が0になったインスタンスの実際の
   * 除去・CombatStat再計算は、この呼び出しの中では行わない場合がある
   * （`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`は`14_Catalog定義スキーマ.md`
   * 「上限に到達した効果は、該当するEffectActionの解決後に失効する」契約のため、
   * 呼び出し側の実装が`finalizeConsumedEffectDurations`まで遅延させる）。この
   * ヒットの会心・ダメージ計算は、消費し終えた直後の`units`（まだ除去前の
   * combatStats）をそのまま使ってよい。
   *
   * PR #280再レビュー[P1]: 凍結解除（`removeFreezeEffect`）と同じくステップを
   * `yield`するgeneratorを返す。消費で0になったインスタンスの失効はR-EFF-09の
   * カスケードを伴い、そのカスケード分・seed分の各除去は「次の除去へ進む前に
   * PS/Memory連鎖へ通知する」必要があるため（まとめて最終stateで通知すると、
   * 子`EffectExpired`のwatcherが親を既に除去済みとして観測する）。
   */
  readonly consumeEffectDuration?: (
    ownerUnitId: BattleUnitId,
    kind: ConsumptionKind,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
    /** R-HIT-04: 指定時はこの1インスタンスだけを消費する（Nヒット回避の自己消費）。 */
    effectInstanceId?: EffectInstanceId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * レビュー再々指摘[P1]（PR #209）: `consumeEffectDuration`が遅延させた
   * 消費済みインスタンス（`NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`）を、
   * このEffectAction（`applyDamageAction`1回分、全ヒット）の解決完了後に
   * まとめて失効させる（`EffectExpired`発行、CombatStat再計算を含む）。
   * `consumeEffectDuration`と同じ理由で呼び出し側が注入する。未指定、または
   * 遅延対象が無ければ何もしない。
   */
  readonly finalizeConsumedEffectDurations?: (
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SKL-08（レビュー再指摘[P1]、PR #214）: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
   * が参照する「同じ解決スコープ内の直前DAMAGE結果」を保持する、呼び出し側が
   * 1解決スコープ（1行動、または行動外トップレベルイベント）ごとに新規生成する
   * 共有registry。未指定なら`LAST_DAMAGE_DEALT`/`LAST_DAMAGE_RECEIVED`を要求する
   * Formulaは`FormulaEvaluator`が明確な例外で拒否する。
   */
  readonly damageResults?: DamageResultRegistry;
  /**
   * R-ACTN-01 #2（レビュー再指摘[P2]、PR #215）: このヒット列を解決した対象が
   * `TargetSelectorDefinition.includeDefeated: true`で選択された場合`true`。
   * 未指定（`false`扱い）なら、これまでどおり参照時点で既に戦闘不能な対象への
   * ヒットを適用しない。`true`の場合は、対象が戦闘不能であることを理由に
   * ヒットをスキップしない — DAMAGEも他のEffectAction種別と同じ明示指定を
   * 尊重する（`effect-action-group-resolver.ts`の非DAMAGE分岐と対になる契約）。
   */
  readonly includeDefeated?: boolean;
  /**
   * CAP_TRIGGER_CONTEXT（RES-005、Issue #172）: このPSを発動させた原因イベントの
   * 発生源・対象の`BattleUnitId`。`FormulaSourceReference.kind: TRIGGER_SOURCE`/
   * `TRIGGER_TARGET`を持つDAMAGE Formulaの評価に使う。`TRIGGER_TARGET`は複数
   * ユニットを指しうるが、Formula側は単一参照のため先頭の1体を使う（R-TGT-10
   * と同じ規約）。未指定ならこれらを要求するFormulaは`FormulaEvaluator`が
   * 明確な例外で拒否する。
   *
   * PRレビュー指摘[P2]: `BattleUnit`ではなくIDを保持する — ヒットごとの
   * ループで先行するヒットが対象のHP・combatStatsを変更しうるため、Formula
   * 評価の直前に`working`（このヒット時点の最新状態）から都度引き直す。
   */
  readonly triggerSourceUnitId?: BattleUnitId;
  readonly triggerTargetUnitIds?: readonly BattleUnitId[];
  /**
   * R-STS-03（凍結解除）＋R-EFF-09（`linkedEffectGroupId`カスケード）: 呼び出し側
   * （`lifecycle/`、`combat/`は`effects/`へ依存できないため）が注入する、凍結
   * 除去の完全な処理（`FreezeRemoved`発行、同グループの未失効子効果があれば
   * `duration-expiry-service.ts`と同じ順序・イベント形でカスケード除去、
   * `recalculateCombatStats`）。未指定の場合は`AppliedEffect`を直接filterし
   * `FreezeRemoved`だけを発行する簡易版へfallbackする（カスケード・CombatStat
   * 再計算は行わない — 既存テストが`effects/`層のモックを用意しなくても
   * 動き続けるための最小動作）。
   *
   * PRレビュー再々指摘[P2]（Issue #183）: カスケードの各ステップを`yield`する
   * generatorを返す — `context.onFactEventForPassiveChain`が指定されていれば
   * （AS/EX・チャージ解放）`applyDamageActionSteps`がこのgeneratorを同期的に
   * 駆動しステップごとに通知する。未指定（PS自身のEffectSequence解決）なら
   * `applyDamageActionSteps`自身が`yield`し、呼び出し元
   * （`resolveOneEffectActionApplication`）が`driveActivation`の共有stateへ
   * 正しく参加させる。`.next()`へ渡す値は、そのyield中にPS連鎖が変化させた
   * 最新の`units`（変化が無ければ渡さない）。
   */
  readonly removeFreezeEffect?: (
    targetUnitId: BattleUnitId,
    freezeEffectInstanceId: EffectInstanceId,
    triggeringDamage: number,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SHD-01第3項／R-SUB-01「個別消滅条件」（DMG-004、Issue #194／DMG-005、
   * Issue #190）: 残量が0になったシールドインスタンス、または耐久力が0になった
   * サブユニットインスタンスを`EffectExpired`（`reason: SHIELD_DEPLETED` /
   * `SUBUNIT_DEPLETED`）として失効させ、R-EFF-09の`linkedEffectGroupId`カスケード
   * （production例: `SKL_LILY_SINGER_PS2`「シールドの消滅と共に攻撃力バフも
   * 消滅する」）とCombatStat再計算まで行う完全な処理。`removeFreezeEffect`と
   * まったく同じ理由（`combat/`は`effects/`へ依存できない、module境界）で
   * 呼び出し側（`lifecycle/`）が注入し、同じ「除去1件ごとに`yield`する」規約を持つ。
   *
   * 未指定の場合は`AppliedEffect`を直接filterし`EffectExpired`だけを発行する
   * 簡易版へfallbackする（カスケード・CombatStat再計算は行わない —
   * `removeFreezeEffect`のfallbackと同じ、hookを用意しない単体テスト用の最小動作）。
   */
  readonly expireDepletedAbsorbers?: (
    targetUnitId: BattleUnitId,
    depletedEffectInstanceIds: readonly EffectInstanceId[],
    reason: DepletedAbsorberReason,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
  /**
   * R-SUB-02第3項（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`、DMG-005、Issue #190）:
   * サブユニットの追加ダメージに付随するデバフを、追加ダメージを与えた対象へ
   * 付与する。`expireDepletedAbsorbers`とまったく同じ理由（`combat/`は`effects/`と
   * Catalogの`effectActions`マップへ到達できない）で呼び出し側が注入し、同じ
   * 「1件ごとに`yield`する」規約を持つ。未指定なら追加デバフを付与しない
   * （hookを用意しない単体テストでは追加ダメージだけが起きる）。
   */
  readonly grantSubUnitAdditionalDamageDebuff?: (
    targetUnitId: BattleUnitId,
    debuffEffectActionDefinitionId: EffectActionDefinitionId,
    ownerUnitId: BattleUnitId,
    units: readonly BattleUnit[],
    parentEventId: DomainEventId,
  ) => Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >;
}

/**
 * `expireDepletedAbsorbers`が運ぶ「吸収先を使い切った」失効理由。R-SHD-01第3項の
 * シールド枯渇とR-SUB-01のサブユニット枯渇は、どちらも時間制限でも消費条件でもない
 * 個別消滅条件であり、失効経路（`expireEffectsSteps`）を共有する。
 */
export type DepletedAbsorberReason = "SHIELD_DEPLETED" | "SUBUNIT_DEPLETED";

function skip(hit: ResolvedEffectApplication): DamageHitOutcome {
  return {
    targetBattleUnitId: hit.targetBattleUnitId,
    hitIndex: hit.hitIndex,
    applied: false,
    isCritical: false,
    damage: 0,
  };
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
 * R-EFF-07: `context.consumeEffectDuration`（呼び出し側が注入する、`combat/`は
 * `effects/`へ依存できないため）へ委譲し、`ownerUnitId`が保持する`kind`一致の
 * 消費条件効果を1消費・必要なら失効させる。フック未指定、または該当効果が
 * 無い場合は`workingMap`を変更せず`parentEventId`をそのまま返す。
 */
function* consumeAndExpire(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  ownerUnitId: BattleUnitId,
  kind: ConsumptionKind,
  parentEventId: DomainEventId,
  effectInstanceId?: EffectInstanceId,
): Generator<DamageStep, DomainEventId, readonly BattleUnit[] | undefined> {
  if (context.consumeEffectDuration === undefined) {
    return parentEventId;
  }
  const result = yield* driveRemovalSteps(
    context,
    workingMap,
    context.consumeEffectDuration(
      ownerUnitId,
      kind,
      Array.from(workingMap.values()),
      parentEventId,
      effectInstanceId,
    ),
  );
  return result.lastEventId;
}

/**
 * PR #280再レビュー[P1]: 除去ステップを`yield`するgenerator（凍結解除・消費失効・
 * 遅延失効の確定）を、凍結解除と同じ規約で駆動する共通ヘルパー。
 * `context.onFactEventForPassiveChain`があればステップごとにその場で同期通知し、
 * 無ければ1ステップずつ`yield`して、driverが更新した`units`を次の除去へ注入する。
 */
function* driveRemovalSteps(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  removal: Generator<
    { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
    { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
    readonly BattleUnit[] | undefined
  >,
): Generator<
  DamageStep,
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  let step = removal.next();
  while (!step.done) {
    if (context.onFactEventForPassiveChain !== undefined) {
      let stepUnits = step.value.units;
      for (const event of step.value.events) {
        stepUnits = context.onFactEventForPassiveChain(event, stepUnits);
      }
      step = removal.next(stepUnits);
    } else {
      const injected = yield { events: step.value.events, units: step.value.units };
      step = removal.next(injected);
    }
  }
  for (const unit of step.value.units) {
    workingMap.set(unit.battleUnitId, unit);
  }
  return step.value;
}

/** `08_ドメインイベント.md`の一般的な流儀: 記録済みの新規イベントをPS即時連鎖フックへ順に転送する。 */
function notifyNewEvents(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  eventsStart: number,
): void {
  if (context.onFactEventForPassiveChain === undefined) {
    return;
  }
  for (const event of context.recorder.getEvents().slice(eventsStart)) {
    const updatedUnits = context.onFactEventForPassiveChain(event, Array.from(workingMap.values()));
    for (const unit of updatedUnits) {
      workingMap.set(unit.battleUnitId, unit);
    }
  }
}

/**
 * PR #283再レビュー[P1]: 1ヒットの内部イベント（`UnitBeingAttacked`・
 * `EvasionActivated`・`HitConfirmed`・`CriticalCheckResolved`・
 * `DamageWillBeApplied`）を、記録直後にPS/Memory即時連鎖へ届けて次の判定へ進む前に
 * 解決し切るための共通ヘルパー。凍結解除・消費失効（`driveRemovalSteps`）と同じ
 * 2経路の規約を持つ。
 *
 * - `context.onFactEventForPassiveChain`あり（AS/EX・チャージ解放）: その場で
 *   同期通知する。この経路では`effect-action-group-resolver.ts`の`innerEvents`が
 *   常に空になるため、ここで通知しないイベントはPS/Memory連鎖へ一度も届かない
 *   （`CriticalCheckResolved`をtriggerにするproduction PSが実戦闘で発動しない、
 *   という形で顕在化していた）。
 * - 未指定（PS/Memory自身のEffectSequence解決）: 1ステップ`yield`し、driver
 *   （`resolveOneEffectActionApplication`）が子連鎖を解決して更新した`units`を
 *   `.next()`で注入する。これが無いとEffectAction完了時まで連鎖が遅れ、
 *   TIMINGイベントの再検証契機を過ぎてしまう。
 */
function* notifyOrYieldNewEvents(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  eventsStart: number,
): Generator<DamageStep, void, readonly BattleUnit[] | undefined> {
  if (context.onFactEventForPassiveChain !== undefined) {
    notifyNewEvents(context, workingMap, eventsStart);
    return;
  }
  const injected = yield {
    events: context.recorder.getEvents().slice(eventsStart),
    units: Array.from(workingMap.values()),
  };
  for (const unit of injected ?? []) {
    workingMap.set(unit.battleUnitId, unit);
  }
}

/**
 * `notifyOrYieldNewEvents`が解決した子連鎖の後に、このヒットを続行してよいかを
 * `working`（連鎖後の最新state）から判定する（PR #283再々レビュー[P1]）。
 *
 * - `INTERRUPT`: 使用者が戦闘不能。R-SKL-01/R-SKL-03に従い、このヒットを含む
 *   残りのヒットをすべて中断する
 * - `SKIP`: 対象が戦闘不能（`context.includeDefeated`の明示指定がない場合）。
 *   このヒットは適用せず、R-SKL-08の直前結果へ0を記録して次のヒットへ進む
 * - `CONTINUE`: 続行してよい。以降の判定・イベントは返された最新の
 *   `attacker`/`target`を使う（連鎖が会心率・防御力・`AppliedEffect`を
 *   変えていても取りこぼさない）
 *
 * 各イベントの記録直後にこれを行うことで、既に成立しなくなった前提のまま次の
 * 判定へ進んだり、後続イベント（とその連鎖）を余計に発行したりしなくなる。
 */
type HitRevalidation =
  | { readonly kind: "CONTINUE"; readonly attacker: BattleUnit; readonly target: BattleUnit }
  | { readonly kind: "INTERRUPT" }
  | { readonly kind: "SKIP"; readonly attacker: BattleUnit; readonly target: BattleUnit };

function revalidateHit(
  context: DamageEventContext,
  workingMap: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
): HitRevalidation {
  const attacker = findUnit(workingMap, attackerUnitId, "attacker.battleUnitId");
  if (isDefeated(attacker)) {
    return { kind: "INTERRUPT" };
  }
  const target = findUnit(workingMap, targetUnitId, "hits[].targetBattleUnitId");
  if (!(context.includeDefeated ?? false) && isDefeated(target)) {
    return { kind: "SKIP", attacker, target };
  }
  return { kind: "CONTINUE", attacker, target };
}

/**
 * `context.removeFreezeEffect`未指定時のfallback。`AppliedEffect`を直接filterし
 * `FreezeRemoved`だけを発行する — R-EFF-09のlinkedEffectGroupカスケードも
 * CombatStat再計算も行わない（`combat/`は`effects/`へ依存できないため、
 * どちらも呼び出し側が注入する`removeFreezeEffect`でしか実現できない）。
 * production経路（`effect-action-group-resolver.ts`）は常にこのhookを注入する
 * ため、この簡易版が実際に使われるのはhookを用意しない単体テストだけ。
 */
function* fallbackRemoveFreezeEffectSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  freezeEffect: AppliedEffect,
  triggeringDamage: number,
  parentEventId: DomainEventId,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  const eventsStart = context.recorder.getEvents().length;
  const freezeRemoved = context.recorder.record({
    eventType: "FreezeRemoved",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: targetUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectInstanceId: freezeEffect.effectInstanceId,
      battleUnitId: targetUnitId,
      triggeringDamage,
    },
    stateDelta: {
      units: {
        [targetUnitId]: {
          effects: {
            [freezeEffect.effectInstanceId]: {
              before: toEffectSnapshot(freezeEffect, true),
              after: undefined,
            },
          },
        },
      },
    },
  });
  const updatedUnits = units.map((unit) =>
    unit.battleUnitId === targetUnitId
      ? {
          ...unit,
          appliedEffects: unit.appliedEffects.filter(
            (effect) => effect.effectInstanceId !== freezeEffect.effectInstanceId,
          ),
        }
      : unit,
  );
  const injected = yield {
    events: context.recorder.getEvents().slice(eventsStart),
    units: updatedUnits,
  };
  return { units: injected ?? updatedUnits, lastEventId: freezeRemoved.eventId };
}

/**
 * R-SHD-01第3項／R-SUB-01（個別消滅条件）: 残量・耐久力が0になった吸収先を
 * 失効させる。`context.expireDepletedAbsorbers`（呼び出し側が注入する完全版）が
 * あればそれへ、無ければ`fallbackExpireDepletedAbsorberSteps`へ委譲する。
 */
function expireDepletedAbsorberSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  depletedEffectInstanceIds: readonly EffectInstanceId[],
  reason: DepletedAbsorberReason,
  parentEventId: DomainEventId,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  return context.expireDepletedAbsorbers !== undefined
    ? context.expireDepletedAbsorbers(
        targetUnitId,
        depletedEffectInstanceIds,
        reason,
        units,
        parentEventId,
      )
    : fallbackExpireDepletedAbsorberSteps(
        context,
        units,
        targetUnitId,
        depletedEffectInstanceIds,
        reason,
        parentEventId,
      );
}

/**
 * `context.expireDepletedAbsorbers`未指定時のfallback。`fallbackRemoveFreezeEffectSteps`
 * とまったく同じ役割・同じ制限（R-EFF-09カスケードもCombatStat再計算も行わない）
 * を持つ、単体テスト向けの最小動作。production経路
 * （`effect-action-group-resolver.ts`）は常にhookを注入する。
 */
function* fallbackExpireDepletedAbsorberSteps(
  context: DamageEventContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  depletedEffectInstanceIds: readonly EffectInstanceId[],
  reason: DepletedAbsorberReason,
  parentEventId: DomainEventId,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId },
  readonly BattleUnit[] | undefined
> {
  let working = units;
  let lastEventId = parentEventId;
  for (const effectInstanceId of depletedEffectInstanceIds) {
    const holder = working.find((unit) => unit.battleUnitId === targetUnitId);
    const expiring = holder?.appliedEffects.find(
      (effect) => effect.effectInstanceId === effectInstanceId,
    );
    if (expiring === undefined) {
      continue;
    }
    const eventsStart = context.recorder.getEvents().length;
    const expired = context.recorder.record({
      eventType: "EffectExpired",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: targetUnitId,
      targetUnitIds: [targetUnitId],
      payload: {
        effectInstanceId,
        battleUnitId: targetUnitId,
        effectActionDefinitionId: expiring.effectActionDefinitionId,
        kindKey: expiring.kindKey,
        reason,
        linkedEffectGroupId: expiring.duration.definition.linkedEffectGroupId,
        cascaded: false,
      },
      stateDelta: {
        units: {
          [targetUnitId]: {
            effects: {
              [effectInstanceId]: { before: toEffectSnapshot(expiring, true), after: undefined },
            },
          },
        },
      },
    });
    working = working.map((unit) =>
      unit.battleUnitId === targetUnitId
        ? {
            ...unit,
            appliedEffects: unit.appliedEffects.filter(
              (effect) => effect.effectInstanceId !== effectInstanceId,
            ),
          }
        : unit,
    );
    lastEventId = expired.eventId;
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: working,
    };
    working = injected ?? working;
  }
  return { units: working, lastEventId };
}

/**
 * R-SKL-03「MISSでなければ、対象固有の特別な回避、会心、ダメージ、シールド、
 * 戦闘不能、PS/Memory連鎖をヒットごとに解決する」が要求する、1ヒットの**観測**部分。
 * `observeHitSteps`が攻撃側定義から必要とする値だけをまとめる。
 *
 * DAMAGE EffectActionのヒットは`damageAction.payload`からそのまま作り、サブユニットの
 * 追加ダメージ（R-SUB-02）は「1ヒットとして扱われます」（`戦闘システム.md`）に従い、
 * 契機になった攻撃の`accuracy`を引き継ぎつつ会心・貫通を持たないprofileを作る。
 */
interface HitObservationProfile {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
  readonly damageType: DamageType;
  readonly accuracyMode: AccuracyMode;
  readonly criticalMode: CriticalMode;
  readonly piercing: {
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
  };
}

/**
 * `observeHitSteps`の結果。`INTERRUPT`は使用者の戦闘不能（R-SKL-01/R-SKL-03により
 * 残りのヒットも中断する）、`SKIP`はこのヒットが成立しなかった場合
 * （対象の戦闘不能・回避）で、どちらもR-SKL-08の直前結果への0記録は済んでいる。
 */
type HitObservation =
  | { readonly kind: "INTERRUPT"; readonly lastEventId: DomainEventId }
  | { readonly kind: "SKIP"; readonly lastEventId: DomainEventId }
  | {
      readonly kind: "CONFIRMED";
      readonly attacker: BattleUnit;
      readonly target: BattleUnit;
      readonly critical: CriticalResult;
      readonly lastEventId: DomainEventId;
      /** `DamageCalculated`の直接の契機になる`DamageWillBeApplied`のID。 */
      readonly damageWillBeAppliedEventId: DomainEventId;
    };

/**
 * R-DMG-05 #1〜#4 ＋ R-SKL-03: 1ヒットのダメージ計算に入るまでの観測を解決する
 * （`UnitBeingAttacked` → R-EFF-07の`NEXT_*_ATTACK`消費 → 回避判定 → `HitConfirmed`
 * → 会心判定 → `CriticalCheckResolved` → `DamageWillBeApplied`）。各イベントの記録
 * 直後にPS/Memory即時連鎖を解決し、その連鎖後の最新stateで前提を再検証してから次へ
 * 進む（`08_ドメインイベント.md`「TIMINGイベント後の再検証」）。
 *
 * PR #289レビュー[P1]（DMG-005、Issue #190）: この観測列を通常ヒットとサブユニット
 * 追加ダメージ（R-SUB-02）で共有するために切り出した。切り出す前は追加ダメージが
 * `DamageCalculated`から始まっており、Nヒット回避（R-HIT-04）・被ヒット消費条件
 * （R-EFF-07の`OUTGOING_HIT`/`INCOMING_HIT`）・`HitConfirmed`起点のPSが追加ヒットを
 * 一度も観測できなかった。raw原文（`戦闘システム.md`）は追加ダメージを明示的に
 * 「1ヒットとして扱われます」と規定しているため、観測側に例外を設けない。
 */
function* observeHitSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  profile: HitObservationProfile,
  parentEventId: DomainEventId,
): Generator<DamageStep, HitObservation, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  const attackerAtStart = findUnit(working, attackerUnitId, "attacker.battleUnitId");

  // `08_ドメインイベント.md`「UnitBeingAttacked」: 攻撃対象が確定した直後
  // （命中判定・ダメージ計算より前）に発行する。R-EFF-07:
  // `NEXT_INCOMING_ATTACK`はこの発行時点で消費する。
  const unitBeingAttackedEventsStart = context.recorder.getEvents().length;
  const unitBeingAttacked = context.recorder.record({
    eventType: "UnitBeingAttacked",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
    },
  });
  lastEventId = unitBeingAttacked.eventId;
  // PR #280再レビュー[P1]: `UnitBeingAttacked`は消費失効より前に記録されている
  // ため、状態を書き換える前にここで通知する。消費失効自身の通知は
  // `consumeAndExpire`が除去1件ごとに行う（またはcallback未指定なら`yield`する）。
  // PR #283再レビュー[P1]: これもTIMINGイベントであり、下の再検証はその連鎖の結果を
  // 見るためのもの。callback未指定の経路でも連鎖をここで解決し切る必要がある。
  yield* notifyOrYieldNewEvents(context, working, unitBeingAttackedEventsStart);
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    targetUnitId,
    "NEXT_INCOMING_ATTACK",
    lastEventId,
  );

  // R-EFF-07: `NEXT_OUTGOING_ATTACK`は攻撃者が命中判定に到達した時点
  // （MISS/命中を問わない）で消費する。専用のドメインイベントは持たない。
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    attackerAtStart.battleUnitId,
    "NEXT_OUTGOING_ATTACK",
    lastEventId,
  );

  // レビュー再指摘 PR #209[P1]: `UnitBeingAttacked`／`NEXT_OUTGOING_ATTACK`消費が
  // 発火したPS連鎖は`working`を書き換え得る（対象を回復・戦闘不能にする等）。
  // `08_ドメインイベント.md`のTIMINGイベント契約どおり、命中・会心・ダメージ計算
  // に入る前に発生源・対象の生存を再検証し、計算用ステータスも`working`から取り直す。
  const afterTiming = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterTiming.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterTiming.kind === "SKIP") {
    // R-SKL-08: TIMING処理後に対象が戦闘不能になった場合も、この不成立結果を
    // 0として直前結果に記録する。
    recordDamageResult(
      context.damageResults,
      afterTiming.attacker.battleUnitId,
      afterTiming.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }
  const attackerAfterTiming = afterTiming.attacker;
  const targetAfterTiming = afterTiming.target;

  // R-HIT-02/R-HIT-04: 対象の有効な回避効果を判定する（暗闇/R-HIT-03は
  // `resolveEffectSequencePlan`のスキル使用単位ゲートで既に判定済み — MISSに
  // なるスキルはこのDAMAGE EffectAction自体に到達しない）。
  // R-HIT-05（M7-018、Issue #272）: 攻撃側定義の`accuracy.mode`と、使用者が
  // 持つ必中効果（`GUARANTEED_HIT`）を実効値へ畳み込んでから判定する。使用者は
  // TIMING処理後の最新状態から取り直す — 直前のPS連鎖が必中効果を付与・失効させ得る。
  const effectiveAccuracyMode = resolveEffectiveAccuracyMode(
    attackerAfterTiming,
    profile.accuracyMode,
  );
  const evasion = resolveEvasion(targetAfterTiming, effectiveAccuracyMode, random);
  if (evasion.evaded) {
    const evasionEventsStart = context.recorder.getEvents().length;
    const evasionActivated = context.recorder.record({
      eventType: "EvasionActivated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: context.parentEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [targetUnitId],
      payload: {
        effectActionDefinitionId: evasion.evadedByEffectActionDefinitionId!,
        effectInstanceId: evasion.evadedByEffectInstanceId!,
        hitIndex: profile.hitIndex,
        targetUnitId,
      },
    });
    lastEventId = evasionActivated.eventId;
    // R-HIT-04（M7-018、Issue #272）: 回避したこの被ヒットで、回避を成立させた
    // インスタンス自身の`INCOMING_HIT`消費を1消費する（Nヒット回避の「Nヒット」
    // はこの消費で数える）。R-EFF-07の一般規則（命中確定で消費）に対する
    // 本ルール固有の例外のため、同じ対象が持つ他の`INCOMING_HIT`消費効果を
    // 巻き込まないよう、消費対象をこのインスタンスへ限定する。
    // R-SKL-01/02（レビュー指摘[P1]）: `EvasionActivated`もFACTイベントとして
    // PS/Memoryの即時連鎖の契機になり得るため、次のヒットへ進む前に通知する。
    yield* notifyOrYieldNewEvents(context, working, evasionEventsStart);
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      targetAfterTiming.battleUnitId,
      "INCOMING_HIT",
      lastEventId,
      evasion.evadedByEffectInstanceId,
    );
    // R-SKL-08: MISSも結果種別を持つ直前結果として記録する（R-SKL-08本文）。
    recordDamageResult(
      context.damageResults,
      attackerAfterTiming.battleUnitId,
      targetAfterTiming.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  const hitConfirmedEventsStart = context.recorder.getEvents().length;
  const hitConfirmed = context.recorder.record({
    eventType: "HitConfirmed",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: context.parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
    },
  });

  // PR #283再レビュー[P1]: R-DMG-05 #2「命中判定」の結果である`HitConfirmed`は、
  // #3「会心判定」へ進む前に連鎖を解決し切る。callbackありの経路では
  // `effect-action-group-resolver.ts`の`innerEvents`が常に空になるため、ここで
  // 通知しないとPS/Memoryへ一度も届かない。
  yield* notifyOrYieldNewEvents(context, working, hitConfirmedEventsStart);

  // PR #283再々レビュー[P1]: `HitConfirmed`の子連鎖はDAMAGEを行いうるため、
  // 会心判定へ進む前に生存を再検証して不要な乱数消費とイベント発行を避ける。
  const afterHitConfirmed = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterHitConfirmed.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterHitConfirmed.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      afterHitConfirmed.attacker.battleUnitId,
      afterHitConfirmed.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  // 会心判定は上の連鎖を反映した最新の使用者状態から行う（連鎖が会心率・会心
  // ダメージのバフを付与・失効させ得るため）。
  const attackerBeforeCritical = afterHitConfirmed.attacker;
  const critical = resolveCritical(
    profile.criticalMode,
    createPercentage(attackerBeforeCritical.combatStats.criticalRate),
    attackerBeforeCritical.combatStats.criticalDamageBonus,
    random,
  );

  const criticalCheckResolvedEventsStart = context.recorder.getEvents().length;
  const criticalCheckResolved = context.recorder.record({
    eventType: "CriticalCheckResolved",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: hitConfirmed.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      mode: profile.criticalMode,
      baseCriticalRate: critical.baseRate,
      effectiveCriticalRate: critical.effectiveRate,
      result: critical.isCritical,
    },
  });
  // PR #283再レビュー[P1]: `CriticalCheckResolved`をtriggerにするproduction PSが
  // 実在するため、`DamageWillBeApplied`へ進む前にここで連鎖を解決する。
  yield* notifyOrYieldNewEvents(context, working, criticalCheckResolvedEventsStart);

  // PR #283再々レビュー[P1]: `CriticalCheckResolved`の子連鎖も同様にDAMAGEを
  // 行いうるため、`DamageWillBeApplied`を発行する前に生存を再検証する。
  const afterCriticalCheck = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (afterCriticalCheck.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (afterCriticalCheck.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      afterCriticalCheck.attacker.battleUnitId,
      afterCriticalCheck.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }

  // R-DMG-05 #4（DMG-001、Issue #195）: 命中・会心の確定後、ダメージ計算より前に
  // `DamageWillBeApplied`（TIMING）を発行する。
  const willBeAppliedEventsStart = context.recorder.getEvents().length;
  // R-DMG-04（DMG-002、Issue #192）: この時点の集計結果をsnapshotとして載せる。
  // 下の連鎖が軽減効果を付け外しし得るため、確定値は`DamageCalculated`側で改めて集計する。
  const willBeAppliedMultipliers = composeDamageModifiers({
    attacker: afterCriticalCheck.attacker,
    defender: afterCriticalCheck.target,
    damageType: profile.damageType,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
  });
  const damageWillBeApplied = context.recorder.record({
    eventType: "DamageWillBeApplied",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: criticalCheckResolved.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      damageType: profile.damageType,
      isCritical: critical.isCritical,
      criticalMultiplier: critical.multiplier,
      defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
      shieldIgnoreRate: profile.piercing.shieldIgnoreRate,
      damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
      outgoingDamageMultiplier: willBeAppliedMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: willBeAppliedMultipliers.incomingMultiplier,
    },
  });
  lastEventId = damageWillBeApplied.eventId;
  // PR #283レビュー[P1]: PS/Memory自身のEffectSequence解決では、この連鎖を
  // ここで解決しないと「TIMINGイベント後に親処理の前提を再検証する」契約を破る。
  yield* notifyOrYieldNewEvents(context, working, willBeAppliedEventsStart);

  // 「TIMINGイベント後の再検証」: 連鎖が使用者を戦闘不能にしたなら残りのヒットを
  // 中断し（R-SKL-01/R-SKL-03）、対象を戦闘不能にしたならこのヒットを適用しない。
  const beforeDamage = revalidateHit(context, working, attackerUnitId, targetUnitId);
  if (beforeDamage.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }
  if (beforeDamage.kind === "SKIP") {
    recordDamageResult(
      context.damageResults,
      beforeDamage.attacker.battleUnitId,
      beforeDamage.target.battleUnitId,
      0,
      context.skillUseId,
    );
    return { kind: "SKIP", lastEventId };
  }
  return {
    kind: "CONFIRMED",
    attacker: beforeDamage.attacker,
    target: beforeDamage.target,
    critical,
    lastEventId,
    damageWillBeAppliedEventId: damageWillBeApplied.eventId,
  };
}

/** `absorbBeforeHitPointsSteps`が返す、HP適用より前に吸収された量の内訳。 */
interface AbsorptionBeforeHitPoints {
  /** R-SHD-02 #2: ダメージタイプに対応するタイプありシールドの吸収量。 */
  readonly typedShieldAbsorbed: number;
  /** R-SHD-02 #3: タイプなしシールドの吸収量。 */
  readonly untypedShieldAbsorbed: number;
  /** R-SHD-02 #4／R-SUB-01: サブユニットの吸収量。 */
  readonly subUnitAbsorbed: number;
  /**
   * PR #289再レビュー[P2]: 吸収イベント（`ShieldConsumed`/`SubUnitDamaged`）の
   * PS/Memory連鎖が前提を崩したため、残りの吸収先へ進まずに打ち切ったことを表す。
   * `INTERRUPT`は使用者の戦闘不能（R-SKL-01「使用者が戦闘不能になった場合、未解決
   * 効果を中断する」）、`SKIP`は対象の戦闘不能（R-ACTN-01 #2）。どちらの場合も
   * 呼び出し側はHP適用と`HitPointReduced`以降のイベントへ進んではならない —
   * 既に解決した吸収だけを残してこのヒットを終える。
   */
  readonly interruption: "NONE" | "INTERRUPT" | "SKIP";
  readonly lastEventId: DomainEventId;
}

/**
 * R-SHD-02 #2〜#4（DMG-004、Issue #194／DMG-005、Issue #190）: HPへ到達する前の
 * 吸収先へ、`poolDamage`（`shieldIgnoreRate`分を除いた残り）を規定の順序
 * 「タイプありシールド → タイプなしシールド → サブユニット」で振り分ける。
 * `08_ドメインイベント.md`「ダメージイベント」の並び（`DamageCalculated`→
 * `ShieldConsumed`／`SubUnitDamaged`→`HitPointReduced`→`DamageApplied`）どおり、
 * 吸収はHP適用より前に記録する。
 *
 * PRレビュー[P1]（DMG-004）: **プール1つ／サブユニット1体**を単位に
 * 「減少 → `ShieldConsumed`（`SubUnitDamaged`）→ PS/Memory即時連鎖の解決 →
 * 枯渇分の`EffectExpired`とR-EFF-09カスケード」を完了させてから次の吸収先・HPへ
 * 進む。まとめて吸収してから通知すると、先行する吸収イベントに反応するPSが
 * 「まだ未処理のはずの後続の吸収先とHPまで変更済み」の状態を観測し、
 * `DamageApplied`に反応するPSが残量0のシールド／サブユニットとそのlinked groupを
 * まだ有効として観測してしまう（どちらも`catalog-event-types.ts`でFACT triggerと
 * して許可されている）。
 *
 * サブユニットはシールドの後（R-SUB-01第1項「通常シールドをすべて適用した後に
 * サブユニットがダメージを受ける」）で、タイプ区分を持たない。R-SUB-01第2項の
 * 「毒、炎上など、通常シールドで受けられないダメージはサブユニットでも受けない」は
 * 呼び出し側の責務である — `continuous-damage-service.ts`はBURN/POISONを
 * この関数へ渡さない。
 */
function* absorbBeforeHitPointsSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  damageType: DamageType,
  poolDamage: number,
  parentEventId: DomainEventId,
  hitContext: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
  },
): Generator<DamageStep, AbsorptionBeforeHitPoints, readonly BattleUnit[] | undefined> {
  const absorbedByPool = new Map<DamageType | null, number>();
  let remaining = poolDamage;
  let lastEventId = parentEventId;
  let interruption: AbsorptionBeforeHitPoints["interruption"] = "NONE";
  /**
   * PR #289レビュー[P2]（DMG-005、Issue #190）: `ShieldConsumed`/`SubUnitDamaged`起点の
   * PS/Memory即時連鎖は`working`を書き換え得る（攻撃者・対象を戦闘不能にする等）。
   * R-SKL-01/R-SKL-03の中断契約に従い、連鎖の解決後は毎回この判定を通してから
   * 次の吸収先へ進む。
   *
   * PR #289再レビュー[P2]: 打ち切った事実を戻り値へ載せる。以前は残ダメージを
   * そのままHPへ向けていたため、「使用者が戦闘不能になった後もそのヒットのHP適用だけは
   * 続く」というR-SKL-01違反が残っていた。
   */
  const absorptionInterrupted = (): boolean => {
    const revalidation = revalidateHit(context, working, attackerUnitId, targetUnitId);
    if (revalidation.kind === "CONTINUE") {
      return false;
    }
    interruption = revalidation.kind;
    return true;
  };
  // 「対応しないタイプありシールドへダメージを適用しない」（R-SHD-02末尾）ため、
  // このヒットの`damageType`と一致するタイプありプールと、タイプなしプールだけを
  // この順に走査する。
  for (const shieldType of [damageType, null] as const) {
    if (remaining <= 0) {
      break;
    }
    // 直前のプールの連鎖が残量・保持者を変え得るため、そのつど最新状態から取り直す。
    const holder = working.get(targetUnitId);
    if (holder === undefined) {
      break;
    }
    const absorption = absorbFromShieldPool(holder, remaining, shieldType);
    if (absorption.change === undefined) {
      continue;
    }
    const holderAfterPool: BattleUnit = { ...holder, appliedEffects: absorption.appliedEffects };
    working.set(targetUnitId, holderAfterPool);
    remaining -= absorption.absorbed;
    absorbedByPool.set(shieldType, absorption.absorbed);

    const consumedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitShieldConsumed(
      context,
      holderAfterPool,
      absorption.change,
      "DAMAGE_ABSORPTION",
      lastEventId,
      hitContext,
    );
    yield* notifyOrYieldNewEvents(context, working, consumedEventsStart);

    // R-SHD-01第3項（個別消滅条件）: このプールで使い切ったインスタンスを、
    // 次のプール・サブユニット・HPへ進む前に失効させる。
    if (absorption.change.depletedEffectInstanceIds.length > 0) {
      const expiry = yield* driveRemovalSteps(
        context,
        working,
        expireDepletedAbsorberSteps(
          context,
          Array.from(working.values()),
          targetUnitId,
          absorption.change.depletedEffectInstanceIds,
          "SHIELD_DEPLETED",
          lastEventId,
        ),
      );
      lastEventId = expiry.lastEventId;
    }
    // PR #289レビュー[P2]: このプールの連鎖が攻撃者・対象を戦闘不能にしていれば、
    // 残りの吸収先へ進まない（R-SKL-01/R-SKL-03）。
    if (absorptionInterrupted()) {
      return {
        typedShieldAbsorbed: absorbedByPool.get(damageType) ?? 0,
        untypedShieldAbsorbed: absorbedByPool.get(null) ?? 0,
        subUnitAbsorbed: 0,
        interruption,
        lastEventId,
      };
    }
  }

  // R-SUB-01第1項: シールドを通り抜けた残りをサブユニットへ。1体ずつ
  // 「減少→`SubUnitDamaged`→連鎖→枯渇失効」を完了してから次の1体へ進む。
  // 連鎖が新しいサブユニットを付与しても同じヒットで無限に吸収し続けないよう、
  // 進行はあくまで残ダメージが尽きるか吸収できるインスタンスが無くなるまでとし、
  // 各周回で`working`から最新の保持者を取り直す。
  let subUnitAbsorbed = 0;
  while (remaining > 0) {
    const holder = working.get(targetUnitId);
    if (holder === undefined) {
      break;
    }
    const absorption = absorbFromNextSubUnit(holder, remaining);
    if (absorption.change === undefined) {
      break;
    }
    const holderAfter: BattleUnit = { ...holder, appliedEffects: absorption.appliedEffects };
    working.set(targetUnitId, holderAfter);
    remaining -= absorption.absorbed;
    subUnitAbsorbed += absorption.absorbed;

    const damagedEventsStart = context.recorder.getEvents().length;
    lastEventId = emitSubUnitDamaged(
      context,
      holderAfter,
      absorption.change,
      "DAMAGE_ABSORPTION",
      lastEventId,
      hitContext,
    );
    yield* notifyOrYieldNewEvents(context, working, damagedEventsStart);

    if (absorption.change.depleted) {
      const expiry = yield* driveRemovalSteps(
        context,
        working,
        expireDepletedAbsorberSteps(
          context,
          Array.from(working.values()),
          targetUnitId,
          [absorption.change.effectInstanceId],
          "SUBUNIT_DEPLETED",
          lastEventId,
        ),
      );
      lastEventId = expiry.lastEventId;
    }
    // PR #289レビュー[P2]: シールドプールと同じく、このサブユニットの連鎖が
    // 攻撃者・対象を戦闘不能にしていれば次の1体へ進まない（R-SKL-01/R-SKL-03）。
    if (absorptionInterrupted()) {
      break;
    }
  }

  return {
    typedShieldAbsorbed: absorbedByPool.get(damageType) ?? 0,
    untypedShieldAbsorbed: absorbedByPool.get(null) ?? 0,
    subUnitAbsorbed,
    interruption,
    lastEventId,
  };
}

/**
 * `applyConfirmedDamageSteps`の結果。`APPLIED`以外は吸収の途中でPS/Memory連鎖が前提を
 * 崩したことを表し、`INTERRUPT`（使用者の戦闘不能）は残りのヒットも中断させる。
 */
type ConfirmedDamageApplication = {
  readonly kind: "APPLIED" | "INTERRUPT" | "SKIP";
  readonly lastEventId: DomainEventId;
};

/**
 * R-DMG-05 #6〜#8 ＋ R-SHD-02/R-SUB-01: 確定した1ヒットのダメージ量を実際に適用する
 * （吸収先への振り分け → HP → `HitPointReduced` → `DamageApplied` →（致死なら）
 * `UnitDefeated` → PS/Memory連鎖 → R-EFF-07の`OUTGOING_HIT`/`INCOMING_HIT`消費）。
 *
 * PR #289レビュー[P1]（DMG-005、Issue #190）: `observeHitSteps`と同じ理由で、通常
 * ヒットとサブユニット追加ダメージが**同じ適用経路**を共有するために切り出した。
 * 呼び出し側の違いは`finalDamage`をどう計算したかだけである。
 */
function* applyConfirmedDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  profile: Pick<
    HitObservationProfile,
    "effectActionDefinitionId" | "hitIndex" | "damageType" | "piercing"
  >,
  finalDamage: number,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  const targetBeforeAbsorption = findUnit(working, targetUnitId, "hits[].targetBattleUnitId");

  const hpDirectDamage = shieldBypassedDamage(finalDamage, profile.piercing.shieldIgnoreRate);
  const absorption = yield* absorbBeforeHitPointsSteps(
    context,
    working,
    attackerUnitId,
    targetUnitId,
    profile.damageType,
    finalDamage - hpDirectDamage,
    lastEventId,
    { effectActionDefinitionId: profile.effectActionDefinitionId, hitIndex: profile.hitIndex },
  );
  lastEventId = absorption.lastEventId;
  if (absorption.interruption !== "NONE") {
    // PR #289再レビュー[P2]: 吸収イベントの連鎖が使用者を戦闘不能にした
    // （R-SKL-01「未解決効果を中断する」）、または対象を戦闘不能にした
    // （R-ACTN-01 #2）場合、このヒットはHPへ到達しない。既に解決した吸収
    // （`ShieldConsumed`/`SubUnitDamaged`が自身のStateDeltaで記録済み）はそのまま残し、
    // `HitPointReduced`以降のイベントは発行しない。
    // R-SKL-08: 確定した`DamageApplied`を持たないヒットは、他の不成立ヒットと同じく
    // 直前結果へ0を記録する（以前の成功結果を透けて見せないため）。
    recordDamageResult(context.damageResults, attackerUnitId, targetUnitId, 0, context.skillUseId);
    return { kind: absorption.interruption, lastEventId };
  }

  // 吸収の連鎖（`ShieldConsumed`/`SubUnitDamaged`/`EffectExpired`）の解決後の
  // 最新状態からHPを起点にする。
  const targetAfterAbsorption = working.get(targetUnitId) ?? targetBeforeAbsorption;
  const absorbedBeforeHitPoints =
    absorption.typedShieldAbsorbed + absorption.untypedShieldAbsorbed + absorption.subUnitAbsorbed;

  const hpBefore = targetAfterAbsorption.currentHp;
  // R-SHD-02 #5: 吸収先を通り抜けた残りがHPへ向かう（`hpDirectDamage`を含む）。
  const hitPointDamage = finalDamage - absorbedBeforeHitPoints;
  const hpAfter = Math.max(0, hpBefore - hitPointDamage);
  // R-SHD-03第2項「HPを0未満にせず、超過分を破棄する」。
  const discardedDamage = hitPointDamage - (hpBefore - hpAfter);
  const updatedTarget: BattleUnit = {
    ...targetAfterAbsorption,
    // R-NUM-02: `combatStats.maximumHp`は全精度（R-STA-01/R-NUM-01）で保持されるため、
    // HPゲージへ渡す境界で最大値を0方向へ切り捨てて整数化する。
    currentHp: createHitPoint(
      hpAfter,
      truncateFraction(targetAfterAbsorption.combatStats.maximumHp),
    ),
  };
  working.set(targetUnitId, updatedTarget);
  // R-SKL-08（レビュー再指摘[P1]、PR #214）＋G-10／RES-003A（Issue #257）:
  // 確定した結果を直前結果と`SUM_DAMAGE_*`の累計へ記録する。`BattleUnit`の永続
  // フィールドではないため、StateDelta・独立Reducer復元の対象にはならない。
  recordDamageResult(
    context.damageResults,
    attackerUnitId,
    targetUnitId,
    finalDamage,
    context.skillUseId,
  );

  // `08_ドメインイベント.md`「HitPointReduced」(RES-005、Issue #172): HPを減らした後、
  // R-DMG-05の並び上は`DamageCalculated`と`DamageApplied`の間に発行する。HP変化の
  // StateDeltaはここに持たせる — `DamageApplied`にも同じdeltaを付けると独立Reducer
  // 復元が同じ変化を二重適用してしまうため。
  const hitPointReduced = context.recorder.record({
    eventType: "HitPointReduced",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      hitPointDamage: hpBefore - hpAfter,
      hpBefore,
      hpAfter,
    },
    stateDelta: { units: { [targetUnitId]: { hp: { before: hpBefore, after: hpAfter } } } },
  });

  const damageApplied = context.recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: hitPointReduced.eventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      calculatedDamage: finalDamage,
      // R-SHD-02/03（DMG-004、Issue #194）＋R-SUB-01（DMG-005、Issue #190）:
      // 適用先ごとの内訳。`typedShieldAbsorbed + untypedShieldAbsorbed +
      // subUnitAbsorbed + hitPointDamage + discardedDamage === calculatedDamage`
      // （`08_ドメインイベント.md`不変条件#6）。
      hpDirectDamage,
      typedShieldAbsorbed: absorption.typedShieldAbsorbed,
      untypedShieldAbsorbed: absorption.untypedShieldAbsorbed,
      subUnitAbsorbed: absorption.subUnitAbsorbed,
      discardedDamage,
      hitPointDamage: hpBefore - hpAfter,
      hpBefore,
      hpAfter,
      defeated: isDefeated(updatedTarget),
    },
  });

  // R-SKL-01/02: このヒットが発行した事実イベントそれぞれからのPS即時連鎖を、
  // 発生順に（DamageApplied→UnitDefeatedがあればその後）次のヒットへ進む前に解決する。
  // 致死ヒットでも`DamageApplied`起点のPS（例:「味方がダメージを受けた時」）を
  // `UnitDefeated`だけに上書きして見逃さないよう、両方を個別にフックへ渡す
  // （PR #141レビュー[P1]）。`UnitDefeated`は「HPが0へ遷移した」ヒットだけが発行する
  // — `includeDefeated: true`（PR #215）では既に戦闘不能な対象へもヒットが続くため、
  // 判定基準は吸収連鎖の解決後（`targetAfterAbsorption`）の状態にする。
  lastEventId = damageApplied.eventId;
  // `FreezeRemoved`（と、あればそのカスケード）と吸収イベント（およびその枯渇失効）は
  // このヒットのHP適用より前に既に連鎖通知済みのため含めない。
  const factEvents: BattleDomainEvent[] = [hitPointReduced, damageApplied];
  if (!isDefeated(targetAfterAbsorption) && isDefeated(updatedTarget)) {
    const unitDefeated = context.recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: damageApplied.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attackerUnitId,
      targetUnitIds: [targetUnitId],
      payload: { unitId: targetUnitId, causeEventId: damageApplied.eventId },
    });
    factEvents.push(unitDefeated);
    lastEventId = unitDefeated.eventId;
  }

  // PS/Memory自身のEffectSequence解決（callback未指定）では、これらのFACTイベントを
  // `effect-action-group-resolver.ts`が`innerEvents`としてEffectAction完了時に
  // まとめてdriverへ渡す（DMG-001以来の既存契約）ため、ここでは`yield`しない。
  if (context.onFactEventForPassiveChain !== undefined) {
    for (const factEvent of factEvents) {
      const updatedUnits = context.onFactEventForPassiveChain(
        factEvent,
        Array.from(working.values()),
      );
      for (const unit of updatedUnits) {
        working.set(unit.battleUnitId, unit);
      }
    }
  }

  // R-EFF-07: このヒットがMISSでなく確定した時点でOUTGOING_HIT（攻撃者側）/
  // INCOMING_HIT（対象側）を消費する。R-HIT-04の回避効果（EVASION/HIT_EVASION）は
  // この一括消費の対象外で、`consumeEffectDurations`が常に除外する — Nヒット回避は
  // 自身が回避した被ヒットでだけ消費するため（PR #275レビュー[P1]）。
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    attackerUnitId,
    "OUTGOING_HIT",
    lastEventId,
  );
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    targetUnitId,
    "INCOMING_HIT",
    lastEventId,
  );
  return { kind: "APPLIED", lastEventId };
}

/**
 * `applySubUnitAdditionalDamageSteps`の結果。`interrupted`は使用者の戦闘不能で追加
 * ヒットを未解決のまま残したことを表し、`ApplyDamageActionResult.interrupted`へ伝わる
 * （追加ヒットは`hits`に含まれないため`interruptedCount`では表せない）。
 */
interface SubUnitAdditionalDamageResult {
  readonly lastEventId: DomainEventId;
  readonly interrupted: boolean;
}

/**
 * R-SUB-02（DMG-005、Issue #190）: 1つのDAMAGE EffectActionの解決が終わった直後に、
 * 使用者が保持するサブユニットの追加ダメージを解決する。
 *
 * - 「所持者の攻撃対象ごとに追加ダメージを1ヒット加える」「複数対象への攻撃では、
 *   各対象へ1ヒットずつ加える」: この攻撃で実際に適用されたヒットの**対象**を
 *   重複なく（初出順で）並べ、その各対象へ加える。同じ対象への複数ヒットは
 *   1回にまとまる
 * - 所持者が同じサブユニットを複数保持していればその数だけ加える
 *   （production例: `SKL_OLGA_VETERAN_PS1`「サブユニット『カムラッドⅡ』を3つ付与する」）
 * - 「追加ダメージでは通常の防御力減衰を行わない」: `damage-calculator.ts`を
 *   経由せず、`SUBUNIT_ADDITIONAL_DAMAGE` Formula（対象の現在防御力をそのまま
 *   差し引く）の結果へ、通常のダメージ規則どおりの最終切り捨てと最低1ダメージ
 *   （R-DMG-02）だけを適用する。会心判定・命中判定・属性相性・与被ダメージ補正は
 *   いずれも行わない — R-SUB-02はそれらを一切規定せず、追加ダメージは所持者の
 *   スキルではなくサブユニットが持つ固定の効果だからである
 * - 使用者が途中で戦闘不能になり残りのヒットを中断した場合（R-SKL-01/R-SKL-03）は
 *   追加ダメージも行わない。既に戦闘不能になった対象も飛ばす（R-ACTN-01 #2）
 *
 * サブユニットの並びは**解決を始める前に**確定させる（`shieldDecayPools`と同じ
 * 規約）— 追加ダメージ自身のPS/Memory連鎖が新しいサブユニットを付与しても、同じ
 * 攻撃で連鎖的に追加ダメージが増えないようにするためである。実際の値（所持者の
 * 攻撃力・対象の防御力）だけをそのつど最新状態から求める。
 */
function* applySubUnitAdditionalDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  outcomes: readonly DamageHitOutcome[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  interrupted: boolean,
  parentEventId: DomainEventId,
): Generator<DamageStep, SubUnitAdditionalDamageResult, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  if (interrupted) {
    // 元のヒット列が既に中断されている（`interruptedCount`が表す）。
    return { lastEventId, interrupted: false };
  }
  const attacker = working.get(attackerUnitId);
  const sources = attacker === undefined ? [] : subUnitAdditionalDamageSources(attacker);
  if (sources.length === 0) {
    // サブユニットを保持していなければ未解決の追加ヒットも存在しない。
    return { lastEventId, interrupted: false };
  }
  if (attacker === undefined || isDefeated(attacker)) {
    // PR #289再々レビュー[P2]: 最後のヒットの連鎖で使用者が戦闘不能になった場合、
    // 追加ヒットは未解決のまま残る（R-SKL-01「未解決効果を中断する」）。
    return { lastEventId, interrupted: true };
  }
  // 「所持者の**攻撃対象**ごとに」（R-SUB-02第1項）が数えるのは、その攻撃が誰を
  // 狙ったかであって、攻撃自身のヒットが通ったかではない — 追加ダメージは独立した
  // 1ヒットとして自前の命中判定を持つ（`applyOneSubUnitAdditionalDamageSteps`）ため、
  // 元のヒットが回避されていても対象からは外さない。既に戦闘不能な対象は下の
  // `isDefeated`判定が除く（R-ACTN-01 #2）。使用者の戦闘不能による中断
  // （`interrupted`）はこの関数の冒頭で既に打ち切っている。
  const targetUnitIds = [...new Set(outcomes.map((outcome) => outcome.targetBattleUnitId))];

  // 追加ダメージのヒット番号は、この攻撃の追加ダメージ列の中で0から通し番号にする
  // （元のDAMAGE EffectActionのヒット番号とは別系列であり、`effectActionDefinitionId`
  // もサブユニット側の定義IDになるため衝突しない）。
  let additionalHitIndex = 0;
  for (const targetUnitId of targetUnitIds) {
    for (const source of sources) {
      const owner = working.get(attackerUnitId);
      if (owner === undefined || isDefeated(owner)) {
        return { lastEventId, interrupted: true };
      }
      const target = working.get(targetUnitId);
      if (target === undefined || isDefeated(target)) {
        break;
      }
      // このサブユニットが直前の連鎖で解除・枯渇していれば追加ダメージも起きない。
      const stillHeld = owner.appliedEffects.some(
        (effect) =>
          effect.effectInstanceId === source.effectInstanceId &&
          effect.subUnit !== undefined &&
          effect.subUnit.durability > 0,
      );
      if (!stillHeld) {
        continue;
      }
      const hitIndex = additionalHitIndex;
      additionalHitIndex += 1;
      const additionalHit = yield* applyOneSubUnitAdditionalDamageSteps(
        context,
        working,
        random,
        owner.battleUnitId,
        target.battleUnitId,
        source,
        {
          effectActionDefinitionId: source.effectActionDefinitionId,
          hitIndex,
          // R-SUB-02（`ApplySubunitPayload.additionalDamage.damageType`）: 明示が
          // なければこの追加ダメージの契機になった攻撃のダメージタイプを引き継ぐ。
          damageType: source.additionalDamage.damageType ?? damageAction.payload.damageType,
          // 命中特性は契機になった攻撃から引き継ぐ（`damageType`の既定と同じ規約）。
          accuracyMode: damageAction.payload.accuracy.mode,
          // R-SUB-02の計算式に会心の項が無く、Catalogにも会心モードの宣言が無い。
          criticalMode: "PREVENTED",
          // R-SUB-02にもCatalogスキーマにも追加ダメージの貫通を表す項が無い。
          piercing: {
            defenseIgnoreRate: 0,
            shieldIgnoreRate: 0,
            damageReductionIgnoreRate: 0,
          },
        },
        lastEventId,
      );
      lastEventId = additionalHit.lastEventId;
      // PR #289再々レビュー[P2]: 追加ヒット自身の観測・吸収連鎖で使用者が戦闘不能に
      // なった場合も、残る追加ヒットを解決せずここで打ち切る（R-SKL-01）。
      if (additionalHit.kind === "INTERRUPT") {
        return { lastEventId, interrupted: true };
      }
    }
  }
  return { lastEventId, interrupted: false };
}

/**
 * `applySubUnitAdditionalDamageSteps`が1体×1対象について行う解決。
 *
 * PR #289レビュー[P1]: raw原文（`戦闘システム.md`）の「サブユニットが攻撃に対して
 * 追加するダメージは１ヒットとして扱われます」に従い、通常ヒットとまったく同じ
 * 観測（`observeHitSteps`）と適用（`applyConfirmedDamageSteps`）を通す。これにより
 * Nヒット回避（R-HIT-04）・被ヒット消費条件（R-EFF-07の`OUTGOING_HIT`/
 * `INCOMING_HIT`）・`HitConfirmed`／`CriticalCheckResolved`起点のPSが、追加ヒットも
 * 他のヒットと同じように観測できる。
 *
 * 通常ヒットと異なるのは**ダメージ計算だけ**で、R-SUB-02が定める次の3点に限られる。
 *
 * - `SUBUNIT_ADDITIONAL_DAMAGE` Formulaの結果をそのまま丸めて最終ダメージにする
 *   （`damage-calculator.ts`の防御力減衰・属性相性・与被ダメージ補正を経由しない、
 *   「追加ダメージでは通常の防御力減衰を行わない」）
 * - 会心は`PREVENTED`固定にする。R-SUB-02の計算式に会心の項が無く、サブユニットは
 *   会心モードを宣言するCatalog fieldも持たないためである（`CriticalCheckResolved`
 *   自体は他のヒットと同じく発行し、乱数も消費しない）
 * - 貫通（`piercing`）を持たない。R-SUB-02にもCatalogスキーマにも対応する項が無い
 *
 * `accuracy`は契機になった攻撃のものを引き継ぐ（`damageType`の既定と同じ規約）—
 * 追加ヒットは所持者の「その攻撃」に加わるものであり、独立した命中特性を持たない。
 */
function* applyOneSubUnitAdditionalDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  source: SubUnitAdditionalDamageSource,
  profile: HitObservationProfile,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  const observation = yield* observeHitSteps(
    context,
    working,
    random,
    attackerUnitId,
    targetUnitId,
    profile,
    parentEventId,
  );
  if (observation.kind !== "CONFIRMED") {
    return { kind: observation.kind, lastEventId: observation.lastEventId };
  }
  const owner = observation.attacker;
  const target = observation.target;

  const formulaContext = {
    skillSource: owner,
    target,
    allUnits: Array.from(working.values()),
    subUnitProviderAttack: source.providerAttack,
  };
  const formulaResult = evaluateFormula(
    source.additionalDamage.formula,
    formulaContext,
    "subUnit.additionalDamage.formula",
  );
  // R-DMG-04（DMG-002、Issue #192）: 与／被ダメージ補正は「攻撃側／防御側に有効な
  // `APPLY_DAMAGE_MOD`を集計する」規則であり、ダメージの出どころを限定していない。
  // R-DOT-01が継続ダメージについて「ダメージ軽減・増加、属性相性の影響を受けない」と
  // 明示的に除外しているのに対し、R-SUB-02が除外するのは防御力減衰だけであるため、
  // 1ヒットとして扱う追加ダメージにはこの補正が乗る。
  //
  // PR #289再レビュー[P2]: 以前は`DamageWillBeApplied`（`observeHitSteps`が集計）が
  // 実際の倍率を通知しながら`DamageCalculated`は常に1で計算しており、公開イベントと
  // `EVENT_PAYLOAD`条件が「実際には適用されない補正」を観測していた。集計は
  // R-DMG-04末尾どおり`DamageWillBeApplied`の連鎖解決**後**にやり直す。
  const damageModifierMultipliers = composeDamageModifiers({
    attacker: owner,
    defender: target,
    damageType: profile.damageType,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
  });
  // Q-DMG-01「ダメージ計算の途中では丸めず、最終結果で小数部分を切り捨てる」＋
  // R-DMG-02 #1/#3「最低1ダメージ」。属性相性（`attributeMultiplier`）と会心倍率が
  // 1のままなのは、R-SUB-02の計算式がそれらの項を持たないためである（`calculateDamage`の
  // 基本ダメージ式自体を経由しない）。
  const preTruncationDamage =
    formulaResult *
    damageModifierMultipliers.outgoingMultiplier *
    damageModifierMultipliers.incomingMultiplier;
  const truncatedDamage = Math.max(1, Math.floor(preTruncationDamage));
  // R-DMG-02「ダメージ無効効果がある場合も結果を1とする」: 通常ヒットと同じく、
  // 切り捨て後の値を「incoming raw damage」として対象の有効なDAMAGE_IMMUNITYを判定する。
  const damageImmunity = resolveDamageImmunity(target, truncatedDamage, formulaContext);
  const finalDamage = damageImmunity.nullified ? 1 : truncatedDamage;

  const damageCalculated = context.recorder.record({
    eventType: "DamageCalculated",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: observation.damageWillBeAppliedEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: owner.battleUnitId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId: target.battleUnitId,
      attackerAttack: owner.combatStats.attack,
      defenderDefense: target.combatStats.defense,
      // R-SUB-02末尾「追加ダメージでは通常の防御力減衰を行わない」: Formulaが
      // 対象の防御力をそのまま差し引くため、減衰後の実効防御という概念を持たない。
      effectiveDefense: target.combatStats.defense,
      defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
      shieldIgnoreRate: profile.piercing.shieldIgnoreRate,
      damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
      // `DamageCalculated.skillPower`はFormula評価結果そのもの（補正適用前）。
      skillPower: formulaResult,
      attributeMultiplier: 1,
      criticalMultiplier: observation.critical.multiplier,
      outgoingDamageMultiplier: damageModifierMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: damageModifierMultipliers.incomingMultiplier,
      actionDamageMultiplier: 1,
      preTruncationDamage,
      finalDamage,
      damageType: profile.damageType,
    },
  });

  const application = yield* applyConfirmedDamageSteps(
    context,
    working,
    owner.battleUnitId,
    target.battleUnitId,
    profile,
    finalDamage,
    damageCalculated.eventId,
  );
  let lastEventId = application.lastEventId;
  if (application.kind !== "APPLIED") {
    return { kind: application.kind, lastEventId };
  }

  // R-SUB-02第3項「追加デバフが定義されている場合も対象ごとに適用する」。
  // 追加ダメージの適用が完了した後に付与する — デバフ（例:
  // `SKL_SHIRANA_SORA_AS1`の行動速度-20）が対象のCombatStatを変える前に、この
  // 追加ダメージ自身の計算を終えておくためである。
  //
  // PR #289再レビュー[P2]: 付与の直前に前提を再検証する。この追加ダメージ自身が
  // 対象を倒した場合や、`DamageApplied`/`UnitDefeated`の連鎖が使用者を倒した場合、
  // 付与フックは通常のEffectAction解決（`effect-action-group-resolver.ts`の
  // R-ACTN-01 #2判定）を経由せず直接`grantEffect`まで進むため、ここで止めないと
  // 戦闘不能な対象へデバフが残り、R-SKL-01の中断契約にも反する。
  const debuff = source.additionalDamage.debuff;
  if (debuff !== undefined && context.grantSubUnitAdditionalDamageDebuff !== undefined) {
    const beforeDebuff = revalidateHit(context, working, owner.battleUnitId, target.battleUnitId);
    if (beforeDebuff.kind !== "CONTINUE") {
      // 使用者の戦闘不能はこの攻撃の残りの追加ヒットも中断させる（R-SKL-01）。
      return { kind: beforeDebuff.kind, lastEventId };
    }
    const granted = yield* driveRemovalSteps(
      context,
      working,
      context.grantSubUnitAdditionalDamageDebuff(
        target.battleUnitId,
        debuff.effectActionDefinitionId,
        owner.battleUnitId,
        Array.from(working.values()),
        lastEventId,
      ),
    );
    lastEventId = granted.lastEventId;
  }
  return { kind: "APPLIED", lastEventId };
}

/**
 * `DamageApplicationService` の基本形 (`05_ドメインモデル.md`)。`SkillResolutionService`が
 * 解決した1つのDAMAGE EffectActionのヒット列を、R-DMG-05の順序（命中→会心→
 * ダメージ適用直前TIMING→ダメージ計算→HP適用→戦闘不能判定）でヒットごとに
 * 処理する。R-ACTN-01/R-SKL-03:
 * 参照時点で既に戦闘不能な対象へのヒットは、`context.includeDefeated`（選択元
 * `TargetSelectorDefinition.includeDefeated`）が`true`でない限り適用をスキップ
 * する（レビュー再指摘[P2]、PR #215: 非DAMAGE種別と同じ明示指定を尊重する）。
 * R-SKL-01/R-SKL-03:
 * 使用者(attacker)自身が途中で戦闘不能になった場合、以降の未解決ヒットをすべて
 * 中断する（対象が異なるヒットも含む）。シールド・サブユニット・リンクダメージへの
 * 適用調整(R-SHD-*、R-SUB-*、R-LNK-*)はM8未実装のため、HPへ直接適用する。
 * 適用されたヒットごとに `HitConfirmed`→`CriticalCheckResolved`→`DamageWillBeApplied`
 * →`DamageCalculated`→`HitPointReduced`→`DamageApplied`（→`UnitDefeated`）を発行する。
 * スキップしたヒットは命中が確定して
 * いないためイベントを発行しない（`08_ドメインイベント.md`「HitConfirmed」）。
 *
 * `08_ドメインイベント.md`「TIMINGイベント後の再検証」: 子連鎖はDAMAGEを行いうる
 * （production例: `SKL_EVIE_KYONSHI_PS1`・`SKL_LAYLA_ENTREPRENEUR_PS2`は
 * `CriticalCheckResolved`起点でDAMAGEを行う）ため、下の各通知の直後に
 * `revalidateHit`で前提を再検証してから次の判定・イベントへ進む（PR #283
 * 再々レビュー[P1]）。対象が戦闘不能になればこのヒットを適用せず、使用者が
 * 戦闘不能になれば残りのヒットをすべて中断する。判定・計算の入力も、そのつど
 * 連鎖後の最新状態から取り直す。
 *
 * 1ヒットが発行する内部イベントは、記録直後にPS/Memory即時連鎖へ届けて次の判定へ
 * 進む前に解決し切る（`notifyOrYieldNewEvents`、PR #283再レビュー[P1]）。
 * `UnitBeingAttacked`・`EvasionActivated`・`HitConfirmed`・`CriticalCheckResolved`・
 * `DamageWillBeApplied`が対象で、消費失効・凍結解除カスケードは`consumeAndExpire`／
 * `driveRemovalSteps`が除去1件ごとに同じ規約で解決する。解決経路は2通り。
 *
 * - `context.onFactEventForPassiveChain`あり（AS/EX・チャージ解放）: その場で
 *   同期通知する。この経路では`effect-action-group-resolver.ts`の`innerEvents`が
 *   常に空になるため、ここで通知しないイベントは連鎖へ一度も届かない
 * - 未指定（PS/Memory自身のEffectSequence解決）: 1ステップ`yield`し、driver
 *   （`resolveOneEffectActionApplication`）が子連鎖を解決して更新した`units`を
 *   `.next()`で注入する
 *
 * `applyDamageAction`（下の同期wrapper）は
 * `yield`された値を読み捨てるため、連鎖driverを持たない呼び出し元・テストでは
 * 従来どおりの振る舞いになる。
 */
export function* applyDamageActionSteps(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
  context: DamageEventContext,
): Generator<
  { readonly events: readonly BattleDomainEvent[]; readonly units: readonly BattleUnit[] },
  ApplyDamageActionResult,
  readonly BattleUnit[] | undefined
> {
  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const outcomes: DamageHitOutcome[] = [];
  let interruptedCount = 0;
  // R-SKL-01: 使用者の戦闘不能で未解決の効果を残したかどうか。`hits`に含まれない
  // サブユニット追加ヒット（R-SUB-02）の中断も表せるよう`interruptedCount`とは別に持つ。
  let interrupted = false;
  let lastEventId = context.parentEventId;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const currentAttacker = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");

    // R-SKL-01/R-SKL-03: 使用者が戦闘不能になったら残りの未解決ヒットを中断する。
    if (isDefeated(currentAttacker)) {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }

    const target = findUnit(working, hit.targetBattleUnitId, "hits[].targetBattleUnitId");

    if (!(context.includeDefeated ?? false) && isDefeated(target)) {
      outcomes.push(skip(hit));
      // R-SKL-08（レビュー再々々指摘[P1]、PR #214）: 対象不在で適用されなかった
      // このヒットも「同じ解決スコープ内の直前結果」になる。以前の成功した
      // DAMAGE結果を透けて見せ続けないよう0として記録する（例外にはしない —
      // MISS等は有効な定義のもとで通常発生し得る実行時の結果であり、R-NUM-04が
      // 拒否対象とするCatalog定義エラーではないため）。
      recordDamageResult(
        context.damageResults,
        currentAttacker.battleUnitId,
        target.battleUnitId,
        0,
        context.skillUseId,
      );
      continue;
    }

    // R-DMG-05 #1〜#4／R-SKL-03: 1ヒットの観測（`UnitBeingAttacked`→消費→回避判定→
    // `HitConfirmed`→会心判定→`CriticalCheckResolved`→`DamageWillBeApplied`）は、
    // サブユニット追加ダメージ（R-SUB-02）と共有する`observeHitSteps`が解決する。
    const observation = yield* observeHitSteps(
      context,
      working,
      random,
      attacker.battleUnitId,
      hit.targetBattleUnitId,
      {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        damageType: damageAction.payload.damageType,
        accuracyMode: damageAction.payload.accuracy.mode,
        criticalMode: damageAction.payload.critical.mode,
        // R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003、Issue #196）: この定義自身の
        // 静的な貫通率へ、攻撃側が保持している`APPLY_PIERCING_MOD`の一時貫通を
        // 合成する。ヒットごとに評価するのは、同じEffectActionの途中でPS連鎖が
        // 新たな貫通を付与・解除しうるため（`composeDamageModifiers`と同じ粒度）。
        // `NEXT_OUTGOING_ATTACK`で消費されたインスタンスは
        // `finalizeConsumedEffectDurations`まで除去されないため、このヒットの
        // 計算にはまだ有効なものとして参加する。
        piercing: composePiercing(damageAction.payload.piercing, currentAttacker),
      },
      lastEventId,
    );
    lastEventId = observation.lastEventId;
    if (observation.kind === "INTERRUPT") {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }
    if (observation.kind === "SKIP") {
      outcomes.push(skip(hit));
      continue;
    }
    const critical = observation.critical;
    const attackerBeforeDamage = observation.attacker;
    const targetBeforeDamage = observation.target;

    // R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003、Issue #196。PR #296レビュー[P1]）:
    // このヒットで実際に使う貫通率を、`DamageWillBeApplied`のsnapshotではなく
    // 再検証後の攻撃側（`attackerBeforeDamage`）から改めて合成する。
    // `willBeAppliedMultipliers`と`damageModifierMultipliers`が同じ理由で
    // 二段構えになっているのと同じ扱い —— `DamageWillBeApplied`起点のPS連鎖が
    // 貫通を付け外ししうるため、確定値はここで採り直す必要がある。
    //
    // 以降の防御力無視・軽減無視・シールド無視・HP適用は、必ずこの1つの
    // `piercing`を参照する（`damageAction.payload.piercing`を直接読み直すと、
    // 一時付与が`DamageWillBeApplied`のpayloadにしか現れない）。
    const piercing = composePiercing(damageAction.payload.piercing, attackerBeforeDamage);
    const defenseIgnoreRate = piercing.defenseIgnoreRate;
    // R-NUM-04: `triggerSource`/`triggerTarget`はRES-005（Issue #172）が
    // `context.triggerSourceUnitId`/`triggerTargetUnitIds`（`TRIGGER_TARGET`は
    // 複数ユニットを指しうるが、Formula側は単一参照のため先頭の1体を使う、
    // R-TGT-10と同じ規約）から配線する。`bindings`はこの呼び出し元では
    // 引き続き用意できない。`lastResults`（R-SKL-08、レビュー再指摘[P1]
    // PR #214）は`context.damageResults`（呼び出し側が1解決スコープ
    // ごとに新規生成する共有registry）から、この攻撃者自身の直前DAMAGE結果と、
    // `context.skillUseId`が識別するEffectSequence解決の累計DAMAGE結果
    // （`SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`、G-10／RES-003A、Issue #257）
    // を取り出す。
    // PRレビュー指摘[P2]: IDから`working`（このヒット時点の最新状態、
    // 先行するヒットやPS連鎖による変更を反映済み）へ都度引き直す。R-DMG-02の
    // `damageThreshold`（`resolveDamageImmunity`）も同じcontextを再利用する
    // （`CURRENT_HP_RATIO(source: TARGET)`は対象=`targetBeforeDamage`自身の
    // 現在HPを参照する）。
    const formulaContext = {
      skillSource: attackerBeforeDamage,
      target: targetBeforeDamage,
      allUnits: Array.from(working.values()),
      lastResults: damageResultsFor(
        context.damageResults,
        attackerBeforeDamage.battleUnitId,
        context.skillUseId,
      ),
      ...(context.triggerSourceUnitId !== undefined
        ? {
            triggerSource: findUnit(
              working,
              context.triggerSourceUnitId,
              "context.triggerSourceUnitId",
            ),
          }
        : {}),
      ...(context.triggerTargetUnitIds?.[0] !== undefined
        ? {
            triggerTarget: findUnit(
              working,
              context.triggerTargetUnitIds[0],
              "context.triggerTargetUnitIds[0]",
            ),
          }
        : {}),
    };
    // R-DMG-04（DMG-002、Issue #192）: 与/被ダメージ倍率は`DamageWillBeApplied`の
    // 連鎖後の最新状態（`attackerBeforeDamage`/`targetBeforeDamage`）から集計する
    // — 連鎖が被ダメージ軽減効果を付与・解除し得るため、snapshotを使い回さない。
    // R-DMG-03の`damageReductionIgnoreRate`は、この集計の中で負の被ダメージ補正
    // だけへ適用する。
    const damageModifierMultipliers = composeDamageModifiers({
      attacker: attackerBeforeDamage,
      defender: targetBeforeDamage,
      damageType: damageAction.payload.damageType,
      damageReductionIgnoreRate: piercing.damageReductionIgnoreRate,
    });
    const rawDamageResult = calculateDamage({
      attackerAttack: attackerBeforeDamage.combatStats.attack,
      attackerAttribute: attackerBeforeDamage.attribute,
      attackerAffinityBonus: attackerBeforeDamage.combatStats.affinityBonus,
      defenderDefense: targetBeforeDamage.combatStats.defense,
      defenderAttribute: targetBeforeDamage.attribute,
      defenseIgnoreRate,
      skillPowerFormula: damageAction.payload.formula,
      damageModifiers: damageAction.payload.damageModifiers,
      criticalMultiplier: critical.multiplier,
      outgoingDamageMultiplier: damageModifierMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: damageModifierMultipliers.incomingMultiplier,
      formulaContext,
    });
    // R-STS-03「新たな攻撃スキルによるダメージで解除する」「解除契機となった
    // ダメージを凍結効果定義の増幅率だけ増加させる（既定値+50%）」＋
    // ON_ATTACK_BONUS_DAMAGE_BUFF（M7-004、Issue #183）: 対象が凍結中なら、この
    // 確定済みヒット（DAMAGE EffectAction、継続ダメージ・デバフのみのスキルは
    // `applyDamageAction`自体を経由しないため構造的に対象外）へ増幅を適用し
    // 凍結を解除する。攻撃者自身が保持する`APPLY_ATTACK_DAMAGE_BONUS`由来の
    // `AppliedEffect`（`isAttackDamageBonus: true`、`magnitude`は付与時点で
    // 評価済みのFormula結果）も合算する（複数付与されていれば全て加算）。
    // `14_Catalog定義スキーマ.md`「凍結のダメージ解除倍率」の規約どおり
    // `damageAmplificationOnBreak`は加算率（+50%を`0.5`で表す）であり、倍率
    // そのものではない — `1 + damageAmplificationOnBreak`が実際の倍率になる。
    // Q-DMG-01「ダメージ計算の途中では丸めず、最終結果で小数部分を切り捨てる」:
    // 増幅・追加ダメージは`calculateDamage`が既に切り捨てた`finalDamage`にでは
    // なく、丸め前の`preTruncationDamage`に適用し、この関数全体でただ一度だけ
    // 最終切り捨て・最低1ダメージ（R-DMG-02 #1/#3/#4）を行う。
    const frozenEffect = activeStatusEffect(targetBeforeDamage, "FREEZE");
    const freezeMultiplier =
      frozenEffect !== undefined
        ? 1 + (frozenEffect.statusDetails?.damageAmplificationOnBreak ?? 0.5)
        : 1;
    const attackDamageBonus = attackerBeforeDamage.appliedEffects
      .filter((effect) => effect.isAttackDamageBonus === true)
      .reduce((sum, effect) => sum + effect.magnitude, 0);
    const combinedPreTruncationDamage =
      rawDamageResult.preTruncationDamage * freezeMultiplier + attackDamageBonus;
    const combinedFinalDamage = Math.max(1, Math.floor(combinedPreTruncationDamage));
    // R-DMG-02「ダメージ無効効果がある場合も結果を1とする」: `calculateDamage`
    // 自身は`AppliedEffect`を知らない純粋な数値計算のため、ここで対象の
    // 有効なDAMAGE_IMMUNITYを判定し、成立すれば`finalDamage`を1へ上書きする。
    // R-DMG-02の順序どおり（#1切り捨て→#2無効化）、既に切り捨て済みの
    // `combinedFinalDamage`を「incoming raw damage」として判定する。
    const damageImmunity = resolveDamageImmunity(
      targetBeforeDamage,
      combinedFinalDamage,
      formulaContext,
    );
    const damageResult = {
      ...rawDamageResult,
      preTruncationDamage: combinedPreTruncationDamage,
      finalDamage: damageImmunity.nullified ? 1 : combinedFinalDamage,
    };

    const damageCalculated = context.recorder.record({
      eventType: "DamageCalculated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      // R-DMG-05 #4→#6（DMG-001、Issue #195）: 直接の契機は`CriticalCheckResolved`
      // ではなく、その後に発行した`DamageWillBeApplied`（このTIMINGイベントの連鎖が
      // 計算前提を変え得るため、因果としてもこの間に挟まる）。
      parentEventId: observation.damageWillBeAppliedEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: attacker.battleUnitId,
      targetUnitIds: [hit.targetBattleUnitId],
      payload: {
        skillDefinitionId: context.skillDefinitionId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        targetUnitId: hit.targetBattleUnitId,
        attackerAttack: attackerBeforeDamage.combatStats.attack,
        defenderDefense: targetBeforeDamage.combatStats.defense,
        effectiveDefense: damageResult.effectiveDefense,
        defenseIgnoreRate,
        shieldIgnoreRate: piercing.shieldIgnoreRate,
        damageReductionIgnoreRate: piercing.damageReductionIgnoreRate,
        skillPower: damageResult.skillPower,
        attributeMultiplier: damageResult.attributeMultiplier,
        criticalMultiplier: critical.multiplier,
        outgoingDamageMultiplier: damageResult.outgoingDamageMultiplier,
        incomingDamageMultiplier: damageResult.incomingDamageMultiplier,
        actionDamageMultiplier: damageResult.actionDamageMultiplier,
        preTruncationDamage: damageResult.preTruncationDamage,
        finalDamage: damageResult.finalDamage,
        damageType: damageAction.payload.damageType,
      },
    });

    // R-STS-03: このヒットが凍結を解除する契機になった場合、`DamageCalculated`
    // （増幅済みの`finalDamage`を確定済み）の直後に凍結を除去する。R-EFF-09の
    // linkedEffectGroupカスケードは`context.removeFreezeEffect`（呼び出し側が
    // 注入、`combat/`は`effects/`へ依存できないため）へ委譲し、未指定なら
    // `AppliedEffect`を直接filterする簡易版（カスケードなし）にfallbackする。
    // `duplicate: true`固定（`freeze-grant-service.ts`）のためR-EFF-05の最強
    // 選択対象にならず、`isEffective`は常にtrue。
    //
    // PRレビュー再々指摘[P2]（Issue #183）: いずれのgeneratorも、
    // `context.onFactEventForPassiveChain`が指定されていれば（AS/EX・チャージ
    // 解放）その場で同期的に駆動しステップごとに通知する — まとめて最後に
    // 通知すると同じイベントが二重発火するため、ここでは通知しない。未指定
    // （PS自身のEffectSequence解決）なら、このステップ自体を`yield`し、
    // 呼び出し元（`resolveOneEffectActionApplication`）が`driveActivation`の
    // 共有stateへ正しく参加させる。
    let lastEventIdBeforeHp = damageCalculated.eventId;
    if (frozenEffect !== undefined) {
      const removeGen =
        context.removeFreezeEffect !== undefined
          ? context.removeFreezeEffect(
              targetBeforeDamage.battleUnitId,
              frozenEffect.effectInstanceId,
              damageResult.finalDamage,
              Array.from(working.values()),
              lastEventIdBeforeHp,
            )
          : fallbackRemoveFreezeEffectSteps(
              context,
              Array.from(working.values()),
              targetBeforeDamage.battleUnitId,
              frozenEffect,
              damageResult.finalDamage,
              lastEventIdBeforeHp,
            );
      let removeStep = removeGen.next();
      while (!removeStep.done) {
        let stepUnits = removeStep.value.units;
        if (context.onFactEventForPassiveChain !== undefined) {
          for (const event of removeStep.value.events) {
            stepUnits = context.onFactEventForPassiveChain(event, stepUnits);
          }
          removeStep = removeGen.next(stepUnits);
        } else {
          const injected = yield {
            events: removeStep.value.events,
            units: removeStep.value.units,
          };
          removeStep = removeGen.next(injected);
        }
      }
      const removal = removeStep.value;
      for (const unit of removal.units) {
        working.set(unit.battleUnitId, unit);
      }
      lastEventIdBeforeHp = removal.lastEventId;
    }

    // R-DMG-05 #6〜#8: 確定したダメージ量の適用（吸収先への振り分け→HP→
    // `HitPointReduced`→`DamageApplied`→`UnitDefeated`→連鎖→R-EFF-07のヒット消費）も、
    // サブユニット追加ダメージ（R-SUB-02）と共有する`applyConfirmedDamageSteps`が行う。
    const application = yield* applyConfirmedDamageSteps(
      context,
      working,
      attackerBeforeDamage.battleUnitId,
      targetBeforeDamage.battleUnitId,
      {
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: hit.hitIndex,
        damageType: damageAction.payload.damageType,
        piercing,
      },
      damageResult.finalDamage,
      lastEventIdBeforeHp,
    );
    lastEventId = application.lastEventId;
    // PR #289再レビュー[P2]: 吸収の連鎖が使用者を戦闘不能にしたなら、このヒットの
    // HP適用ごと中断して残りのヒットも解決しない（R-SKL-01/R-SKL-03）。対象側の
    // 戦闘不能はこのヒットだけを不成立にする（R-ACTN-01 #2）。
    if (application.kind === "INTERRUPT") {
      interruptedCount = hits.length - i;
      interrupted = true;
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }
    if (application.kind === "SKIP") {
      outcomes.push(skip(hit));
      continue;
    }

    outcomes.push({
      targetBattleUnitId: hit.targetBattleUnitId,
      hitIndex: hit.hitIndex,
      applied: true,
      isCritical: critical.isCritical,
      damage: damageResult.finalDamage,
    });
  }

  // R-SUB-02（DMG-005、Issue #190）: 使用者がサブユニットを保持していれば、この
  // 攻撃の対象ごとに追加ダメージを1ヒットずつ加える。全ヒットの解決が終わった
  // この時点で行うのは、R-SUB-02が数える単位が「ヒット」ではなく「攻撃対象」
  // だからである（5ヒット単体攻撃でも追加ダメージは1回、2体攻撃なら各1回）。
  const additional = yield* applySubUnitAdditionalDamageSteps(
    context,
    working,
    random,
    attacker.battleUnitId,
    outcomes,
    damageAction,
    interrupted,
    lastEventId,
  );
  lastEventId = additional.lastEventId;
  // PR #289再々レビュー[P2]: 追加ヒットは`hits`に含まれないため`interruptedCount`へは
  // 足せない。中断の事実だけを`interrupted`として外側へ伝える。
  interrupted = interrupted || additional.interrupted;

  // レビュー再々指摘[P1]（PR #209）: `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`
  // の消費で0になったインスタンスは、このEffectAction（全ヒット）の解決が
  // 終わった今ここで初めて実際に失効させる（`consumeEffectDuration`は消費の
  // 記録だけを行い、除去とCombatStat再計算をここまで遅延させている）。
  // 中断（使用者の戦闘不能）でループを抜けた場合も、既に消費済みの分は
  // ここで確定させる。
  if (context.finalizeConsumedEffectDurations !== undefined) {
    // PR #280再レビュー[P1]: 遅延させた失効の確定も、除去1件ごとに通知（または
    // callback未指定なら`yield`）する。
    const finalized = yield* driveRemovalSteps(
      context,
      working,
      context.finalizeConsumedEffectDurations(Array.from(working.values()), lastEventId),
    );
    lastEventId = finalized.lastEventId;
  }

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    hits: outcomes,
    interruptedCount,
    interrupted,
    lastEventId,
  };
}

/**
 * `applyDamageActionSteps`を同期的に完了まで駆動する薄いwrapper。generatorが
 * `yield`する場面は`context.onFactEventForPassiveChain`未指定（PS/Memory自身の
 * EffectSequence解決）の時だけであり、その経路をこのwrapperで駆動する呼び出し元は
 * 連鎖driverを持たない（PR #142以来の既存契約）。ここでは`yield`された値を単に
 * 読み捨てて`.next()`する — 全ての既存呼び出し元・テストと完全に同じ振る舞いを
 * 保つ。production経路（`effect-action-group-resolver.ts`）はこのwrapperではなく
 * `applyDamageActionSteps`を直接駆動し、各`yield`を`EFFECT_RESOLVED`として
 * `driveActivation`の共有stateへ参加させる。
 */
export function applyDamageAction(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
  context: DamageEventContext,
): ApplyDamageActionResult {
  const gen = applyDamageActionSteps(attacker, hits, damageAction, units, random, context);
  let step = gen.next();
  while (!step.done) {
    step = gen.next();
  }
  return step.value;
}
