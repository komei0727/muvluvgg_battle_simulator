import { describe, expect, it } from "vitest";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { loadProductionSnapshot, noMissNoCrit } from "../../testing/fixtures/index.js";
import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import {
  observeLifecycleDamageProbe,
  type DamageProbeObservation,
} from "../../testing/production-unit/damage-probe.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  observeSkillUse,
  productionBoard,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * R-INT-01 #5: 致死耐えは1ヒットではなく1回の攻撃（DAMAGE 1回）を守る。致死に達した攻撃の
 * 残りのヒットもHP1未満にせず、耐えの回数はその攻撃で1回分だけ使う。回復の時点は効果ごとの
 * 宣言（`healTiming`）に従い、`AFTER_ATTACK` の効果は攻撃の終了後に1回だけ回復する。
 * 実`catalog/`の定義で確かめる。
 *
 * 保持者（`ally:subject`、最大HP10000）へ実定義を前提アクションで付け、`enemy:front`から
 * 合成の1攻撃を撃つ。盤面は攻撃力1000・防御力500のため威力0.132で1ヒット66になり、
 * 評価シートの「HP50へ66×13ヒット」の例をそのまま再現できる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_RAMI_UNYIELDING",
  "UNIT_CHIZURU_DOMESTIC",
  "UNIT_FLUTE_VAMPIRE",
  "UNIT_KOTOHA_REBEL",
  "UNIT_MAO_SUMMER",
  "UNIT_OLGA_VETERAN",
  "UNIT_ROSIE_CAMPAIGN",
  "UNIT_TATIANA_SAGE",
  "UNIT_YUI_HEIR",
  "UNIT_LYDIA_SUMMER",
  "UNIT_YIFEI_STORM",
  "UNIT_SHOUKA_BEACH",
]);

const HOLDER = "ally:subject";
/** 1ヒット66（(1000 - 500) × 0.132）。 */
const POWER_66 = 0.132;

interface Holder {
  readonly units: readonly BattleUnit[];
  readonly definitions: ReturnType<typeof productionBoard>["definitions"];
}

function holderWith(
  unitDefinitionId: string,
  effectActionDefinitionIds: readonly string[],
  currentHp: number,
): Holder {
  const production = productionBoard(snapshot, unitDefinitionId, {
    subject: { state: { currentHp } },
  });
  return {
    definitions: production.definitions,
    units: applyPrecedingActions(
      production,
      effectActionDefinitionIds.map((effectActionDefinitionId) => ({
        effectActionDefinitionId,
        target: "SELF" as const,
      })),
    ),
  };
}

/** 保持者へ1回の攻撃を撃ち、次の攻撃へ引き継ぐ盤面と観測を返す。 */
function strike(
  holder: Holder,
  options: { readonly hitCount?: number; readonly power?: number } = {},
): DamageProbeObservation & Holder {
  const observation = observeLifecycleDamageProbe({
    definitions: holder.definitions,
    units: holder.units,
    attackerUnitId: "enemy:front",
    targetUnitId: HOLDER,
    power: options.power ?? POWER_66,
    hitCount: options.hitCount ?? 13,
    damageType: "PHYSICAL",
    accuracy: "GUARANTEED",
  });
  return { ...observation, definitions: holder.definitions };
}

function holderOf(units: readonly BattleUnit[]): BattleUnit {
  return units.find((unit) => unit.battleUnitId === HOLDER)!;
}

function hpOf(units: readonly BattleUnit[]): number {
  return holderOf(units).currentHp;
}

function remainingOf(units: readonly BattleUnit[], effectActionDefinitionId: string) {
  return holderOf(units)
    .appliedEffects.filter((effect) => effect.effectActionDefinitionId === effectActionDefinitionId)
    .map((effect) => effect.duration.consumptionRemaining ?? "UNLIMITED");
}

/** 保持者への各ヒット適用後のHP（`DamageApplied.hpAfter`）。 */
function hpAfterEachHit(observation: DamageProbeObservation): number[] {
  return observation.recorder
    .getEvents()
    .flatMap((event) =>
      event.eventType === "DamageApplied" && event.payload.targetUnitId === HOLDER
        ? [event.payload.hpAfter]
        : [],
    );
}

