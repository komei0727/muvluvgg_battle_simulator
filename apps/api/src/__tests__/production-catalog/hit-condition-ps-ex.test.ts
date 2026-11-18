import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import { evasionOf } from "../../testing/production-unit/evasion.js";
import {
  hitConditionedSkill,
  hitConditionViolations,
  withEvadingEnemies,
} from "../../testing/production-unit/hit-condition.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeSkillUse,
  type BoardOverrides,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillUse,
  type SkillUseObservation,
} from "../../testing/production-unit/skill-behaviour.js";
import {
  effectApplied,
  realDamage,
  skillUseCompleted,
  turnCompleting,
  turnStarted,
  unitDefeated,
} from "../../testing/production-unit/trigger-events.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * R-SKL-06 #4a（Issue #826）: PS・EXの攻撃後に付く敵へのデバフ・マーカー・継続ダメージ・
 * 状態異常は、そのPS／EX自身の攻撃を全ヒット回避した敵には付かない。反撃・追撃のPSは
 * 元のASではなくPS自身の攻撃の命中で判定する。
 *
 * 各行は評価シートの確定仕様から「命中を条件にする効果」と「回避でも起きる効果」を
 * 宣言する。敵全員が全ヒットを回避する盤面と回避の無い盤面で実`catalog/`を使い、
 * - 回避盤面では命中条件付きの効果が1件も開始されない
 * - 回避盤面でも命中条件の無い効果（自己効果・資源の直接操作）は起きる
 * - 回避の無い盤面では命中条件付きの効果が開始される
 * - どちらの盤面でも、宣言された`hitCondition`の参照先DAMAGEが同じ対象へ命中する前に
 *   条件付きの効果が開始されない
 * を確かめる。
 */

const unitIds = (
  JSON.parse(readFileSync(`${PRODUCTION_CATALOG_DIR}/units.json`, "utf8")) as {
    readonly unitDefinitionId: string;
  }[]
).map((u) => u.unitDefinitionId);
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, unitIds);

interface Row {
  readonly sr: string;
  readonly unitDefinitionId: string;
  readonly use: SkillUse;
  readonly board?: BoardOverrides;
  readonly precedingActions?: readonly PrecedingAction[];
  /** 命中した生存対象にだけ付く効果。 */
  readonly conditioned: readonly string[];
  /** 敵が全ヒットを回避しても起きる効果（自己効果・資源の直接操作）。 */
  readonly unconditioned?: readonly string[];
}

const ex = (skillDefinitionId: string): SkillUse => ({
  kind: "ACTIVE",
  skillDefinitionId,
  actionType: "EX",
});

