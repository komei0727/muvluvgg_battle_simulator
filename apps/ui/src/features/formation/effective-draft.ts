// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4「編成draftと選択dialog」。
//
// モード別draft（`formation-reducer.ts`）は味方の学園レベル・レベルリンク・
// ユニット強化を持たない（REF-058 / Issue #603）。それらはモード非依存の単一slice
// （`player-enhancement-reducer.ts`）が持つため、request-mapper・draft-validation・
// stat previewなど既存の読み手へ渡す直前にここで重ね合わせる。既存の読み手は
// `BattleDraft`だけを見て動くため、この合成関数以外は変更を要らない。
import type { BattleDraft, FormationSlotInput } from "../../entities/battle-draft.js";
import type { PlayerEnhancementState } from "./player-enhancement-reducer.js";

function withResolvedEnhancement(
  slot: FormationSlotInput,
  playerEnhancement: PlayerEnhancementState,
): FormationSlotInput {
  if (slot.unitDefinitionId === undefined) {
    return slot;
  }
  const enhancement = playerEnhancement.units[slot.unitDefinitionId];
  return enhancement === undefined ? slot : { ...slot, enhancement };
}

/**
 * モード別draftへ手持ちデータ（味方の学園レベル・レベルリンク・ユニット強化）を
 * 重ね合わせた`BattleDraft`を作る。味方の`enabled`（強化トグル）はモード非依存
 * ではないため（`UI-AC-030`）、draft自身の値をそのまま使う。
 */
export function withPlayerEnhancement(
  draft: BattleDraft,
  playerEnhancement: PlayerEnhancementState,
): BattleDraft {
  return {
    ...draft,
    allySlots: draft.allySlots.map((slot) => withResolvedEnhancement(slot, playerEnhancement)),
    allyEnhancement: {
      ...draft.allyEnhancement,
      academyLevels: playerEnhancement.academyLevels,
      levelLink: playerEnhancement.levelLink,
    },
  };
}
