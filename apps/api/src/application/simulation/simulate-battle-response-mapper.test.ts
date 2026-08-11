import { describe, expect, it } from "vitest";
import type { CooldownStateResponseBody } from "../contracts/response.js";
import { toBattleSimulationResponseBody } from "./simulate-battle-response-mapper.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { createMarkerId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId, createEffectInstanceId } from "../../domain/shared/event-ids.js";
import type { EffectSnapshot } from "../../domain/battle/events/state-delta.js";
import { STATUS_AILMENT_KINDS } from "../../domain/catalog/definitions/effect-action-payload.js";
import type { EffectImmunityCategory } from "../../domain/catalog/definitions/catalog-enums.js";
import { effectCategoriesOf } from "../../domain/battle/effects/effect-category-classifier.js";
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";
import type { StatusKind } from "../../domain/catalog/definitions/effect-action-payload.js";

/** `APPLY_STATUS`の実定義（`effectCategoriesOf`へ渡す分類入力）。 */
function statusDefinition(status: StatusKind) {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: `ACT_TEST_${status}`,
      kind: "APPLY_STATUS",
      payload: { status, duration: { timeLimit: { unit: "ACTION", count: 1 } } },
    },
    "effectAction",
  );
}

const BATTLE_ID = createBattleId("battle-1");
const ALLY_ID = createBattleUnitId("ally:1");
const ENEMY_ID = createBattleUnitId("enemy:1");
const SKL_A = createSkillDefinitionId("SKL_A");
const SKL_B = createSkillDefinitionId("SKL_B");
const SKL_C = createSkillDefinitionId("SKL_C");
const SKL_D = createSkillDefinitionId("SKL_D");
const ACTION_1 = createActionId("action-1");
const ACTION_2 = createActionId("action-2");

