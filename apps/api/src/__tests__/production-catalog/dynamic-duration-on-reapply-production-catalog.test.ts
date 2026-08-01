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
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * M7-014（Issue #268、`DYNAMIC_DURATION_ON_REAPPLY`）: `SKL_SIENA_DIVA_PS1`
 * 「コン・フオーコ」のraw原文「1行動の気絶を付与する。対象に1行動の気絶が
 * 付与されていた場合は、2行動の気絶に上書きする」を、production Catalogの
 * `ACT_SIENA_DIVA_PS1_STUN`（`duration.reapply`）と実ライフサイクル
 * （`resolveSkillUse`→APPLY_STATUS resolver→`grantStunStatus`）で検証する。
 *
 * それまでは`DurationDefinition`が「既存効果の残存有無に応じて付与するduration
 * を動的に変える」表現を持たず、常に1行動の気絶付与へ近似していた
 * （`docs/ddd/15_Unit_Memory変換台帳.md`）。
 *
 * `SKL_SIENA_DIVA_PS1`自身を丸ごと解決すると`ACT_SIENA_DIVA_PS1_ATK_UP`
 * （`CAP_STAT_MOD`）とDAMAGEも同じEffectSequenceで走り、気絶の再付与だけを
 * 分離できない。`mao-committee-ps2-stealth-production-catalog.test.ts`と同じ
 * 方針で、実カタログから読んだ`ACT_SIENA_DIVA_PS1_STUN`定義そのものだけを持つ
 * 最小限の合成AS skillで包む（trigger側の絞り込みはM7-011／Issue #265が
 * `effect-applied-classification-production-catalog.test.ts`で検証済み）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SIENA_UNIT_ID = "UNIT_SIENA_DIVA";
const PS1_STUN_EFFECT_ID = "ACT_SIENA_DIVA_PS1_STUN";
const EX_STUN_EFFECT_ID = "ACT_SIENA_DIVA_EX_STUN";
const TEST_ENEMY_UNIT_ID = "UNIT_TEST_REAPPLY_ENEMY";

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
      maximumHp: 100,
      attack: 50,
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
      maximumHp: 100,
      attack: 50,
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

/** 実production STUN定義1件だけを敵単体へ適用する最小限の合成AS skill。 */
function grantStunSkill(skillId: string, effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
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
    metadata: { displayName: skillId, tags: [] },
  };
}

interface Harness {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly siena: BattleUnit;
  readonly enemy: BattleUnit;
  readonly skills: ReadonlyMap<string, SkillDefinition>;
  readonly stunDefinition: EffectActionDefinition;
}

