import type { BattleUnit } from "../model/battle-unit.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";
import type { UnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";
import {
  createEmptyPassiveActivationGuard,
  recordActivation,
  type PassiveActivationGuard,
} from "./passive-activation-guard.js";
import type {
  PassiveChainLimits,
  PassiveChainLimitViolationReason,
} from "./passive-chain-limits.js";
import {
  checkEffectRuntimeCounterDepth,
  checkEffectsResolvedCount,
  checkPassiveDepth,
} from "./passive-chain-limits.js";
import type { MemoryCandidate, MemoryCandidateGroup } from "./memory-candidate.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import {
  createEmptyPassiveResolutionStack,
  depthOf,
  peekTop,
  popTop,
  pushCandidateGroups,
  withTopCandidates,
  withTopMemoryCandidates,
  type PassiveResolutionStack,
  type PassiveResolutionStackEntry,
} from "./passive-resolution-stack.js";
import { applySimultaneousActivationLimit } from "./passive-simultaneous-activation-limit.js";
import { reconfirmPassiveCandidate } from "./reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/** 1件のPS発動処理が完了した時点の結果。 */
export interface PassiveActivationCompletion {
  /** R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」がこのPS自身の
   * EffectSequenceに適用され、中断したかどうか。中断してもチェーン全体は継続する
   * （Skill中断接続: 呼び出し側が`PassiveInterrupted`等へ変換できるよう、中断した
   * candidateを結果へ集約するだけに留める）。 */
  readonly interrupted: boolean;
}

/**
 * PSの発動処理（#34/#73が実装）が`resolvePassiveChain`へ差し出す、1件分の途中
 * 経過。`R-ATM-02`の3フェーズ（前段・効果処理・後段）に対応して4種類ある。
 *
 * - `TIMING_EVENT`: `EffectActionStarting`・`UnitBeingAttacked`・
 *   `DamageWillBeApplied`のような、EffectActionが実際に解決する前に発行される
 *   TIMINGイベント（`08_ドメインイベント.md`のイベント分類）と、前段・後段
 *   フェーズで発行されるFACTイベント（`PassiveActivated`・`MemoryTriggered`・
 *   完了イベント後の`SKILL_USE`単位期間減算など）。まだ効果は解決して
 *   いない（PSの反応でEffectAction自体が中断・再計算されうる）ため、効果解決数
 *   Guardをカウントしない。`resolvePassiveChain`はイベントを即座に候補解決し、
 *   `.next()`で再開する。
 * - `EFFECT_RESOLVED`: 1つのEffectAction/EffectStepの解決完了と、それが発行した
 *   事後ドメインイベント（`events`、0件以上、発生順、`DamageCalculated`・
 *   `DamageApplied`のようなFACTイベント）をまとめて報告する。効果解決数Guardは、
 *   この`yield`を受け取った時点で直ちに1件としてカウントする — `events`が
 *   新たなPS候補を誘発しても、このカウントは連鎖の深さに影響されない。
 *   `R-ATM-01`により、各イベントの状態保守は即時に行うが候補の**発動**は
 *   この発動自身の保留キューへ積む。
 * - `DEFERRED_EVENT`: 効果処理フェーズの境界で発行されるFACTイベントのうち、
 *   効果解決数Guardの対象ではないもの（`EffectSequence`スコープの
 *   `RuntimeCounterReset`、完了イベント直前の`RuntimeCounterChanged`）。
 *   `EFFECT_RESOLVED`と同じく検出のみ即時・発動は保留する。
 * - `COMPLETION_EVENT`: 完了イベント（`PassiveResolved`／`PassiveInterrupted`／
 *   `MemoryResolved`）。`R-ATM-01`の即時解決規則の唯一の例外として、発行時に
 *   候補を検出したうえで保留キューの末尾へ積み、その保留キューをすべて解決して
 *   から（＝自身の候補が最後に）発動する（`R-ATM-02` #3の後段フェーズ）。
 *
 * 「効果解決」と「その効果が発行した事後イベント」を`EFFECT_RESOLVED`という
 * 1つの`yield`へまとめるのは、もし「イベントを`yield`した後、別の`yield`で
 * 効果解決を報告する」という2段階の契約にすると、最初の`yield`が誘発した子PS
 * 連鎖を解決している間は後段の`yield`へ決して到達できず（子PSもまた同じ
 * パターンで自分の子を誘発し続けるため）、再帰的なPS連鎖では効果解決数Guardが
 * 実質的に機能しなくなるため。`TIMING_EVENT`はこの問題を再発させない —
 * TIMINGイベントに反応したPS自身の効果は、それ自身の`EFFECT_RESOLVED`で
 * カウントされる（未解決のTIMINGイベントの連鎖という形でカウントを回避する
 * ことはできない。カウントされるのは常に「実際に解決した効果」の数）。
 */
export type PassiveActivationStep =
  | { readonly kind: "TIMING_EVENT"; readonly event: TriggerCandidateEvent }
  | { readonly kind: "EFFECT_RESOLVED"; readonly events: readonly TriggerCandidateEvent[] }
  | { readonly kind: "DEFERRED_EVENT"; readonly event: TriggerCandidateEvent }
  | { readonly kind: "COMPLETION_EVENT"; readonly event: TriggerCandidateEvent };

