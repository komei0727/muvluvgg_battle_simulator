import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `05_ドメインモデル.md`「PassiveActivationGuard」: `BattleUnitId + SkillDefinitionId`
 * を解決スコープごとに記録し、同じPSの再発動を防ぐ（R-PS-07）。`cooldown-state.ts`
 * と同じ不変更新方針（新しいインスタンスを返し、既存参照は変更しない）を採る。
 * スコープ終了時の破棄は呼び出し側が新しい空Guardを使うだけで良く、専用APIは
 * 持たない。
 */
export type PassiveActivationGuard = ReadonlySet<string>;

function guardKey(battleUnitId: BattleUnitId, skillDefinitionId: SkillDefinitionId): string {
  return `${battleUnitId}::${skillDefinitionId}`;
}

export function createEmptyPassiveActivationGuard(): PassiveActivationGuard {
  return new Set();
}

export function hasActivated(
  guard: PassiveActivationGuard,
  battleUnitId: BattleUnitId,
  skillDefinitionId: SkillDefinitionId,
): boolean {
  return guard.has(guardKey(battleUnitId, skillDefinitionId));
}

/** R-PS-05 #1「発動済み集合への追加をPP消費やイベント発行より先に行い、再入を防ぐ」。 */
export function recordActivation(
  guard: PassiveActivationGuard,
  battleUnitId: BattleUnitId,
  skillDefinitionId: SkillDefinitionId,
): PassiveActivationGuard {
  return new Set(guard).add(guardKey(battleUnitId, skillDefinitionId));
}