function survivalConsumptions(
  observation: DamageProbeObservation,
  effectActionDefinitionId: string,
) {
  return observation.consumptions
    .filter((consumption) => consumption.effectActionDefinitionId === effectActionDefinitionId)
    .map(({ before, after }) => ({ before, after }));
}

describe("致死耐えは1回の攻撃の全ヒットを守る（R-INT-01 #5）", () => {
  it("IT-CAT-SURVIVAL-001 [R-INT-01, R-EFF-07] SR-219・SR-226・SR-233: HP50へ66×13の1攻撃でも終了までHP1以上で、耐えは1回分だけ使い、次の別攻撃は防がない", () => {
    for (const [unitDefinitionId, effectActionDefinitionId] of [
      ["UNIT_RAMI_UNYIELDING", "ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL"],
      ["UNIT_FLUTE_VAMPIRE", "ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL"],
    ] as const) {
      const first = strike(holderWith(unitDefinitionId, [effectActionDefinitionId], 50));
      expect(first.defeated).toEqual([]);
      expect(hpAfterEachHit(first)).toEqual(new Array<number>(13).fill(1));
      expect(survivalConsumptions(first, effectActionDefinitionId)).toEqual([
        { before: 1, after: 0 },
      ]);
      expect(remainingOf(first.units, effectActionDefinitionId)).toEqual([]);

      const second = strike(first);
      expect(second.defeated).toEqual([HOLDER]);
    }
  });

  it("IT-CAT-SURVIVAL-002 [R-INT-01, R-EFF-07] SR-219・SR-226: 非致死の攻撃では耐えを使わず、次の致死攻撃で初めて使う", () => {
    const holder = holderWith("UNIT_FLUTE_VAMPIRE", ["ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL"], 5000);
    const survived = strike(holder);
    expect(hpOf(survived.units)).toBe(5000 - 66 * 13);
    expect(remainingOf(survived.units, "ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL")).toEqual([1]);

    const lethal = strike(survived, { hitCount: 3, power: 4 });
    expect(lethal.defeated).toEqual([]);
    expect(hpOf(lethal.units)).toBe(1);
    expect(remainingOf(lethal.units, "ACT_FLUTE_VAMPIRE_PS3_DEATH_SURVIVAL")).toEqual([]);
  });

  it("IT-CAT-SURVIVAL-003 [R-INT-01, R-EFF-07] SR-345: 真夏EXの致死耐え5回は致死攻撃1回で5→4になり、次の致死攻撃で4→3になる", () => {
    const holder = holderWith("UNIT_MAO_SUMMER", ["ACT_MAO_SUMMER_EX_DEATH_SURVIVAL"], 50);
    const first = strike(holder);
    expect(first.defeated).toEqual([]);
    expect(hpOf(first.units)).toBe(1);
    expect(survivalConsumptions(first, "ACT_MAO_SUMMER_EX_DEATH_SURVIVAL")).toEqual([
      { before: 5, after: 4 },
    ]);

    const second = strike(first);
    expect(second.defeated).toEqual([]);
    expect(remainingOf(second.units, "ACT_MAO_SUMMER_EX_DEATH_SURVIVAL")).toEqual([3]);
  });

  it("IT-CAT-SURVIVAL-004 [R-INT-01, R-HEAL-01] SR-365・SR-394・SR-419: 攻撃中はHP1で耐え、攻撃の終了後に最大HPの50%／30%／25%を1回だけ回復する", () => {
    for (const [unitDefinitionId, effectActionDefinitionId, currentHp, expectedHp] of [
      ["UNIT_OLGA_VETERAN", "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL", 50, 5001],
      ["UNIT_ROSIE_CAMPAIGN", "ACT_ROSIE_CAMPAIGN_PS2_DEATH_SURVIVAL", 50, 3001],
      ["UNIT_TATIANA_SAGE", "ACT_TATIANA_SAGE_PS1_DEATH_SURVIVAL", 88, 2501],
    ] as const) {
      const observed = strike(holderWith(unitDefinitionId, [effectActionDefinitionId], currentHp));
      expect(observed.defeated).toEqual([]);
      // 66×13＝858は現在HPを超えるため、致死に達したヒット以降はHP1で止まる。
      expect(hpAfterEachHit(observed)).toHaveLength(13);
      expect(Math.min(...hpAfterEachHit(observed))).toBe(1);
      expect(hpAfterEachHit(observed).at(-1)).toBe(1);
      expect(observed.heals).toEqual([
        {
          effectActionDefinitionId,
          targetUnitId: HOLDER,
          healAmount: expectedHp - 1,
          hpBefore: 1,
          hpAfter: expectedHp,
        },
      ]);
      expect(hpOf(observed.units)).toBe(expectedHp);
    }
  });

  it("IT-CAT-SURVIVAL-005 [R-INT-01, R-HEAL-01] SR-222・SR-227: 千鶴PS2・コトハPS2は耐えた時点で1回だけ回復し、同じ攻撃の残りヒットで回復を繰り返さない", () => {
    // 千鶴PS2: 最大HP＋30%後の13000を基準とする75%回復で、単発致死なら1＋9750＝9751。
    const chizuruSingle = strike(
      holderWith(
        "UNIT_CHIZURU_DOMESTIC",
        ["ACT_CHIZURU_DOMESTIC_PS2_MAXHP_UP", "ACT_CHIZURU_DOMESTIC_PS2_DEATH_SURVIVAL"],
        50,
      ),
      { hitCount: 1, power: 4 },
    );
    expect(hpOf(chizuruSingle.units)).toBe(9751);
    // コトハPS2: 最大HP10000の65%で、単発致死なら1＋6500＝6501。
    const kotohaSingle = strike(
      holderWith("UNIT_KOTOHA_REBEL", ["ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL"], 50),
      { hitCount: 1, power: 4 },
    );
    expect(hpOf(kotohaSingle.units)).toBe(6501);

    const kotohaMulti = strike(
      holderWith("UNIT_KOTOHA_REBEL", ["ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL"], 50),
    );
    expect(kotohaMulti.heals).toHaveLength(1);
    expect(kotohaMulti.heals[0]!.hpBefore).toBe(1);
    expect(hpOf(kotohaMulti.units)).toBe(6501 - 66 * 12);
  });

  it("IT-CAT-SURVIVAL-006 [R-INT-01, R-EFF-09] SR-419: タチアナPS1の耐えを使って回復した後も深慮が残る", () => {
    const observed = strike(
      holderWith(
        "UNIT_TATIANA_SAGE",
        ["ACT_TATIANA_SAGE_PS1_DEATH_SURVIVAL", "ACT_TATIANA_SAGE_PS1_PRUDENCE_MARK"],
        88,
      ),
    );
    expect(hpOf(observed.units)).toBe(2501);
    expect(holderOf(observed.units).markerStates.map((marker) => marker.markerId)).toEqual(
      holderOf(
        holderWith("UNIT_TATIANA_SAGE", ["ACT_TATIANA_SAGE_PS1_PRUDENCE_MARK"], 88).units,
      ).markerStates.map((marker) => marker.markerId),
    );
  });

  it("IT-CAT-SURVIVAL-007 [R-INT-01, R-SUB-02] SR-365: サブユニット追加ヒットも同じ攻撃に含め、オルガPS2の回復はその後に1回だけ行う", () => {
    // 唯依AS1（371×3）にリディアPS2「うみのともだちⅢ」の追加85が続く1攻撃。HP50の敵は
    // 本体で致死に達してHP1で耐え、追加ヒットもHP1で止まり、攻撃の終わりに5000回復して5001。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_YUI_HEIR",
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS1" },
      board: {
        enemies: [
          {
            id: "enemy:center",
            position: { column: "CENTER", row: "FRONT" },
            state: { currentHp: 50 },
          },
        ],
      },
      precedingActions: [
        { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", target: "SELF" },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL", target: "ENEMY" },
      ],
    });
    expect(observed.hpDeltas?.["enemy:center"]).toBe(5001 - 50);
  });

  it("IT-CAT-SURVIVAL-008 [R-INT-01, R-SUB-02] SR-219・SR-365: 追加ヒットまで精算を待つ間も、使った耐えを同じスキルの別DAMAGEで再利用しない", () => {
    // 亦菲EXは7ヒットのDAMAGEの後に締めの別DAMAGEを持つ。最初のDAMAGEで耐えたHP50の敵は、
    // 追加ヒットの精算待ちでも、締めのDAMAGEは別の攻撃として防げず倒れる。
    const board = {
      enemies: [
        {
          id: "enemy:center",
          position: { column: "CENTER" as const, row: "FRONT" as const },
          state: { currentHp: 50 } as Partial<BattleUnit>,
        },
      ],
    };
    const yifeiExWith = (survivalEffectActionDefinitionId: string) =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_YIFEI_STORM",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_YIFEI_STORM_EX", actionType: "EX" },
        board,
        precedingActions: [
          { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", target: "SELF" },
          { effectActionDefinitionId: survivalEffectActionDefinitionId, target: "ENEMY" },
        ],
      });
    expect(yifeiExWith("ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL").hpDeltas?.["enemy:center"]).toBe(
      -50,
    );
    // オルガPS2も同じ耐えを締めのDAMAGEへ持ち越さない。回復は追加ヒットの解決後（攻撃の
    // 終わり）のため、締めのDAMAGEで倒れた敵は回復しない。
    expect(yifeiExWith("ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL").hpDeltas?.["enemy:center"]).toBe(-50);
  });

  it("IT-CAT-SURVIVAL-009 [R-INT-01, R-SUB-02, R-LNK-02] SR-219: リンクの派生ダメージで耐えたリンク先は、保留した追加ヒットから派生するダメージでも同じ耐えでHP1に留まる", () => {
    // 唯依AS1（371×3）＋リディアPS2「うみのともだちⅢ」の追加85が敵Aへ向かい、AはBへ75%を
    // 転送する（小花PS2のリンク）。HP50のBはラミPS2の耐えで本体由来の278をHP1で耐え、追加由来の
    // 63も同じ攻撃なのでHP1で止まる。
    const LINK_SOURCE = "enemy:center";
    const LINK_DESTINATION = "enemy:back";
    const board = productionBoard(snapshot, "UNIT_YUI_HEIR", {
      enemies: [
        { id: LINK_SOURCE, position: { column: "CENTER", row: "FRONT" } },
        {
          id: LINK_DESTINATION,
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 50 },
        },
      ],
    });
    const prepared = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT", target: "SELF" },
      { effectActionDefinitionId: "ACT_SHOUKA_BEACH_PS2_DAMAGE_LINK", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL", target: "SELF" },
    ]);
    // 前提アクションの付与者は検証対象のため、リンク先とラミPS2の保持者をBへ付け替える。
    const destinationId = createBattleUnitId(LINK_DESTINATION);
    const survival = holderOf(prepared).appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL",
    )!;
    const units = prepared.map((unit) => {
      if (unit.battleUnitId === HOLDER) {
        return {
          ...unit,
          appliedEffects: unit.appliedEffects.filter((effect) => effect !== survival),
        };
      }
      if (unit.battleUnitId === LINK_SOURCE) {
        return {
          ...unit,
          appliedEffects: unit.appliedEffects.map((effect) =>
            effect.damageLink === undefined
              ? effect
              : {
                  ...effect,
                  sourceUnitId: destinationId,
                  damageLink: { ...effect.damageLink, linkToUnitId: destinationId },
                },
          ),
        };
      }
      if (unit.battleUnitId === LINK_DESTINATION) {
        return {
          ...unit,
          appliedEffects: [
            ...unit.appliedEffects,
            { ...survival, sourceUnitId: destinationId, targetUnitId: destinationId },
          ],
        };
      }
      return unit;
    });
    const skill = snapshot.skills.get(createSkillDefinitionId("SKL_YUI_HEIR_AS1"))!;
    const recorder = new EventRecorder(createBattleId("B_SURVIVAL_LINK"));
    const after = resolveSkillUse(
      units.find((unit) => unit.battleUnitId === HOLDER)!,
      skill,
      "AS",
      "AS",
      units,
      board.definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId("B_SURVIVAL_LINK:action:1"),
      recorder.nextResolutionScopeId(),
    ).units;

    const linkedDamages = recorder
      .getEvents()
      .flatMap((event) =>
        event.eventType === "LinkedDamageGenerated" ? [event.payload.linkedDamage] : [],
      );
    expect(linkedDamages).toEqual([278, 278, 278, 63]);
    expect(after.find((unit) => unit.battleUnitId === LINK_DESTINATION)?.currentHp).toBe(1);
  });
});