// R-NUM-01: 割合はDomain内部で1.0=100%として保持する（`percentage.ts`）。
const ALLY_COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0.05,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};
const ENEMY_COMBAT_STATS = {
  maximumHp: 100,
  attack: 8,
  defense: 8,
  criticalRate: 0.05,
  actionSpeed: 8,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function baseResult(overrides: Partial<SimulateBattleResult> = {}): SimulateBattleResult {
  return {
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 3,
    initialState: {
      status: "READY",
      currentTurn: 0,
      units: {
        [ALLY_ID]: {
          hp: 100,
          ap: 0,
          pp: 0,
          extraGauge: 0,
          maximumAp: 3,
          maximumPp: 2,
          maximumExtraGauge: 100,
          combatStats: ALLY_COMBAT_STATS,
          baseCombatStats: ALLY_COMBAT_STATS,
        },
        [ENEMY_ID]: {
          hp: 100,
          ap: 0,
          pp: 0,
          extraGauge: 0,
          maximumAp: 3,
          maximumPp: 2,
          maximumExtraGauge: 100,
          combatStats: ENEMY_COMBAT_STATS,
          baseCombatStats: ENEMY_COMBAT_STATS,
        },
      },
    },
    finalState: {
      status: "COMPLETED",
      currentTurn: 1,
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
      units: {
        [ALLY_ID]: {
          hp: 90,
          ap: 1,
          pp: 0,
          extraGauge: 5,
          maximumAp: 3,
          maximumPp: 2,
          maximumExtraGauge: 100,
          combatStats: ALLY_COMBAT_STATS,
          baseCombatStats: ALLY_COMBAT_STATS,
        },
        [ENEMY_ID]: {
          hp: 0,
          ap: 0,
          pp: 0,
          extraGauge: 0,
          maximumAp: 3,
          maximumPp: 2,
          maximumExtraGauge: 100,
          combatStats: ENEMY_COMBAT_STATS,
          baseCombatStats: ENEMY_COMBAT_STATS,
        },
      },
    },
    events: [],
    stateTransitions: [],
    unitRoster: [
      {
        battleUnitId: ALLY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_001"),
        side: "ALLY",
        position: { column: "LEFT", row: "FRONT" },
        globalCoordinate: { x: 0, y: 2 },
        combatStats: ALLY_COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
      {
        battleUnitId: ENEMY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_101"),
        side: "ENEMY",
        position: { column: "CENTER", row: "BACK" },
        globalCoordinate: { x: 1, y: 0 },
        combatStats: ENEMY_COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
    ],
    ...overrides,
  };
}

describe("toBattleSimulationResponseBody", () => {
  it("API-RESP-001: maps top-level schemaVersion/battleId/catalogRevision/result (10_API設計.md BattleSimulationResponse)", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("battle-1");
    expect(body.catalogRevision).toBe("rev-1");
    expect(body.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 3,
    });
  });

  it("API-RESP-002: initialState always has stateVersion 0 and an empty actionQueue", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.initialState.stateVersion).toBe(0);
    expect(body.initialState.battleStatus).toBe("READY");
    expect(body.initialState.cycleNumber).toBe(0);
    expect(body.initialState.actionQueue).toEqual([]);
  });

  it("API-RESP-003: finalState.stateVersion is the last stateTransition's stateVersionAfter, or 0 when there were none", () => {
    const withTransitions = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          { causedBySequence: 1, stateVersionBefore: 0, stateVersionAfter: 1, stateDelta: {} },
          { causedBySequence: 2, stateVersionBefore: 1, stateVersionAfter: 2, stateDelta: {} },
        ],
      }),
    );
    expect(withTransitions.finalState.stateVersion).toBe(2);

    const withoutTransitions = toBattleSimulationResponseBody(baseResult());
    expect(withoutTransitions.finalState.stateVersion).toBe(0);
  });

  it("API-RESP-004: lists units in roster order (ally before enemy) with formationPosition/coordinate converted back to the per-side API representation", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.initialState.units.map((u) => u.battleUnitId)).toEqual(["ally:1", "enemy:1"]);
    const ally = body.initialState.units[0]!;
    expect(ally.unitDefinitionId).toBe("UNIT_001");
    expect(ally.side).toBe("ALLY");
    expect(ally.formationPosition).toEqual({ column: 0, row: "FRONT" });
    expect(ally.coordinate).toEqual({ x: 0, y: 2 });

    const enemy = body.initialState.units[1]!;
    // domain BACK maps back to the API's REAR spelling regardless of side.
    expect(enemy.formationPosition).toEqual({ column: 1, row: "REAR" });
  });

  // G-09（M7-002A／Issue #255）: AP/PP/EXの最大値も`MODIFY_RESOURCE_CAPACITY`で
  // 戦闘中に変わりうるため、roster（開始時点の不変値）ではなくこの時点のsnapshotから写す。
  it("API-RESP-005: maps hp/resources current values and gauge maximums from the snapshot, and derives combatStatus from hp", () => {
    const body = toBattleSimulationResponseBody(baseResult());
    const finalAlly = body.finalState.units[0]!;
    const finalEnemy = body.finalState.units[1]!;

    expect(finalAlly.hp).toEqual({ current: 90, maximum: 100 });
    expect(finalAlly.resources).toEqual({
      ap: { current: 1, maximum: 3 },
      pp: { current: 0, maximum: 2 },
      extraGauge: { current: 5, maximum: 100 },
    });
    expect(finalAlly.combatStatus).toBe("ACTIVE");
    expect(finalEnemy.hp.current).toBe(0);
    expect(finalEnemy.combatStatus).toBe("DEFEATED");
  });

  it("API-RESP-006: includes real combatStats from the roster and truthfully-empty shields/subUnits/effects/cooldowns (no shield/effect mechanic exists yet, and this snapshot has no active cooldowns)", () => {
    const body = toBattleSimulationResponseBody(baseResult());
    const ally = body.initialState.units[0]!;

    expect(ally.combatStats).toEqual({
      attack: 10,
      defense: 10,
      criticalRate: 5,
      actionSpeed: 10,
      affinityBonus: 0,
      criticalDamageBonus: 50,
    });
    expect(ally.shields).toEqual({ physical: 0, energy: 0, untyped: 0 });
    expect(ally.subUnits).toEqual([]);
    expect(ally.effects).toEqual([]);
    expect(ally.cooldowns).toEqual([]);
  });

  it("API-RESP-006b (R-NUM-01 / 10_API設計.md CombatStatsResponse): converts criticalRate/affinityBonus/criticalDamageBonus from Domain's 1.0=100% ratio to percentage points, while leaving attack/defense/actionSpeed as raw magnitudes", () => {
    const base = baseResult();
    const distinctCombatStats = {
      ...ALLY_COMBAT_STATS,
      attack: 123,
      defense: 45,
      actionSpeed: 67,
      criticalRate: 0.1,
      affinityBonus: 0.25,
      criticalDamageBonus: 0.5,
    };
    const withDistinctRatios = baseResult({
      initialState: {
        ...base.initialState,
        units: {
          ...base.initialState.units,
          [ALLY_ID]: { ...base.initialState.units[ALLY_ID]!, combatStats: distinctCombatStats },
        },
      },
    });

    const body = toBattleSimulationResponseBody(withDistinctRatios);

    expect(body.initialState.units[0]!.combatStats).toEqual({
      attack: 123,
      defense: 45,
      actionSpeed: 67,
      criticalRate: 10,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    });
  });

  it("API-RESP-012 (R-EFF-10): maps real MarkerSnapshots from snapshot.markers into BattleUnitStateResponseBody.markers instead of always returning an empty array", () => {
    const markerInstanceId = createMarkerInstanceId("battle-1:marker:1");
    const markerId = createMarkerId("MARKER_TEST");
    const base = baseResult();
    const withMarker = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            markers: [
              {
                markerInstanceId,
                markerId,
                sourceUnitId: ENEMY_ID,
                stackCount: 2,
                stackMax: 3,
                duration: { unit: "ACTION", remaining: 1 },
              },
            ],
          },
        },
      },
    });

    const body = toBattleSimulationResponseBody(withMarker);

    expect(body.finalState.units[0]!.markers).toEqual([
      {
        markerInstanceId: "battle-1:marker:1",
        markerId: "MARKER_TEST",
        sourceUnitId: "enemy:1",
        stackCount: 2,
        stackMax: 3,
        duration: { unit: "ACTION", remaining: 1 },
      },
    ]);
    // A unit with no MarkerState instances still gets a truthfully-empty array.
    expect(body.finalState.units[1]!.markers).toEqual([]);
  });

  it("API-RESP-012C (M7-009, Issue #182): classifies an APPLY_STATUS-derived AppliedEffect as STATUS_ABNORMALITY and publishes its statusKind, instead of deriving BUFF from a zero magnitude", () => {
    const base = baseResult();
    const withStatus = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            effects: [
              {
                effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
                effectDefinitionId: "ACT_TEST_STUN",
                sourceUnitId: ENEMY_ID,
                kindKey: "ACT_TEST_STUN",
                duplicate: false,
                isEffective: true,
                magnitude: 0,
                categories: ["DEBUFF", "STATUS"],
                statusKind: "STUN",
                duration: { unit: "ACTION", remaining: 1 },
                appliedTurnNumber: 1,
              },
            ],
          },
        },
      },
    });

    const body = toBattleSimulationResponseBody(withStatus);

    expect(body.finalState.units[0]!.effects).toEqual([
      {
        effectInstanceId: "battle-1:effect:1",
        effectDefinitionId: "ACT_TEST_STUN",
        sourceUnitId: "enemy:1",
        category: "STATUS_ABNORMALITY",
        effectKindKey: "ACT_TEST_STUN",
        statusKind: "STUN",
        stackMode: "NON_STACKING",
        isEffective: true,
        value: { magnitude: 0 },
        duration: { unit: "ACTION", remaining: 1 },
        appliedTurnNumber: 1,
      },
    ]);
  });

  it("API-RESP-012E: classifies an advantageous APPLY_STATUS (STEALTH etc., outside STATUS_AILMENT_KINDS) as BUFF while still publishing its statusKind, matching effectCategoriesOf", () => {
    const base = baseResult();
    const withAdvantageousStatus = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            effects: [
              {
                effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
                effectDefinitionId: "ACT_TEST_STEALTH",
                sourceUnitId: ALLY_ID,
                kindKey: "ACT_TEST_STEALTH",
                duplicate: false,
                isEffective: true,
                magnitude: 0,
                categories: ["BUFF"],
                statusKind: "STEALTH",
                appliedTurnNumber: 1,
              },
              {
                effectInstanceId: createEffectInstanceId("battle-1:effect:2"),
                effectDefinitionId: "ACT_TEST_DAMAGE_IMMUNITY",
                sourceUnitId: ALLY_ID,
                kindKey: "ACT_TEST_DAMAGE_IMMUNITY",
                duplicate: false,
                isEffective: true,
                magnitude: 0,
                categories: ["BUFF"],
                statusKind: "DAMAGE_IMMUNITY",
                appliedTurnNumber: 1,
              },
            ],
          },
        },
      },
    });

    const effects =
      toBattleSimulationResponseBody(withAdvantageousStatus).finalState.units[0]!.effects;

    expect(effects.map((effect) => effect.category)).toEqual(["BUFF", "BUFF"]);
    expect(effects.map((effect) => effect.statusKind)).toEqual(["STEALTH", "DAMAGE_IMMUNITY"]);
  });

  it("API-RESP-012F: classifies every STATUS_AILMENT_KINDS member as STATUS_ABNORMALITY", () => {
    const base = baseResult();
    const withAilments = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            effects: STATUS_AILMENT_KINDS.map((statusKind, index) => ({
              effectInstanceId: createEffectInstanceId(`battle-1:effect:${index + 1}`),
              effectDefinitionId: `ACT_TEST_${statusKind}`,
              sourceUnitId: ENEMY_ID,
              kindKey: `ACT_TEST_${statusKind}`,
              duplicate: false,
              isEffective: true,
              magnitude: 0,
              // `categories`は手書きせず、Domainの唯一の
              // 分類元へ実際に通した値を載せる（以前は`["BUFF"]`という、この
              // statusKindではありえない値のままでも通っていた）。
              categories: [
                ...effectCategoriesOf({ magnitude: 0, statusKind }, statusDefinition(statusKind)),
              ],
              statusKind,
              appliedTurnNumber: 1,
            })),
          },
        },
      },
    });

    const effects = toBattleSimulationResponseBody(withAilments).finalState.units[0]!.effects;

    expect(effects.map((effect) => effect.category)).toEqual(
      STATUS_AILMENT_KINDS.map(() => "STATUS_ABNORMALITY"),
    );
  });

  it("API-RESP-012D (M7-009, Issue #182): keeps deriving BUFF/DEBUFF from the magnitude sign for effects without a statusKind, and omits statusKind entirely", () => {
    const base = baseResult();
    const withStatMods = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            effects: [
              {
                effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
                effectDefinitionId: "ACT_TEST_ATTACK_UP",
                sourceUnitId: ALLY_ID,
                kindKey: "ACT_TEST_ATTACK_UP",
                duplicate: false,
                isEffective: true,
                magnitude: 0.1,
                categories: ["BUFF"],
                appliedTurnNumber: 1,
              },
              {
                effectInstanceId: createEffectInstanceId("battle-1:effect:2"),
                effectDefinitionId: "ACT_TEST_ATTACK_DOWN",
                sourceUnitId: ENEMY_ID,
                kindKey: "ACT_TEST_ATTACK_DOWN",
                duplicate: false,
                isEffective: true,
                magnitude: -0.1,
                categories: ["DEBUFF"],
                appliedTurnNumber: 1,
              },
            ],
          },
        },
      },
    });

    const effects = toBattleSimulationResponseBody(withStatMods).finalState.units[0]!.effects;

    expect(effects.map((effect) => effect.category)).toEqual(["BUFF", "DEBUFF"]);
    expect(effects.every((effect) => !("statusKind" in effect))).toBe(true);
  });

  it("API-RESP-012G: classifies continuous damage from the Domain categories, so a positive-magnitude 毒/炎上 is STATUS_ABNORMALITY and 固定継続ダメージ is DEBUFF, not BUFF", () => {
    // `APPLY_CONTINUOUS_DAMAGE`は`statusKind`を持たず`magnitude`（ダメージ量）が
    // 正値のため、符号だけで分類すると毒・炎上・固定継続ダメージがすべて`BUFF`に
    // なる。R-EFF-02/R-STS-01の分類（`AppliedEffect.categories`）を正本にする。
    const base = baseResult();
    const dot = (
      index: number,
      definitionId: string,
      categories: readonly EffectImmunityCategory[],
      continuousDamageKind: "POISON" | "BURN" | "FIXED",
    ) => ({
      effectInstanceId: createEffectInstanceId(`battle-1:effect:${index}`),
      effectDefinitionId: definitionId,
      sourceUnitId: ENEMY_ID,
      kindKey: definitionId,
      duplicate: false,
      isEffective: true,
      // 継続ダメージ量は常に正値 — ここが符号ベース分類の破綻点だった。
      magnitude: 120,
      categories,
      continuousDamage: { continuousDamageKind, damageType: "PHYSICAL" as const },
      appliedTurnNumber: 1,
    });
    const withContinuousDamage = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            effects: [
              dot(1, "ACT_TEST_POISON", ["DEBUFF", "STATUS"], "POISON"),
              dot(2, "ACT_TEST_BURN", ["DEBUFF", "STATUS"], "BURN"),
              // 固定継続ダメージは名前付きの状態異常ではないため`DEBUFF`止まり。
              dot(3, "ACT_TEST_FIXED_DOT", ["DEBUFF"], "FIXED"),
            ],
          },
        },
      },
    });

    const effects =
      toBattleSimulationResponseBody(withContinuousDamage).finalState.units[0]!.effects;

    expect(effects.map((effect) => effect.category)).toEqual([
      "STATUS_ABNORMALITY",
      "STATUS_ABNORMALITY",
      "DEBUFF",
    ]);
    // `statusKind`は`APPLY_STATUS`由来の効果だけが持つ。継続ダメージは持たない。
    expect(effects.every((effect) => !("statusKind" in effect))).toBe(true);
  });

  it("API-RESP-012B (R-MEM-04, REL-008): publishes a Memory-granted MarkerState with sourceSide and no sourceUnitId instead of failing on the granter-less source", () => {
    const base = baseResult();
    const withMemoryMarker = baseResult({
      finalState: {
        ...base.finalState,
        units: {
          ...base.finalState.units,
          [ALLY_ID]: {
            ...base.finalState.units[ALLY_ID]!,
            markers: [
              {
                markerInstanceId: createMarkerInstanceId("battle-1:marker:1"),
                markerId: createMarkerId("MARKER_TEST"),
                // R-MEM-04: Memory由来の付与は`sourceUnitId`を持たず`sourceSide`を持つ。
                sourceSide: "ALLY",
                stackCount: 1,
                stackMax: null,
              },
            ],
          },
        },
      },
    });

    // `EffectStateResponse`と同じexactly-one union。付与者ユニットを推測せず、
    // 付与元陣営だけを公開する。
    expect(toBattleSimulationResponseBody(withMemoryMarker).finalState.units[0]!.markers).toEqual([
      {
        markerInstanceId: "battle-1:marker:1",
        markerId: "MARKER_TEST",
        sourceSide: "ALLY",
        stackCount: 1,
        stackMax: null,
      },
    ]);
  });

  it("API-RESP-013 (R-EFF-10): maps a StateTransition's markers delta into an EntityCollectionDelta (added/updated/removed derived from before/after undefined)", () => {
    const markerInstanceId = createMarkerInstanceId("battle-1:marker:1");
    const markerId = createMarkerId("MARKER_TEST");
    const applied = {
      markerInstanceId,
      markerId,
      sourceUnitId: ENEMY_ID,
      stackCount: 1,
      stackMax: 3,
    };
    const updatedAfter = { ...applied, stackCount: 2 };

    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  markers: { [markerInstanceId]: { before: undefined, after: applied } },
                },
              },
            },
          },
          {
            causedBySequence: 2,
            stateVersionBefore: 1,
            stateVersionAfter: 2,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  markers: { [markerInstanceId]: { before: applied, after: updatedAfter } },
                },
              },
            },
          },
          {
            causedBySequence: 3,
            stateVersionBefore: 2,
            stateVersionAfter: 3,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  markers: { [markerInstanceId]: { before: updatedAfter, after: undefined } },
                },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.markers).toEqual({
      added: [
        {
          markerInstanceId: "battle-1:marker:1",
          markerId: "MARKER_TEST",
          sourceUnitId: "enemy:1",
          stackCount: 1,
          stackMax: 3,
        },
      ],
      updated: [],
      removed: [],
    });
    expect(body.stateTransitions[1]!.delta.units!["ally:1"]!.markers).toEqual({
      added: [],
      updated: [
        {
          id: "battle-1:marker:1",
          before: {
            markerInstanceId: "battle-1:marker:1",
            markerId: "MARKER_TEST",
            sourceUnitId: "enemy:1",
            stackCount: 1,
            stackMax: 3,
          },
          after: {
            markerInstanceId: "battle-1:marker:1",
            markerId: "MARKER_TEST",
            sourceUnitId: "enemy:1",
            stackCount: 2,
            stackMax: 3,
          },
        },
      ],
      removed: [],
    });
    expect(body.stateTransitions[2]!.delta.units!["ally:1"]!.markers).toEqual({
      added: [],
      updated: [],
      removed: [
        {
          id: "battle-1:marker:1",
          before: {
            markerInstanceId: "battle-1:marker:1",
            markerId: "MARKER_TEST",
            sourceUnitId: "enemy:1",
            stackCount: 2,
            stackMax: 3,
          },
        },
      ],
    });
  });

  it("API-RESP-013B (M7-001B review fix, Issue #243): maps a StateTransition's effects delta into an EntityCollectionDelta (added/updated/removed derived from before/after undefined), so an EFFECT_IMMUNITY (or any AppliedEffect) grant that persists to battle end is visible in stateTransitions, not just finalState", () => {
    const effectInstanceId = createEffectInstanceId("battle-1:effect:1");
    const granted: EffectSnapshot = {
      effectInstanceId,
      effectDefinitionId: "ACT_TEST_IMMUNITY",
      sourceUnitId: ENEMY_ID,
      kindKey: "ACT_TEST_IMMUNITY",
      duplicate: true,
      isEffective: true,
      magnitude: 0,
      categories: ["BUFF"],
      appliedTurnNumber: 1,
    };
    const updatedAfter: EffectSnapshot = {
      ...granted,
      immunity: { categories: ["STATUS"], maxBlocks: null, blockedCount: 1 },
    };

    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  effects: { [effectInstanceId]: { before: undefined, after: granted } },
                },
              },
            },
          },
          {
            causedBySequence: 2,
            stateVersionBefore: 1,
            stateVersionAfter: 2,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  effects: { [effectInstanceId]: { before: granted, after: updatedAfter } },
                },
              },
            },
          },
          {
            causedBySequence: 3,
            stateVersionBefore: 2,
            stateVersionAfter: 3,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  effects: { [effectInstanceId]: { before: updatedAfter, after: undefined } },
                },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.effects).toEqual({
      added: [
        {
          effectInstanceId: "battle-1:effect:1",
          effectDefinitionId: "ACT_TEST_IMMUNITY",
          sourceUnitId: "enemy:1",
          category: "BUFF",
          effectKindKey: "ACT_TEST_IMMUNITY",
          stackMode: "STACKABLE",
          isEffective: true,
          value: { magnitude: 0 },
          appliedTurnNumber: 1,
        },
      ],
      updated: [],
      removed: [],
    });
    const grantedResponseBody = {
      effectInstanceId: "battle-1:effect:1",
      effectDefinitionId: "ACT_TEST_IMMUNITY",
      sourceUnitId: "enemy:1",
      category: "BUFF",
      effectKindKey: "ACT_TEST_IMMUNITY",
      stackMode: "STACKABLE",
      isEffective: true,
      value: { magnitude: 0 },
      appliedTurnNumber: 1,
    };
    // `immunity` (blockedCount etc.) is not part of the public EffectStateResponse
    // contract (internal-only, same treatment as consumptionRemaining), so the
    // "updated" before/after look identical here even though the domain-level
    // blockedCount changed.
    expect(body.stateTransitions[1]!.delta.units!["ally:1"]!.effects).toEqual({
      added: [],
      updated: [
        { id: "battle-1:effect:1", before: grantedResponseBody, after: grantedResponseBody },
      ],
      removed: [],
    });
    expect(body.stateTransitions[2]!.delta.units!["ally:1"]!.effects).toEqual({
      added: [],
      updated: [],
      removed: [{ id: "battle-1:effect:1", before: grantedResponseBody }],
    });
  });

  it("API-RESP-007: maps a BattleLogEvent to BattleLogEventResponseBody, preserving optional fields only when present", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        events: [
          {
            sequence: 1,
            type: "BATTLE_STARTED",
            category: "FACT",
            turnNumber: 0,
            cycleNumber: 0,
            rootSequence: 1,
            targetUnitIds: [],
            details: { turnLimit: 3 },
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateTransitionIndex: 0,
          },
        ],
      }),
    );

    expect(body.events).toEqual([
      {
        sequence: 1,
        type: "BATTLE_STARTED",
        category: "FACT",
        turnNumber: 0,
        cycleNumber: 0,
        rootSequence: 1,
        targetUnitIds: [],
        details: { turnLimit: 3 },
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        stateTransitionIndex: 0,
      },
    ]);
  });

  it("API-RESP-008: maps a StateTransition's flat unit hp/ap/pp/extraGauge delta into the nested battle/resources shape and derives a combatStatus change on defeat", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 5,
            stateVersionBefore: 3,
            stateVersionAfter: 4,
            stateDelta: {
              battleStatus: { before: "RUNNING", after: "COMPLETED" },
              units: {
                [ENEMY_ID]: { hp: { before: 10, after: 0 } },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions).toEqual([
      {
        causedBySequence: 5,
        stateVersionBefore: 3,
        stateVersionAfter: 4,
        delta: {
          battle: { battleStatus: { before: "RUNNING", after: "COMPLETED" } },
          units: {
            "enemy:1": {
              hp: { before: 10, after: 0 },
              combatStatus: { before: "ACTIVE", after: "DEFEATED" },
            },
          },
        },
      },
    ]);
  });

  it("API-RESP-009: maps ap/pp/extraGauge deltas under resources without a combatStatus change when hp is untouched", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 2,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: { units: { [ALLY_ID]: { ap: { before: 0, after: 3 } } } },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta).toEqual({
      units: { "ally:1": { resources: { ap: { before: 0, after: 3 } } } },
    });
  });

  it("API-RESP-010 (P1 fix): maps a unit's real cooldowns (10_API設計.md CooldownStateResponse, filtering out any zero-remaining entries) and charge instead of discarding them", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        finalState: {
          status: "COMPLETED",
          currentTurn: 1,
          result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
          units: {
            [ALLY_ID]: {
              hp: 90,
              ap: 1,
              pp: 0,
              extraGauge: 5,
              maximumAp: 3,
              maximumPp: 2,
              maximumExtraGauge: 100,
              combatStats: ALLY_COMBAT_STATS,
              baseCombatStats: ALLY_COMBAT_STATS,
              cooldowns: {
                [SKL_A]: { unit: "ACTION", remaining: 2, setActionId: ACTION_1 },
                [SKL_B]: { unit: "TURN", remaining: 1, setTurnNumber: 3 },
                // A completed cooldown the domain still tracks internally but is no
                // longer "active" (10_API設計.md: cooldowns lists only skills with
                // remaining > 0).
                [SKL_C]: { unit: "ACTION", remaining: 0, setActionId: ACTION_1 },
              },
              charge: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
            },
            [ENEMY_ID]: {
              hp: 0,
              ap: 0,
              pp: 0,
              extraGauge: 0,
              maximumAp: 3,
              maximumPp: 2,
              maximumExtraGauge: 100,
              combatStats: ENEMY_COMBAT_STATS,
              baseCombatStats: ENEMY_COMBAT_STATS,
            },
          },
        },
      }),
    );

    const finalAlly = body.finalState.units[0]!;
    expect(finalAlly.cooldowns).toEqual([
      { skillDefinitionId: "SKL_A", unit: "ACTION", remaining: 2, setAtActionId: "action-1" },
      { skillDefinitionId: "SKL_B", unit: "TURN", remaining: 1, setAtTurnNumber: 3 },
    ]);
    expect(finalAlly.charge).toEqual({
      skillDefinitionId: "SKL_D",
      startedActionId: "action-2",
      status: "CHARGING",
    });
  });

  it("API-RESP-010B (REL-004, Issue #203, R-SKL-04): serializes an ACTION cooldown that has no setting scope by omitting setAtActionId, because a Passive Skill activated outside any action legitimately produces one", () => {
    // `startCooldown`は`scope === undefined`（ターン開始・終了などのトップレベル
    // イベントからのPS発動）で設定scopeなしのエントリを作る。ここで例外にしていた
    // ため、実在Unit`UNIT_LUCIE_MAID`のレスポンスが500になっていた。
    const body = toBattleSimulationResponseBody(
      baseResult({
        finalState: {
          status: "COMPLETED",
          currentTurn: 1,
          result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
          units: {
            [ALLY_ID]: {
              hp: 90,
              ap: 1,
              pp: 0,
              extraGauge: 5,
              maximumAp: 3,
              maximumPp: 2,
              maximumExtraGauge: 100,
              combatStats: ALLY_COMBAT_STATS,
              baseCombatStats: ALLY_COMBAT_STATS,
              cooldowns: { [SKL_A]: { unit: "ACTION", remaining: 2 } },
            },
            [ENEMY_ID]: {
              hp: 0,
              ap: 0,
              pp: 0,
              extraGauge: 0,
              maximumAp: 3,
              maximumPp: 2,
              maximumExtraGauge: 100,
              combatStats: ENEMY_COMBAT_STATS,
              baseCombatStats: ENEMY_COMBAT_STATS,
            },
          },
        },
      }),
    );

    const cooldowns = body.finalState.units.find(
      (unit) => unit.battleUnitId === ALLY_ID,
    )?.cooldowns;
    expect(cooldowns).toEqual([{ skillDefinitionId: SKL_A, unit: "ACTION", remaining: 2 }]);
    expect(cooldowns?.[0] && "setAtActionId" in cooldowns[0]).toBe(false);
  });

  it("API-RESP-010C: throws instead of silently dropping the opposite-side scope field when a Domain cooldown has both setActionId and setTurnNumber set (unit ACTION with a stray setTurnNumber)", () => {
    expect(() =>
      toBattleSimulationResponseBody(
        baseResult({
          finalState: {
            status: "COMPLETED",
            currentTurn: 1,
            result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
            units: {
              [ALLY_ID]: {
                hp: 90,
                ap: 1,
                pp: 0,
                extraGauge: 5,
                maximumAp: 3,
                maximumPp: 2,
                maximumExtraGauge: 100,
                combatStats: ALLY_COMBAT_STATS,
                baseCombatStats: ALLY_COMBAT_STATS,
                cooldowns: {
                  [SKL_A]: {
                    unit: "ACTION",
                    remaining: 2,
                    setActionId: ACTION_1,
                    setTurnNumber: 3,
                  },
                },
              },
              [ENEMY_ID]: {
                hp: 0,
                ap: 0,
                pp: 0,
                extraGauge: 0,
                maximumAp: 3,
                maximumPp: 2,
                maximumExtraGauge: 100,
                combatStats: ENEMY_COMBAT_STATS,
                baseCombatStats: ENEMY_COMBAT_STATS,
              },
            },
          },
        }),
      ),
    ).toThrow(/setTurnNumber/);
  });

  it("API-RESP-011 (P1 fix): maps a StateTransition's cooldowns delta into an EntityCollectionDelta (added/updated/removed derived from remaining crossing zero) and charge into a ValueChange with null for the unset side", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  cooldowns: {
                    [SKL_A]: { unit: "ACTION", before: 0, after: 2, setActionId: ACTION_1 },
                    [SKL_B]: { unit: "TURN", before: 2, after: 1 },
                    [SKL_C]: { unit: "ACTION", before: 1, after: 0 },
                  },
                  charge: {
                    before: undefined,
                    after: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
                  },
                },
              },
            },
          },
          {
            causedBySequence: 2,
            stateVersionBefore: 1,
            stateVersionAfter: 2,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  charge: {
                    before: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
                    after: undefined,
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.cooldowns).toEqual({
      added: [
        {
          skillDefinitionId: "SKL_A",
          unit: "ACTION",
          remaining: 2,
          setAtActionId: "action-1",
        },
      ],
      updated: [{ id: "SKL_B", before: 2, after: 1 }],
      removed: [{ id: "SKL_C", before: 1 }],
    });
    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.charge).toEqual({
      before: null,
      after: { skillDefinitionId: "SKL_D", startedActionId: "action-2", status: "CHARGING" },
    });
    expect(body.stateTransitions[1]!.delta.units!["ally:1"]!.charge).toEqual({
      before: { skillDefinitionId: "SKL_D", startedActionId: "action-2", status: "CHARGING" },
      after: null,
    });
  });

  it("API-RESP-010D: CooldownStateResponseBody rejects a value with both setAtActionId and setAtTurnNumber at the type level, even through an intermediate variable (not just via excess-property-check on a literal)", () => {
    const both = {
      skillDefinitionId: "SKL_1",
      unit: "ACTION" as const,
      remaining: 1,
      setAtActionId: "a-1",
      setAtTurnNumber: 1,
    };

    // @ts-expect-error `setAtTurnNumber` is `never` on the ACTION variant, so this
    // assignment must fail even though `both` isn't an object literal (the
    // excess-property-check bypass the round 4 review found).
    const rejected: CooldownStateResponseBody = both;
    expect(rejected.unit).toBe("ACTION");
  });
});
