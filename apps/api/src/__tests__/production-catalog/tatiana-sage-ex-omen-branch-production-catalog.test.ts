import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyMarker } from "../../domain/battle/effects/marker-apply-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { toEffectSnapshot, toMarkerSnapshot } from "../../domain/battle/events/state-delta.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { createTargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * RES-004-TATIANA-EX（Issue #225）: raw原文
 *
 * > 敵全体に威力169.6でEN攻撃する。攻撃時に対象が「凶兆」を2つ以上所持していた場合、
 * > さらに対象の次の攻撃での与ダメージを100％減少させるデバフを付与する。
 * > 対象が「凶兆」を2つ所持していなかった場合、「凶兆」を1つ付与する
 *
 * を、実 `catalog/` の `SKL_TATIANA_SAGE_EX` を無改変のまま実 `resolveSkillUse`
 * へ通して検証する。PR #231 は `CAP_DAMAGE_MOD`（`DMG-002`／Issue #192）未実装の
 * ため `EffectSequencePlan` レベルの振り分け（`IT-CAP-EFFSTEP-005`）までしか
 * 確かめられなかった。#192 が `APPLY_DAMAGE_MOD` を実ライフサイクルへ配線したので、
 * ここでは実際の付与・実際のダメージ無効化・消費による失効までを固定する。
 *
 * 検証対象は3つの production 定義すべてが同じAOE解決の中で対象ごとに正しく
 * 振り分けられること:
 * - `ACT_TATIANA_SAGE_EX_DAMAGE`（全対象）
 * - `ACT_TATIANA_SAGE_EX_DEBUFF`（`TARGET_HAS_MARKER` GTE 2 の対象だけ）
 * - `ACT_TATIANA_SAGE_EX_MARK`（`NOT(...)` すなわちしきい値未満の対象だけ）
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const TATIANA_UNIT_ID = "UNIT_TATIANA_SAGE";
const TATIANA_EX_ID = "SKL_TATIANA_SAGE_EX";
const MARKER_ID = "MARKER_TATIANA_SAGE_OMEN";
const DAMAGE_ACTION_ID = "ACT_TATIANA_SAGE_EX_DAMAGE";
const DEBUFF_ACTION_ID = "ACT_TATIANA_SAGE_EX_DEBUFF";
const MARK_ACTION_ID = "ACT_TATIANA_SAGE_EX_MARK";

const ENEMY_UNIT_ID = "UNIT_TEST_TATIANA_ENEMY";
const ENEMY_ATTACK_ACTION_ID = "ACT_TEST_TATIANA_ENEMY_ATTACK";
const ENEMY_ATTACK_SKILL_ID = "SKL_TEST_TATIANA_ENEMY_ATTACK";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

/** 会心・MISSのゆらぎを排して、補正倍率だけがダメージ差の原因になるようにする。 */
function noMissNoCrit(): SequenceRandomSource {
  return new SequenceRandomSource(new Array(256).fill(0.99));
}

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
      maximumHp: 5000,
      attack: 100,
      defense: 50,
      criticalRate: 0,
      actionSpeed: 100,
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
      maximumHp: 5000,
      attack: 100,
      defense: 50,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 100,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: undefined as never,
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

/**
 * デバフ対象が「次の攻撃」として撃つための最小のAS。`ACT_TATIANA_SAGE_EX_DEBUFF`
 * は`direction: OUTGOING`／`damageType: null`なので、攻撃側の種別は問わない。
 */
function enemyAttackAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ENEMY_ATTACK_ACTION_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function enemyAttackSkill(): SkillDefinition {
  const bindingId = createTargetBindingId("TGT_TEST_PRIMARY");
  return {
    skillDefinitionId: createSkillDefinitionId(ENEMY_ATTACK_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: bindingId,
          selector: createTargetSelectorDefinition(
            { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
            `${ENEMY_ATTACK_SKILL_ID}.targetBindings[0].selector`,
            undefined,
          ),
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: bindingId },
          actions: [
            { effectActionDefinitionId: createEffectActionDefinitionId(ENEMY_ATTACK_ACTION_ID) },
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
    metadata: { displayName: ENEMY_ATTACK_SKILL_ID, tags: [] },
  };
}

function snapshotOf(units: readonly BattleUnit[]): BattleStateSnapshot {
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
          ...(unit.appliedEffects.length > 0
            ? { effects: unit.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
            : {}),
          ...(unit.markerStates.length > 0
            ? { markers: unit.markerStates.map((marker) => toMarkerSnapshot(marker)) }
            : {}),
        },
      ]),
    ),
  };
}