/**
 * PSの発動処理は、上記`PassiveActivationStep`を`yield`するジェネレータとして
 * 提供される。`resolvePassiveChain`は`yield`のたびに効果解決数Guardを確認した
 * 直後、その`events`それぞれについて`R-ATM-01`の解決コンテキストに従った処理
 * （前段・後段フェーズなら即時解決、効果処理フェーズなら状態保守のみ即時で
 * 候補は保留）を行ってから`.next()`で再開する。全stepを解決し終えたら`return`で
 * `PassiveActivationCompletion`を返す。
 *
 * `resolvePassiveChain`が実際に呼び出すのは`next()`だけなので、標準の`Generator`
 * 全体ではなく、この最小限のプル型イテレータ形状だけを契約とする。`function*`で
 * 実装したジェネレータはそのままこの形へ構造的に適合する。
 */
export interface PassiveActivation {
  next(): IteratorResult<PassiveActivationStep, PassiveActivationCompletion>;
}

export type DetectPassiveCandidates = (event: TriggerCandidateEvent) => PassiveCandidateGroup;
/** R-MEM-01: `event`に対するMemory候補（R-MEM-02順に並んでいることを期待する）。 */
export type DetectMemoryCandidates = (event: TriggerCandidateEvent) => MemoryCandidateGroup;
/**
 * `08_ドメインイベント.md`「発動直前の再確認」Memory候補: trigger conditionが
 * 現在も成立しているかを候補処理の直前に再評価する（PS候補の
 * `reconfirmPassiveCandidate`に対応）。「対象候補が1件以上存在する」は
 * 実際にEffectSequenceの対象解決を行う`activateMemory`側でしか判定できないため、
 * 発動処理が対象0件を検出した時点でイベントを発行せずに終える契約とする。
 */
export type ReconfirmMemoryCandidate = (
  candidate: MemoryCandidate,
  event: TriggerCandidateEvent,
) => boolean;
export type ActivateMemoryCandidate = (
  candidate: MemoryCandidate,
  event: TriggerCandidateEvent,
) => PassiveActivation;
export type GetCurrentBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit;
/**
 * `POSITION_RELATION`（Issue #144）の対象解決専用の安全なlookup。
 * `GetCurrentBattleUnit`（`getCurrentUnit`、本番実装は`requireUnit`）は未知の
 * `BattleUnitId`に対して例外を送出する契約だが、R-PS-01/Issue #144は「対象不在」を
 * 条件不成立として決定的に候補破棄する契約（`evaluateTriggerCondition`の
 * `POSITION_RELATION`分岐参照）のため、両者を混用してはならない。
 */
export type FindBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit | undefined;
export type ActivatePassiveCandidate = (
  candidate: PassiveCandidate,
  event: TriggerCandidateEvent,
) => PassiveActivation;

