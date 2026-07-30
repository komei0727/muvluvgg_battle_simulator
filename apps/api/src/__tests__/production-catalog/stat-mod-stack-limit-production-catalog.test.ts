import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * M7-012（Issue #266、`STACK_LIMIT_ON_STAT_MOD`、R-EFF-05）:
 * `SKL_TARISA_TROUBLEMAKER_PS1`「徹底的にやってやろうじゃん！」のraw原文
 * 「自身に「負けん気」を1つ付与し、攻撃力を2.5%上昇させる（重複可）。……
 * 「負けん気」は最大14個まで所持できる」のうち、攻撃力バフ側の重複上限を、
 * production Catalogの`ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`（`stacking.max: 14`）と
 * 実ライフサイクル（`resolveSkillUse`→APPLY_STAT_MOD resolver→`grantEffect`）で
 * 検証する。
 *
 * それまで`APPLY_STAT_MOD.stacking`は`STACKABLE`だけを持ち、Marker側の
 * `stack.max`に相当する上限フィールドが無かったため、攻撃力バフは無制限に
 * 積み上がっていた（`docs/ddd/15_Unit_Memory変換台帳.md`）。
 *
 * PS1自身のEffectSequenceを丸ごと解決するとMarker付与・`REMOVE_MARKER`・
 * `DamageApplied`起点のtrigger解決も同じ解決に載り、攻撃力バフの重複上限だけを
 * 分離できない。`dynamic-duration-on-reapply-production-catalog.test.ts`と同じ
 * 方針で、実カタログから読んだ`ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`定義そのもの
 * だけを持つ最小限の合成AS skillで包む。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const TARISA_UNIT_ID = "UNIT_TARISA_TROUBLEMAKER";
const PS1_ATK_UP_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP";
const PS1_MARKER_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_PS1_MARKER";
const GRANT_SKILL_ID = "SKL_TEST_GRANT_PS1_ATK_UP";

/** raw原文の上限。攻撃力バフ側もMarker「負けん気」と同じ14個で止まる。 */
const STACK_MAX = 14;
const BASE_ATTACK = 100;
/** 15回使い、うち14回だけが付与へ到達することを見る。 */
const USE_COUNT = STACK_MAX + 1;
const LIMITS = { maximumAp: USE_COUNT, maximumPp: 3, maximumExtraGauge: 100 };

function member(): BattlePartyMember {
  const position = { column: "CENTER", row: "FRONT" } as const;
  return {
    battleUnitId: createBattleUnitId("ally:tarisa"),
    unitDefinitionId: TARISA_UNIT_ID as never,
    attribute: "SMART",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 1000,
      attack: BASE_ATTACK,
      defense: 50,
      criticalRate: 0.2,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
}

/** 実production定義1件だけを自身へ適用する最小限の合成AS skill。 */
function grantAtkUpSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(GRANT_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(PS1_ATK_UP_EFFECT_ID) },
          ],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: GRANT_SKILL_ID, tags: [] },
  };
}

interface Harness {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly tarisa: BattleUnit;
  readonly skill: SkillDefinition;
  readonly snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>;
}

function harness(): Harness {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([TARISA_UNIT_ID as never], []);
  const skill = grantAtkUpSkill();
  const skillDefinitions = new Map(snapshot.skills);
  skillDefinitions.set(skill.skillDefinitionId, skill);

  return {
    definitions: {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(snapshot.effectActions),
      unitDefinitions: new Map(snapshot.units),
      skillDefinitions,
    },
    recorder: new EventRecorder(createBattleId("B_1")),
    tarisa: {
      ...createBattleUnit(member(), "ALLY", LIMITS),
      currentAp: LIMITS.maximumAp,
    },
    skill,
    snapshot,
  };
}

function useSkill(
  h: Harness,
  units: readonly BattleUnit[],
  actionNumber: number,
): readonly BattleUnit[] {
  const actor = units.find((u) => u.battleUnitId === h.tarisa.battleUnitId)!;
  return resolveSkillUse(
    actor,
    h.skill,
    "AS",
    "AS",
    units,
    h.definitions,
    new SequenceRandomSource([]),
    h.recorder,
    1,
    0,
    createActionId(`B_1:action:${actionNumber}`),
    h.recorder.nextResolutionScopeId(),
  ).units;
}

function atkUpsOf(units: readonly BattleUnit[], h: Harness) {
  const tarisa = units.find((u) => u.battleUnitId === h.tarisa.battleUnitId)!;
  return tarisa.appliedEffects.filter(
    (effect) => effect.effectActionDefinitionId === PS1_ATK_UP_EFFECT_ID,
  );
}

