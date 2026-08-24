import { describe, expect, it } from "vitest";
import { resolveEffectSequencePlan } from "./effect-action-group-resolver.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { createEffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  contextFor,
  damageAction,
  seedRecorder,
  singleActionStep,
  statModAction,
  unit,
} from "../../../testing/fixtures/effect-sequence-plan.js";

/**
 * R-EFF-09「各インスタンスの失効イベントは、次のインスタンスへ進む前にPS/Memoryの
 * 即時連鎖へ渡す」を、同期callback（`onFactEventForPassiveChain`）を持たない経路
 * ——PS/Memory自身のEffectSequence解決——が満たすための駆動契約。
 *
 * driverは`yield`ごとにそのイベント群の候補連鎖を**完全に解決してから**`.next()`で
 * 再開する（`triggering/resolve-passive-chain.ts`）。その解決中に記録されたイベントは
 * 同じrecorderへ積まれるため、再開後に捕捉位置を進めないと、次の`yield`または
 * EffectAction完了時の`innerEvents`がそれを拾い直し、**同じイベントが2度**
 * `resolveEvent`へ渡る。PS自身は発動済みGuard（R-PS-07）で覆い隠れるが、
 * 1解決スコープ1回制限を持たないMemoryやイベントごとに走るRuntimeCounter更新は
 * 二重に実行される。
 */

const REMOVE_ID = createEffectActionDefinitionId("ACT_TEST_REMOVE_BUFFS");
const removeBuffs: EffectActionDefinition = {
  kind: "REMOVE_EFFECTS",
  effectActionDefinitionId: REMOVE_ID,
  metadata: { tags: [] },
  payload: { categories: ["BUFF"] },
};

/**
 * driverを模して、`yield`のたびにそのイベントを記録し、**その処理中に子連鎖が発行した
 * イベント**を1件recorderへ積む。実際の`resolvePassiveChain`が候補連鎖を解決する間に
 * 起きることの最小再現。
 */
function driveWithChildChain(
  plan: EffectSequencePlan,
  units: readonly BattleUnit[],
  context: ReturnType<typeof contextFor>,
): readonly string[] {
  const box = { units };
  const generator = resolveEffectSequencePlan(plan, box, context);
  const delivered: string[] = [];
  let childCount = 0;
  let step = generator.next();
  while (!step.done) {
    const events = step.value.kind === "TIMING_EVENT" ? [step.value.event] : step.value.events;
    for (const event of events) {
      delivered.push(String(event.eventId));
    }
    childCount += 1;
    context.recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: context.actionScope,
      rootEventId: context.rootEventId,
      payload: { turnNumber: childCount },
    });
    step = generator.next();
  }
  return delivered;
}

/** 子連鎖が積んだ`TurnStarted`のeventId（driverが解決済みのもの）。 */
function childChainEventIds(context: ReturnType<typeof contextFor>): readonly string[] {
  return context.recorder
    .getEvents()
    .filter((event) => event.eventType === "TurnStarted")
    .map((event) => String(event.eventId));
}

describe("EffectSequence resolution: child-chain events are delivered to the driver only once (R-EFF-09)", () => {
  it("UT-R-EFF-09-028: a multi-instance REMOVE_EFFECTS never re-delivers the events its own child chain recorded during an earlier step", () => {
    const buff = statModAction("ACT_TEST_BUFF");
    const actor = unit("ACTOR", "ALLY");
    const holderBase = unit("HOLDER", "ALLY");
    const holder: BattleUnit = {
      ...holderBase,
      appliedEffects: [1, 2, 3].map(
        (n): AppliedEffect => ({
          effectInstanceId: createEffectInstanceId(`buff-${n}`),
          effectActionDefinitionId: buff.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(buff.effectActionDefinitionId),
          duplicate: true,
          sourceUnitId: holderBase.battleUnitId,
          targetUnitId: holderBase.battleUnitId,
          magnitude: 0.1,
          categories: ["BUFF"],
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          appliedTurnNumber: 1,
        }),
      ),
    };
    const effectActions = new Map([
      [buff.effectActionDefinitionId, buff],
      [REMOVE_ID, removeBuffs],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    // callback未指定＝PS/Memory自身のEffectSequence解決の経路。
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, holder.battleUnitId, REMOVE_ID)],
      targetUnitIds: [holder.battleUnitId],
      resolvedBindings: new Map(),
    };

    const delivered = driveWithChildChain(plan, [actor, holder], context);

    // 3インスタンスぶんの除去が別々のstepとしてdriverへ届く（R-EFF-09の粒度）。
    expect(delivered.filter((id) => id !== "")).toEqual([...new Set(delivered)]);
    expect(
      recorder.getEvents().filter((event) => event.eventType === "EffectRemoved"),
    ).toHaveLength(3);
    // 子連鎖が積んだイベントは1件もdriverへ返らない（既に解決済みのため）。
    for (const childEventId of childChainEventIds(context)) {
      expect(delivered).not.toContain(childEventId);
    }
  });

  it("UT-R-EFF-09-029: the same holds for a multi-hit DAMAGE, whose hit chain yields per step through the same cursor", () => {
    const strike = damageAction("ACT_TEST_STRIKE", 3);
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const effectActions = new Map([[strike.effectActionDefinitionId, strike]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [{ effectActionDefinitionId: strike.effectActionDefinitionId }],
          applications: [
            {
              targetUnitId: target.battleUnitId,
              effectActionDefinitionId: strike.effectActionDefinitionId,
              includeDefeated: false,
              hits: [1, 2, 3].map((hitIndex) => ({
                targetUnitId: target.battleUnitId,
                effectActionDefinitionId: strike.effectActionDefinitionId,
                hitIndex,
              })),
            },
          ],
        },
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const delivered = driveWithChildChain(plan, [actor, target], context);

    expect(delivered).toEqual([...new Set(delivered)]);
    expect(
      recorder.getEvents().filter((event) => event.eventType === "DamageApplied"),
    ).toHaveLength(3);
    for (const childEventId of childChainEventIds(context)) {
      expect(delivered).not.toContain(childEventId);
    }
  });
});
