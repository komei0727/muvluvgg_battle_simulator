import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EffectStepDefinition } from "../../domain/catalog/definitions/effect-sequence.js";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import { evasionOf } from "../../testing/production-unit/evasion.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeSkillUse,
  type BoardOverrides,
  type BoardUnitSpec,
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

interface HitConditionedSkill {
  readonly unitDefinitionId: string;
  readonly skillDefinitionId: string;
  readonly skillType: string;
  /** 命中条件付き効果ID → 参照先DAMAGE ID。 */
  readonly conditions: ReadonlyMap<string, readonly string[]>;
  /** 分岐（BRANCH／RANDOM_BRANCH）の外に置かれた命中条件付き効果があるか。 */
  readonly hasTopLevelConditioned: boolean;
}

function collect(
  steps: readonly EffectStepDefinition[],
  conditions: Map<string, readonly string[]>,
  topLevel: boolean,
): boolean {
  let foundTopLevel = false;
  for (const step of steps) {
    switch (step.kind) {
      case "ACTION":
        for (const action of step.actions) {
          if (action.hitCondition !== undefined) {
            conditions.set(action.effectActionDefinitionId, [
              ...(conditions.get(action.effectActionDefinitionId) ?? []),
              ...action.hitCondition.effectActionDefinitionIds,
            ]);
            foundTopLevel ||= topLevel;
          }
        }
        break;
      case "BRANCH":
        collect(step.thenSteps, conditions, false);
        collect(step.elseSteps, conditions, false);
        break;
      case "RANDOM_BRANCH":
        for (const branch of step.branches) {
          collect(branch.steps, conditions, false);
        }
        break;
      case "REPEAT":
        foundTopLevel ||= collect(step.steps, conditions, topLevel);
        break;
    }
  }
  return foundTopLevel;
}

const HIT_CONDITIONED: readonly HitConditionedSkill[] = unitIds.flatMap((unitDefinitionId) => {
  const unit = snapshot.units.get(unitDefinitionId as never)!;
  return [...unit.activeSkillDefinitionIds, unit.extraSkillDefinitionId].flatMap((skillId) => {
    const skill = snapshot.skills.get(skillId)!;
    const conditions = new Map<string, readonly string[]>();
    const hasTopLevelConditioned = collect(skill.resolution.steps, conditions, true);
    return conditions.size === 0
      ? []
      : [
          {
            unitDefinitionId,
            skillDefinitionId: skill.skillDefinitionId,
            skillType: skill.skillType,
            conditions,
            hasTopLevelConditioned,
          },
        ];
  });
});

const ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];
const EVADING_BOARD: BoardOverrides = {
  enemies: ENEMIES.map((spec) => ({ ...spec, state: { appliedEffects: [evasionOf(spec.id)] } })),
};

function use(entry: HitConditionedSkill, board: BoardOverrides): readonly ObservedAction[] {
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

/** 命中条件付き効果の開始より前に、参照先DAMAGEが同じ対象へ命中していない違反を列挙する。 */
function violations(
  entry: HitConditionedSkill,
  actions: readonly ObservedAction[],
): readonly string[] {
  const found: string[] = [];
  actions.forEach((action, index) => {
    const referenced = entry.conditions.get(action.effectActionDefinitionId);
    if (referenced === undefined) {
      return;
    }
    // 同じ効果IDを自身にも条件なしで使う定義（`SKL_YURIA_JOKER_AS1`の呼応）があるため、
    // 命中条件の対象である敵側だけを見る。
    for (const target of action.targets.filter((id) => id.startsWith("enemy:"))) {
      const hit = actions
        .slice(0, index)
        .some(
          (earlier) =>
            referenced.includes(earlier.effectActionDefinitionId) &&
            earlier.targets.includes(target) &&
            earlier.resultKind === undefined,
        );
      if (!hit) {
        found.push(`${action.effectActionDefinitionId}@${target}`);
      }
    }
  });
  return found;
}

describe("production hitCondition sweep (R-SKL-06 #4a)", () => {
  it("IT-CAT-HITCOND-000: the production Catalog declares hitCondition on general AS follow-up effects", () => {
    expect(HIT_CONDITIONED.length).toBeGreaterThanOrEqual(50);
  });

  it.each(HIT_CONDITIONED.map((entry) => [entry.skillDefinitionId, entry] as const))(
    "IT-CAT-HITCOND-001 [R-SKL-06]: %s starts no hit-conditioned effect on a target the referenced DAMAGE never hit, whether every enemy evades or none does",
    (_skillId, entry) => {
      const evaded = use(entry, EVADING_BOARD);
      expect(violations(entry, evaded)).toEqual([]);

      const hit = use(entry, {});
      expect(violations(entry, hit)).toEqual([]);
      if (entry.hasTopLevelConditioned) {
        expect(hit.some((action) => entry.conditions.has(action.effectActionDefinitionId))).toBe(
          true,
        );
      }
    },
  );
});
