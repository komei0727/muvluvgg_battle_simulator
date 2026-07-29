import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { grantStunStatus } from "../../domain/battle/effects/stun-grant-service.js";
import { grantFreezeStatus } from "../../domain/battle/effects/freeze-grant-service.js";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";

/**
 * M7-011（Issue #265、`EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）:
 * 「敵にデバフが付与された際」「敵に状態異常が付与された際」のように、付与
 * された効果の**分類**を発動契機にするPSを、実際の`EffectApplied`発行元
 * （`effect-grant-service.ts`）が運ぶ分類payload（`effectKind`/`categories`、
 * および既存の`statusKind`）で判定できることを、未改変のproduction Catalog
 * 定義で検証する。
 *
 * それまでは`EffectApplied`のpayloadに分類情報が無く、
 * `SKL_KEI_JACKKNIFE_PS2`/`SKL_LILY_SINGER_PS1`/`SKL_SIENA_DIVA_PS1`
 * （および台帳外の`SKL_KATE_PALADIN_PS1`/`SKL_MEIYA_FATED_PS1`）の
 * trigger conditionは存在しないフィールドを参照して恒常的に不成立、
 * `SKL_URUU_TIMID_PS3`/`SKL_NADYA_SUCCESSOR_PS1`/`PS2`は条件自体を持たず
 * 「何らかの効果が付与された際」へ近似していた
 * （`docs/ddd/15_Unit_Memory変換台帳.md`）。
 *
 * `CAP_DAMAGE_MOD`（M8/DMG-002）・`CAP_SUBUNIT`（M8/DMG-005）・
 * `CAP_SHIELD`（M8/DMG-004）へ依存するPSは、候補検出（trigger一致）までを
 * 検証範囲とする — EffectSequenceの完全解決はそれらのEffectActionが未実装で
 * あり、本Issueのスコープ外だからである。`SKL_KEI_JACKKNIFE_PS2`だけは
 * `DAMAGE`のみで構成されるため、PS発動・ダメージ適用まで通す。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const TEST_ALLY_UNIT_ID = "UNIT_TEST_CLASSIFICATION_ALLY";
const TEST_ENEMY_UNIT_ID = "UNIT_TEST_CLASSIFICATION_ENEMY";

const SPEED_DOWN_DEBUFF = "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN";
const ATTACK_UP_BUFF = "ACT_SIENA_DIVA_PS1_ATK_UP";
const STUN = "ACT_SIENA_DIVA_PS1_STUN";
const FREEZE = "ACT_KATE_PALADIN_EX_FREEZE";
const STEALTH = "ACT_MAO_COMMITTEE_PS2_STEALTH";

/** 分類payloadを持つ`EffectApplied`を実際に発行する全ユニットのCatalog。 */
const CATALOG_UNIT_IDS = [
  "UNIT_KEI_JACKKNIFE",
  "UNIT_LILY_SINGER",
  "UNIT_SIENA_DIVA",
  "UNIT_URUU_TIMID",
  "UNIT_NADYA_SUCCESSOR",
  "UNIT_KATE_PALADIN",
  "UNIT_MEIYA_FATED",
  "UNIT_MAO_COMMITTEE",
];

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
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
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
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
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

function loadProductionSnapshot(): ReturnType<
  ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]
> {
  return loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(CATALOG_UNIT_IDS as never[], []);
}

function unitDefinitionsWithTestUnits(
  snapshot: ReturnType<typeof loadProductionSnapshot>,
): Map<UnitDefinition["unitDefinitionId"], UnitDefinition> {
  const unitDefinitions = new Map(snapshot.units);
  for (const id of [TEST_ALLY_UNIT_ID, TEST_ENEMY_UNIT_ID]) {
    unitDefinitions.set(createUnitDefinitionId(id), testUnitDefinition(id));
  }
  return unitDefinitions;
}

/**
 * production `EffectActionDefinition`を実際の付与サービスへ通し、そこから
 * 発行された本物の`EffectApplied`をtrigger候補イベントとして返す
 * （payloadを手書きしない — 分類payloadの生成そのものが検証対象のため）。
 */
