import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/definitions/catalog-ids.js";
import { validateFormationInput, type FormationInput } from "../battle/model/formation-input.js";
import { DomainValidationError } from "../shared/errors.js";

const MIN_FORMATIONS = 1;
const MAX_FORMATIONS = 3;

/** R-TWR-02 #2: 再登場ユニットのHP・攻撃力・防御力の基本値に掛ける係数（−99%）。 */
export const REAPPEARANCE_BASE_STAT_MULTIPLIER = 0.01;

/**
 * R-TWR-01: 1陣営分の総力戦の編成列（出撃順）を検証する。各編成にはR-FRM-01〜04を
 * そのまま適用し、そのうえで1編成内の同じ`UnitDefinitionId`（R-FRM-03の例外）と
 * 同じメモリーIDを拒否する。別の編成どうしの重複は再登場（R-TWR-02）として許可する。
 *
 * 重複はユニット定義単位で判定する。同じキャラクターの衣装違いは別の
 * `UnitDefinitionId`を持つため、ここでは区別せず受理する。
 */
export function validateTotalWarFormations(
  formations: readonly FormationInput[],
  knownMemoryDefinitionIds: ReadonlySet<MemoryDefinitionId>,
  path: string,
): void {
  if (formations.length < MIN_FORMATIONS || formations.length > MAX_FORMATIONS) {
    throw new DomainValidationError(
      path,
      `must contain between ${MIN_FORMATIONS} and ${MAX_FORMATIONS} formations, got ${formations.length}`,
    );
  }

  formations.forEach((formation, formationIndex) => {
    const formationPath = `${path}[${formationIndex}]`;
    validateFormationInput(formation, knownMemoryDefinitionIds, formationPath);

    const seenUnits = new Set<UnitDefinitionId>();
    formation.slots.forEach((slot, slotIndex) => {
      if (seenUnits.has(slot.unitDefinitionId)) {
        throw new DomainValidationError(
          `${formationPath}.slots[${slotIndex}].unitDefinitionId`,
          `duplicates a UnitDefinitionId already placed in this formation: "${slot.unitDefinitionId}"`,
        );
      }
      seenUnits.add(slot.unitDefinitionId);
    });

    const seenMemories = new Set<MemoryDefinitionId>();
    formation.memoryDefinitionIds.forEach((memoryDefinitionId, memoryIndex) => {
      if (seenMemories.has(memoryDefinitionId)) {
        throw new DomainValidationError(
          `${formationPath}.memoryDefinitionIds[${memoryIndex}]`,
          `duplicates a MemoryDefinitionId already assigned to this formation: "${memoryDefinitionId}"`,
        );
      }
      seenMemories.add(memoryDefinitionId);
    });
  });
}

/**
 * R-TWR-02 #1・#2: 1陣営分の編成列（出撃順）について、参加枠ごとの基礎値係数を返す。
 * 戻り値は`formations`と同じ形（編成ごと・参加枠ごと）で、より前の編成に同じ
 * `UnitDefinitionId`がいる参加枠だけが`REAPPEARANCE_BASE_STAT_MULTIPLIER`になる。
 * 3回目以降も同じ係数で、登場回数で累乗しない。
 *
 * 相手陣営の編成は数えないため、陣営ごとに別々に呼ぶ。1編成内の重複は
 * `validateTotalWarFormations`が先に拒否する前提で、ここでは前の編成だけを見る。
 */
export function resolveReappearanceMultipliers(
  formations: readonly FormationInput[],
): readonly (readonly number[])[] {
  const appearedInEarlierFormations = new Set<UnitDefinitionId>();
  return formations.map((formation) => {
    const multipliers = formation.slots.map((slot) =>
      appearedInEarlierFormations.has(slot.unitDefinitionId)
        ? REAPPEARANCE_BASE_STAT_MULTIPLIER
        : 1,
    );
    formation.slots.forEach((slot) => appearedInEarlierFormations.add(slot.unitDefinitionId));
    return multipliers;
  });
}
