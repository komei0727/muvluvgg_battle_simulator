// docs/ui-design/03_API・データ連携設計.md §6（総力戦の送信前検証、UI-AC-057）と
// 01_UI要求・画面設計.md §5.10「編成内の重複と再登場」。
//
// 1編成ぶんの規則は既存の`validateDraftWithRules`をそのまま各組へ当て、違反の`path`を
// 総力戦リクエストの形（`/allyFormations/{i}/...`）へ読み替える。サーバーの422も同じ
// `path`で返るため、クライアント違反とサーバー違反を同じ入力欄へ対応づけられる。
import { FORMATION_INDICES, usedFormationIndices } from "./total-war-draft.js";
import type { FormationIndex, TotalWarDraft } from "./total-war-draft.js";
import {
  BATTLE_DRAFT_VALIDATION_RULES,
  validateDraftWithRules,
} from "../formation/draft-validation.js";
import type { DraftValidationRules } from "../formation/draft-validation.js";
import { memorySlotsForSide, memorySlotKeyOf, slotsForSide } from "../formation/types.js";
import type { BattleDraft, Side } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";

/**
 * 規定ターン数は15固定でリクエストにも入力にも現れない（R-TWR-01 #5）。編成プールは
 * 両陣営とも`PLAYABLE`（R-TWR-01 #6）で、通常戦闘の規則と同じ。
 */
const TOTAL_WAR_VALIDATION_RULES: DraftValidationRules = {
  ...BATTLE_DRAFT_VALIDATION_RULES,
  validatesTurnLimit: false,
};

const SIDES: readonly Side[] = ["ally", "enemy"];

function formationPrefix(side: Side): string {
  return side === "ally" ? "/allyFormation" : "/enemyFormation";
}

function totalWarFormationPath(side: Side, index: FormationIndex): string {
  return `${formationPrefix(side)}s/${String(index)}`;
}

/** `/allyFormation`または`/enemyFormation`で始まる違反の陣営。それ以外は陣営を持たない。 */
function sideOfPath(path: string): Side | undefined {
  return SIDES.find(
    (side) => path === formationPrefix(side) || path.startsWith(`${formationPrefix(side)}/`),
  );
}

/**
 * 組の違反から、その陣営が使う編成の分だけを残して`path`を読み替える。組には両陣営が
 * 同居するため、編成数を超えた側（味方2編成なら組3の味方側）の違反はここで落とす。
 */
function relocate(
  violations: readonly UiViolation[],
  draft: TotalWarDraft,
  index: FormationIndex,
): readonly UiViolation[] {
  return violations.flatMap((violation) => {
    const side = sideOfPath(violation.path);
    if (side === undefined || !usedFormationIndices(draft, side).includes(index)) {
      return [];
    }
    return [
      {
        ...violation,
        path:
          totalWarFormationPath(side, index) + violation.path.slice(formationPrefix(side).length),
        formationIndex: index,
      },
    ];
  });
}

/**
 * R-TWR-01 #3: 1つの編成に同じ`unitDefinitionId`は1体。違反は2体目以降の枠へ出す。
 * 1体目は正当な配置であり、どちらを外すかを利用者が選べるようにする。`slots`の並びは
 * 編成エディタの表示順（前衛column 0〜2、後衛column 0〜2）と一致する。衣装違いは別定義
 * なので違反にしない（キャラクターの同一性をUIで推定しない）。
 */
function duplicateUnits(
  formation: BattleDraft,
  side: Side,
  index: FormationIndex,
): readonly UiViolation[] {
  const seen = new Set<string>();
  return slotsForSide(formation, side).flatMap((slot) => {
    const id = slot.unitDefinitionId;
    if (id === undefined) {
      return [];
    }
    if (!seen.has(id)) {
      seen.add(id);
      return [];
    }
    return [
      {
        path: `${totalWarFormationPath(side, index)}/units`,
        slotKey: slot.slotKey,
        formationIndex: index,
        code: "DUPLICATE_UNIT_IN_FORMATION",
        message: "1つの編成に同じユニットは1体までです。別の編成へ移してください。",
        severity: "error",
      },
    ];
  });
}

/** R-TWR-01 #4: 1つの編成に同じメモリーは1件。違反は2件目以降のメモリー枠へ出す。 */
function duplicateMemories(
  formation: BattleDraft,
  side: Side,
  index: FormationIndex,
): readonly UiViolation[] {
  const seen = new Set<string>();
  return memorySlotsForSide(formation, side).flatMap((id, memoryIndex) => {
    if (id === undefined) {
      return [];
    }
    if (!seen.has(id)) {
      seen.add(id);
      return [];
    }
    return [
      {
        path: `${totalWarFormationPath(side, index)}/memoryDefinitionIds`,
        slotKey: memorySlotKeyOf(side, memoryIndex),
        formationIndex: index,
        code: "DUPLICATE_MEMORY_IN_FORMATION",
        message: "1つの編成に同じメモリーは1件までです。",
        severity: "error",
      },
    ];
  });
}

/**
 * 呼び出し側は味方の各組へ`withPlayerEnhancement`で手持ちデータを重ねてから渡す
 * （04_コンポーネント・状態管理設計.md §4）。編成数（1〜3）は検証しない——追加・削除の
 * 操作が範囲外を作れない構造にしている。
 */
export function validateTotalWarDraft(
  draft: TotalWarDraft,
  catalog: BattleSimulationCatalogResponse,
): readonly UiViolation[] {
  return FORMATION_INDICES.flatMap((index) => {
    const formation = draft.formations[index];
    return [
      ...relocate(
        validateDraftWithRules(formation, catalog, TOTAL_WAR_VALIDATION_RULES),
        draft,
        index,
      ),
      ...SIDES.filter((side) => usedFormationIndices(draft, side).includes(index)).flatMap(
        (side) => [
          ...duplicateUnits(formation, side, index),
          ...duplicateMemories(formation, side, index),
        ],
      ),
    ];
  });
}
