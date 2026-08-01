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
import { toEffectSnapshot, toMarkerSnapshot } from "../../domain/battle/events/state-delta.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import {
  createMarkerId,
  createUnitDefinitionId,
  type MarkerId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-015（Issue #269、`CAP_MARKER_STACK_FORMULA`）: Marker所持数を参照する
 * Formula `MARKER_COUNT_SCALE`（R-NUM-04「評価時点の`MarkerState.stackCount`を
 * 参照する」）が実ライフサイクルへ配線されていることを、実`catalog/`の3定義を
 * 無改変のまま実`resolveSkillUse`へ通して固定する。
 *
 * `EFF-004`（Issue #160）はMarker本体（付与・スタック・失効・カスケード）だけを
 * 実装してcloseし、このFormulaの検証を持たないまま`CAP_MARKER_STACK_FORMULA`を
 * `PLANNED`で残していた。M7-010（Issue #177、監査）がその所有者不在を検出し、
 * 本Issueが引き継いだ。
 *
 * production使用は次の2経路に分かれ、両方を実際の解決から確認する。
 * - `APPLY_STAT_MOD.payload.formula`（`target: SKILL_SOURCE`）:
 *   `ACT_CHIYURU_NEWYEAR_AS1_ATK_UP` / `ACT_CHIYURU_NEWYEAR_AS1_DEF_UP`
 * - `DAMAGE.payload.damageModifiers[]`（`target: TARGET`、R-DMG-01の
 *   Action内追加ダメージ倍率）: `ACT_KARINA_DOWNER_AS1_DAMAGE` /
 *   `ACT_FEE_BATH_AS2_DAMAGE`
 *
 * Issue #269本文は「対象3Unitはいずれも他のM8 Capabilityでも非selectableのまま」と
 * 書いているが、これは監査時点（2026-07-29）の観測である。その後
 * `CAP_DAMAGE_MOD`（`DMG-002`／#192）・`CAP_SHIELD`（`DMG-004`／#194）・
 * `CAP_CONTINUOUS_DAMAGE`（`DMG-008`／#189）が実装され、本Capabilityの完了で
 * `UNIT_CHIYURU_NEWYEAR`・`UNIT_FEE_BATH`は実際に`selectable`になる
 * （`UNIT_KARINA_DOWNER`だけは`CAP_COVER_DAMAGE`・`CAP_TARGET_REDIRECT`で
 * 非selectableのまま）。件数の追跡は`m7-completion-audit.test.ts`が担い、
 * ここで固定するのはFormula評価の実配線そのものである。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const CHIYURU_UNIT_ID = "UNIT_CHIYURU_NEWYEAR";
const CHIYURU_AS1_ID = "SKL_CHIYURU_NEWYEAR_AS1";
const CHIYURU_ATK_UP_ID = "ACT_CHIYURU_NEWYEAR_AS1_ATK_UP";
const CHIYURU_DEF_UP_ID = "ACT_CHIYURU_NEWYEAR_AS1_DEF_UP";
const MOCHI_MARKER_ID = "MARKER_CHIYURU_NEWYEAR_MOCHI";

const KARINA_UNIT_ID = "UNIT_KARINA_DOWNER";
const KARINA_AS1_ID = "SKL_KARINA_DOWNER_AS1";
const KARINA_DAMAGE_ID = "ACT_KARINA_DOWNER_AS1_DAMAGE";
const KEIBO_MARKER_ID = "MARKER_KEIBO";

const FEE_UNIT_ID = "UNIT_FEE_BATH";
const FEE_AS2_ID = "SKL_FEE_BATH_AS2";
const FEE_DAMAGE_ID = "ACT_FEE_BATH_AS2_DAMAGE";
const FEE_MARKER_ACTION_ID = "ACT_FEE_BATH_AS2_MARKER";
const FLUSH_MARKER_ID = "MARKER_FEE_BATH_FLUSH";

const ENEMY_UNIT_ID = "UNIT_TEST_MARKER_SCALE_ENEMY";
const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

