import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import {
  definitionsWith,
  effectActionFrom,
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * REL-001（Issue #202、`CAP_SPECIFIC_IMMUNITY`）: M7-001B（Issue #243）は
 * `EFFECT_IMMUNITY.statusKinds`（R-EFF-03の状態異常種別限定免疫）を、Domain単体と
 * Catalog Schema/Mapperテスト（`UT-CAT-*`）だけで`IMPLEMENTED`にしていた。
 * `14_Catalog定義スキーマ.md`が「Schema/Mapperや単体関数だけの完成…では
 * `IMPLEMENTED`にしない」と定めている形そのものであり、production代表2件
 * （`ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY`／`ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY`、
 * どちらも`categories: [STATUS]` + `statusKinds: [STUN]`）が実経路で効くことは
 * 機械証跡になっていなかった。
 *
 * このCapabilityの完了境界は「STATUSカテゴリ全体ではなく、指定した種別だけを
 * 拒否する」ことであり、**拒否される種別と拒否されない種別を同じ免疫に対して
 * 両方通さないと**、カテゴリ丸ごとの免疫と区別がつかない。したがってここでは
 * 実`catalog/`の実スキルだけで次を通す。
 *
 * - 実`SKL_LILY_HERO_AS2`のSTUN（`statusKinds`に含まれる）→ 拒否される
 * - 実`SKL_NANAE_COMMANDER_EX`のFREEZE（同じSTATUSだが含まれない）→ 通る
 * - 同じ行動のstat debuff（`ACT_LILY_HERO_AS2_SPEED_DOWN`）→ 通る
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const AOI_UNIT_ID = "UNIT_AOI_GUARDIAN";
const AOI_EX_ID = "SKL_AOI_GUARDIAN_EX";
const AOI_STUN_IMMUNITY_ID = "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY";
const HIIRO_UNIT_ID = "UNIT_HIIRO_LONEWOLF";
const HIIRO_PS2_ID = "SKL_HIIRO_LONEWOLF_PS2";
const HIIRO_STUN_IMMUNITY_ID = "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY";
/** STUNを確率1で付与する実AS。同じ行動でstat debuffも付与する。 */
const LILY_UNIT_ID = "UNIT_LILY_HERO";
const LILY_AS2_ID = "SKL_LILY_HERO_AS2";
const LILY_STUN_ID = "ACT_LILY_HERO_AS2_STUN";
const LILY_SPEED_DOWN_ID = "ACT_LILY_HERO_AS2_SPEED_DOWN";
/** STUN以外のSTATUS（FREEZE）を付与する実EX。 */
const NANAE_UNIT_ID = "UNIT_NANAE_COMMANDER";
const NANAE_EX_ID = "SKL_NANAE_COMMANDER_EX";
const NANAE_FREEZE_ID = "ACT_NANAE_COMMANDER_EX_FREEZE";

const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 8 };
const COMBAT_STATS = {
  maximumHp: 100000,
  attack: 100,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function actor(
  battleUnitId: string,
  unitDefinitionId: string,
  side: "ALLY" | "ENEMY",
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position: { column: "CENTER", row: "FRONT" },
    combatStats: COMBAT_STATS,
    limits: LIMITS,
    overrides: {
      currentAp: LIMITS.maximumAp,
      currentPp: LIMITS.maximumPp,
      currentExtraGauge: LIMITS.maximumExtraGauge,
      ...overrides,
    },
  });
}

function loadSnapshot(): BattleCatalogSnapshot {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [
    AOI_UNIT_ID,
    HIIRO_UNIT_ID,
    LILY_UNIT_ID,
    NANAE_UNIT_ID,
  ]);
  // 実Catalogの定義形をこのテストの前提として固定する（近似・差し替えなし）。
  expect(effectActionFrom(snapshot, AOI_STUN_IMMUNITY_ID)).toMatchObject({
    kind: "EFFECT_IMMUNITY",
    payload: { categories: ["STATUS"], statusKinds: ["STUN"], maxBlocks: null },
  });
  expect(effectActionFrom(snapshot, HIIRO_STUN_IMMUNITY_ID)).toMatchObject({
    kind: "EFFECT_IMMUNITY",
    payload: {
      categories: ["STATUS"],
      statusKinds: ["STUN"],
      duration: { consumption: { kind: "INCOMING_HIT", maxCount: 3 } },
    },
  });
  expect(effectActionFrom(snapshot, LILY_STUN_ID)).toMatchObject({
    kind: "APPLY_STATUS",
    payload: { status: "STUN", probability: 1 },
  });
  expect(effectActionFrom(snapshot, NANAE_FREEZE_ID)).toMatchObject({
    kind: "APPLY_STATUS",
    payload: { status: "FREEZE" },
  });
  return snapshot;
}