export interface PassiveChainDependencies {
  /** 呼び出し側が`detectPassiveCandidates`（#19）等具体的な検出処理を閉じ込める。
   * 返り値はR-PS-02/R-PS-08順にソート済みであることを期待する（`sortPassiveCandidates`
   * の契約と同じ）。同時発動制限（R-PS-03）は本関数が適用するため、呼び出し側では
   * 適用不要。 */
  readonly detectCandidates: DetectPassiveCandidates;
  readonly getCurrentUnit: GetCurrentBattleUnit;
  /**
   * `POSITION_RELATION`（Issue #144）の再確認（R-PS-04）が候補検出時と同じ対象
   * 解決を使うために渡す。未指定時は`reconfirmPassiveCandidate`へ渡さず、
   * `POSITION_RELATION`を参照するtriggerの再確認はcontext不足として例外になる
   * （`evaluateTriggerCondition`の既存契約と同じ）。
   */
  readonly findUnit?: FindBattleUnit;
  readonly activate: ActivatePassiveCandidate;
  /**
   * R-MEM-01/02（Issue #179）: 同じイベントのMemory候補。未指定ならMemory候補を
   * 一切持たない（M6までの挙動と同じ）。
   */
  readonly detectMemoryCandidates?: DetectMemoryCandidates;
  readonly reconfirmMemoryCandidate?: ReconfirmMemoryCandidate;
  readonly activateMemory?: ActivateMemoryCandidate;
  readonly limits: PassiveChainLimits;
  /**
   * `RESOLUTION_PHASE`（Issue #144、TRIGGER_EXCLUSION_TIMING）を候補検出時と
   * 同一の値で再確認（R-PS-04）するために`reconfirmPassiveCandidate`へそのまま
   * 渡す。1解決スコープの全体を通じて固定（呼び出し側が決める）。
   */
  readonly resolutionPhase?: ResolutionPhase;
  /**
   * `ALIVE_UNIT_COUNT`（RES-004、Issue #171）の再確認（R-PS-04）が候補検出時と
   * 同じ生存数母集団を使うために渡す。`findUnit`/`getCurrentUnit`と同様、
   * 呼び出し側の可変な`units`を都度読み直す関数として渡す（`resolveTopGroup`は
   * PS連鎖の途中で何度も呼ばれるため、固定配列だと再確認のたびに古い状態を
   * 参照してしまう）。未指定時は`ALIVE_UNIT_COUNT`を参照するactivationCondition
   * の再確認がthrowする（`evaluateTriggerCondition`の既存契約と同じ）。
   */
  readonly getAllUnits?: () => readonly BattleUnit[];
  /**
   * `TURN_NUMBER`（RES-004、Issue #171）を候補検出時と同一の値で再確認
   * （R-PS-04）するために`reconfirmPassiveCandidate`へそのまま渡す。
   * `resolutionPhase`と同様、1解決スコープの全体を通じて固定。
   */
  readonly turnNumber?: number;
  /**
   * `TARGET_STATE`の`UNIT_TYPE`/`ROLE`（M7-001E、Issue #248、
   * `CAP_TARGET_STATE_EXTENDED_FIELD`）を候補検出時と同じCatalog参照表で
   * 再確認（R-PS-04）するために`reconfirmPassiveCandidate`へそのまま渡す。
   * 未指定時はこれらを参照するtrigger/activationConditionの再確認がthrowする
   * （`evaluateTriggerCondition`の既存契約と同じ）。
   */
  readonly unitDefinitions?: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  /**
   * R-EFF-08（`expiration.conditions`）は
   * 「関連するドメインイベント発行後、PS/Memory候補抽出前に評価する」契約
   * のため、トップレベルの`event`だけでなく、PS連鎖の内部で発行される
   * `TIMING_EVENT`/`EFFECT_RESOLVED`の各イベント（`PassiveActivated`・
   * `EffectActionStarting`・`DamageApplied`等）に対しても同じ契約を満たす
   * 必要がある。呼び出し側（`combat/`/`effects/`へ依存できない`triggering/`の
   * 代わりに`lifecycle/PassiveActivationRuntime`）が注入する。`event`に対して
   * 特殊失効条件が成立した効果があれば失効させ、その結果新たに発行された
   * イベント（`EffectExpired`・`CombatStatChanged`等）を返す。未指定、または
   * 該当なしの場合は空配列を返す契約とする。
   */
  readonly applyExpirationConditions?: (
    event: TriggerCandidateEvent,
  ) => readonly TriggerCandidateEvent[];
  /**
   * R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）:
   * `duration.removeOnSourceDefeated`を宣言したMarkerを、その付与者が戦闘不能に
   * なった`UnitDefeated`に対して解除する。`applyExpirationConditions`（R-EFF-08）
   * と同じ理由でPS連鎖内部の各イベントへも届ける必要がある — PS自身の
   * EffectSequenceが与えたダメージによる`UnitDefeated`は`onFactEvent`を経由
   * しないため。
   *
   * `applyExpirationConditions`のようにイベント配列を
   * まとめて返す形にはできない。Marker解除はR-EFF-09のカスケードで
   * linked group全体（子`AppliedEffect`→親`MarkerState`）を巻き込むため、
   * 全メンバーを除去してから配列を返すと、最初の子`EffectExpired`をPS/Memoryへ
   * 渡す時点で親Markerが既に消えている。R-EFF-09「各インスタンスの失効イベント
   * （と、それに続くCombatStat再計算）は、次のインスタンスへ進む前にPS/Memoryの
   * 即時連鎖へ渡す」に反し、親Markerを条件にするPS/Memoryが同じ`UnitDefeated`でも
   * トップレベル経路では発動しPS連鎖内部経路では発動しない、という差を生む。
   * そのため`applyEffectRuntimeCounterUpdates`と同じ`resolveChild`形にし、
   * 1メンバーの除去を記録するたびにその候補連鎖を完全に解決してから次のメンバーへ
   * 進む。`resolveChild`が返すviolationはそのまま返し、以降のメンバーは処理しない。
   * 未指定、または該当なしの場合は`undefined`を返す契約とする。
   */
  readonly applyMarkerSourceDefeatRemovals?: (
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ) => PassiveChainLimitViolationReason | undefined;
  /**
   * `R-EFF-11`（`AppliedEffect`スコープ、EFF-005/Issue #162）の
   * `counterUpdates`更新も、`applyExpirationConditions`と同じ理由で
   * トップレベルの`event`だけでなくPS連鎖内部の各イベント（PS自身がyieldする
   * `PassiveActivated`・`EffectActionStarting`、PS効果由来の`DamageApplied`等、
   * `onFactEvent`を経由しないイベント）に対しても届ける必要がある。`event`に
   * 一致する`AppliedEffect`スコープの`counterUpdates`を検出し、マッチした
   * 各エントリを1件ずつ更新・記録するたびに`resolveChild`（＝`resolveEvent`
   * 自身への再帰）を呼び出し、その`RuntimeCounterChanged`の候補連鎖を完全に
   * 解決してから次のエントリを適用する（複数の
   * `AppliedEffect`が同じイベントへ一致する場合、最初の`RuntimeCounterChanged`が
   * 誘発したPSが後続effectを解除・変更しうるため、全件を先にバッチ更新して
   * から返すと後続の`before`/`after`が候補解決前の古い状態になってしまう —
   * `SkillRuntime`側の`detectAndRecordRuntimeCounterChanges`と同じ「1件ずつ
   * record→候補解決→次へ」の順序をこの経路でも守る）。`resolveChild`が返す
   * violationはそのまま返し、以降のエントリは処理しない。`event`自身の
   * `expiration.conditions`評価・候補抽出より前に呼ぶ（R-EFF-11「原因イベントの
   * 状態変更確定後、PS/Memory候補抽出前にcounter更新を決定する」）。未指定、
   * またはマッチなしの場合は`undefined`を返す契約とする。
   */
  readonly applyEffectRuntimeCounterUpdates?: (
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ) => PassiveChainLimitViolationReason | undefined;
  /**
   * EFF-006/Issue #212: `R-EFF-11`の`EffectSequence`スコープ版。`applyEffectRuntimeCounterUpdates`
   * （`AppliedEffect`スコープ）と同じ理由・同じ契約（`event`に一致する現在進行中の
   * EffectSequence解決のcounterUpdatesを検出・記録し、1件ずつ`resolveChild`で
   * 候補連鎖を完全に解決してから次へ進む）。`state.effectRuntimeCounterDepth`を
   * `applyEffectRuntimeCounterUpdates`と共有する（自己再誘発の上限はスコープを
   * 問わず1つの決定的な上限を設ければ十分なため、`ChainState`を分割しない）。
   */
  readonly applyEffectSequenceRuntimeCounterUpdates?: (
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ) => PassiveChainLimitViolationReason | undefined;
}

