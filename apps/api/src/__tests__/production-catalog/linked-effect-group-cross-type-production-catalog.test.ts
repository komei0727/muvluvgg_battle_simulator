import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../../domain/battle/events/state-delta.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { applyStateDelta } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";

/**
 * M7-013（Issue #267、`LINKED_EFFECT_GROUP_CROSS_TYPE`、R-EFF-09第1項）:
 * `AppliedEffect`と`MarkerState`をまたぐ`linkedEffectGroup`カスケードを、
 * production Catalogの実定義と実ライフサイクル（`resolveSkillUse`→
 * `REMOVE_MARKER` resolver→`reduceMarkerStack`/`removeMarkers`→
 * `linked-group-cascade.ts`）で検証する。
 *
 * 対象はraw原文が「Markerの解除に連動して`AppliedEffect`も解除される」と書く2件:
 *
 * - `SKL_TARISA_TROUBLEMAKER_PS1`「徹底的にやってやろうじゃん！」
 *   「攻撃力バフは解除不可だが、「負けん気」が解除されると同時に解除される」
 * - `SKL_AOI_ELEGANT_AS1`「百花繚乱」
 *   「会心率デバフと継続ダメージデバフは解除不可だが、「高揚」が解除されると同時に解除される」
 *
 * それまで`catalog-integrity.ts`の`validateMarkerLinkedGroupCascadeSupport`が
 * cross-type定義を`UNSUPPORTED_MARKER_LINKED_GROUP`としてCatalogロード時点で
 * 拒否していたため、両者は`dispellable: false`の恒久効果へ近似されていた
 * （`docs/ddd/15_Unit_Memory変換台帳.md`）。
 *
 * PS1/AS1のEffectSequenceを丸ごと解決するとダメージ・trigger解決も同じ解決に
 * 載ってカスケードだけを分離できないため、`stat-mod-stack-limit-production-
 * catalog.test.ts`（M7-012）と同じ方針で、実カタログから読んだ定義そのものだけを
 * 持つ最小限の合成AS skillで包む。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const TARISA_UNIT_ID = "UNIT_TARISA_TROUBLEMAKER";
const TARISA_MARKER_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_PS1_MARKER";
const TARISA_ATK_UP_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP";
const TARISA_REMOVE_MARKER_EFFECT_ID = "ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER";
const TARISA_MARKER_ID = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";
const TARISA_GROUP_ID = "TARISA_TROUBLEMAKER_PS1_LINK";

const AOI_UNIT_ID = "UNIT_AOI_ELEGANT";
const AOI_MARKER_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU";
const AOI_CRIT_DOWN_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN";
const AOI_DOT_EFFECT_ID = "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT";
const AOI_CLEAR_MARKER_EFFECT_ID = "ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU";
const AOI_MARKER_ID = "MARKER_AOI_ELEGANT_KOUYOU";
const AOI_GROUP_ID = "AOI_ELEGANT_AS1_KOUYOU_LINK";

const BASE_ATTACK = 100;
const BASE_CRITICAL_RATE = 0.5;
const LIMITS = { maximumAp: 8, maximumPp: 3, maximumExtraGauge: 100 };

function member(unitDefinitionId: string, battleUnitId: string): BattlePartyMember {
  const position = { column: "CENTER", row: "FRONT" } as const;
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 1000,
      attack: BASE_ATTACK,
      defense: 50,
      criticalRate: BASE_CRITICAL_RATE,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
}

/** 実production定義だけを順に自身へ適用する最小限の合成AS skill。 */
function selfSkill(skillDefinitionId: string, effectActionIds: readonly string[]): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillDefinitionId),
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
          actions: effectActionIds.map((id) => ({
            effectActionDefinitionId: createEffectActionDefinitionId(id),
          })),
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
    metadata: { displayName: skillDefinitionId, tags: [] },
  };
}

interface Harness {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly actor: BattleUnit;
  readonly snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>;
  readonly skills: ReadonlyMap<string, SkillDefinition>;
}

function harness(unitDefinitionId: string, synthetic: readonly SkillDefinition[]): Harness {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([unitDefinitionId as never], []);
  const skillDefinitions = new Map(snapshot.skills);
  for (const skill of synthetic) {
    skillDefinitions.set(skill.skillDefinitionId, skill);
  }

  return {
    definitions: {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(snapshot.effectActions),
      unitDefinitions: new Map(snapshot.units),
      skillDefinitions,
    },
    recorder: new EventRecorder(createBattleId("B_1")),
    actor: {
      ...createBattleUnit(member(unitDefinitionId, "ally:actor"), "ALLY", LIMITS),
      currentAp: LIMITS.maximumAp,
    },
    snapshot,
    skills: new Map(synthetic.map((skill) => [String(skill.skillDefinitionId), skill])),
  };
}