const ROWS: readonly Row[] = [
  {
    sr: "SR-011",
    unitDefinitionId: "UNIT_EVIE_KYONSHI",
    use: ex("SKL_EVIE_KYONSHI_EX"),
    conditioned: ["ACT_EVIE_KYONSHI_EX_DEBUFF"],
    unconditioned: ["ACT_EVIE_KYONSHI_EX_SELF_BUFF"],
  },
  {
    sr: "SR-012",
    unitDefinitionId: "UNIT_YURIA_YUKATA",
    use: ex("SKL_YURIA_YUKATA_EX"),
    conditioned: ["ACT_YURIA_YUKATA_EX_SPEED_DOWN", "ACT_YURIA_YUKATA_EX_CRIT_DOWN"],
  },
  {
    sr: "SR-020",
    unitDefinitionId: "UNIT_RAMI_NEWYEAR",
    use: ex("SKL_RAMI_NEWYEAR_EX"),
    conditioned: ["ACT_RAMI_NEWYEAR_EX_FREEZE"],
  },
  {
    sr: "SR-031",
    unitDefinitionId: "UNIT_AOI_ELEGANT",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_ELEGANT_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    conditioned: ["ACT_AOI_ELEGANT_PS1_ATK_DOWN"],
  },
  {
    sr: "SR-032",
    unitDefinitionId: "UNIT_MIHIME_SNIPER",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIHIME_SNIPER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:back", skillType: "AS" }),
      triggeredBy: "enemy:front",
    },
    conditioned: ["ACT_MIHIME_SNIPER_PS2_SPD_DOWN"],
  },
  {
    sr: "SR-034",
    unitDefinitionId: "UNIT_YUI_HEIR",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS1",
      trigger: realDamage({ from: "enemy:back", to: "ally:front", skillType: "AS" }),
    },
    conditioned: ["ACT_YUI_HEIR_PS1_DMG_DOWN"],
  },
  {
    sr: "SR-060",
    unitDefinitionId: "UNIT_MERU_SIRIUS",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MERU_SIRIUS_PS2",
      trigger: turnCompleting({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    conditioned: ["ACT_MERU_SIRIUS_PS2_DMG_DOWN"],
  },
  {
    sr: "SR-094",
    unitDefinitionId: "UNIT_KEI_JACKKNIFE",
    use: ex("SKL_KEI_JACKKNIFE_EX"),
    conditioned: ["ACT_KEI_JACKKNIFE_EX_SPEED_DOWN"],
  },
  {
    sr: "SR-095",
    unitDefinitionId: "UNIT_LAURA_MOUNTAIN",
    use: ex("SKL_LAURA_MOUNTAIN_EX"),
    conditioned: ["ACT_LAURA_MOUNTAIN_EX_ATKDOWN"],
  },
  {
    sr: "SR-127",
    unitDefinitionId: "UNIT_MAO_COMMITTEE",
    use: ex("SKL_MAO_COMMITTEE_EX"),
    conditioned: ["ACT_MAO_COMMITTEE_EX_DMG_DOWN"],
  },
  {
    sr: "SR-160",
    unitDefinitionId: "UNIT_ANIS_TROUBLEMAKER",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ANIS_TROUBLEMAKER_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    conditioned: ["ACT_ANIS_TROUBLEMAKER_PS2_CRIT_PREVENTION"],
    unconditioned: ["ACT_ANIS_TROUBLEMAKER_PS2_EVASION"],
  },
  {
    sr: "SR-162",
    unitDefinitionId: "UNIT_CHIYURU_MAZE",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
      trigger: skillUseCompleted({ actor: "ally:front", targets: ["enemy:left"], skillType: "AS" }),
      triggeredBy: "ally:front",
    },
    board: {
      allies: [{ id: "ally:front", position: { column: "LEFT", row: "FRONT" }, attribute: "SHY" }],
    },
    conditioned: ["ACT_CHIYURU_MAZE_PS1_POISON"],
  },
  {
    sr: "SR-163",
    unitDefinitionId: "UNIT_CHIYURU_MAZE",
    use: ex("SKL_CHIYURU_MAZE_EX"),
    // 気絶・被ダメージ増加は攻撃後も状態異常を持つ対象だけ。毒を持たせて条件を満たす。
    precedingActions: [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ],
    conditioned: ["ACT_CHIYURU_MAZE_EX_STUN", "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP"],
  },
  {
    sr: "SR-164",
    unitDefinitionId: "UNIT_CLARA_TSUNDERE",
    use: ex("SKL_CLARA_TSUNDERE_EX"),
    conditioned: ["ACT_CLARA_TSUNDERE_EX_STUN"],
    unconditioned: ["ACT_CLARA_TSUNDERE_EX_PP_ZERO"],
  },
  {
    sr: "SR-165",
    unitDefinitionId: "UNIT_EVIE_ECO",
    use: ex("SKL_EVIE_ECO_EX"),
    conditioned: ["ACT_EVIE_ECO_EX_STUN"],
  },
  {
    sr: "SR-166",
    unitDefinitionId: "UNIT_FEE_ACTOR",
    use: ex("SKL_FEE_ACTOR_EX"),
    conditioned: ["ACT_FEE_ACTOR_EX_BURN"],
  },
  {
    sr: "SR-168",
    unitDefinitionId: "UNIT_KARINA_DOWNER",
    use: ex("SKL_KARINA_DOWNER_EX"),
    conditioned: ["ACT_KARINA_DOWNER_EX_ATKDOWN", "ACT_KARINA_DOWNER_EX_DOT"],
  },
  {
    sr: "SR-170",
    unitDefinitionId: "UNIT_KOTOHA_DAILY",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOTOHA_DAILY_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    conditioned: ["ACT_KOTOHA_DAILY_PS1_FREEZE"],
  },
  {
    sr: "SR-176",
    unitDefinitionId: "UNIT_MEIYA_FATED",
    use: ex("SKL_MEIYA_FATED_EX"),
    conditioned: ["ACT_MEIYA_FATED_EX_STUN"],
    unconditioned: ["ACT_MEIYA_FATED_EX_DMG_REDUCTION"],
  },
  {
    sr: "SR-177",
    unitDefinitionId: "UNIT_MERU_SIRIUS",
    use: ex("SKL_MERU_SIRIUS_EX"),
    conditioned: ["ACT_MERU_SIRIUS_EX_DMG_UP", "ACT_MERU_SIRIUS_EX_STUN"],
  },
  {
    sr: "SR-179",
    unitDefinitionId: "UNIT_MIRIAM_MAGE",
    use: ex("SKL_MIRIAM_MAGE_EX"),
    // 凍結は攻撃後にHP30%以下の命中した生存敵だけ。HPの低い敵を置く。
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    conditioned: ["ACT_MIRIAM_MAGE_EX_DOT_DEBUFF", "ACT_MIRIAM_MAGE_EX_FREEZE"],
  },
  {
    sr: "SR-181",
    unitDefinitionId: "UNIT_SAYA_LONGING",
    use: ex("SKL_SAYA_LONGING_EX"),
    conditioned: ["ACT_SAYA_LONGING_EX_BURN"],
  },
  {
    sr: "SR-183",
    unitDefinitionId: "UNIT_SIENA_DIVA",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_DIVA_PS1",
      trigger: effectApplied({
        source: "ally:subject",
        target: "enemy:front",
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "STUN",
      }),
    },
    conditioned: ["ACT_SIENA_DIVA_PS1_STUN"],
    unconditioned: ["ACT_SIENA_DIVA_PS1_ATK_UP"],
  },
  {
    sr: "SR-184",
    unitDefinitionId: "UNIT_SIENA_DIVA",
    use: ex("SKL_SIENA_DIVA_EX"),
    conditioned: ["ACT_SIENA_DIVA_EX_STUN"],
  },
  {
    sr: "SR-212",
    unitDefinitionId: "UNIT_TARISA_TROUBLEMAKER",
    use: ex("SKL_TARISA_TROUBLEMAKER_EX"),
    conditioned: ["ACT_TARISA_TROUBLEMAKER_EX_ATK_DOWN"],
    unconditioned: ["ACT_TARISA_TROUBLEMAKER_EX_ATK_UP", "ACT_TARISA_TROUBLEMAKER_EX_IMMUNITY"],
  },
  {
    sr: "SR-232",
    unitDefinitionId: "UNIT_SHOUKA_BEACH",
    use: ex("SKL_SHOUKA_BEACH_EX"),
    // AP0の分岐でだけ攻撃力低下が付く。
    board: { subject: { state: { currentAp: 0 } } },
    conditioned: ["ACT_SHOUKA_BEACH_EX_ATK_DOWN"],
    unconditioned: ["ACT_SHOUKA_BEACH_EX_DAMAGE_LINK"],
  },
  {
    sr: "SR-236",
    unitDefinitionId: "UNIT_AOI_GUARDIAN",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    conditioned: ["ACT_AOI_GUARDIAN_PS2_STUN"],
  },
  {
    sr: "SR-240",
    unitDefinitionId: "UNIT_DOROTHEA_GRACE",
    use: ex("SKL_DOROTHEA_GRACE_EX"),
    conditioned: ["ACT_DOROTHEA_GRACE_EX_STUN"],
  },
  {
    sr: "SR-267",
    unitDefinitionId: "UNIT_AOI_ELEGANT",
    use: ex("SKL_AOI_ELEGANT_EX"),
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: "MARKER_AOI_ELEGANT_UKIASHI" }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    conditioned: ["ACT_AOI_ELEGANT_EX_ATK_DOWN"],
    unconditioned: ["ACT_AOI_ELEGANT_EX_CD_RESET"],
  },
  {
    sr: "SR-271",
    unitDefinitionId: "UNIT_CHIYURU_NEWYEAR",
    use: ex("SKL_CHIYURU_NEWYEAR_EX"),
    conditioned: ["ACT_CHIYURU_NEWYEAR_EX_POISON"],
    unconditioned: ["ACT_CHIYURU_NEWYEAR_EX_CD_RESET", "ACT_CHIYURU_NEWYEAR_EX_MOCHI"],
  },
  {
    sr: "SR-283",
    unitDefinitionId: "UNIT_KOTOHA_DAILY",
    use: ex("SKL_KOTOHA_DAILY_EX"),
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentExtraGauge: 3 },
        },
        {
          id: "enemy:left",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentExtraGauge: 3 },
        },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    conditioned: ["ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN_MARKER", "ACT_KOTOHA_DAILY_EX_EX_GAIN_DOWN"],
    unconditioned: ["ACT_KOTOHA_DAILY_EX_EX_DOWN"],
  },
  {
    sr: "SR-309",
    unitDefinitionId: "UNIT_URUU_SUMMER",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_URUU_SUMMER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_URUU_SUMMER_AS1",
      }),
      triggeredBy: "ally:subject",
    },
    conditioned: ["ACT_URUU_SUMMER_PS1_DEF_DOWN_MARKER", "ACT_URUU_SUMMER_PS1_DEF_DOWN"],
    unconditioned: ["ACT_URUU_SUMMER_PS1_SELF_DMG_DOWN"],
  },
  {
    sr: "SR-339",
    unitDefinitionId: "UNIT_HIIRO_FREEWOLF",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_FREEWOLF_PS2",
      trigger: { eventType: "TurnStarted", category: "FACT", payload: { turnNumber: 1 } },
    },
    conditioned: ["ACT_HIIRO_FREEWOLF_PS2_MARKER_BRAND"],
  },
  {
    sr: "SR-358",
    unitDefinitionId: "UNIT_NADYA_SUCCESSOR",
    use: ex("SKL_NADYA_SUCCESSOR_EX"),
    conditioned: ["ACT_NADYA_SUCCESSOR_EX_STUN"],
    unconditioned: ["ACT_NADYA_SUCCESSOR_EX_TRAINING_MARK", "ACT_NADYA_SUCCESSOR_EX_SUBUNIT"],
  },
  {
    sr: "SR-361",
    unitDefinitionId: "UNIT_OLGA_NADYA_BOND",
    use: ex("SKL_OLGA_NADYA_BOND_EX"),
    conditioned: [
      "ACT_OLGA_NADYA_BOND_EX_STUN",
      "ACT_OLGA_NADYA_BOND_EX_DEF_DOWN_MARKER",
      "ACT_OLGA_NADYA_BOND_EX_DEF_DOWN",
    ],
  },
  {
    sr: "SR-367",
    unitDefinitionId: "UNIT_SHIRANA_SORA",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_SHIRANA_SORA_PS1")]: {
              [createRuntimeCounterId("SKL_SHIRANA_SORA_PS1_TRIGGER_COUNT")]: {
                value: 1,
                carry: 0,
              },
            },
          },
        },
      },
    },
    conditioned: ["ACT_SHIRANA_SORA_PS1_OUTGOING_DOWN"],
  },
  {
    sr: "SR-379",
    unitDefinitionId: "UNIT_YURIA_JOKER",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_JOKER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_YURIA_JOKER_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_YURIA_JOKER_PS1")]: {
              [createRuntimeCounterId("SKL_YURIA_JOKER_PS1_TRIGGER_COUNT")]: { value: 2, carry: 0 },
            },
          },
        },
      },
    },
    conditioned: ["ACT_YURIA_JOKER_PS1_INCOMING_DMG_UP"],
  },
  {
    sr: "SR-384",
    unitDefinitionId: "UNIT_KOKORO_SPORTSDAY",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KOKORO_SPORTSDAY_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    // 与ダメージ低下はストイック中だけ付く。
    board: { subject: { markers: [{ markerId: "MARKER_KOKORO_SPORTSDAY_STOIC" }] } },
    conditioned: ["ACT_KOKORO_SPORTSDAY_PS2_DMG_DOWN"],
  },
  {
    sr: "SR-389",
    unitDefinitionId: "UNIT_RAVEL_MODEL",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAVEL_MODEL_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:left" }),
      triggeredBy: "enemy:left",
    },
    conditioned: ["ACT_RAVEL_MODEL_PS1_MARK", "ACT_RAVEL_MODEL_PS1_DMG_UP_DEBUFF"],
  },
  {
    sr: "SR-391",
    unitDefinitionId: "UNIT_RAVEL_MODEL",
    use: ex("SKL_RAVEL_MODEL_EX"),
    conditioned: ["ACT_RAVEL_MODEL_EX_MARK", "ACT_RAVEL_MODEL_EX_DMG_UP_DEBUFF"],
  },
  {
    sr: "SR-399",
    unitDefinitionId: "UNIT_LYDIA_GENIUS",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    conditioned: ["ACT_LYDIA_GENIUS_PS2_HEALING_DOWN"],
    unconditioned: ["ACT_LYDIA_GENIUS_PS2_PP_DOWN"],
  },
  {
    sr: "SR-415",
    unitDefinitionId: "UNIT_NINA_ZINA_FRONTRUNNER",
    use: ex("SKL_NINA_ZINA_FRONTRUNNER_EX"),
    conditioned: [
      "ACT_NINA_ZINA_FRONTRUNNER_EX_DEBUFF_MARKER",
      "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_DOWN",
      "ACT_NINA_ZINA_FRONTRUNNER_EX_ATK_BUFF_SEAL",
    ],
    unconditioned: ["ACT_NINA_ZINA_FRONTRUNNER_EX_AP_UP"],
  },
  {
    sr: "SR-420",
    unitDefinitionId: "UNIT_TATIANA_SAGE",
    use: ex("SKL_TATIANA_SAGE_EX"),
    // 既存の凶兆2個以上なら低下、未満なら凶兆+1だけ。両方の枝を盤面に置く。
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: "MARKER_TATIANA_SAGE_OMEN", stackCount: 2 }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    conditioned: ["ACT_TATIANA_SAGE_EX_DEBUFF", "ACT_TATIANA_SAGE_EX_MARK"],
  },
];