export type PassiveChainResult =
  | {
      readonly ok: true;
      readonly activationGuard: PassiveActivationGuard;
      readonly interruptedCandidates: readonly PassiveCandidate[];
    }
  | {
      readonly ok: false;
      readonly reason: PassiveChainLimitViolationReason;
    };

function detectLimitedCandidates(
  event: TriggerCandidateEvent,
  deps: PassiveChainDependencies,
): PassiveCandidateGroup {
  return applySimultaneousActivationLimit(deps.detectCandidates(event)).kept;
}

/**
 * `R-ATM-01`「検出のみ即時」: `event`のPS候補（R-PS-03適用済み）とMemory候補
 * （R-MEM-02順）を、発行時点の状態で1つのグループとして確定する。発動時機
 * （即時／保留）はこのグループをどこへ渡すかで決まり、検出そのものは
 * 両コンテキストで同一である。
 */
export function detectPassiveCandidateGroup(
  event: TriggerCandidateEvent,
  deps: PassiveChainDependencies,
): PassiveResolutionStackEntry {
  return {
    event,
    candidates: detectLimitedCandidates(event, deps),
    memoryCandidates: detectMemoryCandidateGroup(event, deps),
  };
}

/**
 * R-MEM-01: Memory候補の検出。R-PS-03の同時発動制限はPS専用（R-MEM-01「Memory
 * triggeredEffects はPP、クールタイム、先制攻撃、1解決スコープ1回制限を持たない」）
 * のため適用しない。
 */
function detectMemoryCandidateGroup(
  event: TriggerCandidateEvent,
  deps: PassiveChainDependencies,
): MemoryCandidateGroup {
  return deps.detectMemoryCandidates?.(event) ?? [];
}

/** `resolvePassiveChain`の再帰呼び出し全体で共有する可変状態。 */
interface ChainState {
  guard: PassiveActivationGuard;
  effectsResolved: number;
  readonly interruptedCandidates: PassiveCandidate[];
  /** `05_ドメインモデル.md`「PassiveCandidateStack」（本Issueでは「PassiveResolutionStack」）。
   * 制御フロー自体はJSの呼び出しスタックによる再帰で駆動するが、各階層で
   * push/popし、観測可能な状態として保つ。 */
  stack: PassiveResolutionStack;
  /**
   * `deps.applyEffectRuntimeCounterUpdates`から
   * `resolveChild`（`resolveEvent`自身への再帰）が呼ばれている間、増加させたまま
   * 保つ深さカウンタ。呼び出しが返った直後（`resolveChild`による再帰的候補解決を
   * 待たずに）減算すると、`RuntimeCounterChanged`を自身の`counterUpdates.trigger`
   * に持つ誤ったCatalog定義がPS連鎖内部（`onFactEvent`を経由しない`resolveEvent`
   * 自身の再帰）で無限に自己再生成した場合にこの上限が機能しない（各呼び出しの
   * 深さが常に1へ戻ってしまうため）。`state`（`resolvePassiveChain`の再帰全体で
   * 共有する可変状態）に持たせることで、`resolveEvent`の実際のJS呼び出し
   * スタックの深さと一致させる。
   */
  effectRuntimeCounterDepth: number;
  /**
   * `R-ATM-01`の保留キュー。1回のスキル効果処理（＝`driveSteps`の1回の呼び出し）
   * につき1フレームを積み、その効果処理中に検出した候補グループをイベント発生順に
   * 保持する。配列末尾が現在進行中の効果処理のフレーム。フレームが無い（＝効果処理の
   * 外）なら候補は従来どおり即時解決する。
   *
   * ネストした発動（保留キュー排出中に発動したPS/Memory）は自分のフレームを持ち、
   * その効果処理中の候補は自分のフレームへ入る。これにより`R-ATM-02`の
   * 「自分の後段フェーズを終えてから親のキューの次の候補へ進む」深さ優先が
   * 効果処理単位で保たれる。
   */
  readonly pendingFrames: PassiveResolutionStackEntry[][];
}

