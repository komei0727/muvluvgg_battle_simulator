import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * M7-017（Issue #271、`CAP_RESOURCE_DISTRIBUTE`）: production Catalogの
 * `UNIT_SUIRAN_CHAOS`／`SKL_SUIRAN_CHAOS_EX`（原文「敵単体に威力318でEN攻撃し、
 * このスキルの発動のために自身が消費したEXゲージを、自身を除く味方全体に分配して
 * 加算する」）を実カタログから読み込み、実ライフサイクル（`resolveSkillUse`→
 * `resolveEffectSequencePlan`→`resource-modification-service.ts`）経由で
 * `operation: DISTRIBUTE`が近似なしに解決できることを検証する。
 *
 * 検証の要点は「対象ごとに総量8を配る（＝`ADD`と同じ）のではなく、総量8を
 * 対象数で等分して加算する」ことと、`ResourceChanged`のStateDeltaが独立Reducer
 * （`state-delta-reducer.ts`）で同じ結果へ復元できることの2点である。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SUIRAN_UNIT_ID = "UNIT_SUIRAN_CHAOS";
const EX_SKILL_ID = "SKL_SUIRAN_CHAOS_EX";
const EX_DISTRIBUTE_ID = "ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE";
const OTHER_UNIT_ID = "UNIT_TEST_DISTRIBUTE_PEER";

/** 原文どおり、EXコストは8 — 分配される総量もこの8である。 */
const EX_COST = 8;
const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 0,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
}

function testUnitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 0,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
}

function battleUnit(
  id: string,
  unitDefinitionId: string,
  side: Side,
  column: "LEFT" | "CENTER" | "RIGHT",
): BattleUnit {
  return createBattleUnit(
    member(id, unitDefinitionId, side, { column, row: "FRONT" }),
    side,
    LIMITS,
  );
}

function definitionsWith(
  snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>,
): BattleDefinitions {
  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(createUnitDefinitionId(OTHER_UNIT_ID), testUnitDefinition(OTHER_UNIT_ID));
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions: new Map(snapshot.skills),
  };
}

/** Suiran（EXゲージ満タン）＋`allyCount`体の味方＋敵1体を並べ、実EXを解決する。 */
function resolveProductionEx(allyCount: number): {
  suiran: BattleUnit;
  allies: readonly BattleUnit[];
  recorder: EventRecorder;
  result: ReturnType<typeof resolveSkillUse>;
  distributeDefinitionId: ReturnType<typeof createEffectActionDefinitionId>;
} {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([SUIRAN_UNIT_ID as never], []);
  const skill = snapshot.skills.get(createSkillDefinitionId(EX_SKILL_ID))!;
  const distributeDefinitionId = createEffectActionDefinitionId(EX_DISTRIBUTE_ID);
  expect(snapshot.effectActions.get(distributeDefinitionId)).toMatchObject({
    kind: "MODIFY_RESOURCE",
    payload: {
      resource: "EX_GAUGE",
      operation: "DISTRIBUTE",
      formula: { kind: "CONSTANT", value: EX_COST },
    },
  });

  const columns = ["LEFT", "CENTER", "RIGHT"] as const;
  const suiran = {
    ...battleUnit("ally:suiran", SUIRAN_UNIT_ID, "ALLY", "CENTER"),
    currentExtraGauge: EX_COST,
  };
  const allies = Array.from({ length: allyCount }, (_, index) =>
    battleUnit(`ally:peer:${index}`, OTHER_UNIT_ID, "ALLY", columns[index % columns.length]!),
  );
  const enemy = battleUnit("enemy:1", OTHER_UNIT_ID, "ENEMY", "CENTER");
  const recorder = new EventRecorder(createBattleId("B_1"));

  const result = resolveSkillUse(
    suiran,
    skill,
    "EX",
    "EX",
    [suiran, ...allies, enemy],
    definitionsWith(snapshot),
    // 先頭のEN攻撃step（`ACT_SUIRAN_CHAOS_EX_DAMAGE`）の会心判定用。
    // criticalRateは0のため、どの値でも非会心に確定する。
    new SequenceRandomSource([0.99]),
    recorder,
    1,
    0,
    createActionId("B_1:action:1"),
    recorder.nextResolutionScopeId(),
  );

  return { suiran, allies, recorder, result, distributeDefinitionId };
}

describe("production Catalog UNIT_SUIRAN_CHAOS EX distribute definition (M7-017, Issue #271, R-ACTN-02)", () => {
  it("IT-CAP-RESOURCE-DISTRIBUTE-PROD-001 (real lifecycle wiring): the real ACT_SUIRAN_CHAOS_EX_EX_DISTRIBUTE splits the consumed 8 EX evenly across every ally except the user instead of granting each ally the full 8, and its ResourceChanged StateDelta reconstructs the same gauges through the independent Reducer", () => {
    const { suiran, allies, recorder, result } = resolveProductionEx(2);

    // R-ACT-03: EX使用で使用者のEXゲージは全消費される（分配の原資）。
    expect(
      result.units.find((u) => u.battleUnitId === suiran.battleUnitId)!.currentExtraGauge,
    ).toBe(0);
    // 総量8を、自身を除く味方2体で等分 = 各4。対象ごとに8を配る`ADD`ではない。
    for (const ally of allies) {
      expect(
        result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
    }

    const distributed = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
          event.eventType === "ResourceChanged" && event.payload.reason === "EFFECT_ACTION",
      );
    expect(distributed.map((event) => event.payload.battleUnitId).sort()).toEqual(
      allies.map((ally) => ally.battleUnitId).sort(),
    );
    for (const event of distributed) {
      expect(event.payload).toMatchObject({
        resource: "EX_GAUGE",
        before: 0,
        after: 4,
        delta: 4,
        baseDelta: 4,
      });
    }

    let state: BattleStateSnapshot = {
      status: "READY",
      currentTurn: 1,
      units: Object.fromEntries(
        [suiran, ...allies].map((unit) => [
          unit.battleUnitId,
          {
            hp: unit.currentHp,
            ap: unit.currentAp,
            pp: unit.currentPp,
            extraGauge: unit.currentExtraGauge,
            combatStats: unit.combatStats,
          },
        ]),
      ),
    };
    for (const event of distributed) {
      state = applyStateDelta(state, event.stateDelta!);
    }
    for (const ally of allies) {
      expect(state.units[ally.battleUnitId]!.extraGauge).toBe(4);
    }
  });

  it("IT-CAP-RESOURCE-DISTRIBUTE-PROD-002 (BOUNDARY): an indivisible total is truncated per ally (R-NUM-02), so three allies receive 2 each and the remainder is discarded rather than redistributed", () => {
    const { allies, recorder, result } = resolveProductionEx(3);

    // 8 / 3 = 2.666… → 各2（合計6）。端数2は破棄する。
    for (const ally of allies) {
      expect(
        result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.currentExtraGauge,
      ).toBe(2);
    }
    const distributed = recorder
      .getEvents()
      .filter(
        (event) =>
          event.eventType === "ResourceChanged" && event.payload.reason === "EFFECT_ACTION",
      );
    expect(distributed).toHaveLength(3);
  });
});