/** 実`SKL_AOI_GUARDIAN_EX`を実ライフサイクルで解決し、STUN限定免疫を持つAoiを返す。 */
function aoiWithRealImmunity(snapshot: BattleCatalogSnapshot): BattleUnit {
  const aoi = actor("ally:aoi", AOI_UNIT_ID, "ALLY");
  const enemy = actor("enemy:lily", LILY_UNIT_ID, "ENEMY");
  const recorder = new EventRecorder(createBattleId("B_IMM"));
  const resolved = resolveSkillUse(
    aoi,
    skillFrom(snapshot, AOI_EX_ID),
    "EX",
    "EX",
    [aoi, enemy],
    definitionsWith(snapshot),
    noMissNoCrit(),
    recorder,
    1,
    1,
    createActionId("B_IMM:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
  return resolved.find((unit) => unit.battleUnitId === aoi.battleUnitId)!;
}

interface AttackOutcome {
  readonly target: BattleUnit;
  readonly rejected: readonly Extract<
    BattleDomainEvent,
    { eventType: "EffectApplicationRejected" }
  >[];
}

/** `attackerUnitId`の実スキルを`target`へ解決し、拒否イベントと結果状態を返す。 */
function resolveAttack(
  snapshot: BattleCatalogSnapshot,
  attackerUnitId: string,
  skillId: string,
  actionType: "AS" | "EX",
  target: BattleUnit,
): AttackOutcome {
  const attacker = actor("enemy:attacker", attackerUnitId, "ENEMY");
  const units = [target, attacker];
  const recorder = new EventRecorder(createBattleId("B_ATK"));
  const resolved = resolveSkillUse(
    attacker,
    skillFrom(snapshot, skillId),
    actionType,
    actionType,
    units,
    definitionsWith(snapshot),
    noMissNoCrit(),
    recorder,
    1,
    1,
    createActionId("B_ATK:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
  return {
    target: resolved.find((unit) => unit.battleUnitId === target.battleUnitId)!,
    rejected: recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplicationRejected" }> =>
          event.eventType === "EffectApplicationRejected",
      ),
  };
}

function holdsEffect(unit: BattleUnit, effectActionDefinitionId: string): boolean {
  return unit.appliedEffects.some(
    (effect) => effect.effectActionDefinitionId === effectActionDefinitionId,
  );
}

describe("production Catalog EFFECT_IMMUNITY statusKinds (REL-001, Issue #202, CAP_SPECIFIC_IMMUNITY, R-EFF-03)", () => {
  it("IT-CAP-SPECIFIC-IMMUNITY-PROD-001 (real lifecycle wiring): the real SKL_AOI_GUARDIAN_EX grants a STATUS immunity narrowed to STUN alone", () => {
    const snapshot = loadSnapshot();

    const aoi = aoiWithRealImmunity(snapshot);

    const immunity = aoi.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === AOI_STUN_IMMUNITY_ID,
    );
    expect(immunity).toHaveLength(1);
    expect(immunity[0]!.immunity).toMatchObject({
      categories: ["STATUS"],
      statusKinds: ["STUN"],
      blockedCount: 0,
      maxBlocks: null,
    });
  });

  it("IT-CAP-SPECIFIC-IMMUNITY-PROD-002 (the named status kind is rejected): the real SKL_LILY_HERO_AS2 STUN is refused while the same action's stat debuff still lands", () => {
    const snapshot = loadSnapshot();
    const aoi = aoiWithRealImmunity(snapshot);

    const { target, rejected } = resolveAttack(snapshot, LILY_UNIT_ID, LILY_AS2_ID, "AS", aoi);

    expect(holdsEffect(target, LILY_STUN_ID)).toBe(false);
    expect(rejected.map((event) => event.payload.effectActionDefinitionId)).toEqual([LILY_STUN_ID]);
    // 拒否したインスタンスは、実EXが付与したSTUN限定免疫そのものである。
    expect(rejected[0]!.payload).toMatchObject({
      battleUnitId: aoi.battleUnitId,
      statusKind: "STUN",
      blockingEffectInstanceId: aoi.appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === AOI_STUN_IMMUNITY_ID,
      )!.effectInstanceId,
    });
    // 拒否は指定種別だけに掛かる — 同じ行動のstat debuffは通る。
    expect(holdsEffect(target, LILY_SPEED_DOWN_ID)).toBe(true);
    // 免疫自身は消費されて拒否回数を数える（`maxBlocks: null`なので失効はしない）。
    expect(
      target.appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === AOI_STUN_IMMUNITY_ID,
      )!.immunity,
    ).toMatchObject({ blockedCount: 1 });
  });

  it("IT-CAP-SPECIFIC-IMMUNITY-PROD-003 (a different STATUS kind is NOT rejected): the real SKL_NANAE_COMMANDER_EX FREEZE lands through the same STUN-only immunity, proving the immunity is kind-scoped rather than category-wide", () => {
    const snapshot = loadSnapshot();
    const aoi = aoiWithRealImmunity(snapshot);

    const { target, rejected } = resolveAttack(snapshot, NANAE_UNIT_ID, NANAE_EX_ID, "EX", aoi);

    expect(rejected).toEqual([]);
    expect(holdsEffect(target, NANAE_FREEZE_ID)).toBe(true);
    expect(
      target.appliedEffects.find(
        (effect) => effect.effectActionDefinitionId === AOI_STUN_IMMUNITY_ID,
      )!.immunity,
    ).toMatchObject({ blockedCount: 0 });
  });

  it("IT-CAP-SPECIFIC-IMMUNITY-PROD-004 (the second production representative): the real SKL_HIIRO_LONEWOLF_PS2 grants the same STUN-only narrowing through its real UnitDefeated trigger", () => {
    const snapshot = loadSnapshot();
    const hiiro = actor("ally:hiiro", HIIRO_UNIT_ID, "ALLY");
    const enemy = actor("enemy:lily", LILY_UNIT_ID, "ENEMY", { currentHp: 0 });
    const units = [hiiro, enemy];
    const recorder = new EventRecorder(createBattleId("B_HIIRO"));
    const resolutionScopeId = recorder.nextResolutionScopeId();

    // 実PS2のTriggerは`UnitDefeated`（sourceSelector: SELF / targetSelector: ENEMY）。
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    const defeated = recorder.record({
      eventType: "UnitDefeated",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId,
      parentEventId: seed.eventId,
      rootEventId: seed.eventId,
      sourceUnitId: hiiro.battleUnitId,
      targetUnitIds: [enemy.battleUnitId],
      payload: { unitId: enemy.battleUnitId, causeEventId: seed.eventId },
    });
    const activated = new PassiveActivationRuntime(
      {
        definitions: definitionsWith(snapshot),
        random: noMissNoCrit(),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: defeated.eventId,
      },
      units,
    ).onFactEvent(defeated, units).units;

    expect(
      recorder
        .getEvents()
        .some(
          (event) =>
            event.eventType === "PassiveActivated" &&
            (event.payload as { skillDefinitionId: string }).skillDefinitionId === HIIRO_PS2_ID,
        ),
    ).toBe(true);
    const holder = activated.find((unit) => unit.battleUnitId === hiiro.battleUnitId)!;
    const immunity = holder.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === HIIRO_STUN_IMMUNITY_ID,
    );
    expect(immunity).toHaveLength(1);
    expect(immunity[0]!.immunity).toMatchObject({ categories: ["STATUS"], statusKinds: ["STUN"] });

    // 同じSTUN限定免疫が、別スキル由来でも実際にSTUNを拒否する。
    const { target, rejected } = resolveAttack(snapshot, LILY_UNIT_ID, LILY_AS2_ID, "AS", holder);
    expect(holdsEffect(target, LILY_STUN_ID)).toBe(false);
    expect(rejected.map((event) => event.payload.effectActionDefinitionId)).toEqual([LILY_STUN_ID]);
  });
});