const POSITIONS: readonly FormationPosition[] = [
  { column: "LEFT", row: "FRONT" },
  { column: "LEFT", row: "BACK" },
  { column: "RIGHT", row: "FRONT" },
  { column: "RIGHT", row: "BACK" },
];

/**
 * 実Catalogのタチアナと、`omenStacks[i]`個の「凶兆」を事前に持つ敵を用意する。
 * 事前スタックも production の`ACT_TATIANA_SAGE_EX_MARK`（`stack.policy: ADD`）を
 * 実`applyMarker`で重ねて作る — 前ターンまでに同じEXが積んだ状態そのものである。
 */
function setup(omenStacks: readonly number[]) {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([TATIANA_UNIT_ID as never], []);
  const skill = snapshot.skills.get(TATIANA_EX_ID as never)!;

  const markAction = snapshot.effectActions.get(MARK_ACTION_ID as never)!;
  if (markAction.kind !== "APPLY_MARKER") {
    throw new Error(`${MARK_ACTION_ID} must be APPLY_MARKER`);
  }

  const tatiana: BattleUnit = {
    ...createBattleUnit(
      member("ally:tatiana", TATIANA_UNIT_ID, "ALLY", { column: "CENTER", row: "FRONT" }),
      "ALLY",
      LIMITS,
    ),
    currentAp: LIMITS.maximumAp,
    currentExtraGauge: LIMITS.maximumExtraGauge,
  };
  const enemies = omenStacks.map((_, index) => ({
    ...createBattleUnit(
      member(`enemy:${index}`, ENEMY_UNIT_ID, "ENEMY", POSITIONS[index]!),
      "ENEMY",
      LIMITS,
    ),
    currentAp: LIMITS.maximumAp,
  }));

  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(createUnitDefinitionId(ENEMY_UNIT_ID), testUnitDefinition(ENEMY_UNIT_ID));
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(createEffectActionDefinitionId(ENEMY_ATTACK_ACTION_ID), enemyAttackAction());
  const skillDefinitions = new Map(snapshot.skills);
  skillDefinitions.set(createSkillDefinitionId(ENEMY_ATTACK_SKILL_ID), enemyAttackSkill());
  const definitions: BattleDefinitions = {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions,
    skillDefinitions,
  };

  const recorder = new EventRecorder(createBattleId("B_1"));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });

  let units: readonly BattleUnit[] = [tatiana, ...enemies];
  let lastEventId = seed.eventId;
  omenStacks.forEach((stacks, index) => {
    const enemy = enemies[index]!;
    for (let i = 0; i < stacks; i += 1) {
      const grant = applyMarker(
        { recorder, turnNumber: 1, cycleNumber: 1, resolutionScopeId, rootEventId: seed.eventId },
        units,
        {
          markerId: markAction.payload.markerId,
          sourceId: tatiana.battleUnitId,
          targetId: enemy.battleUnitId,
          stackPolicy: markAction.payload.stack.policy,
          stackMax: markAction.payload.stack.max,
          durationDefinition: markAction.payload.duration,
        },
        lastEventId,
      );
      units = grant.units;
      lastEventId = grant.lastEventId;
    }
  });

  omenStacks.forEach((stacks, index) => {
    expect(omenCountOf(units, enemies[index]!.battleUnitId)).toBe(stacks);
  });

  return {
    skill,
    definitions,
    recorder,
    resolutionScopeId,
    units,
    tatianaId: tatiana.battleUnitId,
    enemyIds: enemies.map((enemy) => enemy.battleUnitId),
  };
}

function unitOf(units: readonly BattleUnit[], battleUnitId: BattleUnitId): BattleUnit {
  return units.find((unit) => unit.battleUnitId === battleUnitId)!;
}

function omenCountOf(units: readonly BattleUnit[], battleUnitId: BattleUnitId): number {
  return (
    unitOf(units, battleUnitId).markerStates.find((marker) => marker.markerId === MARKER_ID)
      ?.stackCount ?? 0
  );
}

