import type { PositionColumn } from "../../domain/catalog/definitions/catalog-enums.js";
import type {
  FormationInput as DomainFormationInput,
  FormationPosition,
} from "../../domain/battle/model/formation-input.js";
import type { FormationInput, FormationPositionInput } from "./simulate-battle-command.js";

const COLUMNS: Record<0 | 1 | 2, PositionColumn> = { 0: "LEFT", 1: "CENTER", 2: "RIGHT" };

/**
 * `10_API設計.md`/`09_アプリケーション設計.md`: Commandの配置入力
 * (`column: 0|1|2`, `row: FRONT|REAR`、各陣営から見た表現) をDomainの共通座標
 * 表現(`LEFT|CENTER|RIGHT`, `FRONT|BACK`)へ変換する。
 */
export function toDomainFormationPosition(position: FormationPositionInput): FormationPosition {
  return {
    column: COLUMNS[position.column],
    row: position.row === "FRONT" ? "FRONT" : "BACK",
  };
}

/**
 * R-ENH-01: 強化指定はCommandとDomainで同形のため、キーの有無だけを保つ。
 * 「指定なし」と「空オブジェクトの指定」は意味が違う（後者は陣営を強化対象にする）
 * ので、`undefined`を明示的に埋めずキーごと落とす。
 */
export function toDomainFormationInput(formation: FormationInput): DomainFormationInput {
  return {
    slots: formation.slots.map((slot) => ({
      unitDefinitionId: slot.unitDefinitionId,
      position: toDomainFormationPosition(slot.position),
      ...(slot.enhancement === undefined ? {} : { enhancement: slot.enhancement }),
    })),
    memoryDefinitionIds: formation.memoryDefinitionIds,
    ...(formation.enhancement === undefined ? {} : { enhancement: formation.enhancement }),
  };
}
