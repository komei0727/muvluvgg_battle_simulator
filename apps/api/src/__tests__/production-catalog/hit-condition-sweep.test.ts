import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import {
  hitConditionedSkill,
  hitConditionViolations,
  withEvadingEnemies,
} from "../../testing/production-unit/hit-condition.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeSkillUse,
  type BoardOverrides,
  type ObservedAction,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * R-SKL-06 #4a（Issue #825）: `actions[].hitCondition`を持つ全production定義の横断回帰。
 *
 * ユニット単位の結合テストは代表例しか回さないため、ここで全定義について次の不変条件を
 * 実`resolveSkillUse`経路で確かめる。
 *
 * - 命中条件付きの効果が開始された対象には、その前に参照先DAMAGEのいずれかが同じ対象へ
 *   `APPLIED`（1ヒット以上命中）で完了している（別対象の命中を取り込まない）
 * - 敵全員が全ヒットを回避する盤面では、命中条件付きの効果が1件も開始されない
 *   （必中の攻撃は回避されないため、上の不変条件だけで判定する）
 * - 回避の無い盤面では、分岐の外に置いた命中条件付き効果が少なくとも1件は開始される
 *   （条件付けで付与そのものが消えていないこと）
 */

const unitIds = (
  JSON.parse(readFileSync(`${PRODUCTION_CATALOG_DIR}/units.json`, "utf8")) as {
    readonly unitDefinitionId: string;
  }[]
).map((u) => u.unitDefinitionId);
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, unitIds);

const HIT_CONDITIONED = unitIds.flatMap((unitDefinitionId) => {
  const unit = snapshot.units.get(unitDefinitionId as never)!;
  return [...unit.activeSkillDefinitionIds, unit.extraSkillDefinitionId].flatMap((skillId) => {
    const skill = snapshot.skills.get(skillId)!;
    const entry = hitConditionedSkill(snapshot, skillId);
    return entry === undefined ? [] : [{ ...entry, unitDefinitionId, skillType: skill.skillType }];
  });
});

const EVADING_BOARD: BoardOverrides = withEvadingEnemies();

function use(
  entry: (typeof HIT_CONDITIONED)[number],
  board: BoardOverrides,
): readonly ObservedAction[] {
  const observation = observeSkillUse({
    snapshot,
    unitDefinitionId: entry.unitDefinitionId,
    use: {
      kind: "ACTIVE",
      skillDefinitionId: entry.skillDefinitionId,
      ...(entry.skillType === "EX" ? { actionType: "EX" as const } : {}),
    },
    board,
  });
  return observation.actions ?? [];
}

describe("production hitCondition sweep (R-SKL-06 #4a)", () => {
  it("IT-CAT-HITCOND-000: the production Catalog declares hitCondition on general AS follow-up effects", () => {
    expect(HIT_CONDITIONED.length).toBeGreaterThanOrEqual(50);
  });

  it.each(HIT_CONDITIONED.map((entry) => [entry.skillDefinitionId, entry] as const))(
    "IT-CAT-HITCOND-001 [R-SKL-06]: %s starts no hit-conditioned effect on a target the referenced DAMAGE never hit, whether every enemy evades or none does",
    (_skillId, entry) => {
      const evaded = use(entry, EVADING_BOARD);
      expect(hitConditionViolations(entry, evaded)).toEqual([]);

      const hit = use(entry, {});
      expect(hitConditionViolations(entry, hit)).toEqual([]);
      if (entry.hasTopLevelConditioned) {
        expect(hit.some((action) => entry.conditions.has(action.effectActionDefinitionId))).toBe(
          true,
        );
      }
    },
  );
});
