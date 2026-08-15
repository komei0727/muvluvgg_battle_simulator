import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import {
  collectEffectActionReferences,
  effectActionClosure,
} from "../traceability/production-id-coverage.js";

/**
 * ユニット効果軸の**実行ベース網羅監査**が使う、定義から到達可能な全EffectAction。
 *
 * `UT-AUDIT-UNITCOV-001`（全ID網羅監査）は「IDがテストファイルへ文字列として
 * 現れるか」しか見ないため、表に書いただけで実際には一度も実行されない定義を
 * 見逃す。各ユニット/メモリーのファイルは、自分のテストが実際に実行した
 * EffectAction 集合がここで求める閉包と一致することを自己検証する。
 *
 * 閉包の求め方（payload経由のEffectAction間参照まで辿る）は監査と同一の
 * `effectActionClosure` を共有し、2つの実装が食い違わないようにする。
 */
function payloadsOf(snapshot: BattleCatalogSnapshot): ReadonlyMap<string, unknown> {
  return new Map(
    [...snapshot.effectActions].map(([id, definition]) => [id as string, definition.payload]),
  );
}

/** 指定Unitの全Skillから到達できるEffectAction ID（payload経由の参照閉包を含む）。 */
export function unitEffectActionClosure(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionId: string,
): ReadonlySet<string> {
  const unit = snapshot.units.get(createUnitDefinitionId(unitDefinitionId));
  if (unit === undefined) {
    throw new Error(`UnitDefinition "${unitDefinitionId}" is not present in the loaded snapshot`);
  }
  const seeds = new Set<string>();
  for (const skillId of [
    ...unit.activeSkillDefinitionIds,
    ...unit.passiveSkillDefinitionIds,
    unit.extraSkillDefinitionId,
  ]) {
    const skill = snapshot.skills.get(skillId);
    if (skill === undefined) {
      throw new Error(`unit "${unitDefinitionId}" references unknown skill "${skillId}"`);
    }
    collectEffectActionReferences(skill, seeds);
  }
  return effectActionClosure(seeds, payloadsOf(snapshot));
}

/** 指定Memoryの`triggeredEffects`から到達できるEffectAction ID。 */
export function memoryEffectActionClosure(
  snapshot: BattleCatalogSnapshot,
  memoryDefinitionId: string,
): ReadonlySet<string> {
  const memory = snapshot.memories.get(createMemoryDefinitionId(memoryDefinitionId));
  if (memory === undefined) {
    throw new Error(
      `MemoryDefinition "${memoryDefinitionId}" is not present in the loaded snapshot`,
    );
  }
  const seeds = new Set<string>();
  collectEffectActionReferences(memory.triggeredEffects, seeds);
  return effectActionClosure(seeds, payloadsOf(snapshot));
}

/**
 * 実行された集合と閉包の差分を、テストが読みやすい形で返す。
 * `unreachable` は「production定義上は存在するが前提盤面を作れない」ものを
 * 理由付きで除外するための許可リスト（到達不能判断
 * `UNREACHABLE_BRANCH_BY_RAW_DATA` と同じ運用）。
 */
export function unexecutedEffectActionIds(
  closure: ReadonlySet<string>,
  executed: ReadonlySet<string>,
  unreachable: readonly string[] = [],
): readonly string[] {
  const excused = new Set(unreachable);
  return [...closure].filter((id) => !executed.has(id) && !excused.has(id)).sort();
}
