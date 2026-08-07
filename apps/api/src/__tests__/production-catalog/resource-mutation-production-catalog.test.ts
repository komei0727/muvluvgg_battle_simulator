import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * REL-001（Issue #202、`CAP_RESOURCE_MUTATION`）: M7-002（Issue #185）は
 * `MODIFY_RESOURCE`をDomain単体テストだけで`IMPLEMENTED`にしており、production
 * 代表4件（`resource: HP`のコスト支払い）が実経路で解決できることは機械証跡に
 * なっていなかった。ここでは実`catalog/`から2つの`formula`種別を無改変で読み込み、
 * 実ライフサイクル（`resolveSkillUse`→`effect-action-group-resolver.ts`→
 * `resource-modification-service.ts`）を通す。
 *
 * 1. `MAX_HP_RATIO`（`ACT_LILY_HERO_AS1_HP_COST`、最大HPの10%）
 * 2. `CURRENT_HP_RATIO`（`ACT_MAO_COMMITTEE_AS1_HP_COST`、現在HPの25%）—
 *    支払い額が現在HPに追随することは、`MAX_HP_RATIO`と同じ結果にならない
 *    HP状態からでしか区別できないため、HPを削った状態から解決する
 * 3. `bounds.min: 0`（境界）— 支払い額が現在HPを上回っても負のHPにはならない
 *
 * `ResourceChanged`のStateDeltaが独立Reducer（`state-delta-reducer.ts`）で同じHPへ
 * 復元できることも併せて見る（支払いが「イベントに出ない副作用」になっていないこと）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const LILY_UNIT_ID = "UNIT_LILY_HERO";
const LILY_AS1_ID = "SKL_LILY_HERO_AS1";
const LILY_HP_COST_ID = "ACT_LILY_HERO_AS1_HP_COST";
const MAO_UNIT_ID = "UNIT_MAO_COMMITTEE";
const MAO_AS1_ID = "SKL_MAO_COMMITTEE_AS1";
const MAO_HP_COST_ID = "ACT_MAO_COMMITTEE_AS1_HP_COST";
const PEER_UNIT_ID = "UNIT_TEST_MUTATION_PEER";

/** 実Catalogの支払い率。 */
const LILY_MAX_HP_RATIO = 0.1;
const MAO_CURRENT_HP_RATIO = 0.25;

const MAXIMUM_HP = 10000;
const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 7 };
const COMBAT_STATS = {
  maximumHp: MAXIMUM_HP,
  attack: 100,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function actor(
  battleUnitId: string,
  unitDefinitionId: string,
  side: "ALLY" | "ENEMY",
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position: { column: side === "ALLY" ? "CENTER" : "CENTER", row: "FRONT" },
    combatStats: COMBAT_STATS,
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp, currentPp: LIMITS.maximumPp, ...overrides },
  });
}

function loadSnapshot(): BattleCatalogSnapshot {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [LILY_UNIT_ID, MAO_UNIT_ID]);
  // 実Catalogの定義形をこのテストの前提として固定する（近似・差し替えなし）。
  expect(effectActionFrom(snapshot, LILY_HP_COST_ID)).toMatchObject({
    kind: "MODIFY_RESOURCE",
    payload: {
      resource: "HP",
      operation: "ADD",
      formula: {
        kind: "MAX_HP_RATIO",
        source: { kind: "SKILL_SOURCE" },
        ratio: -LILY_MAX_HP_RATIO,
      },
      bounds: { min: 0, max: "CURRENT_MAX" },
    },
    requiredCapabilities: ["CAP_FORMULA", "CAP_RESOURCE_MUTATION"],
  });
  expect(effectActionFrom(snapshot, MAO_HP_COST_ID)).toMatchObject({
    kind: "MODIFY_RESOURCE",
    payload: {
      resource: "HP",
      operation: "ADD",
      formula: {
        kind: "CURRENT_HP_RATIO",
        source: { kind: "SKILL_SOURCE" },
        ratio: -MAO_CURRENT_HP_RATIO,
      },
      bounds: { min: 0, max: "CURRENT_MAX" },
    },
    requiredCapabilities: ["CAP_FORMULA", "CAP_RESOURCE_MUTATION"],
  });
  return snapshot;
}

interface Resolution {
  readonly actorAfter: BattleUnit;
  readonly hpCostEvent: Extract<BattleDomainEvent, { eventType: "ResourceChanged" }>;
  readonly restoredHp: number;
}

/**
 * 実ASを実ライフサイクルで解決し、HP支払いの`ResourceChanged`だけを取り出す。
 * 同じ行動はAPコスト（`reason: SKILL_COST`）とEXゲージ増加（`EX_GAIN`）の
 * `ResourceChanged`も出すため、`resource`と`reason`の両方で絞る。
 */