function emitEffectApplied(
  snapshot: ReturnType<typeof loadProductionSnapshot>,
  effectActionDefinitionId: string,
  source: BattleUnit,
  target: BattleUnit,
  units: readonly BattleUnit[],
  magnitude = 0,
  into?: { readonly recorder: EventRecorder; readonly parent: BattleDomainEvent },
): {
  event: TriggerCandidateEvent;
  applied: BattleDomainEvent;
  units: readonly BattleUnit[];
} {
  const definition: EffectActionDefinition | undefined = snapshot.effectActions.get(
    effectActionDefinitionId as never,
  );
  expect(
    definition,
    `${effectActionDefinitionId} must exist in the production Catalog`,
  ).toBeDefined();
  // `into`を渡すと、PS発動まで通すテストが使う本番同等のイベント連鎖
  // （`ActionStarted`配下）へそのまま記録する。省略時は候補検出だけを見る
  // ための独立したrecorderで発行する。
  const recorder = into?.recorder ?? new EventRecorder(createBattleId("B_1"));
  const parent =
    into?.parent ??
    recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
  const context = {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    ...(parent.actionId !== undefined ? { actionId: parent.actionId } : {}),
    resolutionScopeId: parent.resolutionScopeId,
    rootEventId: parent.rootEventId ?? parent.eventId,
  };
  const request = {
    definition: definition!,
    sourceId: source.battleUnitId,
    targetId: target.battleUnitId,
    duplicate: true,
    magnitude,
    ...(definition!.kind === "APPLY_STATUS" ? { statusKind: definition!.payload.status } : {}),
    durationDefinition:
      definition!.kind === "APPLY_STATUS" || definition!.kind === "APPLY_STAT_MOD"
        ? definition!.payload.duration
        : { dispellable: true, linkedEffectGroupId: null },
  };
  const granted =
    definition!.kind === "APPLY_STATUS" && definition!.payload.status === "STUN"
      ? grantStunStatus(context, units, request, parent.eventId)
      : definition!.kind === "APPLY_STATUS" && definition!.payload.status === "FREEZE"
        ? grantFreezeStatus(context, units, request, parent.eventId)
        : grantEffect(context, units, request, parent.eventId);

  const applied = recorder
    .getEvents()
    .find((e) => e.eventId === granted.lastEventId && e.eventType === "EffectApplied");
  expect(applied, "the real grant service must emit an EffectApplied").toBeDefined();
  return {
    event: {
      eventType: applied!.eventType,
      category: "FACT",
      ...(applied!.sourceUnitId !== undefined ? { sourceUnitId: applied!.sourceUnitId } : {}),
      ...(applied!.targetUnitIds !== undefined ? { targetUnitIds: applied!.targetUnitIds } : {}),
      payload: applied!.payload,
    },
    applied: applied!,
    units: granted.units,
  };
}

function candidateSkillIds(
  snapshot: ReturnType<typeof loadProductionSnapshot>,
  event: TriggerCandidateEvent,
  units: readonly BattleUnit[],
): readonly string[] {
  return detectPassiveCandidates({
    event,
    units,
    unitDefinitions: unitDefinitionsWithTestUnits(snapshot),
    skillDefinitions: snapshot.skills,
    activationGuard: createEmptyPassiveActivationGuard(),
  }).map((candidate) => candidate.skillDefinition.skillDefinitionId as string);
}

function owner(unitDefinitionId: string, battleUnitId: string, side: Side): BattleUnit {
  return {
    ...createBattleUnit(
      member(battleUnitId, unitDefinitionId, side, { column: "LEFT", row: "BACK" }),
      side,
      LIMITS,
    ),
    // `createBattleUnit`はPP0で始まる（`startBattle`のREADY→RUNNING回復でのみ
    // 付与される）ため、PSコストを賄えるように明示的に満たす。
    currentPp: LIMITS.maximumPp,
  };
}

function plain(unitDefinitionId: string, battleUnitId: string, side: Side): BattleUnit {
  return createBattleUnit(
    member(battleUnitId, unitDefinitionId, side, { column: "RIGHT", row: "FRONT" }),
    side,
    LIMITS,
  );
}