function useSkill(
  h: Harness,
  units: readonly BattleUnit[],
  skillDefinitionId: string,
  actionNumber: number,
): readonly BattleUnit[] {
  const actor = units.find((u) => u.battleUnitId === h.actor.battleUnitId)!;
  return resolveSkillUse(
    actor,
    h.skills.get(skillDefinitionId)!,
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

function actorOf(h: Harness, units: readonly BattleUnit[]): BattleUnit {
  return units.find((u) => u.battleUnitId === h.actor.battleUnitId)!;
}

function initialSnapshot(actor: BattleUnit): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 1,
    units: {
      [actor.battleUnitId]: {
        hp: actor.currentHp,
        ap: actor.currentAp,
        pp: actor.currentPp,
        extraGauge: actor.currentExtraGauge,
        combatStats: actor.combatStats,
      },
    },
  };
}

function liveSnapshot(actor: BattleUnit): BattleStateSnapshot["units"][BattleUnitId] {
  return {
    hp: actor.currentHp,
    ap: actor.currentAp,
    pp: actor.currentPp,
    extraGauge: actor.currentExtraGauge,
    combatStats: actor.combatStats,
    ...(actor.appliedEffects.length > 0
      ? { effects: actor.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
      : {}),
    ...(actor.markerStates.length > 0
      ? { markers: actor.markerStates.map((marker) => toMarkerSnapshot(marker)) }
      : {}),
  };
}

describe("production Catalog cross-type linkedEffectGroup cascade (M7-013, Issue #267, R-EFF-09)", () => {
  it("IT-LINKED-GROUP-CROSS-TYPE-PROD-001 (R-EFF-09第1項): both production groups declare the Marker as PARENT and every AppliedEffect member as CHILD of the same linkedEffectGroupId", () => {
    const tarisa = harness(TARISA_UNIT_ID, []);
    const aoi = harness(AOI_UNIT_ID, []);
    const durationOf = (h: Harness, id: string) => {
      const definition = h.snapshot.effectActions.get(createEffectActionDefinitionId(id))!;
      expect(definition).toBeDefined();
      return (definition as { payload: { duration: unknown } }).payload.duration as {
        linkedEffectGroupId: string | null;
        linkedEffectGroupRole?: string;
        dispellable: boolean;
      };
    };

    expect(durationOf(tarisa, TARISA_MARKER_EFFECT_ID)).toMatchObject({
      linkedEffectGroupId: TARISA_GROUP_ID,
      linkedEffectGroupRole: "PARENT",
    });
    // raw原文「攻撃力バフは解除不可だが、「負けん気」が解除されると同時に解除される」:
    // `dispellable: false`（REMOVE_EFFECTSでは解除できない）とcross-typeカスケード
    // （Markerの解除には連動する）は両立する。
    expect(durationOf(tarisa, TARISA_ATK_UP_EFFECT_ID)).toMatchObject({
      linkedEffectGroupId: TARISA_GROUP_ID,
      linkedEffectGroupRole: "CHILD",
      dispellable: false,
    });

    expect(durationOf(aoi, AOI_MARKER_EFFECT_ID)).toMatchObject({
      linkedEffectGroupId: AOI_GROUP_ID,
      linkedEffectGroupRole: "PARENT",
    });
    for (const childId of [AOI_CRIT_DOWN_EFFECT_ID, AOI_DOT_EFFECT_ID]) {
      expect(durationOf(aoi, childId)).toMatchObject({
        linkedEffectGroupId: AOI_GROUP_ID,
        linkedEffectGroupRole: "CHILD",
        dispellable: false,
      });
    }
  });

  it("IT-LINKED-GROUP-CROSS-TYPE-PROD-002 (R-EFF-09, real lifecycle wiring): removing 「負けん気」 through the production REMOVE_MARKER cascades every ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP instance away and restores base ATTACK", () => {
    const grant = selfSkill("SKL_TEST_TARISA_GRANT", [
      TARISA_MARKER_EFFECT_ID,
      TARISA_ATK_UP_EFFECT_ID,
    ]);
    const clear = selfSkill("SKL_TEST_TARISA_CLEAR", [TARISA_REMOVE_MARKER_EFFECT_ID]);
    const h = harness(TARISA_UNIT_ID, [grant, clear]);

    // 2回使用 → Marker「負けん気」2スタック＋攻撃力バフ2インスタンス。
    let units: readonly BattleUnit[] = [h.actor];
    units = useSkill(h, units, "SKL_TEST_TARISA_GRANT", 1);
    units = useSkill(h, units, "SKL_TEST_TARISA_GRANT", 2);

    const buffed = actorOf(h, units);
    expect(buffed.markerStates.find((m) => m.markerId === TARISA_MARKER_ID)?.stackCount).toBe(2);
    expect(
      buffed.appliedEffects.filter((e) => e.effectActionDefinitionId === TARISA_ATK_UP_EFFECT_ID),
    ).toHaveLength(2);
    expect(buffed.combatStats.attack).toBeCloseTo(BASE_ATTACK * (1 + 0.025 * 2), 9);

    // production `REMOVE_MARKER`は`count: 3` — 残2スタックはこれで全て失われる
    // ため、`reduceMarkerStack`はインスタンスごと除去し（`MarkerRemoved`）、
    // R-EFF-09のcross-typeカスケードが攻撃力バフ2件を巻き込む。
    const before = h.recorder.getEvents().length;
    units = useSkill(h, units, "SKL_TEST_TARISA_CLEAR", 3);

    const cleared = actorOf(h, units);
    expect(cleared.markerStates).toHaveLength(0);
    expect(cleared.appliedEffects).toHaveLength(0);
    expect(cleared.combatStats.attack).toBe(BASE_ATTACK);

    const cascade = h.recorder
      .getEvents()
      .slice(before)
      .filter((e) => e.eventType === "EffectExpired" || e.eventType === "MarkerRemoved");
    expect(cascade.map((e) => e.eventType)).toEqual([
      "EffectExpired",
      "EffectExpired",
      "MarkerRemoved",
    ]);
    for (const expired of cascade.slice(0, 2)) {
      expect(expired.payload).toMatchObject({
        effectActionDefinitionId: TARISA_ATK_UP_EFFECT_ID,
        reason: "LINKED_GROUP_CASCADE",
        linkedEffectGroupId: TARISA_GROUP_ID,
        cascaded: true,
      });
    }
    expect(cascade[2]!.payload).toMatchObject({
      markerId: TARISA_MARKER_ID,
      reason: "REMOVED",
      cascaded: false,
    });
  });

  it("IT-LINKED-GROUP-CROSS-TYPE-PROD-003 (R-EFF-09, real lifecycle wiring): removing 「高揚」 through the production REMOVE_MARKER cascades ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN away and restores base CRITICAL_RATE", () => {
    const grant = selfSkill("SKL_TEST_AOI_GRANT", [AOI_MARKER_EFFECT_ID, AOI_CRIT_DOWN_EFFECT_ID]);
    const clear = selfSkill("SKL_TEST_AOI_CLEAR", [AOI_CLEAR_MARKER_EFFECT_ID]);
    const h = harness(AOI_UNIT_ID, [grant, clear]);

    let units: readonly BattleUnit[] = [h.actor];
    units = useSkill(h, units, "SKL_TEST_AOI_GRANT", 1);

    const debuffed = actorOf(h, units);
    expect(debuffed.markerStates.find((m) => m.markerId === AOI_MARKER_ID)?.stackCount).toBe(1);
    expect(debuffed.combatStats.criticalRate).toBeCloseTo(BASE_CRITICAL_RATE * (1 - 0.25), 9);

    const before = h.recorder.getEvents().length;
    units = useSkill(h, units, "SKL_TEST_AOI_CLEAR", 2);

    const cleared = actorOf(h, units);
    expect(cleared.markerStates).toHaveLength(0);
    expect(cleared.appliedEffects).toHaveLength(0);
    expect(cleared.combatStats.criticalRate).toBe(BASE_CRITICAL_RATE);

    const cascade = h.recorder
      .getEvents()
      .slice(before)
      .filter((e) => e.eventType === "EffectExpired" || e.eventType === "MarkerRemoved");
    expect(cascade.map((e) => e.eventType)).toEqual(["EffectExpired", "MarkerRemoved"]);
    expect(cascade[0]!.payload).toMatchObject({
      effectActionDefinitionId: AOI_CRIT_DOWN_EFFECT_ID,
      reason: "LINKED_GROUP_CASCADE",
      linkedEffectGroupId: AOI_GROUP_ID,
      cascaded: true,
    });
    expect(cascade[1]!.payload).toMatchObject({
      markerId: AOI_MARKER_ID,
      reason: "REMOVED",
      cascaded: false,
    });
  });

  it("IT-LINKED-GROUP-CROSS-TYPE-PROD-004 (independent Reducer restoration): applying only the emitted StateDeltas reconstructs the post-cascade state, with neither the Marker nor its child AppliedEffects left behind", () => {
    const grant = selfSkill("SKL_TEST_TARISA_GRANT", [
      TARISA_MARKER_EFFECT_ID,
      TARISA_ATK_UP_EFFECT_ID,
    ]);
    const clear = selfSkill("SKL_TEST_TARISA_CLEAR", [TARISA_REMOVE_MARKER_EFFECT_ID]);
    const h = harness(TARISA_UNIT_ID, [grant, clear]);

    let units: readonly BattleUnit[] = [h.actor];
    units = useSkill(h, units, "SKL_TEST_TARISA_GRANT", 1);
    units = useSkill(h, units, "SKL_TEST_TARISA_GRANT", 2);
    units = useSkill(h, units, "SKL_TEST_TARISA_CLEAR", 3);

    const reduced = h.recorder
      .getEvents()
      .reduce(
        (state, event) =>
          event.stateDelta === undefined ? state : applyStateDelta(state, event.stateDelta),
        initialSnapshot(h.actor),
      );

    const restored = reduced.units[h.actor.battleUnitId]!;
    expect(restored.effects ?? []).toHaveLength(0);
    expect(restored.markers ?? []).toHaveLength(0);
    expect(restored).toEqual(liveSnapshot(actorOf(h, units)));
  });
});
