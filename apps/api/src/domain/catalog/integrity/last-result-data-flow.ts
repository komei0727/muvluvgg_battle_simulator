import type { EffectStepDefinition } from "../definitions/effect-sequence.js";
import { EFFECT_STEP_ROOT_PATH } from "../definitions/effect-step-walk.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  collectConditionTargetReferences,
  conditionReferencesLastResult,
} from "./condition-inspection.js";
import { LAST_RESULT_TARGET_KINDS } from "./effect-step-inspection.js";

/**
 * Issue #217設計方針E: `LAST_RESULT`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`
 * が、到達しうる全経路で必ず先行結果を持つかを、Catalog構造だけから検証する
 * （実行時値・条件評価・乱数を一切使わない静的解析）。`definitelyAssigned`は
 * 「この時点までに、必ず1つ以上のEffectAction結果が確定している」を表す
 * boolean latticeで、`false`→`true`にしか遷移しない（一度trueになった経路は
 * 二度と後退しない）。
 *
 * 合流規則がstep kindごとに異なるため、この走査だけは`effect-step-walk.ts`の
 * 汎用降下を使わず自前で降下する（網羅`switch`でkind追加時の漏れを検出する）。
 *
 * 合流規則（design point Eの最小規則）:
 * - `ACTION`: conditionが常にtrue（`TRUE`固定）の場合だけ、このstep自身が
 *   必ず結果を残す（false条件へ倒れうる場合や、対象0件になりうる場合も
 *   R-SKL-08よりSKIPPED結果を残すが、conditionが常にtrueとは限らない場合は
 *   「このstep自体がconditionで丸ごとskipされる経路」があるため、それだけを
 *   根拠にdefinitely-definedへ昇格しない）。
 * - `BRANCH`: then/else双方の出口で定義済みの場合だけ、合流後を
 *   definitely-definedとする。
 * - `RANDOM_BRANCH.WEIGHTED_ONE`: 到達可能（`weight > 0`）な全branchの出口で
 *   定義済みの場合だけ、合流後をdefinitely-definedとする。
 * - `RANDOM_BRANCH.INDEPENDENT`: 0 branch成立の経路が常に存在するため、
 *   branch内部だけを根拠に合流後をdefinitely-definedとしない
 *   （入力時点で既にtrueならtrueのまま）。
 * - `REPEAT`: `count >= 1`（Catalogが保証する）ため、bodyを1回歩いた結果を
 *   そのまま採用する（同じ状態からの2回目以降の歩行は、状態が変化しない
 *   純関数のため恒等的に同じ結果になる）。
 */
function walkLastResultDataFlowStep(
  step: EffectStepDefinition,
  path: string,
  definitelyAssigned: boolean,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): boolean {
  switch (step.kind) {
    case "ACTION": {
      // Issue #230: `LAST_RESULT`/`TARGET_SET_COUNT`は`stepCondition`にしか
      // 置けない。`targetCondition`は常にこのstep自身の`target`だけを参照する
      // （`assertTargetConditionReferencesOwnTarget`が保証する）ため、
      // `step.target.kind`のチェックと重複する内容にしかならず、別途走査
      // する必要がない。
      if (!definitelyAssigned) {
        if (conditionReferencesLastResult(step.stepCondition)) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.stepCondition references kind "LAST_RESULT" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        if (
          step.target.kind === "LAST_ACTION_TARGETS" ||
          step.target.kind === "LAST_DAMAGED_TARGETS"
        ) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.target references kind "${step.target.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        for (const reference of collectConditionTargetReferences(step.stepCondition)) {
          if (LAST_RESULT_TARGET_KINDS.has(reference.kind)) {
            violations.push({
              targetId: ownerId,
              rule: "MISSING_PRECEDING_RESULT",
              message: `${path}.stepCondition's TargetReference references kind "${reference.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
            });
          }
        }
      }
      return definitelyAssigned || step.stepCondition.kind === "TRUE";
    }
    case "BRANCH": {
      if (!definitelyAssigned) {
        if (conditionReferencesLastResult(step.condition)) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.condition references kind "LAST_RESULT" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        for (const reference of collectConditionTargetReferences(step.condition)) {
          if (LAST_RESULT_TARGET_KINDS.has(reference.kind)) {
            violations.push({
              targetId: ownerId,
              rule: "MISSING_PRECEDING_RESULT",
              message: `${path}.condition's TargetReference references kind "${reference.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
            });
          }
        }
      }
      const assignedThen = walkLastResultDataFlowList(
        step.thenSteps,
        `${path}.thenSteps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
      const assignedElse = walkLastResultDataFlowList(
        step.elseSteps,
        `${path}.elseSteps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
      return assignedThen && assignedElse;
    }
    case "RANDOM_BRANCH": {
      if (step.mode === "WEIGHTED_ONE") {
        const reachableResults = step.branches
          .map((branch, index) =>
            (branch.weight ?? 0) > 0
              ? walkLastResultDataFlowList(
                  branch.steps,
                  `${path}.branches[${index}].steps`,
                  definitelyAssigned,
                  ownerId,
                  violations,
                )
              : undefined,
          )
          .filter((assigned): assigned is boolean => assigned !== undefined);
        return reachableResults.length > 0
          ? reachableResults.every((assigned) => assigned)
          : definitelyAssigned;
      }
      // INDEPENDENT: 0 branch成立の経路が常に存在するため、branch内部だけを
      // 根拠に合流後をdefinitely-definedへ昇格しない。violation収集のためだけに
      // 各branchを歩く。
      step.branches.forEach((branch, index) => {
        walkLastResultDataFlowList(
          branch.steps,
          `${path}.branches[${index}].steps`,
          definitelyAssigned,
          ownerId,
          violations,
        );
      });
      return definitelyAssigned;
    }
    case "REPEAT":
      return walkLastResultDataFlowList(
        step.steps,
        `${path}.steps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled EffectStepDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function walkLastResultDataFlowList(
  steps: readonly EffectStepDefinition[],
  path: string,
  definitelyAssigned: boolean,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): boolean {
  let assigned = definitelyAssigned;
  steps.forEach((step, index) => {
    assigned = walkLastResultDataFlowStep(step, `${path}[${index}]`, assigned, ownerId, violations);
  });
  return assigned;
}

export function validateLastResultDataFlow(
  steps: readonly EffectStepDefinition[],
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  walkLastResultDataFlowList(steps, EFFECT_STEP_ROOT_PATH, false, ownerId, violations);
}
