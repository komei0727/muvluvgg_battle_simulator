import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import {
  definitionsWith,
  effectActionFrom,
  loadProductionSnapshot,
  noMissNoCrit,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * REL-001（Issue #202、`CAP_ATTACK_DAMAGE_BONUS`）: M7-004（Issue #183）は
 * `APPLY_ATTACK_DAMAGE_BONUS`をDomain単体テストだけで`IMPLEMENTED`にしており、
 * production Catalogの唯一の使用例`ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE`が実経路で
 * 解決できることは機械証跡になっていなかった。ここで実`catalog/`の
 * `SKL_ELENA_MOODMAKER_EX`（原文「攻撃力が最も低い味方に…攻撃力×15%のダメージを
 * 追加するバフ」）を無改変で読み込み、実ライフサイクル
 * （`resolveSkillUse`→`effect-action-group-resolver.ts`→`modifier-effect-action.ts`、
 * および`damage-application-service.ts`）を通す。
 *
 * 検証の要点は3つ。
 *
 * 1. 実EXのTargetBinding（`LOWEST_ATTACK`）が選んだ味方だけが
 *    `isAttackDamageBonus`の`AppliedEffect`を持つ
 * 2. その`magnitude`が実際のDAMAGEヒットへ加算される（保持者が攻撃したときだけ、
 *    切り捨て前の値へちょうど`magnitude`分）
 * 3. `magnitude`は付与時点のsnapshotであり、付与後に攻撃力が動いても変わらない
 *
 * 2は「付与されただけで、どこにも効かない記録値」ではないことの証拠であり、
 * `catalog-src`の宣言（`requiredCapabilities`）とruntimeのずれをここで弾く。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const ELENA_UNIT_ID = "UNIT_ELENA_MOODMAKER";
const ELENA_EX_ID = "SKL_ELENA_MOODMAKER_EX";
const BONUS_DAMAGE_ID = "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE";
/** 実EXの`LOWEST_ATTACK` bindingが選ぶ側の味方。実AS2で追加ダメージの効き先も見る。 */
const AOI_UNIT_ID = "UNIT_AOI_GUARDIAN";
const AOI_AS2_DAMAGE_ID = "ACT_AOI_GUARDIAN_AS2_DAMAGE";
const ENEMY_UNIT_ID = "UNIT_TEST_BONUS_TARGET";

/** `ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE.payload.formula.ratio`（実Catalog）。 */
const BONUS_RATIO = 0.15;
/** 同stepで先に適用される`ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW`の倍率（実Catalog）。 */
const ATTACK_UP_RATIO = 0.35;
const AOI_BASE_ATTACK = 200;
const ELENA_ATTACK = 400;

const LIMITS = { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 6 };
const COMBAT_STATS = {
  maximumHp: 100000,
  attack: 100,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function setup(): {
  readonly snapshot: ReturnType<typeof loadProductionSnapshot>;
  readonly elena: BattleUnit;
  readonly aoi: BattleUnit;
  readonly enemy: BattleUnit;
  readonly recorder: EventRecorder;
  readonly units: readonly BattleUnit[];
} {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [ELENA_UNIT_ID, AOI_UNIT_ID]);

  // 実Catalogの定義形をこのテストの前提として固定する（近似・差し替えなし）。
  expect(effectActionFrom(snapshot, BONUS_DAMAGE_ID)).toMatchObject({
    kind: "APPLY_ATTACK_DAMAGE_BONUS",
    payload: {
      formula: {
        kind: "STAT_RATIO",
        source: { kind: "TARGET" },
        stat: "ATTACK",
        ratio: BONUS_RATIO,
      },
    },
  });

  const elena = testBattleUnit({
    battleUnitId: "ally:elena",
    unitDefinitionId: ELENA_UNIT_ID,
    position: { column: "CENTER", row: "BACK" },
    combatStats: { ...COMBAT_STATS, attack: ELENA_ATTACK },
    limits: LIMITS,
    overrides: { currentExtraGauge: LIMITS.maximumExtraGauge },
  });
  const aoi = testBattleUnit({
    battleUnitId: "ally:aoi",
    unitDefinitionId: AOI_UNIT_ID,
    position: { column: "LEFT", row: "FRONT" },
    combatStats: { ...COMBAT_STATS, attack: AOI_BASE_ATTACK },
    limits: LIMITS,
  });
  const enemy = testBattleUnit({
    battleUnitId: "enemy:1",
    unitDefinitionId: ENEMY_UNIT_ID,
    side: "ENEMY",
    position: { column: "CENTER", row: "FRONT" },
    combatStats: COMBAT_STATS,
    limits: LIMITS,
  });

  return {
    snapshot,
    elena,
    aoi,
    enemy,
    recorder: new EventRecorder(createBattleId("B_BONUS")),
    units: [elena, aoi, enemy],
  };
}

/** 実EXを実ライフサイクルで解決し、`LOWEST_ATTACK`側の味方を返す。 */
function resolveElenaEx(context: ReturnType<typeof setup>): readonly BattleUnit[] {
  const { snapshot, elena, units, recorder } = context;
  return resolveSkillUse(
    elena,
    snapshot.skills.get(createSkillDefinitionId(ELENA_EX_ID))!,
    "EX",
    "EX",
    units,
    definitionsWith(snapshot, { units: [ENEMY_UNIT_ID] }),
    new SequenceRandomSource([]),
    recorder,
    1,
    1,
    createActionId("B_BONUS:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
}

/**
 * 追加ダメージの保持者が実AS2のDAMAGEを1ヒット当て、切り捨て前のダメージを返す。
 * `bonusHolder`の`appliedEffects`をそのまま渡すため、対照実行では追加ダメージ効果
 * だけを取り除いた同じ状態を渡す。
 */
function preTruncationDamageOf(
  context: ReturnType<typeof setup>,
  attacker: BattleUnit,
  target: BattleUnit,
): number {
  const recorder = new EventRecorder(createBattleId("B_HIT"));
  const loaded = effectActionFrom(context.snapshot, AOI_AS2_DAMAGE_ID);
  // 実Catalogから読んだ定義がDAMAGEであることをここで確定させる（`as`で潰さない）。
  if (loaded.kind !== "DAMAGE") {
    throw new Error(`${AOI_AS2_DAMAGE_ID} must be a DAMAGE definition, got ${loaded.kind}`);
  }
  const damageAction = loaded;
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  applyDamageAction(
    attacker,
    [
      {
        targetUnitId: target.battleUnitId,
        effectActionDefinitionId: damageAction.effectActionDefinitionId,
        hitIndex: 1,
      },
    ],
    damageAction,
    [attacker, target],
    noMissNoCrit(),
    {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId: recorder.nextActionId(),
      skillUseId: recorder.nextSkillUseId(),
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: seed.eventId,
      parentEventId: seed.eventId,
      skillDefinitionId: createSkillDefinitionId("SKL_AOI_GUARDIAN_AS2"),
    },
  );
  const calculated = recorder
    .getEvents()
    .find(
      (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
        event.eventType === "DamageCalculated",
    )!;
  return calculated.payload.preTruncationDamage;
}

describe("production Catalog ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE (REL-001, Issue #202, CAP_ATTACK_DAMAGE_BONUS)", () => {
  it("IT-CAP-ATTACK-DAMAGE-BONUS-PROD-001 (real lifecycle wiring): the real SKL_ELENA_MOODMAKER_EX grants the LOWEST_ATTACK ally an isAttackDamageBonus effect whose magnitude is 15% of that ally's ATTACK at grant time", () => {
    const context = setup();

    const resolved = resolveElenaEx(context);

    const aoi = resolved.find((unit) => unit.battleUnitId === context.aoi.battleUnitId)!;
    const bonus = aoi.appliedEffects.filter((effect) => effect.isAttackDamageBonus === true);
    expect(bonus).toHaveLength(1);
    expect(bonus[0]!.effectActionDefinitionId).toBe(BONUS_DAMAGE_ID);
    // 実EXは同じstepで`ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW`（ATTACK +35%）を先に適用
    // するため、`STAT_RATIO`/`source: TARGET`が読む攻撃力は加算後の値である。
    expect(aoi.combatStats.attack).toBe(AOI_BASE_ATTACK * (1 + ATTACK_UP_RATIO));
    expect(bonus[0]!.magnitude).toBe(AOI_BASE_ATTACK * (1 + ATTACK_UP_RATIO) * BONUS_RATIO);

    // 追加ダメージは`LOWEST_ATTACK`側だけが受け取る（`HIGHEST_ATTACK`側のElenaには付かない）。
    const elena = resolved.find((unit) => unit.battleUnitId === context.elena.battleUnitId)!;
    expect(elena.appliedEffects.some((effect) => effect.isAttackDamageBonus === true)).toBe(false);
  });

  it("IT-CAP-ATTACK-DAMAGE-BONUS-PROD-002 (the bonus reaches real damage): a DAMAGE hit from the holder adds exactly the granted magnitude on top of the same hit without the bonus", () => {
    const context = setup();
    const resolved = resolveElenaEx(context);
    const aoi = resolved.find((unit) => unit.battleUnitId === context.aoi.battleUnitId)!;
    const magnitude = aoi.appliedEffects.find(
      (effect) => effect.isAttackDamageBonus === true,
    )!.magnitude;
    // 対照実行は追加ダメージ効果**だけ**を外した同じ攻撃側にする（攻撃力バフ・
    // 与ダメージ補正は残すため、差分は追加ダメージの寄与だけになる）。
    const withoutBonus: BattleUnit = {
      ...aoi,
      appliedEffects: aoi.appliedEffects.filter((effect) => effect.isAttackDamageBonus !== true),
    };

    const withBonus = preTruncationDamageOf(context, aoi, context.enemy);
    const baseline = preTruncationDamageOf(context, withoutBonus, context.enemy);

    expect(magnitude).toBeGreaterThan(0);
    // Q-DMG-01: 追加ダメージは切り捨て前の値へ加算する。
    expect(withBonus - baseline).toBeCloseTo(magnitude, 6);
  });

  it("IT-CAP-ATTACK-DAMAGE-BONUS-PROD-003 (BOUNDARY, grant-time snapshot): raising the holder's ATTACK after the grant does not change the already-granted bonus", () => {
    const context = setup();
    const resolved = resolveElenaEx(context);
    const aoi = resolved.find((unit) => unit.battleUnitId === context.aoi.battleUnitId)!;
    const magnitude = aoi.appliedEffects.find(
      (effect) => effect.isAttackDamageBonus === true,
    )!.magnitude;

    const strengthened: BattleUnit = {
      ...aoi,
      combatStats: { ...aoi.combatStats, attack: aoi.combatStats.attack * 10 },
    };
    const withoutBonus: BattleUnit = {
      ...strengthened,
      appliedEffects: strengthened.appliedEffects.filter(
        (effect) => effect.isAttackDamageBonus !== true,
      ),
    };

    const withBonus = preTruncationDamageOf(context, strengthened, context.enemy);
    const baseline = preTruncationDamageOf(context, withoutBonus, context.enemy);

    // 攻撃力が10倍になっても、加算されるのは付与時に評価済みの`magnitude`のまま。
    expect(withBonus - baseline).toBeCloseTo(magnitude, 6);
  });
});
