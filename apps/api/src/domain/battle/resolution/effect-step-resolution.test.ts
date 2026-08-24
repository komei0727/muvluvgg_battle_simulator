import { describe, expect, it } from "vitest";
import { applyOneEffectAction } from "./effect-step-resolution.js";
import type { EffectActionApplication } from "../skill/skill-resolution-service.js";
import {
  unit,
  statusAction,
  contextFor,
  seedRecorder,
} from "../../../testing/fixtures/effect-sequence-plan.js";

describe("applyOneEffectAction", () => {
  it("UT-EFFECTSTEP-001: drives a kind handler for one target/EffectAction without the surrounding ACTION step lifecycle", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const application: EffectActionApplication = {
      targetUnitId: enemy.battleUnitId,
      effectActionDefinitionId: status.effectActionDefinitionId,
      includeDefeated: false,
      hits: [
        {
          targetUnitId: enemy.battleUnitId,
          effectActionDefinitionId: status.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
    };

    const before = recorder.getEvents().length;
    const { units, result } = applyOneEffectAction(
      application,
      [actor, enemy],
      context,
      context.parentEventId,
    );
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    // ACTION step全体のライフサイクルイベント（EffectStepStarting/EffectStepCompleted）を
    // 一切発行しない — applyEffectActionGroups経由の同種テストとの違いがこの薄い入口の
    // 存在理由そのもの。
    expect(emitted).toEqual(["EffectActionStarting", "EffectApplied", "EffectActionCompleted"]);
    expect(result).toMatchObject({ interrupted: false, resolvedCount: 1, interruptedCount: 0 });

    const granted = units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(granted.appliedEffects).toHaveLength(1);
    expect(granted.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: status.effectActionDefinitionId,
      sourceUnitId: actor.battleUnitId,
      targetUnitId: enemy.battleUnitId,
    });
  });

  it("UT-EFFECTSTEP-002: re-validates actor defeat after the TIMING event before dispatching to the kind handler (R-SKL-01)", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    // TIMINGイベント（EffectActionStarting）を契機に、駆動側がPS/Memory連鎖を解決した
    // 結果として使用者が戦闘不能になった状況をシミュレートする。
    const context = contextFor(
      actor,
      effectActions,
      recorder,
      rootEventId,
      (_event, currentUnits) =>
        currentUnits.map((u) =>
          u.battleUnitId === actor.battleUnitId ? { ...u, currentHp: 0 } : u,
        ),
    );
    const application: EffectActionApplication = {
      targetUnitId: enemy.battleUnitId,
      effectActionDefinitionId: status.effectActionDefinitionId,
      includeDefeated: false,
      hits: [
        {
          targetUnitId: enemy.battleUnitId,
          effectActionDefinitionId: status.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
    };

    const before = recorder.getEvents().length;
    const { units, result } = applyOneEffectAction(
      application,
      [actor, enemy],
      context,
      context.parentEventId,
    );
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    // 使用者が戦闘不能になった時点でkindハンドラへは一切進まないため、
    // EffectActionCompleted（EffectApplied含む）は発行しない。
    expect(emitted).toEqual(["EffectActionStarting"]);
    expect(result).toMatchObject({ interrupted: true, resolvedCount: 0, interruptedCount: 1 });

    const target = units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(0);
  });
});
