import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import {
  completedTargetIdsOf,
  definitionsForSkill,
  effectActionFrom,
  effectActionGroupContext,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  seedRecorder,
  skillFrom,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

interface StatOverrides {
  readonly maximumHp?: number;
  readonly attack?: number;
  readonly defense?: number;
}

function unitOf(
  side: Side,
  id: string,
  unitDefinitionId: string,
  position: FormationPosition,
  overrides: StatOverrides = {},
): BattleUnit {
  return testBattleUnit({
    battleUnitId: id,
    unitDefinitionId,
    side,
    position,
    combatStats: { maximumHp: 100000, attack: 300, defense: 10, ...overrides },
  });
}

/**
 * DMG-003（Issue #196、`TEMP_PIERCING_GRANT`／`CAP_PARTIAL_PIERCING`、R-DMG-03）:
 * 「後続の自身の攻撃へ一時的にpiercingを付与する」`APPLY_PIERCING_MOD`と、
 * `DAMAGE`定義自身が持つ静的な貫通率を、実`catalog/`の未改変定義で検証する証跡。
 *
 * - `SKL_RAMI_NEWYEAR_PS1`（おみくじ運試し）の大吉枝
 *   `ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI`（`defenseIgnoreRate: 0.5`）を`grantEffect`
 *   経路で付与し、`AppliedEffect.piercing`・StateDelta・独立Reducer復元まで確認する。
 * - 付与された貫通が実ダメージ計算へ効くことを、同じ`DAMAGE`定義に対する
 *   付与あり/なしの2回の実行で比較する（負の対照）。
 * - 静的な貫通側の代表は`ACT_EVIE_KYONSHI_EX_DAMAGE`（`defenseIgnoreRate: 0.5`）。
 */

describe("production Catalog CAP_PARTIAL_PIERCING — APPLY_PIERCING_MOD (DMG-003, Issue #196, R-DMG-03)", () => {
  it("IT-CAP-PARTIAL-PIERCING-PROD-001: SKL_RAMI_NEWYEAR_PS1's DAIKICHI branch grants the real ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI, carrying its 50% defense ignore onto the AppliedEffect, StateDelta and independent Reducer restoration", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_RAMI_NEWYEAR"]);
    const skill = skillFrom(snapshot, "SKL_RAMI_NEWYEAR_PS1");
    const grant = effectActionFrom(snapshot, "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI");
    expect(grant.kind).toBe("APPLY_PIERCING_MOD");
    if (grant.kind !== "APPLY_PIERCING_MOD") {
      throw new Error("expected APPLY_PIERCING_MOD");
    }
    expect(grant.payload.defenseIgnoreRate).toBe(0.5);
    expect(grant.payload.duration.consumption).toEqual({
      kind: "NEXT_OUTGOING_ATTACK",
      maxCount: 1,
    });

    const actor = unitOf("ALLY", "rami", "UNIT_RAMI_NEWYEAR", {
      column: "LEFT",
      row: "FRONT",
    });
    const enemy = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY", {
      column: "LEFT",
      row: "FRONT",
    });
    const allUnits = [actor, enemy];
    const definitions = definitionsForSkill(skill, snapshot.effectActions);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_RAMI_DAIKICHI");
    // `SequenceRandomSource`が0.99を返すためWEIGHTED_ONEは最後の枝（末吉）を
    // 選ぶ。大吉枝を決定的に引くため乱数を0へ倒す。
    const context = effectActionGroupContext({
      actor,
      skillId: "SKL_RAMI_NEWYEAR_PS1",
      definitions,
      recorder,
      rootEventId,
      random: new SequenceRandomSource(new Array<number>(64).fill(0)),
    });
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    expect(completedTargetIdsOf(recorder, "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI")).toEqual([
      actor.battleUnitId,
    ]);
    const granted = result.units
      .find((u) => u.battleUnitId === actor.battleUnitId)!
      .appliedEffects.find(
        (e) => e.effectActionDefinitionId === "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
      )!;
    expect(granted.piercing).toEqual({
      defenseIgnoreRate: 0.5,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
    });

    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    expect(
      reconstructed.units[actor.battleUnitId]?.effects?.find(
        (e) => e.effectDefinitionId === "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
      )?.piercing,
    ).toEqual(granted.piercing);
  });

  it("IT-CAP-PARTIAL-PIERCING-PROD-002: holding that real grant makes the very next attack ignore half of the defender's defense (negative control: the identical attack without it deals less)", () => {
    const ramiSnapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_RAMI_NEWYEAR"]);
    const psSkill = skillFrom(ramiSnapshot, "SKL_RAMI_NEWYEAR_PS1");
    const attackSkill = skillFrom(ramiSnapshot, "SKL_RAMI_NEWYEAR_AS3");

    const damageDealt = (withGrant: boolean, scope: string) => {
      const actor = unitOf("ALLY", "rami", "UNIT_RAMI_NEWYEAR", {
        column: "LEFT",
        row: "FRONT",
      });
      // 防御力を高くして、貫通の有無がダメージ差として明確に現れるようにする。
      const enemy = unitOf(
        "ENEMY",
        "e1",
        "UNIT_TEST_ENEMY",
        { column: "LEFT", row: "FRONT" },
        { defense: 200 },
      );
      let allUnits: readonly BattleUnit[] = [actor, enemy];
      const { recorder, rootEventId } = seedRecorder(scope);

      // 対照は「PSを走らせたか」ではなく「一時貫与が
      // 残っているか」だけで切り替える。同じPSは`ACT_RAMI_NEWYEAR_PS1_DMG_UP`
      // （与ダメージ+20%）も必ず付与するため、PS実行そのものを対照にすると
      // 貫通が一切効いていなくてもダメージ差が出てしまい、貫通の配線漏れを
      // 検出できない。両方でPSを完走させ、対照側からは貫通インスタンス1件
      // だけを取り除く。
      const definitions = definitionsForSkill(psSkill, ramiSnapshot.effectActions);
      const plan = resolveSkillOrder(psSkill, actor, allUnits, definitions.effectActions);
      const granted = applyEffectActionGroups(
        plan,
        allUnits,
        effectActionGroupContext({
          actor,
          skillId: "SKL_RAMI_NEWYEAR_PS1",
          definitions,
          recorder,
          rootEventId,
          random: new SequenceRandomSource(new Array<number>(64).fill(0)),
        }),
      );
      allUnits = granted.units.map((unit) =>
        unit.battleUnitId !== actor.battleUnitId || withGrant
          ? unit
          : {
              ...unit,
              appliedEffects: unit.appliedEffects.filter(
                (e) => e.effectActionDefinitionId !== "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
              ),
            },
      );
      const holder = allUnits.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(
        holder.appliedEffects.some(
          (e) => e.effectActionDefinitionId === "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
        ),
      ).toBe(withGrant);
      // 貫通以外の付与（与ダメージ+20%）は両側に等しく残っている。
      expect(
        holder.appliedEffects.filter(
          (e) => e.effectActionDefinitionId === "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
        ),
      ).toHaveLength(1);

      const attacker = holder;
      const attackDefinitions = definitionsForSkill(attackSkill, ramiSnapshot.effectActions);
      const attackPlan = resolveSkillOrder(
        attackSkill,
        attacker,
        allUnits,
        attackDefinitions.effectActions,
      );
      const result = applyEffectActionGroups(
        attackPlan,
        allUnits,
        effectActionGroupContext({
          actor: attacker,
          skillId: "SKL_RAMI_NEWYEAR_AS3",
          definitions: attackDefinitions,
          recorder,
          rootEventId,
        }),
      );
      const after = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      // `DamageWillBeApplied`（snapshot）ではなく`DamageCalculated`（確定値）を
      // 見る。前者にしか合成率が現れず実計算が静的値のまま、という不具合は
      // snapshot側だけを見ていると検出できない。
      const calculated = recorder
        .getEvents()
        .filter(
          (e) =>
            e.eventType === "DamageCalculated" &&
            (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
              "ACT_RAMI_NEWYEAR_AS3_DAMAGE",
        )
        .map((e) => e.payload as { defenseIgnoreRate: number; effectiveDefense: number });
      return { damage: enemy.currentHp - after.currentHp, calculated, enemy };
    };

    const withPiercing = damageDealt(true, "B_RAMI_PIERCE_ON");
    const withoutPiercing = damageDealt(false, "B_RAMI_PIERCE_OFF");
    expect(withPiercing.damage).toBeGreaterThan(withoutPiercing.damage);

    // 一時貫通が確定計算へ届いている: 防御力200 → 実効防御100（50%無視）。
    expect(withPiercing.calculated.length).toBeGreaterThan(0);
    for (const payload of withPiercing.calculated) {
      expect(payload.defenseIgnoreRate).toBe(0.5);
      expect(payload.effectiveDefense).toBe(withPiercing.enemy.combatStats.defense * 0.5);
    }
    // 対照側は静的値（貫通なし）のまま。
    for (const payload of withoutPiercing.calculated) {
      expect(payload.defenseIgnoreRate).toBe(0);
      expect(payload.effectiveDefense).toBe(withoutPiercing.enemy.combatStats.defense);
    }
  });

  it("IT-CAP-PARTIAL-PIERCING-PROD-003: the static piercing side (ACT_EVIE_KYONSHI_EX_DAMAGE) keeps declaring CAP_PARTIAL_PIERCING and its 50% defense/shield ignore", () => {
    const snapshot = loadProductionSnapshot(CATALOG_DIR, ["UNIT_EVIE_KYONSHI"]);
    const damage = effectActionFrom(snapshot, "ACT_EVIE_KYONSHI_EX_DAMAGE");
    expect(damage.kind).toBe("DAMAGE");
    if (damage.kind !== "DAMAGE") {
      throw new Error("expected DAMAGE");
    }
    expect(damage.payload.piercing).toEqual({
      defenseIgnoreRate: 0.5,
      shieldIgnoreRate: 0.5,
      damageReductionIgnoreRate: 0,
    });
    // 貫通を宣言する定義は`CAP_PARTIAL_PIERCING`を自己申告する（Issue #196で必須化）。
  });
});
