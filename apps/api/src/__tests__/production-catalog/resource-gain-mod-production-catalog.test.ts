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
 * REL-001（Issue #202、`CAP_RESOURCE_GAIN_MOD`）: M7-002（Issue #185）は
 * `APPLY_RESOURCE_GAIN_MOD`をDomain単体テストだけで`IMPLEMENTED`にしており、
 * production代表2件（`ACT_MAIA_SALON_AS2_EX_GAIN_DOWN`／
 * `ACT_KARINA_DOWNER_PS2_EX_GAIN_UP`、どちらも`resource: EX_GAUGE`の
 * `rateDelta` ∓0.5）が実経路で効くことは機械証跡になっていなかった。
 *
 * このCapabilityは「付与されたか」ではなく「以後のリソース獲得量が変わるか」で
 * しか完了を判定できない（G-05／R-ACT-03）。したがってここでは常に2段構えで通す。
 *
 * 1. 実スキル（AS／PS）を実ライフサイクルで解決して補正を付与する
 * 2. その保持者が**自分のASを実際に使い**、EXゲージ獲得量が基礎量から変わることを見る
 *
 * 基礎量はR-ACT-03より消費APと同量のため、AP2消費の実AS
 * （`SKL_SENKA_SCHEMER_AS1`）を使い、-50%／+50%が切り捨てで消えない大きさにする。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const MAIA_UNIT_ID = "UNIT_MAIA_SALON";
const MAIA_AS2_ID = "SKL_MAIA_SALON_AS2";
const EX_GAIN_DOWN_ID = "ACT_MAIA_SALON_AS2_EX_GAIN_DOWN";
const KARINA_UNIT_ID = "UNIT_KARINA_DOWNER";
const KARINA_PS2_ID = "SKL_KARINA_DOWNER_PS2";
const EX_GAIN_UP_ID = "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP";
/** 補正の保持者。AP2消費の実ASを持つ（＝基礎EXゲージ獲得量が2）。 */
const SENKA_UNIT_ID = "UNIT_SENKA_SCHEMER";
const SENKA_AS1_ID = "SKL_SENKA_SCHEMER_AS1";
const SENKA_AS1_COST = 2;

const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 7 };
const COMBAT_STATS = {
  maximumHp: 100000,
  attack: 100,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function actor(battleUnitId: string, unitDefinitionId: string, side: "ALLY" | "ENEMY"): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position: { column: "CENTER", row: "FRONT" },
    combatStats: COMBAT_STATS,
    limits: LIMITS,
    // ターン開始のリソース回復（`06_戦闘状態遷移.md` TURN_STARTING #2）を経ずに
    // 行動させるため、AS/PSのコストを払える状態から始める。
    overrides: { currentAp: LIMITS.maximumAp, currentPp: LIMITS.maximumPp },
  });
}

function loadSnapshot(): BattleCatalogSnapshot {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [
    MAIA_UNIT_ID,
    KARINA_UNIT_ID,
    SENKA_UNIT_ID,
  ]);
  // 実Catalogの定義形をこのテストの前提として固定する（近似・差し替えなし）。
  for (const [id, rateDelta] of [
    [EX_GAIN_DOWN_ID, -0.5],
    [EX_GAIN_UP_ID, 0.5],
  ] as const) {
    expect(effectActionFrom(snapshot, id)).toMatchObject({
      kind: "APPLY_RESOURCE_GAIN_MOD",
      payload: {
        resource: "EX_GAUGE",
        rateDelta: { kind: "CONSTANT", value: rateDelta },
        stacking: { mode: "STACKABLE" },
      },
      requiredCapabilities: ["CAP_RESOURCE_GAIN_MOD"],
    });
  }
  expect(skillFrom(snapshot, SENKA_AS1_ID).cost).toMatchObject({
    resource: "AP",
    amount: SENKA_AS1_COST,
  });
  return snapshot;
}

/**
 * `holder`が実`SKL_SENKA_SCHEMER_AS1`を使い、そのASで実際に増えたEXゲージ量を返す。
 * `ActionStarted`が公開する`exBefore`/`exAfter`（R-ACT-03の増加そのもの）を読む。
 */
function exGaugeGainedByOwnAction(
  snapshot: BattleCatalogSnapshot,
  holder: BattleUnit,
  opponent: BattleUnit,
): number {
  const recorder = new EventRecorder(createBattleId("B_GAIN"));
  resolveSkillUse(
    holder,
    skillFrom(snapshot, SENKA_AS1_ID),
    "AS",
    "AS",
    [holder, opponent],
    definitionsWith(snapshot),
    noMissNoCrit(),
    recorder,
    1,
    1,
    createActionId("B_GAIN:action:1"),
    recorder.nextResolutionScopeId(),
  );
  const started = recorder
    .getEvents()
    .find(
      (event): event is Extract<BattleDomainEvent, { eventType: "ActionStarted" }> =>
        event.eventType === "ActionStarted",
    )!;
  return started.payload.exAfter - started.payload.exBefore;
}

