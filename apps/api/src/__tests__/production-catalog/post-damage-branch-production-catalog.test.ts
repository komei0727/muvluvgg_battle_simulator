import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { MarkerState } from "../../domain/battle/model/marker-state.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { Side } from "../../domain/shared/side.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

interface StatOverrides {
  readonly maximumHp?: number;
  readonly attack?: number;
  readonly defense?: number;
}

function unitOf(
  side: Side,
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: StatOverrides = {},
  markerStates: readonly MarkerState[] = [],
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100000,
      attack: overrides.attack ?? 300,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const unit = createBattleUnit(member, side, {
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 10,
  });
  return markerStates.length > 0 ? { ...unit, markerStates } : unit;
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
          maximumAp: unit.maximumAp,
          maximumPp: unit.maximumPp,
          maximumExtraGauge: unit.maximumExtraGauge,
          combatStats: unit.combatStats,
        },
      ]),
    ),
  };
}

function seedRecorder(scope: string): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId(scope));
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
  skillId: string,
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  rootEventId: string,
): EffectActionGroupContext {
  return {
    definitions,
    actorId: actor.battleUnitId,
    random: new SequenceRandomSource(new Array<number>(64).fill(0.99)),
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId(skillId),
  };
}

function definitionsFor(
  effectActions: BattleDefinitions["effectActions"],
  skillId: string,
  skill: SkillDefinition,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions: new Map(),
    skillDefinitions: new Map([[skillId as never, skill]]),
  };
}

function completedTargets(
  recorder: EventRecorder,
  effectActionDefinitionId: string,
): readonly string[] {
  return recorder
    .getEvents()
    .filter(
      (e) =>
        e.eventType === "EffectActionCompleted" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          effectActionDefinitionId,
    )
    .flatMap((e) => (e.payload as { targetUnitIds: readonly string[] }).targetUnitIds);
}

function reconstruct(initial: BattleStateSnapshot, recorder: EventRecorder): BattleStateSnapshot {
  return reduceStateDeltas(
    initial,
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
  );
}

/**
 * DMG-003（Issue #196、`POST_DAMAGE_CRITICAL_BRANCH`／`POST_DAMAGE_SURVIVAL_BRANCH`）:
 * 「この攻撃で会心攻撃が発生した場合」と「この攻撃で敵を倒した場合／攻撃後に敵が
 * 生存していた場合」を、実`catalog/`からロードした未改変のproduction定義で検証する
 * 証跡。
 *
 * - 会心分岐（`LAST_RESULT`の`criticalHitCount`）: `SKL_FEE_BATH_AS2`（単体・3ヒット、
 *   会心時に「ほてり」を1つ追加付与）と`SKL_ROSIE_ARTIST_AS1`（敵横一列、会心時に
 *   追撃＋自身へ与ダメージバフ）。後者はAOEであり、`criticalHitCount`がstep全体
 *   スコープであること——最後に処理した対象1体ではなくstepのどこかで会心が出たか——
 *   をproduction定義の形のまま確かめる。
 * - 撃破/生存分岐（`TARGET_SET_COUNT`の`countOf`）: `SKL_HIIRO_LONEWOLF_AS2`
 *   （敵前後列`TGT_COLUMN`のいずれかを倒したらEXゲージ+1）と`SKL_JULIE_SNOW_EX`
 *   （敵3体`TGT_3ENEMIES`のいずれかが生存していたら追撃）。どちらも近似前は
 *   基準対象(TGT_BASE)1体の生存確認だったため、「基準対象は生き残ったが別の
 *   構成員は倒れた」形を通すことで近似との差を固定する。
 *
 * 会心の有無は`combatStats.criticalRate`（0 / 1）で決定的に切り替える —
 * `resolveProbability`（R-NUM-03）は実効会心率が1なら必ず成立し0なら必ず不成立で、
 * どちらもRandomSourceの並びに依存しない。
 */

/** 会心率を0/1へ固定したUnit（R-NUM-03により乱数の並びに依存せず決定的になる）。 */
function withCriticalRate(unit: BattleUnit, criticalRate: number): BattleUnit {
  return { ...unit, combatStats: { ...unit.combatStats, criticalRate } };
}