/** 会心・MISSのゆらぎを排して、Marker所持数だけがダメージ差の原因になるようにする。 */
function noMissNoCrit(): SequenceRandomSource {
  return new SequenceRandomSource(new Array(512).fill(0.99));
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
      maximumHp: 100000,
      attack: 1000,
      defense: 500,
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
      maximumHp: 100000,
      attack: 1000,
      defense: 500,
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
 * `captureBattleState`と同じ射影のうち、この解決が実際に動かすfieldだけを組み立てる。
 * `SKL_CHIYURU_NEWYEAR_AS1`はクールタイム99ターンを持つため`cooldowns`まで含める
 * （`reduceStateDeltas`側は`CooldownStarted`のStateDeltaでこれを復元する）。
 */
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
          ...(Object.keys(unit.cooldowns).length > 0 ? { cooldowns: unit.cooldowns } : {}),
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

const ENEMY_POSITIONS: readonly FormationPosition[] = [
  { column: "LEFT", row: "FRONT" },
  { column: "CENTER", row: "FRONT" },
  { column: "RIGHT", row: "FRONT" },
  { column: "LEFT", row: "BACK" },
];

/** `applyMarker`へ渡す1件分の事前スタック指定。 */
interface PreStack {
  /** 味方（スキル使用者）へ積むなら`"ACTOR"`、敵へ積むならその添字。 */
  readonly holder: "ACTOR" | number;
  readonly markerId: string;
  readonly stacks: number;
  /** `APPLY_MARKER`のstack上限。実production定義と同じ値を渡す。 */
  readonly stackMax: number | null;
}

/**
 * 実Catalogのスキル使用者と、`enemyCount`体の敵を用意し、`preStacks`のMarkerを
 * 実`applyMarker`（`stack.policy: ADD`）で事前に積む。事前スタックも production の
 * `APPLY_MARKER`と同じ経路で作るため、前ターンまでに実際に積まれた状態そのものになる。
 */
function setup(options: {
  readonly unitDefinitionIds: readonly string[];
  readonly actorUnitDefinitionId: string;
  readonly skillDefinitionId: string;
  readonly enemyCount: number;
  readonly preStacks?: readonly PreStack[];
}) {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot(options.unitDefinitionIds as never[], []);
  const skill = snapshot.skills.get(options.skillDefinitionId as never)!;

  const actor: BattleUnit = {
    ...createBattleUnit(
      member("ally:actor", options.actorUnitDefinitionId, "ALLY", {
        column: "CENTER",
        row: "FRONT",
      }),
      "ALLY",
      LIMITS,
    ),
    currentAp: LIMITS.maximumAp,
    currentExtraGauge: LIMITS.maximumExtraGauge,
  };
  const enemies = Array.from({ length: options.enemyCount }, (_, index) => ({
    ...createBattleUnit(
      member(`enemy:${index}`, ENEMY_UNIT_ID, "ENEMY", ENEMY_POSITIONS[index]!),
      "ENEMY",
      LIMITS,
    ),
    currentAp: LIMITS.maximumAp,
    currentExtraGauge: LIMITS.maximumExtraGauge,
  }));

  const unitDefinitions = new Map(snapshot.units);
  unitDefinitions.set(createUnitDefinitionId(ENEMY_UNIT_ID), testUnitDefinition(ENEMY_UNIT_ID));
  const definitions: BattleDefinitions = {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions: new Map(snapshot.skills),
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

  let units: readonly BattleUnit[] = [actor, ...enemies];
  let lastEventId = seed.eventId;
  for (const preStack of options.preStacks ?? []) {
    const holderId =
      preStack.holder === "ACTOR" ? actor.battleUnitId : enemies[preStack.holder]!.battleUnitId;
    for (let i = 0; i < preStack.stacks; i += 1) {
      const grant = applyMarker(
        { recorder, turnNumber: 1, cycleNumber: 1, resolutionScopeId, rootEventId: seed.eventId },
        units,
        {
          markerId: createMarkerId(preStack.markerId),
          sourceId: actor.battleUnitId,
          targetId: holderId,
          stackPolicy: "ADD",
          stackMax: preStack.stackMax,
          durationDefinition: {
            dispellable: true,
            linkedEffectGroupId: null,
            timeLimit: { unit: "BATTLE", count: 1 },
          },
        },
        lastEventId,
      );
      units = grant.units;
      lastEventId = grant.lastEventId;
    }
  }

  return {
    skill,
    definitions,
    recorder,
    resolutionScopeId,
    units,
    actorId: actor.battleUnitId,
    enemyIds: enemies.map((enemy) => enemy.battleUnitId),
  };
}

/** `setup`が並べた順（`preStacks`の`holder`添字と同じ）で敵IDを取り出す。 */
function enemyAt(setupResult: ReturnType<typeof setup>, index: number): BattleUnitId {
  const battleUnitId = setupResult.enemyIds[index];
  if (battleUnitId === undefined) {
    throw new Error(`enemy ${index} is missing`);
  }
  return battleUnitId;
}

function unitOf(units: readonly BattleUnit[], battleUnitId: BattleUnitId): BattleUnit {
  return units.find((unit) => unit.battleUnitId === battleUnitId)!;
}

function stackCountOf(
  units: readonly BattleUnit[],
  battleUnitId: BattleUnitId,
  markerId: string,
): number {
  return (
    unitOf(units, battleUnitId).markerStates.find(
      (marker) => marker.markerId === (markerId as MarkerId),
    )?.stackCount ?? 0
  );
}

function fireSkill(setupResult: ReturnType<typeof setup>, skillType: "AS" | "EX" = "AS") {
  const { recorder, resolutionScopeId, units, definitions, skill, actorId } = setupResult;
  const eventsBefore = recorder.getEvents().length;
  const result = resolveSkillUse(
    unitOf(units, actorId),
    skill,
    skillType,
    skillType,
    units,
    definitions,
    noMissNoCrit(),
    recorder,
    1,
    1,
    recorder.nextActionId(),
    resolutionScopeId,
  );
  return { result, emitted: recorder.getEvents().slice(eventsBefore) };
}

/** `DamageCalculated`をヒット順に、対象ごとに取り出す。 */
function damageCalculationsOf(
  emitted: readonly { readonly eventType: string; readonly payload: unknown }[],
  targetUnitId: BattleUnitId,
) {
  return emitted
    .filter((event) => event.eventType === "DamageCalculated")
    .map((event) => event.payload as { targetUnitId: string; actionDamageMultiplier: number })
    .filter((payload) => payload.targetUnitId === targetUnitId);
}

function magnitudeOf(
  units: readonly BattleUnit[],
  battleUnitId: BattleUnitId,
  effectActionDefinitionId: string,
): number | undefined {
  return unitOf(units, battleUnitId).appliedEffects.find(
    (effect) => effect.effectActionDefinitionId === effectActionDefinitionId,
  )?.magnitude;
}

describe("production Catalog MARKER_COUNT_SCALE (M7-015, Issue #269, R-NUM-04)", () => {
  it.each([
    { mochi: 0, attackRatio: 0, defenseRatio: 0 },
    { mochi: 1, attackRatio: 0.03, defenseRatio: 0.06 },
    { mochi: 5, attackRatio: 0.15, defenseRatio: 0.3 },
    { mochi: 6, attackRatio: 0.18, defenseRatio: 0.36 },
  ])(
    "IT-CAP-MARKER-STACK-PROD-001: SKL_CHIYURU_NEWYEAR_AS1 scales its own ATTACK/DEFENSE buffs by the $mochi 「お餅」 the SKILL_SOURCE holds and recalculates the combat stats accordingly",
    ({ mochi, attackRatio, defenseRatio }) => {
      const context = setup({
        unitDefinitionIds: [CHIYURU_UNIT_ID],
        actorUnitDefinitionId: CHIYURU_UNIT_ID,
        skillDefinitionId: CHIYURU_AS1_ID,
        enemyCount: 1,
        // `ACT_CHIYURU_NEWYEAR_EX_MOCHI`/`_PS1_MOCHI`の実stack上限（6）で積む。
        preStacks: [{ holder: "ACTOR", markerId: MOCHI_MARKER_ID, stacks: mochi, stackMax: 6 }],
      });
      expect(stackCountOf(context.units, context.actorId, MOCHI_MARKER_ID)).toBe(mochi);

      const units = fireSkill(context).result.units;

      // raw原文「付与されている「お餅」1つにつき、自身の攻撃力を3%、防御力を6%
      // 上昇させる（最大6つまで）」がそのまま`perStack`/`max`になっている。
      expect(magnitudeOf(units, context.actorId, CHIYURU_ATK_UP_ID)).toBeCloseTo(attackRatio, 10);
      expect(magnitudeOf(units, context.actorId, CHIYURU_DEF_UP_ID)).toBeCloseTo(defenseRatio, 10);

      // 評価結果は`AppliedEffect.magnitude`に留まらず、実際のCombatStatへ届く。
      // R-NUM-02の整数化はダメージ側の責務であり、CombatStat自体は丸めないため
      // ここは近似比較にする（`500 × 1.36`は倍精度で679.9999999999999になる）。
      const actor = unitOf(units, context.actorId);
      expect(actor.combatStats.attack).toBeCloseTo(1000 * (1 + attackRatio), 10);
      expect(actor.combatStats.defense).toBeCloseTo(500 * (1 + defenseRatio), 10);
    },
  );

  it("IT-CAP-MARKER-STACK-PROD-002: one SKL_KARINA_DOWNER_AS1 AOE resolution gives each enemy its own Action damage multiplier from that enemy's own 「警棒」 stacks, and ignores a different markerId held by the same target", () => {
    const context = setup({
      // `MARKER_FEE_BATH_FLUSH`を対照として使うため、実在するもう1Unit分の
      // 定義も同じsnapshotへ読み込む（Karina側の定義は一切変えない）。
      unitDefinitionIds: [KARINA_UNIT_ID, FEE_UNIT_ID],
      actorUnitDefinitionId: KARINA_UNIT_ID,
      skillDefinitionId: KARINA_AS1_ID,
      enemyCount: 4,
      preStacks: [
        // `ACT_KARINA_DOWNER_PS1_MARK_ATTACKER`の実stack上限（3）で積む。
        { holder: 1, markerId: KEIBO_MARKER_ID, stacks: 2, stackMax: 3 },
        { holder: 2, markerId: KEIBO_MARKER_ID, stacks: 3, stackMax: 3 },
        // 不成立ケース: 別のMarkerを3つ持っていても「警棒」ではないため寄与しない。
        { holder: 3, markerId: FLUSH_MARKER_ID, stacks: 3, stackMax: null },
      ],
    });
    const [noMarker, twoStacks, threeStacks, otherMarker] = [0, 1, 2, 3].map((index) =>
      enemyAt(context, index),
    ) as [BattleUnitId, BattleUnitId, BattleUnitId, BattleUnitId];

    const { result, emitted } = fireSkill(context);

    // raw原文「対象に付与されている「警棒」1つにつき15%増加する(最大3つまで)」。
    // R-DMG-01のAction内追加ダメージ倍率は`1 + 補正合計`。
    expect(damageCalculationsOf(emitted, noMarker).map((p) => p.actionDamageMultiplier)).toEqual([
      1,
    ]);
    expect(damageCalculationsOf(emitted, twoStacks).map((p) => p.actionDamageMultiplier)).toEqual([
      1.3,
    ]);
    expect(damageCalculationsOf(emitted, threeStacks).map((p) => p.actionDamageMultiplier)).toEqual(
      [1.45],
    );
    expect(damageCalculationsOf(emitted, otherMarker).map((p) => p.actionDamageMultiplier)).toEqual(
      [1],
    );

    // 倍率の差は実際のHP減少差として現れる（同一解決・同一攻撃者・同一防御力）。
    const dealt = (targetId: BattleUnitId): number =>
      unitOf(context.units, targetId).currentHp - unitOf(result.units, targetId).currentHp;
    expect(dealt(twoStacks)).toBeGreaterThan(dealt(noMarker));
    expect(dealt(threeStacks)).toBeGreaterThan(dealt(twoStacks));
    expect(dealt(otherMarker)).toBe(dealt(noMarker));
  });

  it("IT-CAP-MARKER-STACK-PROD-003: SKL_FEE_BATH_AS2 reads the target's 「ほてり」 count once per hit before its own APPLY_MARKER runs, and clamps at the Formula's max even though the Marker itself has no stack limit", () => {
    const context = setup({
      unitDefinitionIds: [FEE_UNIT_ID],
      actorUnitDefinitionId: FEE_UNIT_ID,
      skillDefinitionId: FEE_AS2_ID,
      enemyCount: 1,
      // `MARKER_FEE_BATH_FLUSH`は`stack.max: null`なので、Formulaの`max`が
      // 唯一の上限になる（5つ相当で+100%）。7つはその超過側の境界。
      preStacks: [{ holder: 0, markerId: FLUSH_MARKER_ID, stacks: 7, stackMax: null }],
    });
    const target = enemyAt(context, 0);

    const { result, emitted } = fireSkill(context);

    // 3ヒットとも、このスキル自身が後段で1つ足す前の7つを読む
    // （`0.2 × 7 = 1.4`はFormulaの`max: 1.0`で頭打ち → 倍率2.0）。
    expect(damageCalculationsOf(emitted, target).map((p) => p.actionDamageMultiplier)).toEqual([
      2, 2, 2,
    ]);
    // `ACT_FEE_BATH_AS2_MARKER`は同じstepの後段で確かに1つ積んでいる。
    expect(stackCountOf(result.units, target, FLUSH_MARKER_ID)).toBe(8);
  });

  it("IT-CAP-MARKER-STACK-PROD-004: the 「ほてり」-scaled resolution emits DamageCalculated/DamageApplied under one root with a monotonic stateVersion, and a stack count below the cap yields a strictly smaller multiplier", () => {
    const belowCap = setup({
      unitDefinitionIds: [FEE_UNIT_ID],
      actorUnitDefinitionId: FEE_UNIT_ID,
      skillDefinitionId: FEE_AS2_ID,
      enemyCount: 1,
      preStacks: [{ holder: 0, markerId: FLUSH_MARKER_ID, stacks: 2, stackMax: null }],
    });
    const target = enemyAt(belowCap, 0);
    const { emitted } = fireSkill(belowCap);

    expect(damageCalculationsOf(emitted, target).map((p) => p.actionDamageMultiplier)).toEqual([
      1.4, 1.4, 1.4,
    ]);
    expect(emitted.filter((event) => event.eventType === "DamageApplied")).toHaveLength(3);

    // 同じ解決スコープ・同じrootの因果木に属する。
    const root = emitted[0]!;
    expect(root.parentEventId).toBeUndefined();
    for (const event of emitted) {
      expect(event.resolutionScopeId).toBe(belowCap.resolutionScopeId);
      expect(event.rootEventId).toBe(root.eventId);
      if (event !== root) {
        expect(event.parentEventId).toBeDefined();
      }
    }

    // stateVersionはStateDeltaを伴うイベントでだけ1増える。
    let expectedVersion = root.stateVersionBefore;
    for (const event of emitted) {
      expect(event.stateVersionBefore).toBe(expectedVersion);
      expectedVersion = event.stateDelta === undefined ? expectedVersion : expectedVersion + 1;
      expect(event.stateVersionAfter).toBe(expectedVersion);
    }
  });

  it("IT-CAP-MARKER-STACK-PROD-005: replaying only the StateDeltas of both MARKER_COUNT_SCALE paths onto the pre-action snapshot restores the post-action state, scaled stat-mod magnitudes and scaled damage included", () => {
    for (const context of [
      setup({
        unitDefinitionIds: [CHIYURU_UNIT_ID],
        actorUnitDefinitionId: CHIYURU_UNIT_ID,
        skillDefinitionId: CHIYURU_AS1_ID,
        enemyCount: 1,
        preStacks: [{ holder: "ACTOR", markerId: MOCHI_MARKER_ID, stacks: 4, stackMax: 6 }],
      }),
      setup({
        unitDefinitionIds: [FEE_UNIT_ID],
        actorUnitDefinitionId: FEE_UNIT_ID,
        skillDefinitionId: FEE_AS2_ID,
        enemyCount: 1,
        preStacks: [{ holder: 0, markerId: FLUSH_MARKER_ID, stacks: 3, stackMax: null }],
      }),
    ]) {
      const initial = snapshotOf(context.units);
      const { result, emitted } = fireSkill(context);

      const restored = reduceStateDeltas(
        initial,
        emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      );
      expect(restored).toEqual(snapshotOf(result.units));
    }

    // 復元後のスナップショットが、スケール済みの`magnitude`をそのまま保持する。
    const chiyuru = setup({
      unitDefinitionIds: [CHIYURU_UNIT_ID],
      actorUnitDefinitionId: CHIYURU_UNIT_ID,
      skillDefinitionId: CHIYURU_AS1_ID,
      enemyCount: 1,
      preStacks: [{ holder: "ACTOR", markerId: MOCHI_MARKER_ID, stacks: 4, stackMax: 6 }],
    });
    const initial = snapshotOf(chiyuru.units);
    const { emitted } = fireSkill(chiyuru);
    const restored = reduceStateDeltas(
      initial,
      emitted.flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    expect(
      restored.units[chiyuru.actorId]?.effects?.find(
        (effect) => effect.effectDefinitionId === CHIYURU_ATK_UP_ID,
      )?.magnitude,
    ).toBeCloseTo(0.12, 10);
    expect(
      restored.units[chiyuru.actorId]?.markers?.find(
        (marker) => marker.markerId === MOCHI_MARKER_ID,
      )?.stackCount,
    ).toBe(4);
  });

  it("IT-CAP-MARKER-STACK-PROD-006: the three production definitions are still the unapproximated raw-text ones and each declares CAP_MARKER_STACK_FORMULA", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(
      [CHIYURU_UNIT_ID, KARINA_UNIT_ID, FEE_UNIT_ID] as never[],
      [],
    );

    // 自身の「お餅」1つにつき攻撃力+3%／防御力+6%、最大6つまで。
    for (const [id, perStack, max] of [
      [CHIYURU_ATK_UP_ID, 0.03, 0.18],
      [CHIYURU_DEF_UP_ID, 0.06, 0.36],
    ] as const) {
      const statMod = snapshot.effectActions.get(id as never)!;
      expect(statMod.kind).toBe("APPLY_STAT_MOD");
      if (statMod.kind !== "APPLY_STAT_MOD") {
        throw new Error("unreachable");
      }
      expect(statMod.payload.valueType).toBe("RATIO");
      expect(statMod.payload.formula).toEqual({
        kind: "MARKER_COUNT_SCALE",
        target: { kind: "SKILL_SOURCE" },
        markerId: MOCHI_MARKER_ID,
        perStack,
        max,
      });
      expect([...statMod.requiredCapabilities]).toContain("CAP_MARKER_STACK_FORMULA");
    }

    // 対象の「警棒」1つにつき+15%、最大3つまで／「ほてり」1つにつき+20%、最大5つ相当。
    for (const [id, markerId, perStack, max] of [
      [KARINA_DAMAGE_ID, KEIBO_MARKER_ID, 0.15, 0.45],
      [FEE_DAMAGE_ID, FLUSH_MARKER_ID, 0.2, 1],
    ] as const) {
      const damage = snapshot.effectActions.get(id as never)!;
      expect(damage.kind).toBe("DAMAGE");
      if (damage.kind !== "DAMAGE") {
        throw new Error("unreachable");
      }
      expect(damage.payload.damageModifiers).toEqual([
        {
          kind: "MARKER_COUNT_SCALE",
          target: { kind: "TARGET" },
          markerId,
          perStack,
          max,
        },
      ]);
      expect([...damage.requiredCapabilities]).toContain("CAP_MARKER_STACK_FORMULA");
    }

    // Formulaが読むMarkerを積む側の実定義。Karina/Chiyuruは`stack.max`が
    // Formulaの`max`と同じ所持数（3個・6個）で揃っており、Feeだけが
    // `stack.max: null`（上限はFormula側だけが持つ）である。
    const feeMarker = snapshot.effectActions.get(FEE_MARKER_ACTION_ID as never)!;
    expect(feeMarker.kind).toBe("APPLY_MARKER");
    if (feeMarker.kind !== "APPLY_MARKER") {
      throw new Error("unreachable");
    }
    expect(feeMarker.payload.markerId).toBe(FLUSH_MARKER_ID);
    expect(feeMarker.payload.stack).toEqual({ policy: "ADD", max: null });
  });
});