function debuffsOf(units: readonly BattleUnit[], battleUnitId: BattleUnitId) {
  return unitOf(units, battleUnitId).appliedEffects.filter(
    (effect) => effect.effectActionDefinitionId === DEBUFF_ACTION_ID,
  );
}

/** `setup`へ渡した事前「凶兆」スタック数の並び順で敵IDを取り出す。 */
function enemyAt(setupResult: ReturnType<typeof setup>, index: number): BattleUnitId {
  const battleUnitId = setupResult.enemyIds[index];
  if (battleUnitId === undefined) {
    throw new Error(`enemy ${index} is missing`);
  }
  return battleUnitId;
}

function fireEx(setupResult: ReturnType<typeof setup>) {
  const { recorder, resolutionScopeId, units, definitions, skill, tatianaId } = setupResult;
  const eventsBefore = recorder.getEvents().length;
  const result = resolveSkillUse(
    unitOf(units, tatianaId),
    skill,
    "EX",
    "EX",
    units,
    definitions,
    noMissNoCrit(),
    recorder,
    1,
    1,
    recorder.nextActionId(),
    resolutionScopeId,
  );
  return { result, eventsBefore, emitted: recorder.getEvents().slice(eventsBefore) };
}

/** デバフ保持者が「次の攻撃」を撃つ。実`resolveSkillUse`→実ダメージ計算を通す。 */
function fireEnemyAttack(
  setupResult: ReturnType<typeof setup>,
  units: readonly BattleUnit[],
  attackerId: BattleUnitId,
) {
  const { recorder, resolutionScopeId, definitions } = setupResult;
  const eventsBefore = recorder.getEvents().length;
  const result = resolveSkillUse(
    unitOf(units, attackerId),
    definitions.skillDefinitions.get(createSkillDefinitionId(ENEMY_ATTACK_SKILL_ID))!,
    "AS",
    "AS",
    units,
    definitions,
    noMissNoCrit(),
    recorder,
    1,
    1,
    recorder.nextActionId(),
    resolutionScopeId,
  );
  const emitted = recorder.getEvents().slice(eventsBefore);
  const damageApplied = emitted.filter((event) => event.eventType === "DamageApplied");
  return { result, emitted, damageApplied };
}