/** 実`SKL_MAIA_SALON_AS2`を`maiaCount`体で解決し、唯一の敵へ獲得量減少を積む。 */
function applyRealGainDown(
  snapshot: BattleCatalogSnapshot,
  maiaCount: number,
): { readonly senka: BattleUnit; readonly maia: BattleUnit } {
  const senka = actor("enemy:senka", SENKA_UNIT_ID, "ENEMY");
  const maias = Array.from({ length: maiaCount }, (_, index) =>
    actor(`ally:maia:${index}`, MAIA_UNIT_ID, "ALLY"),
  );
  let units: readonly BattleUnit[] = [...maias, senka];
  const recorder = new EventRecorder(createBattleId("B_DOWN"));

  maias.forEach((maia, index) => {
    units = resolveSkillUse(
      units.find((unit) => unit.battleUnitId === maia.battleUnitId)!,
      skillFrom(snapshot, MAIA_AS2_ID),
      "AS",
      "AS",
      units,
      definitionsWith(snapshot),
      noMissNoCrit(),
      recorder,
      1,
      index + 1,
      createActionId(`B_DOWN:action:${index + 1}`),
      recorder.nextResolutionScopeId(),
    ).units;
  });

  return {
    senka: units.find((unit) => unit.battleUnitId === senka.battleUnitId)!,
    maia: units.find((unit) => unit.battleUnitId === maias[0]!.battleUnitId)!,
  };
}

describe("production Catalog APPLY_RESOURCE_GAIN_MOD (REL-001, Issue #202, CAP_RESOURCE_GAIN_MOD, R-ACT-03/G-05)", () => {
  it("IT-CAP-RESOURCE-GAIN-MOD-PROD-001 (real lifecycle wiring, gain down): the real SKL_MAIA_SALON_AS2 halves the EX gauge its target earns from the target's own next AS", () => {
    const snapshot = loadSnapshot();
    const { senka, maia } = applyRealGainDown(snapshot, 1);

    const gainMods = senka.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === EX_GAIN_DOWN_ID,
    );
    expect(gainMods).toHaveLength(1);
    expect(gainMods[0]!.magnitude).toBe(-0.5);

    // 補正なしの同じASは消費AP分（2）をそのまま得る（R-ACT-03）。
    const baseline = exGaugeGainedByOwnAction(
      snapshot,
      actor("enemy:senka", SENKA_UNIT_ID, "ENEMY"),
      maia,
    );
    expect(baseline).toBe(SENKA_AS1_COST);
    expect(exGaugeGainedByOwnAction(snapshot, senka, maia)).toBe(SENKA_AS1_COST * (1 - 0.5));
  });

  it("IT-CAP-RESOURCE-GAIN-MOD-PROD-002 (real lifecycle wiring, gain up): the real SKL_KARINA_DOWNER_PS2 raises the EX gauge its allies earn from their own next AS", () => {
    const snapshot = loadSnapshot();
    const karina = actor("ally:karina", KARINA_UNIT_ID, "ALLY");
    const senka = actor("ally:senka", SENKA_UNIT_ID, "ALLY");
    const enemy = actor("enemy:maia", MAIA_UNIT_ID, "ENEMY");
    const units = [karina, senka, enemy];
    const recorder = new EventRecorder(createBattleId("B_UP"));
    const resolutionScopeId = recorder.nextResolutionScopeId();

    // 実PS2のTriggerは`TurnCompleting`（SELF/SELF）。`battle.ts`が発行する形
    // （sourceUnitId/targetUnitIdsを持たないグローバルイベント）のまま流す。
    const turnCompleting = recorder.record({
      eventType: "TurnCompleting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    const activated = new PassiveActivationRuntime(
      {
        definitions: definitionsWith(snapshot),
        random: noMissNoCrit(),
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId,
        rootEventId: turnCompleting.eventId,
      },
      units,
    ).onFactEvent(turnCompleting, units).units;

    expect(
      recorder
        .getEvents()
        .some(
          (event) =>
            event.eventType === "PassiveActivated" &&
            (event.payload as { skillDefinitionId: string }).skillDefinitionId === KARINA_PS2_ID,
        ),
    ).toBe(true);
    const buffed = activated.find((unit) => unit.battleUnitId === senka.battleUnitId)!;
    const gainMods = buffed.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === EX_GAIN_UP_ID,
    );
    expect(gainMods).toHaveLength(1);
    expect(gainMods[0]!.magnitude).toBe(0.5);

    expect(exGaugeGainedByOwnAction(snapshot, buffed, enemy)).toBe(SENKA_AS1_COST * 1.5);
  });

  it("IT-CAP-RESOURCE-GAIN-MOD-PROD-003 (BOUNDARY, stacked negatives clamp at zero): two real SKL_MAIA_SALON_AS2 users stack to -100%, so the target earns no EX gauge at all instead of losing gauge it already holds", () => {
    const snapshot = loadSnapshot();
    const { senka, maia } = applyRealGainDown(snapshot, 2);

    // STACKABLE: 保持中の全インスタンスを合算する（-0.5 × 2 = -1.0）。
    expect(
      senka.appliedEffects.filter((effect) => effect.effectActionDefinitionId === EX_GAIN_DOWN_ID),
    ).toHaveLength(2);

    // R-FRM-06は同一UnitDefinitionの複数編成を許すため、合成後の倍率が-100%を
    // 下回る編成はproductionで実際に組める。減少方向は0で打ち止めにする。
    const heldBefore = 3;
    const gained = exGaugeGainedByOwnAction(
      snapshot,
      { ...senka, currentExtraGauge: heldBefore },
      maia,
    );
    expect(gained).toBe(0);
  });
});
