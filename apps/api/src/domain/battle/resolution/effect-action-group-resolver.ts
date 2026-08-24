import type { BattleUnit } from "../model/battle-unit.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type {
  EffectActionGroupContext,
  UnitsBox,
} from "./effect-action/effect-action-group-context.js";
import {
  resolveEffectSequencePlan,
  type EffectActionGroupsResult,
  type EffectSequenceOutcome,
} from "./effect-sequence-resolution.js";

export type {
  EffectActionGroupContext,
  EffectResolutionStep,
  UnitsBox,
} from "./effect-action/effect-action-group-context.js";
export { resolveEffectSequencePlan };
export type { EffectActionGroupsResult, EffectSequenceOutcome };
export {
  applyOneEffectAction,
  resolveOneEffectActionApplication,
  type OneApplicationResult,
} from "./effect-step-resolution.js";

/**
 * AS/EX使用（`resolveSkillUse`）とチャージ発動（`resolveChargeRelease`）が使う
 * 同期API。`resolveEffectSequencePlan`（EffectSequence走査、
 * `effect-sequence-resolution.ts`）を駆動し、yieldのたびに
 * `context.onFactEventForPassiveChain`（提供されていれば）を呼んでPS即時連鎖を
 * 同期的に解決する。これらの呼び出し元は`resolvePassiveChain`の`driveActivation`
 * に自身がnestingされることはない（PS発動の起点であり、候補ではない）ため、
 * 各yieldごとに独立した`resolvePassiveChain`呼び出し（`PassiveActivationRuntime.onFactEvent`）
 * で解決してよい。PSの`EffectSequence`自身の解決は`resolveEffectSequencePlan`へ
 * `yield*`委譲する別経路を使う（`passive-activation-service.ts`）。
 *
 * REF-064／#609: この関数自体は「EffectSequence走査（`resolveEffectSequencePlan`）を
 * 駆動するだけ」の合成であり、step走査（`effect-step-resolution.ts`）へは一切
 * 直接触れない — stepの解決はEffectSequence走査が内部で委譲する。
 */
export function applyEffectActionGroups(
  plan: EffectSequencePlan,
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
): EffectActionGroupsResult {
  const box: UnitsBox = { units };
  const generator = resolveEffectSequencePlan(plan, box, context);
  let step = generator.next();
  while (!step.done) {
    if (context.onFactEventForPassiveChain !== undefined) {
      const events = step.value.kind === "TIMING_EVENT" ? [step.value.event] : step.value.events;
      for (const event of events) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    step = generator.next();
  }
  return step.value;
}
