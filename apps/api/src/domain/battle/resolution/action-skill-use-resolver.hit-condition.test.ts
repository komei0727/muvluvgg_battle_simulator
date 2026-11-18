import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectActionDefinition } from "../../catalog/definitions/effect-action-definition-factory.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../catalog/definitions/skill-definition.js";
import type { EffectStepDefinitionInput } from "../../catalog/definitions/effect-sequence.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { testBattleUnit } from "../../../testing/fixtures/battle-actors.js";
import { testUnitDefinition } from "../../../testing/fixtures/unit-definitions.js";

/**
 * R-SKL-06 #4a（Issue #825）: `actions[].hitCondition`を持つEffectActionは、その適用先が
 * 同じEffectSequence解決の中で参照先DAMAGEから1ヒット以上命中を受けた場合だけ適用する。
 * 回避は確率50%の`EVASION`をヒットごとの抽選列で倒して作る（`resolveProbability`は
 * `next() < 0.5`で回避）。会心は`PREVENTED`で抽選を消費しない。
 */
describe("actions[].hitCondition via resolveSkillUse (R-SKL-06 #4a)", () => {
  const DAMAGE_ID = "ACT_TEST_HIT_DAMAGE";
  const DEBUFF_ID = "ACT_TEST_HIT_ATK_DOWN";
  const SELF_BUFF_ID = "ACT_TEST_HIT_SELF_BUFF";
  const EVADE = 0.1;
  const HIT = 0.9;

  function damage(
    hitCount: number,
    hitConfirmedEffectIds?: readonly string[],
  ): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: DAMAGE_ID,
        kind: "DAMAGE",
        payload: {
          damageType: "PHYSICAL",
          formula: { kind: "SKILL_POWER", power: 1 },
          hitCount,
          critical: { mode: "PREVENTED" },
          ...(hitConfirmedEffectIds !== undefined
            ? {
                hitConfirmedEffects: hitConfirmedEffectIds.map((effectActionDefinitionId) => ({
                  effectActionDefinitionId,
                })),
              }
            : {}),
        },
      },
      "effectAction",
    );
  }

  function statMod(id: string, value: number): EffectActionDefinition {
    return createEffectActionDefinition(
      {
        effectActionDefinitionId: id,
        kind: "APPLY_STAT_MOD",
        payload: {
          stat: "ATTACK",
          valueType: "FIXED",
          formula: { kind: "CONSTANT", value },
          stacking: { mode: "STACKABLE" },
          duration: { timeLimit: { unit: "TURN", count: 2 }, dispellable: true },
        },
      },
      "effectAction",
    );
  }

  const ENEMIES = { kind: "BINDING", targetBindingId: "TGT_ENEMIES" } as const;
  const hitConditioned = (id: string) => ({
    effectActionDefinitionId: id,
    hitCondition: { effectActionDefinitionIds: [DAMAGE_ID] },
  });

  function skill(steps: readonly EffectStepDefinitionInput[]): SkillDefinition {
    return createSkillDefinition({
      skillDefinitionId: "SKL_TEST_HIT_AS",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: "TGT_ENEMIES",
            selector: { kind: "SELECT", side: "ENEMY", count: 2, order: ["DEFAULT"] },
          },
        ],
        steps,
      },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {},
      metadata: { displayName: "hitCondition AS" },
    });
  }

  function evasion(holderId: string): AppliedEffect {
    const definitionId = createEffectActionDefinitionId("ACT_TEST_HIT_EVASION");
    return {
      effectInstanceId: createEffectInstanceId(`EVADE_${holderId}`),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetUnitId: createBattleUnitId(holderId),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "EVASION",
      statusDetails: { probability: 0.5 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function enemyUnit(id: string, column: "LEFT" | "CENTER", hp = 1000): BattleUnit {
    const base = testBattleUnit({
      battleUnitId: id,
      unitDefinitionId: "UNIT_TEST_ENEMY",
      side: "ENEMY",
      position: { column, row: "FRONT" },
      combatStats: { attack: 50, defense: 0, maximumHp: hp },
    });
    return { ...base, appliedEffects: [evasion(id)] };
  }

  function run(
    steps: readonly EffectStepDefinitionInput[],
    hitCount: number,
    rolls: readonly number[],
    enemyHp = 1000,
    hitConfirmedEffectIds?: readonly string[],
    firstEnemyExtraEffects: readonly AppliedEffect[] = [],
  ): { units: readonly BattleUnit[]; events: readonly BattleDomainEvent[] } {
    const attacker = {
      ...testBattleUnit({
        battleUnitId: "ally:attacker",
        unitDefinitionId: "UNIT_TEST_ATTACKER",
        combatStats: { attack: 100, defense: 10, maximumHp: 1000, criticalRate: 0 },
      }),
      currentAp: 2,
    };
    const firstEnemy = enemyUnit("enemy:1", "LEFT", enemyHp);
    const units = [
      attacker,
      { ...firstEnemy, appliedEffects: [...firstEnemy.appliedEffects, ...firstEnemyExtraEffects] },
      enemyUnit("enemy:2", "CENTER", enemyHp),
    ];
    const definition = skill(steps);
    const actions = [
      damage(hitCount, hitConfirmedEffectIds),
      statMod(DEBUFF_ID, -20),
      statMod(SELF_BUFF_ID, 10),
    ];
    const attackerDefinition = testUnitDefinition("UNIT_TEST_ATTACKER");
    const enemyDefinition = testUnitDefinition("UNIT_TEST_ENEMY");
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(actions.map((a) => [a.effectActionDefinitionId, a])),
      unitDefinitions: new Map([
        [attackerDefinition.unitDefinitionId, attackerDefinition],
        [enemyDefinition.unitDefinitionId, enemyDefinition],
      ]),
      skillDefinitions: new Map([[definition.skillDefinitionId, definition]]),
    };
    const recorder = new EventRecorder(createBattleId("B_HIT_CONDITION"));
    const result = resolveSkillUse(
      attacker,
      definitions.skillDefinitions.get(createSkillDefinitionId("SKL_TEST_HIT_AS"))!,
      "AS",
      "AS",
      units,
      definitions,
      new SequenceRandomSource([...rolls]),
      recorder,
      1,
      0,
      createActionId("B_HIT_CONDITION:action:1"),
      recorder.nextResolutionScopeId(),
    );
    return { units: result.units, events: recorder.getEvents() };
  }

  function debuffedEnemies(units: readonly BattleUnit[]): readonly string[] {
    return units
      .filter((u) =>
        u.appliedEffects.some(
          (e) => e.effectActionDefinitionId === createEffectActionDefinitionId(DEBUFF_ID),
        ),
      )
      .map((u) => u.battleUnitId);
  }

  const runHitConfirmed = (rolls: readonly number[]) =>
    run(
      [{ kind: "ACTION", target: ENEMIES, actions: [{ effectActionDefinitionId: DAMAGE_ID }] }],
      2,
      rolls,
      1000,
      [DEBUFF_ID],
    );
  const granted = (units: readonly BattleUnit[], unitId: string) =>
    units
      .find((u) => u.battleUnitId === unitId)!
      .appliedEffects.filter(
        (e) => e.effectActionDefinitionId === createEffectActionDefinitionId(DEBUFF_ID),
      ).length;

  const sameStep: readonly EffectStepDefinitionInput[] = [
    {
      kind: "ACTION",
      target: ENEMIES,
      actions: [{ effectActionDefinitionId: DAMAGE_ID }, hitConditioned(DEBUFF_ID)],
    },
  ];

  it("UT-R-SKL-06-079 [R-SKL-06]: in a 2-target ACTION, the hit-conditioned debuff reaches only the target that was hit, interleaved right after its own damage", () => {
    // enemy:1 → 回避、enemy:2 → 命中。
    const { units, events } = run(sameStep, 1, [EVADE, HIT]);

    expect(debuffedEnemies(units)).toEqual(["enemy:2"]);
    const started = events
      .filter((e) => e.eventType === "EffectActionStarting")
      .map((e) => `${String(e.payload.effectActionDefinitionId)}@${e.targetUnitIds?.join(",")}`);
    expect(started).toEqual([
      `${DAMAGE_ID}@enemy:1`,
      `${DAMAGE_ID}@enemy:2`,
      `${DEBUFF_ID}@enemy:2`,
    ]);
  });

  it.each([
    { label: "0/3 hits", rolls: [EVADE, EVADE, EVADE], debuffed: false },
    { label: "only the first of 3 hits", rolls: [HIT, EVADE, EVADE], debuffed: true },
    { label: "only the last of 3 hits", rolls: [EVADE, EVADE, HIT], debuffed: true },
    { label: "3/3 hits", rolls: [HIT, HIT, HIT], debuffed: true },
  ])(
    "UT-R-SKL-06-080 [R-SKL-06]: a 3-hit DAMAGE with $label decides the debuff per target from its whole hit history",
    ({ rolls, debuffed }) => {
      // enemy:2 は全ヒット命中させ、別対象の命中を取り込まないことも同時に見る。
      const { units } = run(sameStep, 3, [...rolls, HIT, HIT, HIT]);

      expect(debuffedEnemies(units)).toEqual(debuffed ? ["enemy:1", "enemy:2"] : ["enemy:2"]);
    },
  );

  it("UT-R-SKL-06-081 [R-SKL-06]: a hit-conditioned action in a later step still reads the earlier DAMAGE's per-target hit history, while a SELF action without hitCondition is unaffected", () => {
    const { units } = run(
      [
        { kind: "ACTION", target: ENEMIES, actions: [{ effectActionDefinitionId: DAMAGE_ID }] },
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: SELF_BUFF_ID }],
        },
        { kind: "ACTION", target: ENEMIES, actions: [hitConditioned(DEBUFF_ID)] },
      ],
      1,
      [EVADE, EVADE],
    );

    expect(debuffedEnemies(units)).toEqual([]);
    const attacker = units.find((u) => u.battleUnitId === "ally:attacker")!;
    expect(
      attacker.appliedEffects.some(
        (e) => e.effectActionDefinitionId === createEffectActionDefinitionId(SELF_BUFF_ID),
      ),
    ).toBe(true);
  });

  it("UT-R-SKL-06-082 [R-SKL-06]: a target that was hit and defeated still gets no follow-up effect", () => {
    const { units } = run(sameStep, 1, [HIT, HIT], 50);

    expect(debuffedEnemies(units)).toEqual([]);
  });

  it("UT-R-SKL-06-083 [R-SKL-06]: a hit fully absorbed by a shield leaves HP untouched but still counts as a hit for hitCondition", () => {
    const shieldId = createEffectActionDefinitionId("ACT_TEST_HIT_SHIELD");
    const shield: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("SHIELD_enemy:1"),
      effectActionDefinitionId: shieldId,
      kindKey: effectKindKeyFromDefinitionId(shieldId),
      duplicate: true,
      targetUnitId: createBattleUnitId("enemy:1"),
      magnitude: 100000,
      categories: ["SHIELD"],
      shield: { shieldType: null, remaining: 100000 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const { units } = run(sameStep, 1, [HIT, EVADE], 1000, undefined, [shield]);

    const shielded = units.find((u) => u.battleUnitId === "enemy:1")!;
    expect(shielded.currentHp).toBe(1000);
    expect(debuffedEnemies(units)).toEqual(["enemy:1"]);
  });

  describe("DAMAGE hitConfirmedEffects (R-DMG-05 #2a)", () => {
    it("UT-R-DMG-05-010 [R-DMG-05]: grants the effect once per target at its first confirmed hit, after HitConfirmed and before the critical check, and never to a target that evaded every hit", () => {
      const { units, events } = runHitConfirmed([EVADE, EVADE, HIT, HIT]);

      const timeline = events
        .filter((e) =>
          ["HitConfirmed", "EffectApplied", "CriticalCheckResolved", "EvasionActivated"].includes(
            e.eventType,
          ),
        )
        .map((e) => `${e.eventType}@${e.targetUnitIds?.join(",")}`);
      // enemy:1 は2ヒットとも回避、enemy:2 は2ヒットとも命中。付与は enemy:2 の初撃1回だけ。
      expect(timeline).toEqual([
        "EvasionActivated@enemy:1",
        "EvasionActivated@enemy:1",
        "HitConfirmed@enemy:2",
        "EffectApplied@enemy:2",
        "CriticalCheckResolved@enemy:2",
        "HitConfirmed@enemy:2",
        "CriticalCheckResolved@enemy:2",
      ]);
      expect(granted(units, "enemy:1")).toBe(0);
      expect(granted(units, "enemy:2")).toBe(1);
    });
  });
});