function harness(): Harness {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([SIENA_UNIT_ID as never], []);
  const stunDefinition = snapshot.effectActions.get(
    createEffectActionDefinitionId(PS1_STUN_EFFECT_ID),
  )!;
  const skills = new Map<string, SkillDefinition>();
  const skillDefinitions = new Map(snapshot.skills);
  for (const [skillId, effectActionId] of [
    ["SKL_TEST_GRANT_PS1_STUN", PS1_STUN_EFFECT_ID],
    ["SKL_TEST_GRANT_EX_STUN", EX_STUN_EFFECT_ID],
  ] as const) {
    const skill = grantStunSkill(skillId, effectActionId);
    skills.set(skillId, skill);
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }
  const unitDefinitions = new Map(snapshot.units);
  const enemyDefinition = testUnitDefinition(TEST_ENEMY_UNIT_ID);
  unitDefinitions.set(enemyDefinition.unitDefinitionId, enemyDefinition);

  return {
    definitions: {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(snapshot.effectActions),
      unitDefinitions,
      skillDefinitions,
    },
    recorder: new EventRecorder(createBattleId("B_1")),
    siena: {
      ...createBattleUnit(
        member("ally:siena", SIENA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
        "ALLY",
        LIMITS,
      ),
      currentAp: LIMITS.maximumAp,
    },
    enemy: createBattleUnit(
      member("enemy:1", TEST_ENEMY_UNIT_ID, "ENEMY", { column: "CENTER", row: "FRONT" }),
      "ENEMY",
      LIMITS,
    ),
    skills,
    stunDefinition,
  };
}

function useSkill(
  h: Harness,
  skillId: string,
  units: readonly BattleUnit[],
  actionNumber: number,
): readonly BattleUnit[] {
  const actor = units.find((u) => u.battleUnitId === h.siena.battleUnitId)!;
  return resolveSkillUse(
    actor,
    h.skills.get(skillId)!,
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

function stunOf(units: readonly BattleUnit[], h: Harness) {
  const enemy = units.find((u) => u.battleUnitId === h.enemy.battleUnitId)!;
  return enemy.appliedEffects.filter((effect) => effect.statusKind === "STUN");
}

describe("production Catalog ACT_SIENA_DIVA_PS1_STUN dynamic duration on re-apply (M7-014, Issue #268, R-EFF-12)", () => {
  it("IT-CAP-DYNAMIC-DURATION-PROD-001 (R-EFF-12): the production definition declares a 1-ACTION base duration overridden to 2 when a 1-action STUN already remains", () => {
    const h = harness();
    expect(h.stunDefinition.kind).toBe("APPLY_STATUS");
    if (h.stunDefinition.kind !== "APPLY_STATUS") {
      return;
    }
    expect(h.stunDefinition.payload.status).toBe("STUN");
    expect(h.stunDefinition.payload.duration).toMatchObject({
      timeLimit: { unit: "ACTION", count: 1 },
      reapply: { existingRemaining: { op: "EQ", value: 1 }, count: 2 },
    });
  });

  it("IT-CAP-DYNAMIC-DURATION-PROD-002 (R-EFF-12/R-STS-02, real lifecycle wiring): re-applying the real PS1 stun onto a 1-action STUN overwrites the same instance with 2 actions and records StunDurationChanged", () => {
    const h = harness();

    const afterFirst = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", [h.siena, h.enemy], 1);
    const firstStuns = stunOf(afterFirst, h);
    expect(firstStuns).toHaveLength(1);
    expect(firstStuns[0]!.duration.timeLimitRemaining).toBe(1);

    const eventsBeforeSecond = h.recorder.getEvents().length;
    const afterSecond = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", afterFirst, 2);
    const secondStuns = stunOf(afterSecond, h);

    // R-STS-02「再付与時は残り回数が長い方を一つだけ残す」: インスタンスは
    // 増えず、同じインスタンスの残り回数だけが2へ差し替わる。
    expect(secondStuns).toHaveLength(1);
    expect(secondStuns[0]!.effectInstanceId).toBe(firstStuns[0]!.effectInstanceId);
    expect(secondStuns[0]!.duration.timeLimitRemaining).toBe(2);
    expect(secondStuns[0]!.duration.definition).toMatchObject({
      timeLimit: { unit: "ACTION", count: 2 },
    });

    const changed = h.recorder
      .getEvents()
      .slice(eventsBeforeSecond)
      .find((e) => e.eventType === "StunDurationChanged") as Extract<
      BattleDomainEvent,
      { eventType: "StunDurationChanged" }
    >;
    expect(changed).toBeDefined();
    expect(changed.payload).toMatchObject({
      effectInstanceId: firstStuns[0]!.effectInstanceId,
      battleUnitId: h.enemy.battleUnitId,
      remainingBefore: 1,
      remainingAfter: 2,
      reason: "REGRANT_EXTENDED",
    });

    // 独立Reducer復元: `EffectApplied`（残り1で新規）→`StunDurationChanged`
    // （残り1→2へ差し替え）のstateDeltaを順に適用するだけで、差し替え後の
    // 残り回数2を復元できる。`StunDurationChanged`の`before`は既存スナップ
    // ショットを持つため、`EffectApplied`を飛ばして適用するとReducerが
    // 「delta sequenceが欠落・重複している」として正しく拒否する。
    const state: BattleStateSnapshot = {
      status: "READY",
      currentTurn: 1,
      units: {
        [h.enemy.battleUnitId]: {
          hp: h.enemy.currentHp,
          ap: h.enemy.currentAp,
          pp: h.enemy.currentPp,
          extraGauge: h.enemy.currentExtraGauge,
          maximumAp: h.enemy.maximumAp,
          maximumPp: h.enemy.maximumPp,
          maximumExtraGauge: h.enemy.maximumExtraGauge,
          combatStats: h.enemy.combatStats,
        },
      },
    };
    const applied = h.recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload).toMatchObject({
      statusKind: "STUN",
      durationUnit: "ACTION",
      initialRemaining: 1,
    });
    const reduced = applyStateDelta(
      applyStateDelta(state, applied.stateDelta!),
      changed.stateDelta!,
    );
    expect(reduced.units[h.enemy.battleUnitId]!.effects).toHaveLength(1);
    expect(reduced.units[h.enemy.battleUnitId]!.effects![0]).toMatchObject({
      effectDefinitionId: PS1_STUN_EFFECT_ID,
      statusKind: "STUN",
      duration: { unit: "ACTION", remaining: 2 },
    });
  });

  it("IT-CAP-DYNAMIC-DURATION-PROD-003 (R-EFF-12 boundary): a STUN already at 2 remaining actions is outside existingRemaining EQ 1, so a further PS1 stun is a no-op", () => {
    const h = harness();

    const afterFirst = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", [h.siena, h.enemy], 1);
    const afterSecond = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", afterFirst, 2);
    expect(stunOf(afterSecond, h)[0]!.duration.timeLimitRemaining).toBe(2);

    const eventsBeforeThird = h.recorder.getEvents().length;
    const afterThird = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", afterSecond, 3);
    const thirdStuns = stunOf(afterThird, h);

    // 3度目の付与は基本の1行動へ戻り（`EQ 1`不成立）、R-STS-02で既存の2が
    // 維持される — 上書きが累積して延び続けることはない。
    expect(thirdStuns).toHaveLength(1);
    expect(thirdStuns[0]!.duration.timeLimitRemaining).toBe(2);
    expect(
      h.recorder
        .getEvents()
        .slice(eventsBeforeThird)
        .filter((e) => e.eventType === "StunDurationChanged"),
    ).toEqual([]);
  });

  it("IT-CAP-DYNAMIC-DURATION-PROD-004 (R-EFF-12): a 1-action STUN applied by another production skill (EX) also triggers the PS1 overwrite", () => {
    const h = harness();

    // `ACT_SIENA_DIVA_EX_STUN`は`reapply`を持たない1行動の気絶（raw「敵単体に
    // 威力212で攻撃し、1行動の気絶を付与する」）。raw原文のPS1側は付与元を
    // 限定しない（「対象に1行動の気絶が付与されていた場合」）ため、EX由来の
    // 気絶も上書きの契機になる。
    const afterEx = useSkill(h, "SKL_TEST_GRANT_EX_STUN", [h.siena, h.enemy], 1);
    expect(stunOf(afterEx, h)[0]!.duration.timeLimitRemaining).toBe(1);

    const afterPs1 = useSkill(h, "SKL_TEST_GRANT_PS1_STUN", afterEx, 2);
    const stuns = stunOf(afterPs1, h);
    expect(stuns).toHaveLength(1);
    expect(stuns[0]!.duration.timeLimitRemaining).toBe(2);
  });
});
