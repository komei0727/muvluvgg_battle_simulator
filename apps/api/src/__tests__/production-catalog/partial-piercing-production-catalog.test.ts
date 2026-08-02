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
 * DMG-003（Issue #196、`TEMP_PIERCING_GRANT`／`CAP_PARTIAL_PIERCING`、R-DMG-03）:
 * 「後続の自身の攻撃へ一時的にpiercingを付与する」`APPLY_PIERCING_MOD`と、
 * `DAMAGE`定義自身が持つ静的な貫通率を、実`catalog/`の未改変定義で検証する証跡。
 *
 * - `SKL_RAMI_NEWYEAR_PS1`（おみくじ運試し）の大吉枝
 *   `ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI`（`defenseIgnoreRate: 0.5`）を`grantEffect`
 *   経路で付与し、`AppliedEffect.piercing`・StateDelta・独立Reducer復元まで確認する。
 * - 付与された貫通が実ダメージ計算へ効くことを、同じ`DAMAGE`定義に対する
 *   付与あり/なしの2回の実行で比較する（負の対照）。
 * - 静的な貫通側の代表は`ACT_EVIE_KYONSHI_EX_DAMAGE`（`defenseIgnoreRate: 0.5`）。
 */

describe("production Catalog CAP_PARTIAL_PIERCING — APPLY_PIERCING_MOD (DMG-003, Issue #196, R-DMG-03)", () => {
  it("IT-CAP-PARTIAL-PIERCING-PROD-001: SKL_RAMI_NEWYEAR_PS1's DAIKICHI branch grants the real ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI, carrying its 50% defense ignore onto the AppliedEffect, StateDelta and independent Reducer restoration", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_RAMI_NEWYEAR" as never], []);
    const skill = snapshot.skills.get("SKL_RAMI_NEWYEAR_PS1" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_PARTIAL_PIERCING");
    const grant = snapshot.effectActions.get("ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI" as never)!;
    expect(grant.kind).toBe("APPLY_PIERCING_MOD");
    if (grant.kind !== "APPLY_PIERCING_MOD") {
      throw new Error("expected APPLY_PIERCING_MOD");
    }
    expect(grant.payload.defenseIgnoreRate).toBe(0.5);
    expect(grant.payload.duration.consumption).toEqual({
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
    });

    const actor = unitOf("ALLY", "rami", "UNIT_RAMI_NEWYEAR" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const enemy = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const allUnits = [actor, enemy];
    const definitions = definitionsFor(snapshot.effectActions, "SKL_RAMI_NEWYEAR_PS1", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_RAMI_DAIKICHI");
    // `SequenceRandomSource`が0.99を返すためWEIGHTED_ONEは最後の枝（末吉）を
    // 選ぶ。大吉枝を決定的に引くため乱数を0へ倒す。
    const context = {
      ...contextFor(actor, "SKL_RAMI_NEWYEAR_PS1", definitions, recorder, rootEventId),
      random: new SequenceRandomSource(new Array<number>(64).fill(0)),
    };
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    expect(completedTargets(recorder, "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI")).toEqual([
      actor.battleUnitId,
    ]);
    const granted = result.units
      .find((u) => u.battleUnitId === actor.battleUnitId)!
      .appliedEffects.find(
        (e) => e.effectActionDefinitionId === "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
      )!;
    expect(granted.piercing).toEqual({
      defenseIgnoreRate: 0.5,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
    });

    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    expect(
      reconstructed.units[actor.battleUnitId]?.effects?.find(
        (e) => e.effectDefinitionId === "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
      )?.piercing,
    ).toEqual(granted.piercing);
  });

  it("IT-CAP-PARTIAL-PIERCING-PROD-002: holding that real grant makes the very next attack ignore half of the defender's defense (negative control: the identical attack without it deals less)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const ramiSnapshot = catalog.loadSnapshot(["UNIT_RAMI_NEWYEAR" as never], []);
    const psSkill = ramiSnapshot.skills.get("SKL_RAMI_NEWYEAR_PS1" as never)!;
    const attackSkill = ramiSnapshot.skills.get("SKL_RAMI_NEWYEAR_AS3" as never)!;

    const damageDealt = (withGrant: boolean, scope: string): number => {
      const actor = unitOf("ALLY", "rami", "UNIT_RAMI_NEWYEAR" as never, {
        column: "LEFT",
        row: "FRONT",
      });
      // 防御力を高くして、貫通の有無がダメージ差として明確に現れるようにする。
      const enemy = unitOf(
        "ENEMY",
        "e1",
        "UNIT_TEST_ENEMY" as never,
        { column: "LEFT", row: "FRONT" },
        { defense: 200 },
      );
      let allUnits: readonly BattleUnit[] = [actor, enemy];
      const { recorder, rootEventId } = seedRecorder(scope);

      if (withGrant) {
        const definitions = definitionsFor(
          ramiSnapshot.effectActions,
          "SKL_RAMI_NEWYEAR_PS1",
          psSkill,
        );
        const plan = resolveSkillOrder(psSkill, actor, allUnits, definitions.effectActions);
        const granted = applyEffectActionGroups(plan, allUnits, {
          ...contextFor(actor, "SKL_RAMI_NEWYEAR_PS1", definitions, recorder, rootEventId),
          random: new SequenceRandomSource(new Array<number>(64).fill(0)),
        });
        allUnits = granted.units;
      }

      const attacker = allUnits.find((u) => u.battleUnitId === actor.battleUnitId)!;
      const definitions = definitionsFor(
        ramiSnapshot.effectActions,
        "SKL_RAMI_NEWYEAR_AS3",
        attackSkill,
      );
      const plan = resolveSkillOrder(attackSkill, attacker, allUnits, definitions.effectActions);
      const result = applyEffectActionGroups(
        plan,
        allUnits,
        contextFor(attacker, "SKL_RAMI_NEWYEAR_AS3", definitions, recorder, rootEventId),
      );
      const after = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      return enemy.currentHp - after.currentHp;
    };

    const withPiercing = damageDealt(true, "B_RAMI_PIERCE_ON");
    const withoutPiercing = damageDealt(false, "B_RAMI_PIERCE_OFF");
    expect(withPiercing).toBeGreaterThan(withoutPiercing);
  });

  it("IT-CAP-PARTIAL-PIERCING-PROD-003: the static piercing side (ACT_EVIE_KYONSHI_EX_DAMAGE) keeps declaring CAP_PARTIAL_PIERCING and its 50% defense/shield ignore", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_EVIE_KYONSHI" as never], []);
    const damage = snapshot.effectActions.get("ACT_EVIE_KYONSHI_EX_DAMAGE" as never)!;
    expect(damage.kind).toBe("DAMAGE");
    if (damage.kind !== "DAMAGE") {
      throw new Error("expected DAMAGE");
    }
    expect(damage.payload.piercing).toEqual({
      defenseIgnoreRate: 0.5,
      shieldIgnoreRate: 0.5,
      damageReductionIgnoreRate: 0,
    });
    // 貫通を宣言する定義は`CAP_PARTIAL_PIERCING`を自己申告する（Issue #196で必須化）。
    expect(damage.requiredCapabilities).toContain("CAP_PARTIAL_PIERCING");
  });
});
