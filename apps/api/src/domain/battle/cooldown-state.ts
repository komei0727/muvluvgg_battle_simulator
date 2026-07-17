import type { ActionId } from "./events/event-ids.js";
import type { Cooldown, CooldownUnit } from "../catalog/skill-definition.js";
import type { SkillDefinitionId } from "../catalog/catalog-ids.js";

/**
 * `05_ドメインモデル.md`/`06_戦闘状態遷移.md`「クールタイム状態」のBattleUnit側の
 * 可変状態。`setActionId`/`setTurnNumber`は「設定した行動・ターンでは減らさない」
 * (R-SKL-04)を判定するための設定scopeで、ユニット外へは公開しない
 * (`state-delta.ts`の`CooldownState`は`remaining`だけを持つ)。
 */
export interface CooldownEntry {
  readonly unit: CooldownUnit;
  readonly remaining: number;
  readonly setActionId?: ActionId;
  readonly setTurnNumber?: number;
}

export type CooldownMap = Readonly<Record<SkillDefinitionId, CooldownEntry>>;

export interface CooldownChange {
  readonly skillDefinitionId: SkillDefinitionId;
  readonly unit: CooldownUnit;
  readonly before: number;
  readonly after: number;
}

/**
 * R-SKL-04: スキル使用開始時にクールタイムを設定する。`cooldown.count`が0の
 * スキルは減算対象になり得ないため、READY状態のまま何も記録しない
 * (COOLING状態への遷移自体が発生しない)。
 */
export function startCooldown(
  cooldowns: CooldownMap,
  skillDefinitionId: SkillDefinitionId,
  cooldown: Cooldown,
  scope: { readonly actionId: ActionId } | { readonly turnNumber: number },
): { readonly cooldowns: CooldownMap; readonly before: number } {
  const before = cooldowns[skillDefinitionId]?.remaining ?? 0;
  if (cooldown.count === 0) {
    return { cooldowns, before };
  }
  const entry: CooldownEntry = {
    unit: cooldown.unit,
    remaining: cooldown.count,
    ...("actionId" in scope
      ? { setActionId: scope.actionId }
      : { setTurnNumber: scope.turnNumber }),
  };
  return { cooldowns: { ...cooldowns, [skillDefinitionId]: entry }, before };
}

/**
 * R-SKL-04「行動単位」: `currentActionId`と同じ行動で設定されたクールタイムは
 * 減らさない。それ以外の残数1以上のACTION単位クールタイムを1減らす。
 */
export function decrementActionCooldowns(
  cooldowns: CooldownMap,
  currentActionId: ActionId,
): { readonly cooldowns: CooldownMap; readonly changes: readonly CooldownChange[] } {
  return decrementCooldowns(cooldowns, "ACTION", (entry) => entry.setActionId === currentActionId);
}

/**
 * R-SKL-04「ターン単位」: `currentTurnNumber`と同じターンで設定されたクールタイム
 * は減らさない。それ以外の残数1以上のTURN単位クールタイムを1減らす。
 */
export function decrementTurnCooldowns(
  cooldowns: CooldownMap,
  currentTurnNumber: number,
): { readonly cooldowns: CooldownMap; readonly changes: readonly CooldownChange[] } {
  return decrementCooldowns(
    cooldowns,
    "TURN",
    (entry) => entry.setTurnNumber === currentTurnNumber,
  );
}

export type CooldownManipulationOperation = "RESET" | "REDUCE";

/**
 * Issue #129 `COOLDOWN_MANIPULATION`: 他スキルのクールタイムをリセット・短縮する
 * 純粋な状態操作。R-SKL-04の設定scope判定（自身の行動/ターン終了時の自然減算）
 * とは独立した明示的操作のため、`setActionId`/`setTurnNumber`は考慮せず、対象が
 * 現在の行動/ターンで設定されていても適用する。READY/未登録のスキル
 * （エントリ不在、または`remaining`が既に0）への操作は残数不変のためno-opとし、
 * `change`を返さない。
 */
export function manipulateCooldown(
  cooldowns: CooldownMap,
  targetSkillDefinitionId: SkillDefinitionId,
  operation: CooldownManipulationOperation,
  amount?: number,
): { readonly cooldowns: CooldownMap; readonly change?: CooldownChange } {
  const entry = cooldowns[targetSkillDefinitionId];
  if (entry === undefined || entry.remaining === 0) {
    return { cooldowns };
  }
  const before = entry.remaining;
  const after = operation === "RESET" ? 0 : Math.max(0, before - (amount ?? 0));
  if (after === before) {
    return { cooldowns };
  }
  const change: CooldownChange = {
    skillDefinitionId: targetSkillDefinitionId,
    unit: entry.unit,
    before,
    after,
  };
  return {
    cooldowns: { ...cooldowns, [targetSkillDefinitionId]: { ...entry, remaining: after } },
    change,
  };
}

function decrementCooldowns(
  cooldowns: CooldownMap,
  unit: CooldownUnit,
  wasSetInCurrentScope: (entry: CooldownEntry) => boolean,
): { readonly cooldowns: CooldownMap; readonly changes: readonly CooldownChange[] } {
  const changes: CooldownChange[] = [];
  const next: Record<SkillDefinitionId, CooldownEntry> = { ...cooldowns };
  for (const [skillDefinitionId, entry] of Object.entries(cooldowns) as [
    SkillDefinitionId,
    CooldownEntry,
  ][]) {
    if (entry.unit !== unit || entry.remaining === 0 || wasSetInCurrentScope(entry)) {
      continue;
    }
    const after = entry.remaining - 1;
    next[skillDefinitionId] = { ...entry, remaining: after };
    changes.push({ skillDefinitionId, unit, before: entry.remaining, after });
  }
  return { cooldowns: next, changes };
}