/**
 * 効果の適用が開始されたか。命中条件で除外された適用はイベントごと現れない。結果種別は
 * 問わない（回避でも起きる自己効果は、対象のクールタイムが既に0なら`SKIPPED`で終わる）。
 */
function started(observation: SkillUseObservation, effectActionDefinitionId: string): boolean {
  return (observation.actions ?? []).some(
    (action) => action.effectActionDefinitionId === effectActionDefinitionId,
  );
}

function observe(row: Row, board: BoardOverrides): SkillUseObservation {
  return observeSkillUse({
    snapshot,
    unitDefinitionId: row.unitDefinitionId,
    use: row.use,
    board,
    ...(row.precedingActions === undefined ? {} : { precedingActions: row.precedingActions }),
  });
}

describe("production PS/EX hitCondition (R-SKL-06 #4a, Issue #826)", () => {
  it.each(ROWS.map((row) => [row.sr, row.use.skillDefinitionId, row] as const))(
    "IT-CAT-HITCOND-002 [R-SKL-06]: %s %s attaches its follow-up effects only to targets its own attack hit",
    (_sr, _skillId, row) => {
      const declared = hitConditionedSkill(snapshot, row.use.skillDefinitionId);
      expect(declared, "the skill declares hitCondition on its follow-up effects").toBeDefined();
      expect([...declared!.conditions.keys()].sort()).toEqual([...row.conditioned].sort());

      const evaded = observe(row, withEvadingEnemies(row.board));
      expect(evaded.activated).toBeUndefined();
      expect(row.conditioned.filter((id) => started(evaded, id))).toEqual([]);
      expect((row.unconditioned ?? []).filter((id) => !started(evaded, id))).toEqual([]);
      expect(hitConditionViolations(declared!, evaded.actions ?? [])).toEqual([]);

      const hit = observe(row, row.board ?? {});
      expect(row.conditioned.filter((id) => !started(hit, id))).toEqual([]);
      expect(hitConditionViolations(declared!, hit.actions ?? [])).toEqual([]);
    },
  );

  const enemies = (
    overrides: Partial<Record<"front" | "left" | "back", BoardUnitSpec["state"]>>,
  ): BoardOverrides => ({
    enemies: [
      {
        id: "enemy:front",
        position: { column: "CENTER", row: "FRONT" },
        state: overrides.front ?? {},
      },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: overrides.left ?? {} },
      {
        id: "enemy:back",
        position: { column: "CENTER", row: "BACK" },
        state: overrides.back ?? {},
      },
    ],
  });
  const appliedTo = (observation: SkillUseObservation, effectActionDefinitionId: string) =>
    (observation.effectsApplied ?? [])
      .filter((effect) => effect.effectActionDefinitionId === effectActionDefinitionId)
      .map((effect) => effect.unitId);

  it("IT-CAT-HITCOND-003 [R-SKL-06] (SR-095): 全体EXで命中・回避・撃破が混在しても、攻撃力低下は命中した生存対象だけに付く", () => {
    // 1体あたり521ダメージ。前列は回避、左は撃破、後列だけが命中して生き残る。
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_LAURA_MOUNTAIN",
      use: ex("SKL_LAURA_MOUNTAIN_EX"),
      board: enemies({
        front: { appliedEffects: [evasionOf("enemy:front")] },
        left: { currentHp: 300 },
      }),
    });

    expect(appliedTo(observation, "ACT_LAURA_MOUNTAIN_EX_ATKDOWN")).toEqual(["enemy:back"]);
  });

  it.each([
    { currentHp: 3300, frozen: true, note: "攻撃前33%・攻撃後2832（28.32%）" },
    { currentHp: 3468, frozen: true, note: "攻撃後ちょうど30%" },
    { currentHp: 3469, frozen: false, note: "攻撃後30%超" },
    { currentHp: 400, frozen: false, note: "撃破" },
  ])(
    "IT-CAT-HITCOND-004 [R-SKL-06] (SR-179): ミリアムEXの凍結対象は攻撃後のHPで選ぶ（$note）",
    ({ currentHp, frozen }) => {
      const observation = observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_MIRIAM_MAGE",
        use: ex("SKL_MIRIAM_MAGE_EX"),
        board: enemies({ front: { currentHp } }),
      });

      expect(appliedTo(observation, "ACT_MIRIAM_MAGE_EX_FREEZE")).toEqual(
        frozen ? ["enemy:front"] : [],
      );
    },
  );

  it("IT-CAT-HITCOND-005 [R-SKL-06] (SR-179): 攻撃後HP30%以下の敵でも、EXを回避していれば凍結も継続ダメージも付かない", () => {
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MIRIAM_MAGE",
      use: ex("SKL_MIRIAM_MAGE_EX"),
      board: enemies({ front: { currentHp: 2000, appliedEffects: [evasionOf("enemy:front")] } }),
    });

    expect(appliedTo(observation, "ACT_MIRIAM_MAGE_EX_FREEZE")).toEqual([]);
    expect(appliedTo(observation, "ACT_MIRIAM_MAGE_EX_DOT_DEBUFF")).toEqual([
      "enemy:left",
      "enemy:back",
    ]);
  });

  it("IT-CAT-HITCOND-006 [R-SKL-06, R-PS-01] (SR-094): 回避した敵への速度低下は起きず、それを契機とするPS2追撃も無い。正しく付与した別対象からのPS2反応は残る", () => {
    const partlyEvaded = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_KEI_JACKKNIFE",
      use: ex("SKL_KEI_JACKKNIFE_EX"),
      board: enemies({ front: { appliedEffects: [evasionOf("enemy:front")] } }),
    });
    expect(appliedTo(partlyEvaded, "ACT_KEI_JACKKNIFE_EX_SPEED_DOWN")).toEqual([
      "enemy:left",
      "enemy:back",
    ]);
    // 最初に正しく付与した対象（左）への追撃が1回だけ出る。
    expect(
      (partlyEvaded.actions ?? []).filter(
        (action) => action.effectActionDefinitionId === "ACT_KEI_JACKKNIFE_PS2_DAMAGE",
      ),
    ).toEqual([
      { effectActionDefinitionId: "ACT_KEI_JACKKNIFE_PS2_DAMAGE", targets: ["enemy:left"] },
    ]);

    const allEvaded = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_KEI_JACKKNIFE",
      use: ex("SKL_KEI_JACKKNIFE_EX"),
      board: withEvadingEnemies(),
    });
    expect(started(allEvaded, "ACT_KEI_JACKKNIFE_PS2_DAMAGE")).toBe(false);
  });

  it("IT-CAT-HITCOND-007 [R-SKL-06, R-PS-01] (SR-184): EXを回避されたら気絶は付かず、気絶を契機とするPS1も発動しない。命中時のPS1連鎖は残る", () => {
    const evaded = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_SIENA_DIVA",
      use: ex("SKL_SIENA_DIVA_EX"),
      board: withEvadingEnemies(),
    });
    expect(started(evaded, "ACT_SIENA_DIVA_EX_STUN")).toBe(false);
    expect(started(evaded, "ACT_SIENA_DIVA_PS1_DAMAGE")).toBe(false);

    const hit = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_SIENA_DIVA",
      use: ex("SKL_SIENA_DIVA_EX"),
    });
    expect(appliedTo(hit, "ACT_SIENA_DIVA_EX_STUN")).toEqual(["enemy:front"]);
    expect(started(hit, "ACT_SIENA_DIVA_PS1_DAMAGE")).toBe(true);
  });

  it("IT-CAT-HITCOND-008 [R-SKL-06] (SR-164, SR-399): 現在PPの直接操作は回避でも行い、気絶・回復量低下だけが付かない", () => {
    const clara = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_CLARA_TSUNDERE",
      use: ex("SKL_CLARA_TSUNDERE_EX"),
      board: withEvadingEnemies(),
    });
    expect(appliedTo(clara, "ACT_CLARA_TSUNDERE_EX_STUN")).toEqual([]);
    expect(clara.resources).toContainEqual({ unitId: "enemy:front", resource: "PP", delta: -4 });

    const lydia = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_LYDIA_GENIUS",
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
        trigger: turnStarted({ turnNumber: 1 }),
        triggeredBy: "ally:subject",
      },
      board: withEvadingEnemies(),
    });
    expect(appliedTo(lydia, "ACT_LYDIA_GENIUS_PS2_HEALING_DOWN")).toEqual([]);
    expect(lydia.resources).toContainEqual({ unitId: "enemy:back", resource: "PP", delta: -2 });
  });

  it.each([
    { evadedHits: undefined, debuffed: false, enemyHp: undefined },
    { evadedHits: 9, debuffed: true, enemyHp: -116 },
  ])(
    "IT-CAT-HITCOND-009 [R-SKL-06] (SR-212): タリサEXの10ヒットのうち先頭$evadedHitsヒット（未指定は全て）を回避した敵への攻撃力低下は、1ヒット以上命中したときだけ付く。自己効果は回避と独立",
    ({ evadedHits, debuffed, enemyHp }) => {
      const observation = observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_TARISA_TROUBLEMAKER",
        use: ex("SKL_TARISA_TROUBLEMAKER_EX"),
        board: enemies({ front: { appliedEffects: [evasionOf("enemy:front", evadedHits)] } }),
      });

      expect(appliedTo(observation, "ACT_TARISA_TROUBLEMAKER_EX_ATK_DOWN")).toEqual(
        debuffed ? ["enemy:front"] : [],
      );
      expect(appliedTo(observation, "ACT_TARISA_TROUBLEMAKER_EX_ATK_UP")).toEqual(["ally:subject"]);
      expect(observation.hpDeltas?.["enemy:front"]).toBe(enemyHp);
    },
  );

  it("IT-CAT-HITCOND-010 [R-SKL-06] (SR-127): マオEXは命中した対象にだけ与ダメージ低下を付け、全回避なら吸収回復も0", () => {
    const partlyEvaded = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MAO_COMMITTEE",
      use: ex("SKL_MAO_COMMITTEE_EX"),
      board: enemies({ left: { appliedEffects: [evasionOf("enemy:left")] } }),
    });
    expect(appliedTo(partlyEvaded, "ACT_MAO_COMMITTEE_EX_DMG_DOWN").sort()).toEqual([
      "enemy:back",
      "enemy:front",
    ]);

    const allEvaded = observeSkillUse({
      snapshot,
      unitDefinitionId: "UNIT_MAO_COMMITTEE",
      use: ex("SKL_MAO_COMMITTEE_EX"),
      board: withEvadingEnemies(),
    });
    expect(appliedTo(allEvaded, "ACT_MAO_COMMITTEE_EX_DMG_DOWN")).toEqual([]);
    expect(allEvaded.hpDeltas?.["ally:subject"]).toBeUndefined();
  });
});