describe("production Catalog ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP stack limit (M7-012, Issue #266, R-EFF-05)", () => {
  it("IT-CAP-STAT-MOD-STACK-LIMIT-PROD-001 (R-EFF-05): the production stat buff declares the same 14-instance limit as the 「負けん気」 Marker it mirrors", () => {
    const h = harness();
    const atkUp = h.snapshot.effectActions.get(
      createEffectActionDefinitionId(PS1_ATK_UP_EFFECT_ID),
    )!;
    const marker = h.snapshot.effectActions.get(
      createEffectActionDefinitionId(PS1_MARKER_EFFECT_ID),
    )!;

    expect(atkUp.kind).toBe("APPLY_STAT_MOD");
    expect(marker.kind).toBe("APPLY_MARKER");
    if (atkUp.kind !== "APPLY_STAT_MOD" || marker.kind !== "APPLY_MARKER") {
      return;
    }
    expect(atkUp.payload.stacking).toEqual({ mode: "STACKABLE", max: STACK_MAX });
    // raw原文は上限をMarker側にだけ書くが、攻撃力バフはMarkerと1対1で付与される
    // ため、同じ上限を持たなければ原文どおりにならない。
    expect(marker.payload.stack).toEqual({ policy: "ADD", max: STACK_MAX });
    expect(atkUp.payload.formula).toEqual({ kind: "CONSTANT", value: 0.025 });
  });

  it("IT-CAP-STAT-MOD-STACK-LIMIT-PROD-002 (R-EFF-05, real lifecycle wiring): the 15th grant adds no instance and completes as SKIPPED, leaving ATTACK at the 14-stack value", () => {
    const h = harness();

    let units: readonly BattleUnit[] = [h.tarisa];
    for (let i = 1; i <= STACK_MAX; i += 1) {
      units = useSkill(h, units, i);
      expect(atkUpsOf(units, h)).toHaveLength(i);
    }
    const cappedAttack = units.find((u) => u.battleUnitId === h.tarisa.battleUnitId)!.combatStats
      .attack;
    expect(cappedAttack).toBeCloseTo(BASE_ATTACK * (1 + 0.025 * STACK_MAX), 9);

    const eventsBeforeLast = h.recorder.getEvents().length;
    units = useSkill(h, units, USE_COUNT);
    const emitted = h.recorder
      .getEvents()
      .slice(eventsBeforeLast)
      .map((e) => e.eventType);

    expect(atkUpsOf(units, h)).toHaveLength(STACK_MAX);
    expect(emitted).not.toContain("EffectApplied");
    expect(emitted).not.toContain("CombatStatChanged");
    const completed = h.recorder
      .getEvents()
      .slice(eventsBeforeLast)
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload).toMatchObject({
      effectActionDefinitionId: PS1_ATK_UP_EFFECT_ID,
      resultKind: "SKIPPED",
    });
    expect(units.find((u) => u.battleUnitId === h.tarisa.battleUnitId)!.combatStats.attack).toBe(
      cappedAttack,
    );
  });

  it("IT-CAP-STAT-MOD-STACK-LIMIT-PROD-003 (R-EFF-05): the independent Reducer restores exactly 14 effect instances from the emitted stateDeltas", () => {
    const h = harness();

    let units: readonly BattleUnit[] = [h.tarisa];
    for (let i = 1; i <= USE_COUNT; i += 1) {
      units = useSkill(h, units, i);
    }

    const initial: BattleStateSnapshot = {
      status: "READY",
      currentTurn: 1,
      units: {
        [h.tarisa.battleUnitId]: {
          hp: h.tarisa.currentHp,
          ap: h.tarisa.currentAp,
          pp: h.tarisa.currentPp,
          extraGauge: h.tarisa.currentExtraGauge,
          combatStats: h.tarisa.combatStats,
        },
      },
    };
    const reduced = h.recorder
      .getEvents()
      .reduce(
        (state, event) =>
          event.stateDelta === undefined ? state : applyStateDelta(state, event.stateDelta),
        initial,
      );

    const restored = reduced.units[h.tarisa.battleUnitId]!;
    expect(restored.effects).toHaveLength(STACK_MAX);
    expect(
      restored.effects!.every((effect) => effect.effectDefinitionId === PS1_ATK_UP_EFFECT_ID),
    ).toBe(true);
    expect(restored.combatStats.attack).toBe(
      units.find((u) => u.battleUnitId === h.tarisa.battleUnitId)!.combatStats.attack,
    );
  });
});
