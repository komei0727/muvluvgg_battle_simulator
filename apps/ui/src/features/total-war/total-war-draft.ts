// docs/ui-design/03_API・データ連携設計.md §3.2（総力戦の入力モデル、UI-ADR-013）。
//
// `BattleDraft`は陣営ごとに1編成しか持てず`slotKey`にも編成番号が無いため、型を
// 一般化せず3組並べて持つ。各組を通常戦闘と同じ形のまま保つことで、編成エディタ・
// 選択ダイアログ・`buildFormation`・検証規則を総力戦を知らないまま再利用できる。
import { TOTAL_WAR_MAX_FORMATIONS } from "../../entities/total-war.js";
import type { BattleDraft, LogLevel, Side } from "../../entities/battle-draft.js";
import { createInitialDraft } from "../formation/types.js";

/** 編成番号 - 1。 */
export type FormationIndex = 0 | 1 | 2;
export type FormationCount = 1 | 2 | 3;

export const FORMATION_INDICES: readonly FormationIndex[] = [0, 1, 2];

export type TotalWarFormations = readonly [BattleDraft, BattleDraft, BattleDraft];

export interface TotalWarDraft {
  /**
   * 常に3組。i番目が味方の編成i+1と敵の編成i+1。編成数を超える組の陣営側は
   * リクエスト生成・検証・プレビューの対象外で、空のまま持つ。各組の`turnLimit`・
   * `logLevel`・`exerciseExecution`は読まない。
   */
  readonly formations: TotalWarFormations;
  readonly formationCounts: { readonly ally: FormationCount; readonly enemy: FormationCount };
  readonly logLevel: LogLevel;
}

export function createInitialTotalWarDraft(): TotalWarDraft {
  return {
    formations: [createInitialDraft(), createInitialDraft(), createInitialDraft()],
    formationCounts: { ally: 1, enemy: 1 },
    // 通常戦闘と同じ理由で`SUMMARY`を既定にする。最大30体・15ターンになり得る総力戦の
    // `DETAILED`は通常戦闘よりさらに大きい。
    logLevel: "SUMMARY",
  };
}

/** その陣営で使う（送信・検証する）編成のindexを出撃順に返す。 */
export function usedFormationIndices(draft: TotalWarDraft, side: Side): readonly FormationIndex[] {
  return FORMATION_INDICES.slice(0, draft.formationCounts[side]);
}

export function isFormationCount(value: unknown): value is FormationCount {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TOTAL_WAR_MAX_FORMATIONS
  );
}