function markerStackOf(unit: BattleUnit | undefined, markerIdValue: string): number {
  return unit?.markerStates.find((m) => m.markerId === markerIdValue)?.stackCount ?? 0;
}

describe("production Catalog POST_DAMAGE_CRITICAL_BRANCH / POST_DAMAGE_SURVIVAL_BRANCH (DMG-003, Issue #196)", () => {
  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-001: SKL_FEE_BATH_AS2's real LAST_RESULT criticalHitCount branch grants the extra 「ほてり」 only when the attack actually crit", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_FEE_BATH" as never], []);
    const skill = snapshot.skills.get("SKL_FEE_BATH_AS2" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_RESOLUTION_BRANCH_REPEAT");
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    const branch = steps.find((s) => s.kind === "BRANCH")!;
    expect(branch.kind === "BRANCH" && branch.condition).toEqual({
      kind: "LAST_RESULT",
      field: "criticalHitCount",
      op: "GTE",
      value: 1,
    });

    const stacksFor = (criticalRate: number, scope: string): number => {
      const base = unitOf("ALLY", "fee", "UNIT_FEE_BATH" as never, {
        column: "LEFT",
        row: "FRONT",
      });
      const actor = withCriticalRate(base, criticalRate);
      const enemy = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, {
        column: "LEFT",
        row: "FRONT",
      });
      const allUnits = [actor, enemy];
      const definitions = definitionsFor(snapshot.effectActions, "SKL_FEE_BATH_AS2", skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder(scope);
      const result = applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, "SKL_FEE_BATH_AS2", definitions, recorder, rootEventId),
      );
      expect(result.outcome.status).toBe("COMPLETED");
      return markerStackOf(
        result.units.find((u) => u.battleUnitId === enemy.battleUnitId),
        "MARKER_FEE_BATH_FLUSH",
      );
    };

    // 非会心では通常付与の1つだけ、会心では追加付与を含めて2つ。
    expect(stacksFor(0, "B_FEE_NO_CRIT")).toBe(1);
    expect(stacksFor(1, "B_FEE_CRIT")).toBe(2);
  });

  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-002: SKL_ROSIE_ARTIST_AS1's AOE crit branch fires on a step-wide crit, applying the follow-up row damage and the self damage buff", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_ROSIE_ARTIST" as never], []);
    const skill = snapshot.skills.get("SKL_ROSIE_ARTIST_AS1" as never)!;

    const run = (criticalRate: number, scope: string) => {
      const actor = withCriticalRate(
        unitOf("ALLY", "rosie", "UNIT_ROSIE_ARTIST" as never, { column: "LEFT", row: "FRONT" }),
        criticalRate,
      );
      const e1 = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, {
        column: "LEFT",
        row: "FRONT",
      });
      const e2 = unitOf("ENEMY", "e2", "UNIT_TEST_ENEMY" as never, {
        column: "CENTER",
        row: "FRONT",
      });
      const allUnits = [actor, e1, e2];
      const definitions = definitionsFor(snapshot.effectActions, "SKL_ROSIE_ARTIST_AS1", skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder(scope);
      const result = applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, "SKL_ROSIE_ARTIST_AS1", definitions, recorder, rootEventId),
      );
      expect(result.outcome.status).toBe("COMPLETED");
      return { recorder, result, actor, enemies: [e1, e2] as const, allUnits };
    };

    const crit = run(1, "B_ROSIE_CRIT");
    // 追撃は敵横一列（2体）へ、与ダメージバフは自身へ。
    expect([...completedTargets(crit.recorder, "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT")].sort()).toEqual(
      crit.enemies.map((e) => e.battleUnitId).sort(),
    );
    expect(completedTargets(crit.recorder, "ACT_ROSIE_ARTIST_AS1_DMG_UP")).toEqual([
      crit.actor.battleUnitId,
    ]);
    const buffed = crit.result.units.find((u) => u.battleUnitId === crit.actor.battleUnitId)!;
    expect(
      buffed.appliedEffects.filter(
        (e) => e.effectActionDefinitionId === "ACT_ROSIE_ARTIST_AS1_DMG_UP",
      ),
    ).toHaveLength(1);

    const noCrit = run(0, "B_ROSIE_NO_CRIT");
    expect(completedTargets(noCrit.recorder, "ACT_ROSIE_ARTIST_AS1_DAMAGE_CRIT")).toEqual([]);
    expect(completedTargets(noCrit.recorder, "ACT_ROSIE_ARTIST_AS1_DMG_UP")).toEqual([]);

    // 独立Reducer復元でも会心経路のHPが一致する。
    const reconstructed = reconstruct(initialSnapshotFor(crit.allUnits), crit.recorder);
    for (const enemy of crit.enemies) {
      const updated = crit.result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(reconstructed.units[enemy.battleUnitId]?.hp).toBe(updated.currentHp);
    }
  });

  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-003: SKL_URUU_TIMID_AS1's crit branch applies both the battle-long incoming-damage debuff and the critical-rate reduction to the whole row", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_URUU_TIMID" as never], []);
    const skill = snapshot.skills.get("SKL_URUU_TIMID_AS1" as never)!;

    const actor = withCriticalRate(
      unitOf("ALLY", "uruu", "UNIT_URUU_TIMID" as never, { column: "LEFT", row: "FRONT" }),
      1,
    );
    const e1 = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, { column: "LEFT", row: "FRONT" });
    const e2 = unitOf("ENEMY", "e2", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const allUnits = [actor, e1, e2];
    const definitions = definitionsFor(snapshot.effectActions, "SKL_URUU_TIMID_AS1", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_URUU_AS1_CRIT");
    const result = applyEffectActionGroups(
      plan,
      allUnits,
      contextFor(actor, "SKL_URUU_TIMID_AS1", definitions, recorder, rootEventId),
    );

    expect(result.outcome.status).toBe("COMPLETED");
    for (const id of ["ACT_URUU_TIMID_AS1_DMG_TAKEN_UP", "ACT_URUU_TIMID_AS1_CRIT_DOWN"]) {
      expect([...completedTargets(recorder, id)].sort()).toEqual(
        [e1.battleUnitId, e2.battleUnitId].sort(),
      );
    }
    // 会心率低下は継続statのため再計算後の`combatStats`に現れる（-2%）。
    const debuffed = result.units.find((u) => u.battleUnitId === e1.battleUnitId)!;
    expect(debuffed.combatStats.criticalRate).toBeCloseTo(e1.combatStats.criticalRate - 0.02, 10);
  });

  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-004: SKL_HIIRO_LONEWOLF_AS2's real countOf DEFEATED branch fires when any member of the attacked column dies, not only the base target", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_HIIRO_LONEWOLF" as never], []);
    const skill = snapshot.skills.get("SKL_HIIRO_LONEWOLF_AS2" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_SET_CONDITION");
    const steps = skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [];
    const branch = steps.find((s) => s.kind === "BRANCH")!;
    expect(branch.kind === "BRANCH" && branch.condition).toEqual({
      kind: "TARGET_SET_COUNT",
      target: { kind: "BINDING", targetBindingId: "TGT_COLUMN" },
      countOf: "DEFEATED",
      op: "GTE",
      value: 1,
    });

    // 基準対象(front)は生き残り、同じ列のbackだけが倒れる — 近似（TGT_BASEの
    // 生存確認のみ）では観測できなかった形。
    const actor = unitOf("ALLY", "hiiro", "UNIT_HIIRO_LONEWOLF" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const front = unitOf("ENEMY", "front", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const back = unitOf(
      "ENEMY",
      "back",
      "UNIT_TEST_ENEMY" as never,
      { column: "LEFT", row: "BACK" },
      { maximumHp: 1 },
    );
    const allUnits = [actor, front, back];
    const definitions = definitionsFor(snapshot.effectActions, "SKL_HIIRO_LONEWOLF_AS2", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_HIIRO_DEFEATED");
    const result = applyEffectActionGroups(
      plan,
      allUnits,
      contextFor(actor, "SKL_HIIRO_LONEWOLF_AS2", definitions, recorder, rootEventId),
    );

    expect(result.outcome.status).toBe("COMPLETED");
    expect(result.units.find((u) => u.battleUnitId === back.battleUnitId)!.currentHp).toBe(0);
    expect(
      result.units.find((u) => u.battleUnitId === front.battleUnitId)!.currentHp,
    ).toBeGreaterThan(0);
    expect(completedTargets(recorder, "ACT_HIIRO_LONEWOLF_AS2_EX_UP")).toEqual([
      actor.battleUnitId,
    ]);
    expect(
      result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge,
    ).toBeGreaterThan(actor.currentExtraGauge);
  });

  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-005: the same DEFEATED branch stays closed when every member of the attacked column survives", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_HIIRO_LONEWOLF" as never], []);
    const skill = snapshot.skills.get("SKL_HIIRO_LONEWOLF_AS2" as never)!;

    const actor = unitOf("ALLY", "hiiro", "UNIT_HIIRO_LONEWOLF" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const front = unitOf("ENEMY", "front", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const back = unitOf("ENEMY", "back", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "BACK",
    });
    const allUnits = [actor, front, back];
    const definitions = definitionsFor(snapshot.effectActions, "SKL_HIIRO_LONEWOLF_AS2", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_HIIRO_ALIVE");
    const result = applyEffectActionGroups(
      plan,
      allUnits,
      contextFor(actor, "SKL_HIIRO_LONEWOLF_AS2", definitions, recorder, rootEventId),
    );

    expect(result.outcome.status).toBe("COMPLETED");
    expect(completedTargets(recorder, "ACT_HIIRO_LONEWOLF_AS2_EX_UP")).toEqual([]);
    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge).toBe(
      actor.currentExtraGauge,
    );
  });

  it("IT-CAP-POST-DAMAGE-BRANCH-PROD-006: SKL_JULIE_SNOW_EX's countOf ALIVE branch adds the follow-up strike only while a survivor remains among the three targets", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_JULIE_SNOW" as never], []);
    const skill = snapshot.skills.get("SKL_JULIE_SNOW_EX" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_EFFECT_STEP_SET_CONDITION");

    const run = (enemyHp: number, scope: string) => {
      const actor = unitOf("ALLY", "julie", "UNIT_JULIE_SNOW" as never, {
        column: "LEFT",
        row: "FRONT",
      });
      const enemies = (["LEFT", "CENTER", "RIGHT"] as const).map((column, i) =>
        unitOf(
          "ENEMY",
          `e${i}`,
          "UNIT_TEST_ENEMY" as never,
          { column, row: "FRONT" },
          {
            maximumHp: enemyHp,
          },
        ),
      );
      const allUnits = [actor, ...enemies];
      const definitions = definitionsFor(snapshot.effectActions, "SKL_JULIE_SNOW_EX", skill);
      const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
      const { recorder, rootEventId } = seedRecorder(scope);
      const result = applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(actor, "SKL_JULIE_SNOW_EX", definitions, recorder, rootEventId),
      );
      expect(result.outcome.status).toBe("COMPLETED");
      return { recorder, result, enemies };
    };

    const survived = run(100000, "B_JULIE_ALIVE");
    expect(
      [...completedTargets(survived.recorder, "ACT_JULIE_SNOW_EX_DAMAGE_FOLLOWUP")].sort(),
    ).toEqual(survived.enemies.map((e) => e.battleUnitId).sort());

    // 3体とも初撃で倒れると生存数0になり、追撃は一切適用されない。
    const wiped = run(1, "B_JULIE_WIPED");
    expect(
      wiped.result.units.filter((u) => u.side === "ENEMY").every((u) => u.currentHp === 0),
    ).toBe(true);
    expect(completedTargets(wiped.recorder, "ACT_JULIE_SNOW_EX_DAMAGE_FOLLOWUP")).toEqual([]);
  });
});
