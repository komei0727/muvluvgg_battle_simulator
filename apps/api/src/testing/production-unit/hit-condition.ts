import type { EffectStepDefinition } from "../../domain/catalog/definitions/effect-sequence.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { evasionOf } from "./evasion.js";
import type { BoardOverrides, BoardUnitSpec, ObservedAction } from "./skill-behaviour.js";

/**
 * R-SKL-06 #4a: production定義の`actions[].hitCondition`（DAMAGE参照）を横断検証する
 * テストの共通部品。ユニット単位の結合テストは代表例しか回さないため、横断テストが
 * 同じ不変条件（参照先DAMAGEが同じ対象へ命中する前に、条件付き効果を開始しない）を
 * 全定義へ当てる。
 */

export interface HitConditionedSkill {
  readonly skillDefinitionId: string;
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
      case "ACTION": {
        // `targetCondition`付きstep（浮足・状態異常を持つ対象だけ等）は既定盤面で
        // 対象が居ないため、分岐の中と同じく「必ず起きる」側に数えない。
        const unconditionalStep = topLevel && step.targetCondition === undefined;
        for (const action of step.actions) {
          if (
            action.hitCondition !== undefined &&
            "effectActionDefinitionIds" in action.hitCondition
          ) {
            conditions.set(action.effectActionDefinitionId, [
              ...(conditions.get(action.effectActionDefinitionId) ?? []),
              ...action.hitCondition.effectActionDefinitionIds,
            ]);
            foundTopLevel ||= unconditionalStep;
          }
        }
        break;
      }
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

/** スキルが宣言するDAMAGE参照の命中条件。無ければ`undefined`。 */
export function hitConditionedSkill(
  snapshot: BattleCatalogSnapshot,
  skillDefinitionId: string,
): HitConditionedSkill | undefined {
  const skill = snapshot.skills.get(skillDefinitionId as never);
  if (skill === undefined || skill.resolution.kind !== "IMMEDIATE") {
    return undefined;
  }
  const conditions = new Map<string, readonly string[]>();
  const hasTopLevelConditioned = collect(skill.resolution.steps, conditions, true);
  return conditions.size === 0
    ? undefined
    : { skillDefinitionId, conditions, hasTopLevelConditioned };
}

/** 命中条件付き効果の開始より前に、参照先DAMAGEが同じ対象へ命中していない違反を列挙する。 */
export function hitConditionViolations(
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

export const DEFAULT_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** `board`の敵（省略時は既定の3体）全員に、全ヒットを回避する状態を持たせる。 */
export function withEvadingEnemies(board: BoardOverrides = {}): BoardOverrides {
  return {
    ...board,
    enemies: (board.enemies ?? DEFAULT_ENEMIES).map((spec) => ({
      ...spec,
      state: {
        ...spec.state,
        appliedEffects: [...(spec.state?.appliedEffects ?? []), evasionOf(spec.id)],
      },
    })),
  };
}