/**
 * `R-ATM-01`「状態保守はこれまでどおりイベントごとに即時確定する」: `event`に対する
 * RuntimeCounter更新（R-EFF-11）・特殊失効（R-EFF-08）・付与者戦闘不能によるMarker
 * 解除（R-EFF-10）を、候補検出より前にその場で確定させる。
 *
 * `deps.applyEffectRuntimeCounterUpdates`（R-EFF-11、
 * `AppliedEffect`スコープ）を`deps.applyExpirationConditions`（R-EFF-08）より
 * 先に呼ぶ — counter更新は特殊失効条件評価・候補抽出より前に確定させる
 * （R-EFF-11「原因イベントの状態変更確定後、PS/Memory候補抽出前にcounter
 * 更新を決定する」）。`deps.applyEffectSequenceRuntimeCounterUpdates`
 * （EFF-006/Issue #212、`EffectSequence`スコープ）も同じ理由・同じ順序で呼ぶ。
 *
 * 状態保守が新たに発行したイベント（`RuntimeCounterChanged`・`EffectExpired`・
 * `CombatStatChanged`等）は`handleCausedEvent`へ渡す。渡し先は`event`自身と同じ
 * 解決コンテキストであり（即時なら`resolveEvent`、保留なら`deferEvent`）、
 * どちらの場合も`event`自身の候補より前に処理される（`08_ドメインイベント.md`
 * 「イベント発行と処理」手順3〜5、`RuntimeCounterChanged`のpre-matching例外）。
 */
function maintainState(
  event: TriggerCandidateEvent,
  state: ChainState,
  deps: PassiveChainDependencies,
  handleCausedEvent: (
    caused: TriggerCandidateEvent,
  ) => PassiveChainLimitViolationReason | undefined,
): PassiveChainLimitViolationReason | undefined {
  if (deps.applyEffectRuntimeCounterUpdates !== undefined) {
    // 深さは`resolveChild`が実際に呼ばれた分だけ増減する
    // （`deps.applyEffectRuntimeCounterUpdates`がマッチなしで`undefined`を返す
    // 呼び出しではカウントしない）。ここを`resolveEvent`呼び出しそのものに
    // 巻き付けると、AppliedEffect counterと無関係な通常のPS連鎖の深さも誤って
    // カウントしてしまう。
    const violation = deps.applyEffectRuntimeCounterUpdates(event, (child) => {
      state.effectRuntimeCounterDepth += 1;
      try {
        const depthCheck = checkEffectRuntimeCounterDepth(
          state.effectRuntimeCounterDepth,
          deps.limits,
        );
        if (!depthCheck.ok) {
          return depthCheck.reason;
        }
        return handleCausedEvent(child);
      } finally {
        state.effectRuntimeCounterDepth -= 1;
      }
    });
    if (violation !== undefined) {
      return violation;
    }
  }

  if (deps.applyEffectSequenceRuntimeCounterUpdates !== undefined) {
    // EFF-006/Issue #212: 上の`applyEffectRuntimeCounterUpdates`（`AppliedEffect`
    // スコープ）と同じ深さGuard・同じ理由で`resolveChild`ベースにする。
    const violation = deps.applyEffectSequenceRuntimeCounterUpdates(event, (child) => {
      state.effectRuntimeCounterDepth += 1;
      try {
        const depthCheck = checkEffectRuntimeCounterDepth(
          state.effectRuntimeCounterDepth,
          deps.limits,
        );
        if (!depthCheck.ok) {
          return depthCheck.reason;
        }
        return handleCausedEvent(child);
      } finally {
        state.effectRuntimeCounterDepth -= 1;
      }
    });
    if (violation !== undefined) {
      return violation;
    }
  }

  if (deps.applyExpirationConditions !== undefined) {
    for (const causedEvent of deps.applyExpirationConditions(event)) {
      const violation = handleCausedEvent(causedEvent);
      if (violation !== undefined) {
        return violation;
      }
    }
  }

  // M7-020（Issue #279）: R-EFF-10の付与者戦闘不能によるMarker解除。R-EFF-08の
  // 後に呼ぶ（トップレベルの`onFactEvent`と同じ順序）。
  // 除去は1メンバーずつ`resolveChild`で処理してから次へ進む
  // （`deps.applyMarkerSourceDefeatRemovals`のコメント参照）。
  if (deps.applyMarkerSourceDefeatRemovals !== undefined) {
    const violation = deps.applyMarkerSourceDefeatRemovals(event, (child) =>
      handleCausedEvent(child),
    );
    if (violation !== undefined) {
      return violation;
    }
  }

  return undefined;
}

/**
 * 検出済みの候補グループをスタック先頭へ積んで完全に解決してからpopする。
 * PS深度Guard（`R-ATM-02`「深度はネストした発動＝保留キュー排出の入れ子の
 * 深さと読み替える」）はpush直後、候補処理を始める前に確認する。
 */
