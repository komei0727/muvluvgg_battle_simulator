// 01_UI要求・画面設計.md §5.10「編成内の重複と再登場」（R-TWR-02 #1）。
//
// 送信前検証（`total-war-draft-validation.ts`）とは分ける。再登場は送信を止めない
// 予告表示であり、検証の結果に含めると違反として数えられてしまう。
import { usedFormationIndices } from "./total-war-draft.js";
import type { FormationIndex, TotalWarDraft } from "./total-war-draft.js";
import { slotsForSide } from "../formation/types.js";
import type { Side } from "../../entities/battle-draft.js";

const SIDES: readonly Side[] = ["ally", "enemy"];

/** `selectReappearanceSlots`が返す集合の要素。`slotKey`は組の間で同じ文字列になる。 */
export function reappearanceSlotId(index: FormationIndex, slotKey: string): string {
  return `${String(index)}:${slotKey}`;
}

/**
 * R-TWR-02 #1: 同じ陣営のより前の編成に同じユニット定義がいる枠（再登場 −99%）。
 * 補正はサーバーが適用するため、これは予告表示のための派生値であり検証ではない。
 * 相手陣営と同じ編成内（それは`DUPLICATE_UNIT_IN_FORMATION`）は数えない。
 */
export function selectReappearanceSlots(draft: TotalWarDraft): ReadonlySet<string> {
  const reappearing = new Set<string>();
  for (const side of SIDES) {
    const earlier = new Set<string>();
    for (const index of usedFormationIndices(draft, side)) {
      const slots = slotsForSide(draft.formations[index], side);
      for (const slot of slots) {
        if (slot.unitDefinitionId !== undefined && earlier.has(slot.unitDefinitionId)) {
          reappearing.add(reappearanceSlotId(index, slot.slotKey));
        }
      }
      for (const slot of slots) {
        if (slot.unitDefinitionId !== undefined) {
          earlier.add(slot.unitDefinitionId);
        }
      }
    }
  }
  return reappearing;
}
