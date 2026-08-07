import type { ConditionDefinition } from "./condition-definition.js";
import type { EffectActionReference, EffectStepDefinition } from "./effect-sequence.js";

/**
 * `EffectStepDefinition`ツリーを降下する唯一の共通経路。
 *
 * step kindごとの子step列を知っているのは`effectStepChildSteps`だけであり、
 * 走査する側（Catalog整合性検証など）は「1 stepをどう見るか」だけを書く。
 * 降下規則が1箇所に集まっていることで、step kindの追加時に修正すべき箇所が
 * `effectStepChildSteps`の網羅`switch`1つに限定され、漏れがコンパイルエラーになる。
 */

export interface EffectStepChildSteps {
  readonly steps: readonly EffectStepDefinition[];
  /** 親stepのpathからの相対セグメント（例: `thenSteps`／`branches[0].steps`）。 */
  readonly pathSegment: string;
}

/** EffectSequence直下の`steps`を指す既定のpath接頭辞（違反メッセージの定義path）。 */
export const EFFECT_STEP_ROOT_PATH = "steps";

/**
 * 1つのstepが持つ子step列を、定義path上のセグメントとともに列挙する。
 * 網羅`switch`とし、新しいstep kindの追加時にこの関数の更新漏れをコンパイル
 * エラーとして検出する（`effect-action-definition.ts`のkindに対する
 * `durationOf`と同じ方針）。
 */
export function effectStepChildSteps(step: EffectStepDefinition): readonly EffectStepChildSteps[] {
  switch (step.kind) {
    case "ACTION":
      return [];
    case "BRANCH":
      return [
        { steps: step.thenSteps, pathSegment: "thenSteps" },
        { steps: step.elseSteps, pathSegment: "elseSteps" },
      ];
    case "RANDOM_BRANCH":
      return step.branches.map((branch, index) => ({
        steps: branch.steps,
        pathSegment: `branches[${index}].steps`,
      }));
    case "REPEAT":
      return [{ steps: step.steps, pathSegment: "steps" }];
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled EffectStepDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 1つのstepが自分自身に宣言している`ConditionDefinition`を列挙する（子stepの
 * conditionは含まない）。ACTIONは`stepCondition`→`targetCondition`の順で、
 * どちらもこのstepのスコープの条件である（前者はstep全体のgate、後者は対象ごとの
 * filter、R-SKL-06/R-SKL-08）。`effectStepChildSteps`と同じく網羅`switch`とし、
 * step kind追加時の更新漏れをコンパイルエラーとして検出する。
 */
export function effectStepOwnConditions(
  step: EffectStepDefinition,
): readonly ConditionDefinition[] {
  switch (step.kind) {
    case "ACTION":
      return [step.stepCondition, step.targetCondition];
    case "BRANCH":
      return [step.condition];
    case "RANDOM_BRANCH":
    case "REPEAT":
      return [];
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled EffectStepDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * ツリー全体を先行順（自分自身 → 宣言順の子step列）に走査し、`predicate`が最初に
 * trueを返した時点で打ち切る。`predicate`は自分自身のフィールドだけを見ればよく、
 * 子stepへの降下は行わない。
 */
export function someEffectStep(
  steps: readonly EffectStepDefinition[],
  predicate: (step: EffectStepDefinition) => boolean,
): boolean {
  for (const step of steps) {
    if (predicate(step)) {
      return true;
    }
    for (const child of effectStepChildSteps(step)) {
      if (someEffectStep(child.steps, predicate)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * ツリー全体を先行順に走査し、各stepから`collector`が返した値を連結する。
 * `path`は違反メッセージがそのまま使う定義path（`steps[1].thenSteps[0]`等）で、
 * pathを必要としない収集では無視してよい。
 */
export function collectEffectSteps<T>(
  steps: readonly EffectStepDefinition[],
  collector: (step: EffectStepDefinition, path: string) => readonly T[],
  rootPath: string = EFFECT_STEP_ROOT_PATH,
): readonly T[] {
  const collected: T[] = [];
  steps.forEach((step, index) => {
    const stepPath = `${rootPath}[${index}]`;
    collected.push(...collector(step, stepPath));
    for (const child of effectStepChildSteps(step)) {
      collected.push(
        ...collectEffectSteps(child.steps, collector, `${stepPath}.${child.pathSegment}`),
      );
    }
  });
  return collected;
}

/** ツリー全体のACTION stepが参照する`EffectActionDefinition`を宣言順に集める。 */
export function collectEffectActionReferences(
  steps: readonly EffectStepDefinition[],
): readonly EffectActionReference[] {
  return collectEffectSteps(steps, (step) => (step.kind === "ACTION" ? step.actions : []));
}