function resolveCandidateGroup(
  group: PassiveResolutionStackEntry,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  state.stack = pushCandidateGroups(state.stack, [group]);

  const depthCheck = checkPassiveDepth(depthOf(state.stack), deps.limits);
  if (!depthCheck.ok) {
    return depthCheck.reason;
  }

  const violation = resolveTopGroup(state, deps);
  state.stack = popTop(state.stack);
  return violation;
}

/**
 * `R-ATM-01`の即時解決コンテキスト（行動外トップレベルイベント、前段・後段
 * フェーズ）: `event`の状態保守を確定させ、その候補グループを検出して直ちに
 * 解決する。状態保守が発行した子イベントも同じ即時コンテキストで再帰する。
 */
function resolveEvent(
  event: TriggerCandidateEvent,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const violation = maintainState(event, state, deps, (caused) =>
    resolveEvent(caused, state, deps),
  );
  if (violation !== undefined) {
    return violation;
  }
  return resolveCandidateGroup(detectPassiveCandidateGroup(event, deps), state, deps);
}

/**
 * `R-ATM-01`の保留コンテキスト（効果処理フェーズ）: 状態保守は即時に確定させ、
 * 候補グループは検出だけ行って現在の効果処理のフレームへイベント発生順に積む。
 * 状態保守が発行した子イベントも同じ保留コンテキストで再帰するため、キュー内では
 * 子イベントの候補が原因イベントの候補より前に並ぶ（`08_ドメインイベント.md`
 * 「イベント発行と処理」手順3）。
 *
 * フレームが1つも積まれていない場合（効果処理の外から誤って呼ばれた場合）は
 * 即時解決へ委ねる — 保留先が無いまま候補を捨てないための防御。
 */
function deferEvent(
  event: TriggerCandidateEvent,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const violation = maintainState(event, state, deps, (caused) => deferEvent(caused, state, deps));
  if (violation !== undefined) {
    return violation;
  }
  const frame = state.pendingFrames[state.pendingFrames.length - 1];
  const group = detectPassiveCandidateGroup(event, deps);
  if (frame === undefined) {
    return resolveCandidateGroup(group, state, deps);
  }
  frame.push(group);
  return undefined;
}

/**
 * `R-ATM-02` #3の後段フェーズ: 現在の効果処理フレームの保留候補を、イベント発生順に
 * 解決する。1件解決する間に発動したPS/Memoryは自分のフレームを持つため、このループが
 * 見るのは常に当該効果処理が積んだ分だけである。
 */
function drainPendingFrame(
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const frame = state.pendingFrames[state.pendingFrames.length - 1];
  if (frame === undefined) {
    return undefined;
  }
  for (let group = frame.shift(); group !== undefined; group = frame.shift()) {
    const violation = resolveCandidateGroup(group, state, deps);
    if (violation !== undefined) {
      return violation;
    }
  }
  return undefined;
}

/**
 * スタック先頭グループの候補を先頭から順に処理する。R-PS-04の再確認は候補を
 * 処理する直前に必ず行うため、ネストした解決から戻った直後の次候補も、保留キューから
 * 取り出した候補もここを通る。後者にとってはこの再確認が「検出から発動までの間に
 * 効果処理の残り全体が挟まる」ことへの唯一の防波堤になる（`R-ATM-01`）。
 */
function resolveTopGroup(
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const top = peekTop(state.stack);
  if (top === undefined) {
    return undefined;
  }
  const [next, ...restCandidates] = top.candidates;
  if (next === undefined) {
    // R-MEM-02「同じイベントでPS候補とMemory候補が両方存在する場合、PS候補を先に
    // 解決し、その後Memory候補を解決する」: PS候補を使い切ってからMemory候補へ進む。
    return resolveTopMemoryGroup(state, deps);
  }
  state.stack = withTopCandidates(state.stack, restCandidates);

  const currentUnit = deps.getCurrentUnit(next.unit.battleUnitId);
  const reconfirmation = reconfirmPassiveCandidate(
    next,
    currentUnit,
    top.event,
    state.guard,
    deps.findUnit,
    deps.resolutionPhase,
    deps.getAllUnits?.(),
    deps.turnNumber,
    deps.unitDefinitions,
  );
  if (reconfirmation.ok) {
    state.guard = recordActivation(
      state.guard,
      currentUnit.battleUnitId,
      next.skillDefinition.skillDefinitionId,
    );
    const activatedCandidate: PassiveCandidate = { ...next, unit: currentUnit };
    const generator = deps.activate(activatedCandidate, top.event);
    const violation = driveActivation(activatedCandidate, generator, state, deps);
    if (violation !== undefined) {
      return violation;
    }
  }

  return resolveTopGroup(state, deps);
}