describe("production Catalog SKL_TATIANA_SAGE_EX Omen threshold branch (RES-004-TATIANA-EX, Issue #225)", () => {
  it("IT-CAP-TATIANA-OMEN-PROD-001: one AOE resolution damages every enemy, applies ACT_TATIANA_SAGE_EX_DEBUFF only to the 2+ Omen targets, and grants one Omen only to the rest", () => {
    // 0個（Marker無し）・1個（しきい値直前）・2個（しきい値一致）・3個（超過）。
    const context = setup([0, 1, 2, 3]);
    const noOmen = enemyAt(context, 0);
    const belowThreshold = enemyAt(context, 1);
    const atThreshold = enemyAt(context, 2);
    const aboveThreshold = enemyAt(context, 3);
    const { result } = fireEx(context);
    const units = result.units;

    // 攻撃自体は条件を持たない先頭stepなので全対象へ届く。
    for (const enemyId of context.enemyIds) {
      expect(unitOf(units, enemyId).currentHp).toBeLessThan(
        unitOf(context.units, enemyId).currentHp,
      );
    }

    // 「凶兆」2つ以上 → 与ダメージ100%減少デバフ。Markerは増えない。
    for (const enemyId of [atThreshold, aboveThreshold]) {
      expect(debuffsOf(units, enemyId)).toHaveLength(1);
      expect(debuffsOf(units, enemyId)[0]).toMatchObject({
        magnitude: -1,
        damageModifier: { direction: "OUTGOING", damageType: null },
      });
      expect(debuffsOf(units, enemyId)[0]?.duration.definition.consumption).toEqual({
        kind: "NEXT_OUTGOING_ATTACK",
        maxCount: 1,
      });
    }
    expect(omenCountOf(units, atThreshold)).toBe(2);
    expect(omenCountOf(units, aboveThreshold)).toBe(3);

    // 「凶兆」2つ未満 → 「凶兆」を1つ付与。デバフは付かない。
    expect(omenCountOf(units, noOmen)).toBe(1);
    expect(omenCountOf(units, belowThreshold)).toBe(2);
    for (const enemyId of [noOmen, belowThreshold]) {
      expect(debuffsOf(units, enemyId)).toHaveLength(0);
    }
  });

  it("IT-CAP-TATIANA-OMEN-PROD-002: the debuffed target's next attack drops its outgoing multiplier to 0 (final damage held at the R-DMG-02 floor of 1) and the debuff expires on that NEXT_OUTGOING_ATTACK consumption, while an undebuffed target of the same resolution is unaffected", () => {
    const context = setup([0, 2]);
    const undebuffed = enemyAt(context, 0);
    const debuffed = enemyAt(context, 1);
    const afterEx = fireEx(context).result.units;
    expect(debuffsOf(afterEx, debuffed)).toHaveLength(1);
    expect(debuffsOf(afterEx, undebuffed)).toHaveLength(0);

    // 対照: デバフを持たない対象の同一攻撃は通常どおりHPを削る。
    const control = fireEnemyAttack(context, afterEx, undebuffed);
    expect(control.damageApplied).toHaveLength(1);
    const controlDamage = (control.damageApplied[0]?.payload as { hitPointDamage: number })
      .hitPointDamage;
    expect(controlDamage).toBeGreaterThan(0);

    // デバフ保持者の「次の攻撃」は与ダメージ倍率が0まで落ちる。
    // raw原文の「与ダメージを100％減少」はここで完全に効いており、丸め前ダメージは0。
    // ただし最終ダメージはR-DMG-02（最終化）#3「計算結果が1未満の場合も1とする」という
    // 全体不変条件（`07_戦闘ルール詳細.md`冒頭「スキル・効果定義による個別指定は
    // ……最低1ダメージ……を、明示的に上書きを許可した仕様がない限り変更しない」）に
    // よって1へ引き上げられる — `APPLY_DAMAGE_MOD`はこの上書きを宣言していない。
    // Issue #225本文は「0ダメージになり」と書いているが、より詳細なR-DMG-02が優先する。
    const nullified = fireEnemyAttack(context, control.result.units, debuffed);
    expect(nullified.damageApplied).toHaveLength(1);
    const calculated = nullified.emitted.find((event) => event.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      outgoingDamageMultiplier: 0,
      preTruncationDamage: 0,
    });
    expect((nullified.damageApplied[0]?.payload as { hitPointDamage: number }).hitPointDamage).toBe(
      1,
    );

    // R-EFF-07: `NEXT_OUTGOING_ATTACK`はその攻撃で消費され、効果は失効する。
    expect(debuffsOf(nullified.result.units, debuffed)).toHaveLength(0);
    expect(
      nullified.emitted.some(
        (event) =>
          event.eventType === "EffectExpired" &&
          (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
            DEBUFF_ACTION_ID,
      ),
    ).toBe(true);

    // 失効後のさらに次の攻撃は、対照と同じ通常ダメージへ戻る。
    const restored = fireEnemyAttack(context, nullified.result.units, debuffed);
    expect((restored.damageApplied[0]?.payload as { hitPointDamage: number }).hitPointDamage).toBe(
      controlDamage,
    );
  });

  it("IT-CAP-TATIANA-OMEN-PROD-003: the mixed resolution emits per-target EffectApplied/Marker events under one action, each carrying a StateDelta with a monotonic stateVersion and the same root causality", () => {
    const context = setup([0, 1, 2, 3]);
    const noOmen = enemyAt(context, 0);
    const belowThreshold = enemyAt(context, 1);
    const atThreshold = enemyAt(context, 2);
    const aboveThreshold = enemyAt(context, 3);
    const { emitted } = fireEx(context);

    const debuffApplied = emitted.filter(
      (event) =>
        event.eventType === "EffectApplied" &&
        (event.payload as { effectActionDefinitionId?: string }).effectActionDefinitionId ===
          DEBUFF_ACTION_ID,
    );
    expect(
      debuffApplied.map((event) => (event.payload as { targetUnitId: string }).targetUnitId).sort(),
    ).toEqual([atThreshold, aboveThreshold].sort());

    const markerTargets = emitted
      .filter((event) => event.eventType === "MarkerApplied" || event.eventType === "MarkerUpdated")
      .map((event) => (event.payload as { targetUnitId: string }).targetUnitId);
    expect(markerTargets.sort()).toEqual([noOmen, belowThreshold].sort());

    const damaged = emitted
      .filter((event) => event.eventType === "DamageApplied")
      .map((event) => (event.payload as { targetUnitId: string }).targetUnitId);
    expect(damaged.sort()).toEqual([...context.enemyIds].sort());

    // 同じ解決スコープ・同じrootの因果木に属する。
    const root = emitted[0]!;
    expect(root.parentEventId).toBeUndefined();
    for (const event of emitted) {
      expect(event.resolutionScopeId).toBe(context.resolutionScopeId);
      expect(event.rootEventId).toBe(root.eventId);
      if (event !== root) {
        expect(event.parentEventId).toBeDefined();
      }
    }

    // stateVersion（`n`）はStateDeltaを伴うイベントでだけ1増える。
    let expectedVersion = emitted[0]!.stateVersionBefore;
    for (const event of emitted) {
      expect(event.stateVersionBefore).toBe(expectedVersion);
      expectedVersion = event.stateDelta === undefined ? expectedVersion : expectedVersion + 1;
      expect(event.stateVersionAfter).toBe(expectedVersion);
    }
    expect(debuffApplied.every((event: BattleDomainEvent) => event.stateDelta !== undefined)).toBe(
      true,
    );
  });

  it("IT-CAP-TATIANA-OMEN-PROD-004: replaying only the StateDeltas of the mixed resolution onto the pre-action snapshot restores the post-action state, debuff metadata and Omen stacks included", () => {
    const context = setup([0, 1, 2, 3]);
    const initial = snapshotOf(context.units);
    const { result, emitted } = fireEx(context);

    const restored = reduceStateDeltas(
      initial,
      emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(restored).toEqual(snapshotOf(result.units));

    const noOmen = enemyAt(context, 0);
    const belowThreshold = enemyAt(context, 1);
    const atThreshold = enemyAt(context, 2);
    expect(
      restored.units[atThreshold]?.effects?.filter(
        (effect) => effect.effectDefinitionId === DEBUFF_ACTION_ID,
      ),
    ).toHaveLength(1);
    expect(
      restored.units[atThreshold]?.effects?.find(
        (effect) => effect.effectDefinitionId === DEBUFF_ACTION_ID,
      )?.damageModifier,
    ).toEqual({ direction: "OUTGOING", damageType: null });
    expect(
      restored.units[belowThreshold]?.markers?.find((marker) => marker.markerId === MARKER_ID)
        ?.stackCount,
    ).toBe(2);
    expect(
      restored.units[noOmen]?.markers?.find((marker) => marker.markerId === MARKER_ID)?.stackCount,
    ).toBe(1);
  });

  it("IT-CAP-TATIANA-OMEN-PROD-005: the production definitions this branch relies on are still the unapproximated raw-text ones (damage power, -100% OUTGOING modifier, single Omen stack)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([TATIANA_UNIT_ID as never], []);

    const damage = snapshot.effectActions.get(DAMAGE_ACTION_ID as never)!;
    expect(damage.kind).toBe("DAMAGE");
    if (damage.kind !== "DAMAGE") {
      throw new Error("unreachable");
    }
    expect(damage.payload.damageType).toBe("EN");
    expect(damage.payload.formula).toEqual({ kind: "SKILL_POWER", power: 1.696 });

    const debuff = snapshot.effectActions.get(DEBUFF_ACTION_ID as never)!;
    expect(debuff.kind).toBe("APPLY_DAMAGE_MOD");
    if (debuff.kind !== "APPLY_DAMAGE_MOD") {
      throw new Error("unreachable");
    }
    expect(debuff.payload.direction).toBe("OUTGOING");
    expect(debuff.payload.damageType).toBeNull();
    expect(debuff.payload.formula).toEqual({ kind: "CONSTANT", value: -1 });
    expect(debuff.payload.condition).toBeUndefined();
    expect(debuff.payload.duration.consumption).toEqual({
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
    });
    expect([...debuff.requiredCapabilities]).toEqual(["CAP_DAMAGE_MOD"]);

    const mark = snapshot.effectActions.get(MARK_ACTION_ID as never)!;
    expect(mark.kind).toBe("APPLY_MARKER");
    if (mark.kind !== "APPLY_MARKER") {
      throw new Error("unreachable");
    }
    expect(mark.payload.markerId).toBe(MARKER_ID);
    expect(mark.payload.stack).toEqual({ policy: "ADD", max: null });
  });
});
