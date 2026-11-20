import type { MemoryCandidate, MemoryCandidateGroup } from "./memory-candidate.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」（本Issue(#21)では
 * 「PassiveResolutionStack」と表記）: PS候補グループを後入れ先出しで保持する。1件分の
 * エントリは、候補群だけでなく`event`（発動直前確認 R-PS-04 が再評価するトリガー
 * イベント）も一緒に保持する。stackの先頭（配列の先頭要素）が現在解決中のグループ。
 * push／pop相当の操作のみを公開し、内部配列を直接操作させない。
 */
export interface PassiveResolutionStackEntry {
  readonly event: TriggerCandidateEvent;
  readonly candidates: PassiveCandidateGroup;
  /**
   * R-MEM-02: 同じイベントの候補グループはPS候補とMemory候補を1つのエントリとして
   * 保持し、一方を使い切ってからもう一方を先頭から処理する。どちらを先にするかは
   * `resolvesMemoryCandidatesFirst`だけが決める。解決中に新しいイベントが生じた場合は
   * 新しいエントリがスタック先頭へ積まれるため（R-PS-06）、その中の候補は
   * 「現在の候補より後、このエントリの未処理の候補より前」に自然と解決される。
   */
  readonly memoryCandidates: MemoryCandidateGroup;
  /**
   * R-ATM-03: 1回の攻撃スキル使用の攻撃前観測をまとめた発動機会のエントリだけが持つ。
   * `candidates`は全対象の観測から集約した候補で、各候補の契機イベントは
   * `triggerEventOf`が持つ（`event`は最初の観測）。
   */
  readonly preAttackOpportunity?: PreAttackOpportunity;
}

/**
 * R-ATM-03 / R-PS-03: 攻撃前の発動機会の選択状態。同時発動制限は候補検出時ではなく
 * 発動の開始時に確定させる — 発動直前確認（R-PS-04）で不成立になった候補はグループを
 * 占有せず、次の候補が繰り上がる。
 */
export interface PreAttackOpportunity {
  readonly triggerEventOf: ReadonlyMap<PassiveCandidate, TriggerCandidateEvent>;
  /** 発動を開始した候補が占有した同時発動制限グループ（`simultaneousActivationLimitGroupsOf`）。 */
  readonly claimedLimitGroups: Set<string>;
}

/**
 * R-MEM-02 #3: 戦闘開始時・ターン開始時はMemory候補をPS候補より先に解決する
 * （実機の発動順が「戦闘開始時Memory → 戦闘開始時PS → ターン開始時Memory →
 * ターン開始時PS」であるため）。それ以外のイベントはPS候補が先。
 */
const MEMORY_FIRST_EVENT_TYPES: ReadonlySet<string> = new Set(["BattleStarted", "TurnStarted"]);

export function resolvesMemoryCandidatesFirst(entry: PassiveResolutionStackEntry): boolean {
  return MEMORY_FIRST_EVENT_TYPES.has(entry.event.eventType);
}

export type PassiveResolutionStack = readonly PassiveResolutionStackEntry[];

export function createEmptyPassiveResolutionStack(): PassiveResolutionStack {
  return [];
}

export function depthOf(stack: PassiveResolutionStack): number {
  return stack.length;
}

export function peekTop(stack: PassiveResolutionStack): PassiveResolutionStackEntry | undefined {
  return stack[0];
}

/**
 * R-PS-06「新しいグループを候補スタックの先頭へ積む」: `entries`はそのまま先頭へ
 * 積む（`entries[0]`が新しい最上位＝最初に処理される）。複数エントリを同時に積む
 * 場合、呼び出し側は発生順（先に発生したイベントのグループを先に処理したい順）で
 * 並べて渡す。
 */
export function pushCandidateGroups(
  stack: PassiveResolutionStack,
  entries: readonly PassiveResolutionStackEntry[],
): PassiveResolutionStack {
  return [...entries, ...stack];
}

/**
 * R-PS-06「新しいグループの解決後、元のグループの続きへ戻る」: 最上位グループが
 * 使い切られた（候補を処理し尽くした）ときに呼び出し、親グループを最上位へ戻す。
 */
export function popTop(stack: PassiveResolutionStack): PassiveResolutionStack {
  return stack.slice(1);
}

/** 最上位グループのPS候補配列だけを差し替える（1件処理するたびに残りを更新する）。 */
export function withTopCandidates(
  stack: PassiveResolutionStack,
  candidates: readonly PassiveCandidate[],
): PassiveResolutionStack {
  const top = stack[0];
  if (top === undefined) {
    return stack;
  }
  return [{ ...top, candidates }, ...stack.slice(1)];
}

/** R-MEM-02: 最上位グループのMemory候補配列だけを差し替える（PS候補版と同じ規約）。 */
export function withTopMemoryCandidates(
  stack: PassiveResolutionStack,
  memoryCandidates: readonly MemoryCandidate[],
): PassiveResolutionStack {
  const top = stack[0];
  if (top === undefined) {
    return stack;
  }
  return [{ ...top, memoryCandidates }, ...stack.slice(1)];
}