describe("production Catalog EffectApplied classification payload (M7-011, Issue #265)", () => {
  it("IT-CAP-TRIGGER-PAYLOAD-PROD-001: SKL_KEI_JACKKNIFE_PS2 fully activates from a REAL EffectApplied whose classification payload marks a DEBUFF, damaging exactly the debuffed enemy (TRIGGER_TARGET)", () => {
    const snapshot = loadProductionSnapshot();
    const kei = owner("UNIT_KEI_JACKKNIFE", "ally:kei", "ALLY");
    const ally = plain(TEST_ALLY_UNIT_ID, "ally:helper", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");

    // 味方がその敵へ実際にデバフを付与する（`effect-grant-service.ts`が本物の
    // `EffectApplied`を、慧のPS解決と同じイベント連鎖の中へ発行する）。
    const recorder = new EventRecorder(createBattleId("B_2"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const actionId = recorder.nextActionId();
    const actionStarted = recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId,
      payload: {
        actorUnitId: ally.battleUnitId,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const {
      event,
      applied: effectApplied,
      units,
    } = emitEffectApplied(snapshot, SPEED_DOWN_DEBUFF, ally, enemy, [kei, ally, enemy], -50, {
      recorder,
      parent: actionStarted,
    });
    expect(event.payload).toMatchObject({
      effectKind: "APPLY_STAT_MOD",
      categories: ["DEBUFF"],
    });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions: unitDefinitionsWithTestUnits(snapshot),
      skillDefinitions: snapshot.skills,
    };
    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        // `ACT_KEI_JACKKNIFE_PS2_DAMAGE`のcritical判定がRandomSourceを引く
        // （R-CRT-01）。会心を出さない高い値で対象選択には影響させない。
        random: new SequenceRandomSource([0.99, 0.99, 0.99, 0.99, 0.99]),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: actionStarted.eventId,
        actionId,
      },
      units,
    );
    const resolved = runtime.onFactEvent(effectApplied, units);

    const events = recorder.getEvents();
    expect(
      events.some(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            "SKL_KEI_JACKKNIFE_PS2",
      ),
    ).toBe(true);
    const damageApplied = events.find((e) => e.eventType === "DamageApplied");
    expect(damageApplied?.targetUnitIds).toEqual([enemy.battleUnitId]);
    expect(
      resolved.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.currentHp,
    ).toBeLessThan(enemy.currentHp);
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-002: SKL_KEI_JACKKNIFE_PS2 is NOT a candidate for a REAL EffectApplied classified as BUFF — the pre-M7-011 approximation fired on any effect application", () => {
    const snapshot = loadProductionSnapshot();
    const kei = owner("UNIT_KEI_JACKKNIFE", "ally:kei", "ALLY");
    const ally = plain(TEST_ALLY_UNIT_ID, "ally:helper", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");

    const { event, units } = emitEffectApplied(
      snapshot,
      ATTACK_UP_BUFF,
      enemy,
      enemy,
      [kei, ally, enemy],
      0.1,
    );
    expect(event.payload).toMatchObject({ categories: ["BUFF"] });
    expect(candidateSkillIds(snapshot, event, units)).not.toContain("SKL_KEI_JACKKNIFE_PS2");
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-003 (R-STS-01): SKL_KEI_JACKKNIFE_PS2 IS a candidate for a REAL status-ailment EffectApplied, because 状態異常はデバフの一種 — the classifier gives a STUN both STATUS and DEBUFF", () => {
    const snapshot = loadProductionSnapshot();
    const kei = owner("UNIT_KEI_JACKKNIFE", "ally:kei", "ALLY");
    const ally = plain(TEST_ALLY_UNIT_ID, "ally:helper", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");

    const { event, units } = emitEffectApplied(snapshot, STUN, ally, enemy, [kei, ally, enemy]);
    expect(event.payload).toMatchObject({
      effectKind: "APPLY_STATUS",
      categories: ["DEBUFF", "STATUS"],
      statusKind: "STUN",
    });
    expect(candidateSkillIds(snapshot, event, units)).toContain("SKL_KEI_JACKKNIFE_PS2");
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-004 (R-STS-01境界): SKL_SIENA_DIVA_PS1 candidate-izes for a REAL status ailment but not for a beneficial APPLY_STATUS (STEALTH) — 「敵に状態異常が付与された際」は effectKind: APPLY_STATUS より狭い", () => {
    const snapshot = loadProductionSnapshot();
    const siena = owner("UNIT_SIENA_DIVA", "ally:siena", "ALLY");
    const ally = plain(TEST_ALLY_UNIT_ID, "ally:helper", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");

    const stunned = emitEffectApplied(snapshot, STUN, ally, enemy, [siena, ally, enemy]);
    expect(candidateSkillIds(snapshot, stunned.event, stunned.units)).toContain(
      "SKL_SIENA_DIVA_PS1",
    );

    const stealthed = emitEffectApplied(snapshot, STEALTH, enemy, enemy, [siena, ally, enemy]);
    expect(stealthed.event.payload).toMatchObject({
      effectKind: "APPLY_STATUS",
      categories: ["BUFF"],
      statusKind: "STEALTH",
    });
    expect(candidateSkillIds(snapshot, stealthed.event, stealthed.units)).not.toContain(
      "SKL_SIENA_DIVA_PS1",
    );
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-005: SKL_NADYA_SUCCESSOR_PS2 (敵に気絶) and SKL_KATE_PALADIN_PS1 (敵に凍結) each candidate-ize only for their own statusKind", () => {
    const snapshot = loadProductionSnapshot();
    const nadya = owner("UNIT_NADYA_SUCCESSOR", "ally:nadya", "ALLY");
    const kate = owner("UNIT_KATE_PALADIN", "ally:kate", "ALLY");
    const ally = plain(TEST_ALLY_UNIT_ID, "ally:helper", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");
    const party = [nadya, kate, ally, enemy];

    const stunned = emitEffectApplied(snapshot, STUN, ally, enemy, party);
    const stunCandidates = candidateSkillIds(snapshot, stunned.event, stunned.units);
    expect(stunCandidates).toContain("SKL_NADYA_SUCCESSOR_PS2");
    expect(stunCandidates).not.toContain("SKL_KATE_PALADIN_PS1");

    const frozen = emitEffectApplied(snapshot, FREEZE, ally, enemy, party);
    const freezeCandidates = candidateSkillIds(snapshot, frozen.event, frozen.units);
    // `SKL_KATE_PALADIN_PS1`はM7-011以前、payloadに存在しない`field: "status"`を
    // 参照していたため凍結付与でも一度も発動できなかった。
    expect(freezeCandidates).toContain("SKL_KATE_PALADIN_PS1");
    expect(freezeCandidates).not.toContain("SKL_NADYA_SUCCESSOR_PS2");
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-006: SKL_NADYA_SUCCESSOR_PS1 candidate-izes for a status ailment applied to Nadya herself, but not for a plain DEBUFF (「自身に状態異常が付与された際」)", () => {
    const snapshot = loadProductionSnapshot();
    const nadya = owner("UNIT_NADYA_SUCCESSOR", "ally:nadya", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");

    const stunned = emitEffectApplied(snapshot, STUN, enemy, nadya, [nadya, enemy]);
    expect(candidateSkillIds(snapshot, stunned.event, stunned.units)).toContain(
      "SKL_NADYA_SUCCESSOR_PS1",
    );

    const debuffed = emitEffectApplied(
      snapshot,
      SPEED_DOWN_DEBUFF,
      enemy,
      nadya,
      [nadya, enemy],
      -50,
    );
    expect(candidateSkillIds(snapshot, debuffed.event, debuffed.units)).not.toContain(
      "SKL_NADYA_SUCCESSOR_PS1",
    );
  });

  it("IT-CAP-TRIGGER-PAYLOAD-PROD-007: SKL_URUU_TIMID_PS3・SKL_MEIYA_FATED_PS1（自身にデバフ）と SKL_LILY_SINGER_PS1（味方にデバフ）は、DEBUFF分類の付与だけを候補にする", () => {
    const snapshot = loadProductionSnapshot();
    const uruu = owner("UNIT_URUU_TIMID", "ally:uruu", "ALLY");
    const meiya = owner("UNIT_MEIYA_FATED", "ally:meiya", "ALLY");
    const lily = owner("UNIT_LILY_SINGER", "ally:lily", "ALLY");
    const enemy = plain(TEST_ENEMY_UNIT_ID, "enemy:1", "ENEMY");
    const party = [uruu, meiya, lily, enemy];

    // 敵がうるうへデバフを付与する（`SKL_URUU_TIMID_PS3`の
    // sourceSelector: ENEMY / targetSelector: SELF）。冥夜・リリーから見ると
    // 「味方（うるう）へのデバフ付与」でもある。
    const debuffed = emitEffectApplied(snapshot, SPEED_DOWN_DEBUFF, enemy, uruu, party, -50);
    const debuffCandidates = candidateSkillIds(snapshot, debuffed.event, debuffed.units);
    expect(debuffCandidates).toContain("SKL_URUU_TIMID_PS3");
    expect(debuffCandidates).toContain("SKL_LILY_SINGER_PS1");

    const buffed = emitEffectApplied(snapshot, ATTACK_UP_BUFF, enemy, uruu, party, 0.1);
    const buffCandidates = candidateSkillIds(snapshot, buffed.event, buffed.units);
    expect(buffCandidates).not.toContain("SKL_URUU_TIMID_PS3");
    expect(buffCandidates).not.toContain("SKL_LILY_SINGER_PS1");

    // 冥夜自身へのデバフ（`SKL_MEIYA_FATED_PS1`の targetSelector: SELF）。
    const meiyaDebuffed = emitEffectApplied(snapshot, SPEED_DOWN_DEBUFF, enemy, meiya, party, -50);
    expect(candidateSkillIds(snapshot, meiyaDebuffed.event, meiyaDebuffed.units)).toContain(
      "SKL_MEIYA_FATED_PS1",
    );
    const meiyaBuffed = emitEffectApplied(snapshot, ATTACK_UP_BUFF, enemy, meiya, party, 0.1);
    expect(candidateSkillIds(snapshot, meiyaBuffed.event, meiyaBuffed.units)).not.toContain(
      "SKL_MEIYA_FATED_PS1",
    );
  });
});
