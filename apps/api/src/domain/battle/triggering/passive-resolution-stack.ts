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
   * R-MEM-02「同じイベントでPS候補とMemory候補が両方存在する場合、PS候補を先に
   * 解決し、その後Memory候補を解決する」: 同じイベントの候補グループはPS候補と
   * Memory候補を1つのエントリとして保持し、`candidates`（PS）を使い切ってから
   * `memoryCandidates`を先頭から処理する。PS解決中に新しいイベントが生じた場合は
   * 新しいエントリがスタック先頭へ積まれるため（R-PS-06）、その中のMemory候補は
   * 「現在のPS候補グループより後、未処理の親Memory候補より前」に自然と解決される。
   */
  readonly memoryCandidates: MemoryCandidateGroup;
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