function resolveCostSkill(
  snapshot: BattleCatalogSnapshot,
  skillId: string,
  self: BattleUnit,
): Resolution {
  const ally = actor("ally:peer", PEER_UNIT_ID, "ALLY");
  const enemy = actor("enemy:1", PEER_UNIT_ID, "ENEMY");
  const units = [self, ally, enemy];
  const recorder = new EventRecorder(createBattleId("B_COST"));

  const result = resolveSkillUse(
    self,
    skillFrom(snapshot, skillId),
    "AS",
    "AS",
    units,
    definitionsWith(snapshot, { units: [PEER_UNIT_ID] }),
    noMissNoCrit(),
    recorder,
    1,
    1,
    createActionId("B_COST:action:1"),
    recorder.nextResolutionScopeId(),
  );

  const hpCostEvent = recorder
    .getEvents()
    .find(
      (event): event is Extract<BattleDomainEvent, { eventType: "ResourceChanged" }> =>
        event.eventType === "ResourceChanged" &&
        event.payload.resource === "HP" &&
        event.payload.battleUnitId === self.battleUnitId &&
        event.payload.reason === "EFFECT_ACTION",
    )!;

  const restored = reduceStateDeltas(
    initialSnapshotFor(units, { status: "READY" }),
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta !== undefined ? [event.stateDelta] : [])),
  );

  return {
    actorAfter: result.units.find((unit) => unit.battleUnitId === self.battleUnitId)!,
    hpCostEvent,
    restoredHp: restored.units[self.battleUnitId]!.hp,
  };
}

describe("production Catalog MODIFY_RESOURCE HP cost (REL-001, Issue #202, CAP_RESOURCE_MUTATION, R-ACTN-02)", () => {
  it("IT-CAP-RESOURCE-MUTATION-PROD-001 (real lifecycle wiring, MAX_HP_RATIO): the real SKL_LILY_HERO_AS1 pays 10% of the user's MAXIMUM HP, and its ResourceChanged StateDelta restores the same HP through the independent Reducer", () => {
    const snapshot = loadSnapshot();
    const lily = actor("ally:lily", LILY_UNIT_ID, "ALLY", { currentHp: MAXIMUM_HP });

    const { actorAfter, hpCostEvent, restoredHp } = resolveCostSkill(snapshot, LILY_AS1_ID, lily);

    const cost = MAXIMUM_HP * LILY_MAX_HP_RATIO;
    expect(actorAfter.currentHp).toBe(MAXIMUM_HP - cost);
    expect(hpCostEvent.payload).toMatchObject({
      resource: "HP",
      before: MAXIMUM_HP,
      after: MAXIMUM_HP - cost,
      delta: -cost,
    });
    expect(restoredHp).toBe(actorAfter.currentHp);
  });

  it("IT-CAP-RESOURCE-MUTATION-PROD-002 (real lifecycle wiring, CURRENT_HP_RATIO): the real SKL_MAO_COMMITTEE_AS1 pays 25% of the user's CURRENT HP, so a damaged user pays strictly less than the maximum-HP share", () => {
    const snapshot = loadSnapshot();
    const currentHp = MAXIMUM_HP / 2;
    const mao = actor("ally:mao", MAO_UNIT_ID, "ALLY", { currentHp });

    const { actorAfter, hpCostEvent } = resolveCostSkill(snapshot, MAO_AS1_ID, mao);

    const cost = currentHp * MAO_CURRENT_HP_RATIO;
    expect(actorAfter.currentHp).toBe(currentHp - cost);
    expect(hpCostEvent.payload).toMatchObject({ before: currentHp, after: currentHp - cost });
    // 最大HP基準なら2500払うところを、現在HP基準では1250しか払わない。
    expect(cost).toBeLessThan(MAXIMUM_HP * MAO_CURRENT_HP_RATIO);
  });

  it("IT-CAP-RESOURCE-MUTATION-PROD-003 (BOUNDARY, bounds.min): a payment larger than the remaining HP floors at 0 instead of producing a negative gauge", () => {
    const snapshot = loadSnapshot();
    // 最大HPの10%（=1000）より少ない残HPから、実`MAX_HP_RATIO`の支払いを起こす。
    const currentHp = 400;
    const lily = actor("ally:lily", LILY_UNIT_ID, "ALLY", { currentHp });

    const { actorAfter, hpCostEvent } = resolveCostSkill(snapshot, LILY_AS1_ID, lily);

    expect(actorAfter.currentHp).toBe(0);
    expect(hpCostEvent.payload).toMatchObject({ before: currentHp, after: 0, delta: -currentHp });
  });
});