/**
 * R-MEM-01/02: スタック先頭グループのMemory候補を先頭から順に処理する。PS候補と
 * 異なり発動済み集合（R-PS-07）・PP・クールタイムを持たないため、`08_ドメイン
 * イベント.md`「発動直前の再確認」のMemory候補側（trigger conditionが現在も成立
 * すること）だけを`deps.reconfirmMemoryCandidate`で確認する。1件のMemory解決から
 * 生じたイベントは`driveSteps`（PSと共通）が処理するため、その効果処理中に生じた
 * 候補グループはそのMemory発動自身の保留キューへ入り、`MemoryResolved`の後・
 * 未処理の親Memory候補より前に解決される（R-MEM-02の後半、`R-ATM-02`と同じ規約）。
 */
function resolveTopMemoryGroup(
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const top = peekTop(state.stack);
  if (top === undefined) {
    return undefined;
  }
  const [next, ...restCandidates] = top.memoryCandidates;
  if (next === undefined) {
    return undefined;
  }
  state.stack = withTopMemoryCandidates(state.stack, restCandidates);

  const activateMemory = deps.activateMemory;
  if (activateMemory !== undefined && (deps.reconfirmMemoryCandidate?.(next, top.event) ?? true)) {
    const violation = driveSteps(activateMemory(next, top.event), state, deps, undefined);
    if (violation !== undefined) {
      return violation;
    }
  }

  return resolveTopMemoryGroup(state, deps);
}

/**
 * `generator`を完了まで駆動する。`TIMING_EVENT`はGuardをカウントせずそのまま
 * 即時の候補解決へ回す。`EFFECT_RESOLVED`は受け取った直後に効果解決数Guardを
 * 確認してから、`events`を発生順に`deferEvent`で処理する（状態保守は即時、
 * 候補は保留キューへ）。
 */
function driveActivation(
  candidate: PassiveCandidate,
  generator: PassiveActivation,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  return driveSteps(generator, state, deps, candidate);
}

/**
 * PS発動（`candidate`あり）とMemory発動（`candidate`なし）で共通の駆動ループ。
 * Memory発動は使用者ユニットを持たないため中断（R-SKL-01）の集約対象にならない。
 *
 * `R-ATM-01`: この1回の呼び出しが「1回のスキル効果処理」に対応するため、入口で
 * 保留フレームを1つ積み、出口で必ず取り除く。`COMPLETION_EVENT`（完了イベント）を
 * 受け取った時点でそのフレームを排出し、続いて完了イベント自身の候補を解決する
 * （キューの末尾に積んであるため、排出の最後がそれになる）。完了イベントを
 * `yield`せずに終わった発動（対象0件のMemory等）が保留分を残した場合も、
 * `R-ATM-02`「中断時も保留分は解決する」と同じ理由で完了時に排出する。
 */
