import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../domain/battle/skill/skill-resolution-service.js";
import { selectWeightedBranch } from "../domain/battle/skill/random-branch-selection.js";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { UnitDefinitionId } from "../domain/catalog/definitions/catalog-ids.js";
import { createSkillDefinitionId } from "../domain/catalog/definitions/catalog-ids.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import { reduceStateDeltas } from "../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../domain/battle/lifecycle/battle-state-snapshot.js";
import type { Side } from "../domain/shared/side.js";
import type { FormationPosition } from "../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../testing/random/sequence-random-source.js";

/**
 * RES-003（Issue #173、`CAP_RANDOM_BRANCH`）: `RANDOM_BRANCH`の`WEIGHTED_ONE`が
 * Catalog定義順の累積weightへ乱数を1回だけ対応づけて1分岐を選び、選択結果を
 * `RandomBranchSelected`(FACT)へ記録する（R-SKL-07「乱数消費順はCatalog定義順」
 * `random-branch-selection.ts`の`selectWeightedBranch`、`effect-action-group-resolver.ts`
 * の`resolveRandomBranchStep`）ことの、production代表定義による検証証跡。
 *
 * 代表は`SKL_KATE_PALADIN_EX`（実`WEIGHTED_ONE`・3分岐 weight 1/1/1）。branch[0]
 * "HIT5"（`ACT_KATE_PALADIN_EX_DAMAGE5`、他に必須Capabilityを持たない純DAMAGE）
 * だけが現状の実装で完全に解決できるため、branch[0]を選ぶ乱数で実ライフサイクル
 * （`RandomBranchSelected` → `DamageApplied` → StateDelta → 独立Reducer復元）まで
 * 検証する。branch[1] "FREEZE"（`APPLY_STATUS`）・branch[2] "HEAL"（`CAP_HEAL`、
 * M7-005待ちのためPLANNEDのまま）は基本のturn action resolverがまだ実行できない
 * ため、実`branches`配列に対する`selectWeightedBranch`（`resolveRandomBranchStep`が
 * 実行時に呼ぶのと同じ選択関数）で、定義順・weight別に3分岐すべてが選ばれ得る
 * ことだけを検証する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));
const UNIT_ID = "UNIT_KATE_PALADIN";
const SKILL_ID = "SKL_KATE_PALADIN_EX";
const DAMAGE_ACTION_ID = "ACT_KATE_PALADIN_EX_DAMAGE5";

function allyUnit(
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
): BattleUnit {
  const side: Side = "ALLY";
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 200,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

function enemyUnit(
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
): BattleUnit {
  const side: Side = "ENEMY";
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

function initialSnapshotFor(units: readonly BattleUnit[]): BattleStateSnapshot {
  return {
    status: "RUNNING",
    currentTurn: 1,
    units: Object.fromEntries(
      units.map((unit) => [
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
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId("B_CAP_RANDOM_BRANCH"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function contextFor(
  actor: BattleUnit,
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  rootEventId: string,
  random: SequenceRandomSource,
): EffectActionGroupContext {
  return {
    definitions,
    actorId: actor.battleUnitId,
    random,
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId(SKILL_ID),
  };
}

describe("production Catalog CAP_RANDOM_BRANCH (RES-003, Issue #173)", () => {
  it("IT-CAP-RANDOM-BRANCH-PROD-001: SKL_KATE_PALADIN_EX's real WEIGHTED_ONE RANDOM_BRANCH selects branch[0] HIT5 for a low roll and resolves the real ACT_KATE_PALADIN_EX_DAMAGE5 through the lifecycle (RandomBranchSelected + DamageApplied + StateDelta + independent Reducer restoration)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([UNIT_ID as never], []);
    const skill = snapshot.skills.get(SKILL_ID as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_RANDOM_BRANCH");
    const step = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [])[0];
    expect(step?.kind).toBe("RANDOM_BRANCH");
    if (step?.kind !== "RANDOM_BRANCH") {
      throw new Error("expected a RANDOM_BRANCH step");
    }
    expect(step.mode).toBe("WEIGHTED_ONE");
    expect(step.branches).toHaveLength(3);

    const actor = allyUnit("kate", UNIT_ID as never, { column: "LEFT", row: "FRONT" });
    const enemy = enemyUnit("enemy", "UNIT_TEST_ENEMY" as never, { column: "LEFT", row: "FRONT" });
    const allUnits = [actor, enemy];

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions: new Map(),
      skillDefinitions: new Map([[SKILL_ID as never, skill]]),
    };
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder();
    // 先頭の乱数だけがbranch選択に使われる（roll = 0.1 * totalWeight(3) = 0.3 <
    // 累積weight[0]=1 → branch[0]）。残りはDAMAGE5の5ヒット命中/クリティカル判定用に
    // 0.99でno-miss/no-critへ固定する（criticalRate=0のためクリティカルも起きない）。
    const random = new SequenceRandomSource([0.1, ...new Array<number>(64).fill(0.99)]);
    const context = contextFor(actor, definitions, recorder, rootEventId, random);
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");

    const selected = recorder.getEvents().filter((e) => e.eventType === "RandomBranchSelected");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.payload).toMatchObject({
      stepIndex: 0,
      mode: "WEIGHTED_ONE",
      branchIndex: 0,
      label: "HIT5",
    });

    const damageCompleted = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "EffectActionCompleted" &&
          (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
            DAMAGE_ACTION_ID,
      );
    expect(damageCompleted).toHaveLength(1);
    expect((damageCompleted[0]!.payload as { resultKind: string }).resultKind).toBe("APPLIED");

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.currentHp).toBeLessThan(enemy.currentHp);

    // 独立Reducer復元: 記録されたStateDeltaだけから初期状態を再構成し、resolverの
    // 到達したenemy HPと一致することを確認する（R-SKL-07 RANDOM_BRANCH選択枝の
    // 実効果がStateDelta経由でも同じ結果へ復元できる）。
    const initial = initialSnapshotFor(allUnits);
    const reconstructed = reduceStateDeltas(
      initial,
      recorder
        .getEvents()
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(reconstructed.units[enemy.battleUnitId]?.hp).toBe(updatedEnemy.currentHp);
  });

  it("IT-CAP-RANDOM-BRANCH-PROD-002: SKL_KATE_PALADIN_EX's real branches array is selected in Catalog definition order by cumulative weight (R-SKL-07 乱数消費順), reaching all three of HIT5/FREEZE/HEAL", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([UNIT_ID as never], []);
    const skill = snapshot.skills.get(SKILL_ID as never)!;
    const step = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [])[0];
    if (step?.kind !== "RANDOM_BRANCH") {
      throw new Error("expected a RANDOM_BRANCH step");
    }

    // weight 1/1/1（合計3）を均等3分割。roll = next() * 3 が [0,1)→branch0、
    // [1,2)→branch1、[2,3)→branch2。乱数はCatalog定義順の累積weightへ対応する。
    const lowRoll = selectWeightedBranch(step.branches, new SequenceRandomSource([0.1]));
    const midRoll = selectWeightedBranch(step.branches, new SequenceRandomSource([0.5]));
    const highRoll = selectWeightedBranch(step.branches, new SequenceRandomSource([0.9]));

    expect(lowRoll.branchIndex).toBe(0);
    expect(lowRoll.branch.label).toBe("HIT5");
    expect(midRoll.branchIndex).toBe(1);
    expect(midRoll.branch.label).toBe("FREEZE");
    expect(highRoll.branchIndex).toBe(2);
    expect(highRoll.branch.label).toBe("HEAL");
  });
});
