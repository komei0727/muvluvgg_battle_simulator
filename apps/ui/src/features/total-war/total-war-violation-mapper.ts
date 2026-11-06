// docs/ui-design/03_API・データ連携設計.md §13（総力戦のJSON Pointer、UI-API-047）。
//
// `/allyFormations/{i}/...`の`{i}`を落とせば、残りは通常戦闘の`/allyFormation/...`と
// 同じ形になる。`{i}`番目の編成の対応表だけを渡して既存の対応づけ
// （`violation-mapper.ts`）を使い、枠・ギア枠の逆引き規則を二重に持たない。
import type { TotalWarFormationSlotMaps } from "./total-war-request-mapper.js";
import type { UiViolation } from "../../entities/violation.js";
import type { ViolationResponseBody } from "../../shared/api/api-contract.js";
import { mapServerViolationsToUiViolations } from "../simulation/violation-mapper.js";

const FORMATION_PATH_PATTERN = /^\/(ally|enemy)Formations\/(\d+)(\/.*)?$/;

const UNMAPPED_SIDE = { unitSlotKeys: [], memorySlotKeys: [], gearSlotIndices: [] } as const;

function mapOne(violation: ViolationResponseBody, maps: TotalWarFormationSlotMaps): UiViolation {
  const path = violation.path ?? "";
  const match = FORMATION_PATH_PATTERN.exec(path);
  const side = match?.[1] === "ally" ? "ally" : match?.[1] === "enemy" ? "enemy" : undefined;
  const formationIndex = Number(match?.[2]);
  // 送信していない編成のindexは対応づけない。枠を取り違えるより無印にする。
  const sideMap = side === undefined ? undefined : maps[side][formationIndex];
  if (side === undefined || sideMap === undefined) {
    return unmapped(violation);
  }
  const ally = side === "ally" ? sideMap : UNMAPPED_SIDE;
  const enemy = side === "enemy" ? sideMap : UNMAPPED_SIDE;
  const [mapped] = mapServerViolationsToUiViolations(
    [{ ...violation, path: `/${side}Formation${match?.[3] ?? ""}` }],
    ally.unitSlotKeys,
    enemy.unitSlotKeys,
    ally.memorySlotKeys,
    enemy.memorySlotKeys,
    { ally: ally.gearSlotIndices, enemy: enemy.gearSlotIndices },
  );
  // 表示するpathはサーバーが返したものへ戻す。編成indexを落とした形を出すと、
  // サーバーのログやAPIドキュメントと突き合わせられなくなる。陣営の強化入力の違反も
  // `formationIndex`を持つ——3編成で共通の入力なので、どの編成のタブでも同じ欄に出る。
  return { ...(mapped ?? unmapped(violation)), path, formationIndex };
}

/** 枠を持たない違反。`code`の既定は通常戦闘の対応づけと揃える。 */
function unmapped(violation: ViolationResponseBody): UiViolation {
  return {
    path: violation.path ?? "",
    code: violation.ruleId ?? "SERVER_VIOLATION",
    message: violation.message,
    severity: "error",
  };
}

/**
 * `formationSlotMaps`は送信時点の対応表（`buildTotalWarRequest`の戻り値）を渡す。
 * 送信後にdraftを編集しても、422はサーバーが見た配列のindexで返るため。
 * `/allyFormations`（編成数）と`/options/logLevel`は枠を持たない違反として返す。
 */
export function mapTotalWarServerViolations(
  violations: readonly ViolationResponseBody[],
  formationSlotMaps: TotalWarFormationSlotMaps,
): readonly UiViolation[] {
  return violations.map((violation) => mapOne(violation, formationSlotMaps));
}