function driveSteps(
  generator: PassiveActivation,
  state: ChainState,
  deps: PassiveChainDependencies,
  candidate: PassiveCandidate | undefined,
): PassiveChainLimitViolationReason | undefined {
  state.pendingFrames.push([]);
  try {
    while (true) {
      const step = generator.next();
      if (step.done) {
        const violation = drainPendingFrame(state, deps);
        if (violation !== undefined) {
          return violation;
        }
        if (step.value.interrupted && candidate !== undefined) {
          state.interruptedCandidates.push(candidate);
        }
        return undefined;
      }

      if (step.value.kind === "TIMING_EVENT") {
        const violation = resolveEvent(step.value.event, state, deps);
        if (violation !== undefined) {
          return violation;
        }
        continue;
      }

      if (step.value.kind === "DEFERRED_EVENT" || step.value.kind === "COMPLETION_EVENT") {
        const violation = deferEvent(step.value.event, state, deps);
        if (violation !== undefined) {
          return violation;
        }
        if (step.value.kind === "COMPLETION_EVENT") {
          const drained = drainPendingFrame(state, deps);
          if (drained !== undefined) {
            return drained;
          }
        }
        continue;
      }

      state.effectsResolved += 1;
      const effectsCheck = checkEffectsResolvedCount(state.effectsResolved, deps.limits);
      if (!effectsCheck.ok) {
        return effectsCheck.reason;
      }

      for (const event of step.value.events) {
        // 効果処理フェーズの内部でも、TIMINGイベント（`UnitBeingAttacked`・
        // `DamageWillBeApplied`）は現行どおり即時解決する — これらを発動契機から
        // 外すのは`R-ATM-04`（後続Issue）の担当であり、保留対象は`R-ATM-01`が
        // 名指しするFACTイベントに限る。PS/Memory自身のEffectSequence解決では
        // ヒット内部のTIMINGイベントもFACTイベントと同じ`EFFECT_RESOLVED`へ
        // まとめて渡ってくる（`effect-action-handler.ts`の`cursor`）ため、
        // トップレベル経路（`PassiveActivationRuntime.onFactEvent`）と同じ
        // カテゴリ判定をここでも行い、両経路の挙動を一致させる。
        const violation =
          event.category === "TIMING"
            ? resolveEvent(event, state, deps)
            : deferEvent(event, state, deps);
        if (violation !== undefined) {
          return violation;
        }
      }
    }
  } finally {
    state.pendingFrames.pop();
  }
}

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」（本Issueでは「PassiveResolutionStack」）
 * が表す、PS即時連鎖の解決アルゴリズム本体。
 *
 * - R-PS-03: 各候補グループ検出直後に`applySimultaneousActivationLimit`で1件へ絞る。
 * - R-PS-04: 候補を処理する直前に必ず`reconfirmPassiveCandidate`で再確認する。
 *   ネストした解決から親グループへ戻った直後の次候補も同じ経路を通るため、
 *   「TIMINGイベント後に親処理の前提を再検証する」不変条件を満たす。
 * - R-PS-05 #1 / R-PS-07: 発動直前に`recordActivation`でguardへ記録し、再入を防ぐ。
 * - R-PS-06 / R-ATM-01〜02: `activate`が`yield`するイベントのうち、前段・後段
 *   フェーズのもの（`TIMING_EVENT`）はその候補連鎖を完全に解決してから`yield`元の
 *   ジェネレータを再開する。効果処理フェーズのもの（`EFFECT_RESOLVED`・
 *   `DEFERRED_EVENT`）は状態保守だけを即時に確定させ、候補はその発動自身の
 *   保留キューへ積んで`COMPLETION_EVENT`（完了イベント）の後に解決する。
 *   これにより「1回のスキル効果処理の途中に他のスキル効果処理を開始しない」
 *   （R-ATM-01）を保ちつつ、深さ優先（新しい候補を既存の未処理候補より先に処理する）
 *   を効果処理単位で維持する。
 * - 効果解決数Guardは`EFFECT_RESOLVED`を受け取るたびに、その`events`を処理する
 *   前に直ちにカウント・判定する。これにより、各PSの効果が次のPSを即座に誘発し
 *   続ける再帰的な連鎖でもGuardが機能する（イベント処理より後にカウントする
 *   設計だと、カウントへ到達する前に連鎖が深くなり続け、深度Guardにしか頼れ
 *   なくなる）。`TIMING_EVENT`（EffectAction解決前のTIMINGイベント、まだ効果が
 *   解決していないためPSの反応でEffectAction自体が中断・再計算されうる）は
 *   カウントしない。TIMINGイベントに反応したPS自身の効果は、そのPS自身の
 *   `EFFECT_RESOLVED`で別途カウントされるため、未解決のTIMINGイベント連鎖で
 *   カウントを回避することはできない。
 *
 * イベント因果関係について: `TriggerCandidateEvent`は照合専用の最小形であり、
 * `DomainEventId`・`sequence`・`parentEventId`・`rootEventId`を持たない
 * （`trigger-event.ts`参照）。それらの採番は`EventRecorder`（`battle/events`）の
 * 責務であり、実際のEffectSequence解決からイベントを発行する#73が配線する。
 * 本関数が保証するのは、どのイベントを「直近の原因」として各階層の
 * `reconfirmPassiveCandidate`/`activate`へ渡すか（ネストした候補には常に
 * それを生んだ具体的なイベントを渡し、rootイベントへ遡らせない）という
 * 呼び出しの原因追跡だけである。#73が`EventRecorder.record`へ`parentEventId`を
 * 渡す際は、その階層で本関数が渡したイベントの`eventId`を使えばよい。
 */
export function resolvePassiveChain(
  initialEvent: TriggerCandidateEvent,
  initialGuard: PassiveActivationGuard = createEmptyPassiveActivationGuard(),
  deps: PassiveChainDependencies,
): PassiveChainResult {
  return runChain(initialGuard, (state) => resolveEvent(initialEvent, state, deps));
}

/**
 * `R-ATM-02` #3の後段フェーズを、トップレベルの効果処理（AS/EX使用・チャージ解放。
 * `applyEffectActionGroups`が同期callbackでイベントを届けるため`PassiveActivation`
 * ジェネレータを持たない経路）から駆動するための入口。呼び出し側が効果処理中に
 * 検出・保留しておいた候補グループを1件受け取り、`resolvePassiveChain`と同じ
 * 解決規約（R-PS-02〜08・R-MEM-02・実行ガード）で発動させる。
 *
 * 状態保守（R-EFF-08/10/11）は候補を保留した時点で確定済みのため、ここでは
 * 再度行わない。R-PS-04の発動直前確認は`resolveTopGroup`が候補ごとに行うため、
 * 保留中に前提が崩れた候補はこの入口を通ってから破棄される。
 */
export function resolvePendingCandidateGroup(
  group: PassiveResolutionStackEntry,
  initialGuard: PassiveActivationGuard,
  deps: PassiveChainDependencies,
): PassiveChainResult {
  return runChain(initialGuard, (state) => resolveCandidateGroup(group, state, deps));
}

function runChain(
  initialGuard: PassiveActivationGuard,
  run: (state: ChainState) => PassiveChainLimitViolationReason | undefined,
): PassiveChainResult {
  const state: ChainState = {
    guard: initialGuard,
    effectsResolved: 0,
    interruptedCandidates: [],
    stack: createEmptyPassiveResolutionStack(),
    effectRuntimeCounterDepth: 0,
    pendingFrames: [],
  };

  const violation = run(state);
  if (violation !== undefined) {
    return { ok: false, reason: violation };
  }
  return {
    ok: true,
    activationGuard: state.guard,
    interruptedCandidates: state.interruptedCandidates,
  };
}
