import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "./passive-activation-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId } from "../../shared/ids.js";
import { createActionId } from "../../shared/event-ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import {
  contextOf,
  definitionsOf,
  passiveSkillOf,
  recordTurnStarted,
  unit,
  unitDefinitionOf,
} from "../../../testing/fixtures/passive-activation-runtime.js";

/**
 * R-PS-09: PSの`activationCondition`に置いた`SELECTED_TARGET_STATE`が、不成立なら
 * 発動そのものを止める（PP消費・`PassiveActivated`が起きない）ことを、実際の
 * 候補検出→発動直前再確認→発動の経路で確かめる。
 */
describe("PassiveActivationRuntime: SELECTED_TARGET_STATE activationCondition (R-PS-09)", () => {
  const ownerDefinitionId = createUnitDefinitionId("UNIT_SELECTOR_OWNER");
  const enemyDefinitionId = createUnitDefinitionId("UNIT_SELECTOR_ENEMY");
  const farthestEnemyIsCute: SkillDefinition = {
    ...passiveSkillOf("SKL_PS_FARTHEST_CUTE"),
    activationCondition: {
      kind: "SELECTED_TARGET_STATE",
      selector: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        filters: [],
        order: ["FARTHEST"],
        includeDefeated: false,
      },
      field: "ATTRIBUTE",
      op: "EQ",
      value: "CUTE",
    },
  };
  const definitions = definitionsOf(
    new Map([
      [
        ownerDefinitionId,
        unitDefinitionOf(ownerDefinitionId, [farthestEnemyIsCute.skillDefinitionId]),
      ],
      [enemyDefinitionId, unitDefinitionOf(enemyDefinitionId, [])],
    ]),
    new Map([[farthestEnemyIsCute.skillDefinitionId, farthestEnemyIsCute]]),
    new Map(),
  );

  function fireTurnStarted(enemy: BattleUnit) {
    const owner = unit("OWNER", "ALLY", { unitDefinitionId: ownerDefinitionId, currentPp: 3 });
    const recorder = new EventRecorder(createBattleId("B_SELECTED"));
    const turnStarted = recordTurnStarted(recorder);
    const runtime = new PassiveActivationRuntime(
      contextOf(recorder, definitions, turnStarted, createActionId("B_SELECTED:action:1")),
      [owner, enemy],
    );
    const units = runtime.onFactEvent(turnStarted, [owner, enemy]).units;
    return {
      activated: recorder.getEvents().filter((event) => event.eventType === "PassiveActivated")
        .length,
      pp: units.find((u) => u.battleUnitId === owner.battleUnitId)!.currentPp,
    };
  }

  it("UT-R-PS-09-008: does not activate (no PassiveActivated, no PP spent) while the farthest enemy is not CUTE, and activates once it is", () => {
    expect(
      fireTurnStarted({
        ...unit("ENEMY", "ENEMY", { unitDefinitionId: enemyDefinitionId }),
        attribute: "CLEVER",
      }),
    ).toEqual({
      activated: 0,
      pp: 3,
    });
    expect(
      fireTurnStarted({
        ...unit("ENEMY", "ENEMY", { unitDefinitionId: enemyDefinitionId }),
        attribute: "CUTE",
      }),
    ).toEqual({
      activated: 1,
      pp: 1,
    });
  });
});
