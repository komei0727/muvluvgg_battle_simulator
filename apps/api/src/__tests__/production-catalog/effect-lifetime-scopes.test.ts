import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import {
  judgeEffectLifetimes,
  type EffectLifetime,
} from "../../testing/production-unit/effect-lifetime.js";
import { runProductionPartyBattle } from "../../testing/scenario/run-production-battle.js";

/**
 * R-EFF-04/06（Issue #829）: 効果は宣言した時計で終わる。付与ターン末・契機になった敵の
 * 行動末・付与したスキル使用の末・保持者自身の次の行動末・戦闘終了（永続）を混同しない。
 *
 * 実`catalog/`の実ユニットで実戦闘を完走させ、ログ上の各効果インスタンスについて
 * 「付与から終了（失効・解除）までの位置」を時計ごとの不変条件で検査する。戦闘の
 * 組み合わせは、対象の全定義が少なくとも1回付与されるように選んである（網羅は
 * IT-CAT-LIFETIME-001 が確かめる）。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

interface Row {
  readonly sr: string;
  readonly lifetime: EffectLifetime;
  readonly effectActionDefinitionIds: readonly string[];
}

const ROWS: readonly Row[] = [
  {
    sr: "SR-027",
    lifetime: "PERMANENT",
    effectActionDefinitionIds: ["ACT_SHOUKA_SCHEMER_AS2_ATK_DOWN", "ACT_SHOUKA_SCHEMER_AS2_DEF_UP"],
  },
  {
    sr: "SR-028",
    lifetime: "PERMANENT",
    effectActionDefinitionIds: [
      "ACT_MIHIME_SNIPER_AS1_SPD_DOWN1",
      "ACT_MIHIME_SNIPER_AS1_SPD_DOWN2",
      "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
    ],
  },
  {
    sr: "SR-029",
    lifetime: "PERMANENT",
    effectActionDefinitionIds: [
      "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
      "ACT_MIHIME_SNIPER_AS2_SELF_SPD_DOWN",
    ],
  },
  {
    sr: "SR-046",
    lifetime: "HOLDER_NEXT_ACTION",
    effectActionDefinitionIds: ["ACT_CLARA_TSUNDERE_PS1_DEF_DOWN"],
  },
  {
    sr: "SR-058",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: [
      "ACT_SIENA_DIVA_PS2_ALLY_CRIT_UP",
      "ACT_SIENA_DIVA_PS2_ENEMY_CRITDMG_DOWN",
    ],
  },
  {
    sr: "SR-077",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_ELENA_MOODMAKER_PS2_ATK_UP"],
  },
  {
    sr: "SR-082",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: ["ACT_SHOUKA_BEACH_PS1_DEF_UP"],
  },
  {
    sr: "SR-113",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: ["ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL"],
  },
  {
    sr: "SR-183",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_SIENA_DIVA_PS1_ATK_UP"],
  },
  {
    sr: "SR-193",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: [
      "ACT_LAYLA_NURSE_PS3_STEALTH",
      "ACT_LAYLA_NURSE_PS3_THRESHOLD_DMG_DOWN",
    ],
  },
  {
    sr: "SR-213",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_YUI_HEIR_EX_DEF_DOWN"],
  },
  {
    sr: "SR-216",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: ["ACT_EVIE_ECO_PS1_REDIRECT", "ACT_EVIE_ECO_PS1_COVER"],
  },
  {
    sr: "SR-217",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: [
      "ACT_LUNA_HUNGRY_PS1_REDIRECT",
      "ACT_LUNA_HUNGRY_PS1_COVER",
      "ACT_LUNA_HUNGRY_PS1_REFLECT",
    ],
  },
  {
    sr: "SR-218",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: [
      "ACT_NANAE_SOVEREIGN_PS1_REDIRECT",
      "ACT_NANAE_SOVEREIGN_PS1_COVER",
    ],
  },
  {
    sr: "SR-221",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: ["ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK"],
  },
  {
    sr: "SR-223",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: [
      "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST",
      "ACT_DOROTHEA_PIONEER_PS1_LINK_TO_NEAREST",
    ],
  },
  {
    sr: "SR-233",
    lifetime: "GRANTING_TURN",
    effectActionDefinitionIds: [
      "ACT_URUU_SUMMER_PS3_EVASION",
      "ACT_URUU_SUMMER_PS3_DEATH_SURVIVAL",
      "ACT_URUU_SUMMER_PS3_DMG_UP",
      "ACT_URUU_SUMMER_PS3_CRIT_DAMAGE_UP",
    ],
  },
  {
    sr: "SR-237",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_CHIYURU_MAZE_AS1_DEF_DOWN"],
  },
  {
    sr: "SR-347",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: [
      "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
      "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
      "ACT_KARINA_DOWNER_PS1_REDIRECT",
      "ACT_KARINA_DOWNER_PS1_COVER",
    ],
  },
  {
    sr: "SR-351",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_NANAE_SOVEREIGN_EX_ATK_UP"],
  },
  {
    sr: "SR-364",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_OLGA_VETERAN_PS1_ATK_UP"],
  },
  {
    sr: "SR-377",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_YURIA_JOKER_AS1_DEF_DOWN"],
  },
  {
    sr: "SR-378",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_YURIA_JOKER_AS2_DEF_DOWN"],
  },
  {
    sr: "SR-381",
    lifetime: "GRANTING_SKILL_USE",
    effectActionDefinitionIds: ["ACT_YURIA_JOKER_EX_DEF_DOWN"],
  },
  {
    sr: "SR-395",
    lifetime: "GRANTING_ACTION",
    effectActionDefinitionIds: ["ACT_ROSIE_CAMPAIGN_PS3_DMG_DOWN"],
  },
];

interface Matchup {
  readonly ally: readonly string[];
  readonly enemy: readonly string[];
  readonly randomValue: number;
}

const MATCHUPS: readonly Matchup[] = [
  {
    ally: [
      "UNIT_YURIA_JOKER",
      "UNIT_EVIE_ECO",
      "UNIT_CHIZURU_DOMESTIC",
      "UNIT_SIENA_DIVA",
      "UNIT_KARINA_DOWNER",
    ],
    enemy: [
      "UNIT_ROSIE_CAMPAIGN",
      "UNIT_URUU_SUMMER",
      "UNIT_NANAE_SOVEREIGN",
      "UNIT_LUNA_HUNGRY",
      "UNIT_MIHIME_SNIPER",
    ],
    randomValue: 0.8,
  },
  {
    ally: [
      "UNIT_HARRIET_SAGE",
      "UNIT_SHOUKA_SCHEMER",
      "UNIT_EVIE_ECO",
      "UNIT_CLARA_TSUNDERE",
      "UNIT_NANAE_SOVEREIGN",
    ],
    enemy: [
      "UNIT_ROSIE_CAMPAIGN",
      "UNIT_KARINA_DOWNER",
      "UNIT_DOROTHEA_PIONEER",
      "UNIT_CHIZURU_DOMESTIC",
      "UNIT_YURIA_JOKER",
    ],
    randomValue: 0.8,
  },
  {
    ally: [
      "UNIT_NANAE_SOVEREIGN",
      "UNIT_LAYLA_NURSE",
      "UNIT_YURIA_JOKER",
      "UNIT_LUNA_HUNGRY",
      "UNIT_CHIZURU_DOMESTIC",
    ],
    enemy: [
      "UNIT_ELENA_MOODMAKER",
      "UNIT_YUI_HEIR",
      "UNIT_CLARA_TSUNDERE",
      "UNIT_OLGA_VETERAN",
      "UNIT_HARRIET_SAGE",
    ],
    randomValue: 0.8,
  },
  {
    ally: [
      "UNIT_CHIZURU_DOMESTIC",
      "UNIT_YURIA_JOKER",
      "UNIT_NANAE_SOVEREIGN",
      "UNIT_EVIE_ECO",
      "UNIT_ROSIE_CAMPAIGN",
    ],
    enemy: [
      "UNIT_CHIYURU_MAZE",
      "UNIT_HARRIET_SAGE",
      "UNIT_SHOUKA_BEACH",
      "UNIT_URUU_SUMMER",
      "UNIT_LUNA_HUNGRY",
    ],
    randomValue: 0.2,
  },
  {
    ally: ["UNIT_ROSIE_CAMPAIGN", "UNIT_NANAE_SOVEREIGN", "UNIT_YURIA_JOKER"],
    enemy: ["UNIT_EVIE_ECO", "UNIT_SIENA_DIVA", "UNIT_CHIZURU_DOMESTIC"],
    randomValue: 0.8,
  },
  {
    ally: [
      "UNIT_CHIYURU_MAZE",
      "UNIT_MIHIME_SNIPER",
      "UNIT_LAYLA_NURSE",
      "UNIT_NANAE_SOVEREIGN",
      "UNIT_KARINA_DOWNER",
    ],
    enemy: [
      "UNIT_YURIA_JOKER",
      "UNIT_SHOUKA_SCHEMER",
      "UNIT_HARRIET_SAGE",
      "UNIT_OLGA_VETERAN",
      "UNIT_SIENA_DIVA",
    ],
    randomValue: 0.5,
  },
];

function detailsOf(event: BattleLogEvent): Readonly<Record<string, unknown>> {
  return event.details as Readonly<Record<string, unknown>>;
}

const battles: readonly (readonly BattleLogEvent[])[] = MATCHUPS.map(
  (matchup, index) =>
    runProductionPartyBattle(
      CATALOG_DIR,
      { ally: matchup.ally, enemy: matchup.enemy },
      { turnLimit: 8, randomValue: matchup.randomValue, battleId: `B_LIFETIME_${index + 1}` },
    ).events,
);

function verdictsOf(row: Row) {
  const definitionIds = new Set(row.effectActionDefinitionIds);
  return battles.flatMap((events) => judgeEffectLifetimes(events, definitionIds, row.lifetime));
}

describe("Effect lifetimes end on the declared clock (Issue #829)", () => {
  it("IT-CAT-LIFETIME-001 [R-EFF-04]: the battle set reaches the end point of every listed definition at least once", () => {
    const exercised = new Set(
      ROWS.flatMap((row) =>
        verdictsOf(row)
          .filter((verdict) => verdict.exercised)
          .map((verdict) => verdict.effectActionDefinitionId),
      ),
    );
    const missing = ROWS.flatMap((row) => row.effectActionDefinitionIds).filter(
      (id) => !exercised.has(id),
    );
    expect(missing).toEqual([]);
  });

  it.each(ROWS.map((row) => [row.sr, row] as const))(
    "IT-CAT-LIFETIME-002 [R-EFF-04, R-EFF-06]: %s ends each instance on its declared clock",
    (_sr, row) => {
      const violations = verdictsOf(row).flatMap((verdict) =>
        verdict.violation === undefined ? [] : [verdict.violation],
      );
      expect(violations).toEqual([]);
    },
  );

  /**
   * SR-135: 白那（ラッキー）EXのシールドは付与したEX自身の行動終了では減らず、保持者の
   * 次の行動終了から付与時最大値の25%ずつ減る。
   */
  it("IT-CAT-LIFETIME-003 [R-SHD-01]: SKL_SHIRANA_LUCKY_EX's shield first decays on the holder's next action, by 25% of its maximum", () => {
    const events = runProductionPartyBattle(
      CATALOG_DIR,
      {
        ally: ["UNIT_SHIRANA_LUCKY", "UNIT_HARRIET_SAGE"],
        enemy: ["UNIT_SHIRANA_LUCKY", "UNIT_HARRIET_SAGE"],
      },
      { turnLimit: 8, randomValue: 0.5, battleId: "B_LIFETIME_SHIELD" },
    ).events;
    const grants = events.filter(
      (event) =>
        event.type === "EFFECT_APPLIED" &&
        detailsOf(event)["effectActionDefinitionId"] === "ACT_SHIRANA_LUCKY_EX_SHIELD",
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      const holder = detailsOf(grant)["targetUnitId"];
      const firstDecay = events.find(
        (event) =>
          event.type === "SHIELD_CONSUMED" &&
          event.sequence > grant.sequence &&
          detailsOf(event)["reason"] === "DECAY" &&
          detailsOf(event)["battleUnitId"] === holder,
      );
      if (firstDecay === undefined) {
        continue;
      }
      const holderNextAction = events.find(
        (event) =>
          event.type === "ACTION_STARTED" &&
          event.sequence > grant.sequence &&
          event.actionId !== grant.actionId &&
          detailsOf(event)["actorUnitId"] === holder,
      );
      expect(firstDecay.actionId).toBe(holderNextAction?.actionId);
      expect(detailsOf(firstDecay)["absorbed"]).toBe(
        Math.trunc((detailsOf(grant)["magnitude"] as number) * 0.25),
      );
    }
  });

  /**
   * SR-377/378/381: 呼応0個の防御低下（効果量0）はバフにもデバフにも数えない。
   */
  it("IT-CAT-LIFETIME-004 [R-EFF-02]: a zero-valued SKL_YURIA_JOKER defense reduction is classified as neither BUFF nor DEBUFF", () => {
    const events = runProductionPartyBattle(
      CATALOG_DIR,
      {
        ally: ["UNIT_SIENA_DIVA", "UNIT_HARRIET_SAGE", "UNIT_LAYLA_NURSE"],
        enemy: ["UNIT_YURIA_JOKER", "UNIT_HARRIET_SAGE", "UNIT_LAYLA_NURSE"],
      },
      { turnLimit: 8, randomValue: 0.5, battleId: "B_LIFETIME_ZERO" },
    ).events;
    const reductions = events
      .filter(
        (event) =>
          event.type === "EFFECT_APPLIED" &&
          /^ACT_YURIA_JOKER_(AS1|AS2|EX)_DEF_DOWN$/.test(
            detailsOf(event)["effectActionDefinitionId"] as string,
          ),
      )
      .map((event) => ({
        zero: detailsOf(event)["magnitude"] === 0,
        categories: detailsOf(event)["categories"],
      }));
    expect(reductions.some((reduction) => reduction.zero)).toBe(true);
    expect(reductions.some((reduction) => !reduction.zero)).toBe(true);
    for (const reduction of reductions) {
      expect(reduction.categories).toEqual(reduction.zero ? [] : ["DEBUFF"]);
    }
  });
});
