import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import type { FullObservationBattleResult, FullObservationExerciseResult } from "./run-scenario.js";
import { runProductionExerciseBattle, runProductionPartyBattle } from "./run-production-battle.js";

/**
 * スキルレビュー（Issue #824）の対象だった通常ユニット84体。レビュー対象コミット
 * `4943e671` 時点の範囲で固定し、後から追加されたユニットを段階Gの完了件数へ含めない。
 */
export const REVIEWED_UNIT_IDS: readonly string[] = [
  "UNIT_ANIS_SWEETDEVIL",
  "UNIT_ANIS_TROUBLEMAKER",
  "UNIT_AOI_ELEGANT",
  "UNIT_AOI_GUARDIAN",
  "UNIT_CHIYURU_MAZE",
  "UNIT_CHIYURU_NEWYEAR",
  "UNIT_CHIZURU_DOMESTIC",
  "UNIT_CLARA_SANTA",
  "UNIT_CLARA_TSUNDERE",
  "UNIT_YIFEI_STORM",
  "UNIT_DOROTHEA_GRACE",
  "UNIT_DOROTHEA_PIONEER",
  "UNIT_ELENA_MOODMAKER",
  "UNIT_EVIE_ECO",
  "UNIT_EVIE_KYONSHI",
  "UNIT_FEE_ACTOR",
  "UNIT_FEE_BATH",
  "UNIT_FLUTE_INFLUENCER",
  "UNIT_FLUTE_VAMPIRE",
  "UNIT_HARRIET_SAGE",
  "UNIT_HIIRO_FREEWOLF",
  "UNIT_HIIRO_LONEWOLF",
  "UNIT_JULIE_SNOW",
  "UNIT_JUNKA_CHILDHOOD",
  "UNIT_KARINA_DOWNER",
  "UNIT_KATE_PALADIN",
  "UNIT_KEI_JACKKNIFE",
  "UNIT_KOKORO_SPORTSDAY",
  "UNIT_KOTOHA_DAILY",
  "UNIT_KOTOHA_REBEL",
  "UNIT_LAURA_MOUNTAIN",
  "UNIT_LAYLA_ENTREPRENEUR",
  "UNIT_LAYLA_NURSE",
  "UNIT_LILY_HERO",
  "UNIT_LILY_SINGER",
  "UNIT_LUCIE_COMPANION",
  "UNIT_LUCIE_MAID",
  "UNIT_LUNA_HUNGRY",
  "UNIT_LYDIA_GENIUS",
  "UNIT_LYDIA_SUMMER",
  "UNIT_MAIA_LAZY",
  "UNIT_MAIA_SALON",
  "UNIT_MAO_COMMITTEE",
  "UNIT_MAO_SUMMER",
  "UNIT_MEIYA_FATED",
  "UNIT_MERU_BESIDE",
  "UNIT_MERU_FLATSPIN",
  "UNIT_MERU_SIRIUS",
  "UNIT_MIHIME_SNIPER",
  "UNIT_MIRIAM_MAGE",
  "UNIT_NADYA_SUCCESSOR",
  "UNIT_NANAE_COMMANDER",
  "UNIT_NANAE_SOVEREIGN",
  "UNIT_NINA_ZINA_FRONTRUNNER",
  "UNIT_NOEL_RUMBLE",
  "UNIT_OLGA_NADYA_BOND",
  "UNIT_OLGA_VETERAN",
  "UNIT_RAMI_NEWYEAR",
  "UNIT_RAMI_UNYIELDING",
  "UNIT_RAVEL_MODEL",
  "UNIT_ROSIE_ARTIST",
  "UNIT_ROSIE_CAMPAIGN",
  "UNIT_SAYA_BUNNY",
  "UNIT_SAYA_LONGING",
  "UNIT_SENKA_CHRISTMAS",
  "UNIT_SENKA_SCHEMER",
  "UNIT_SHIRANA_LUCKY",
  "UNIT_SHIRANA_SORA",
  "UNIT_SHOUKA_BEACH",
  "UNIT_SHOUKA_SCHEMER",
  "UNIT_SIENA_DIVA",
  "UNIT_SIENA_OFFSTAGE",
  "UNIT_STELLA_STATUE",
  "UNIT_SUIRAN_CASINO",
  "UNIT_SUIRAN_CHAOS",
  "UNIT_TARISA_TROUBLEMAKER",
  "UNIT_TATIANA_SAGE",
  "UNIT_URUU_SUMMER",
  "UNIT_URUU_TIMID",
  "UNIT_MIKOTO_SURVIVOR",
  "UNIT_YUI_HEIR",
  "UNIT_YURIA_JOKER",
  "UNIT_YURIA_WILDCARD",
  "UNIT_YURIA_YUKATA",
];

/** 段階Gの1戦闘。乱数は `(seed, runIndex)` だけで決まる。 */
export type StageGScenario =
  | {
      readonly scenarioId: string;
      readonly kind: "EXERCISE";
      readonly ally: readonly string[];
      readonly enemyUnitDefinitionId: string;
      readonly runIndex: number;
    }
  | {
      readonly scenarioId: string;
      readonly kind: "PARTY";
      readonly ally: readonly string[];
      readonly enemy: readonly string[];
      readonly runIndex: number;
    };

export const STAGE_G_SEED = "issue-840-stage-g";
const PARTY_SIZE = 5;
const PARTY_TURN_LIMIT = 10;

/**
 * 84体を5体ずつ区切る並べ方。歩幅ごとに同じユニットが別の組み合わせで並ぶため、
 * 1つの並べ方では隣り合わない味方同士の連鎖（PS競合・付与先の重なり）も通る。
 */
const GROUPING_STRIDES = [1, 7, 13, 29] as const;

/**
 * 並べ方の巡回では条件が揃わず一度も発動しなかったPSを、実際に発動する編成で通す。
 * どれも探索で見つけた具体的な盤面で、発動条件そのもの（味方のチャージ開始・
 * 自身への状態異常・被ダメージ累計・自身HP20%未満）が成立する。
 */
const FOCUSED_SCENARIOS: readonly StageGScenario[] = [
  {
    scenarioId: "FOCUS-HARRIET-CHARGE",
    kind: "EXERCISE",
    ally: ["UNIT_HARRIET_SAGE", "UNIT_MIRIAM_MAGE", "UNIT_SIENA_OFFSTAGE"],
    enemyUnitDefinitionId: "UNIT_ANIS_SWEETDEVIL_TEX",
    runIndex: 0,
  },
  {
    scenarioId: "FOCUS-CHIZURU-PS3",
    kind: "PARTY",
    ally: [
      "UNIT_CHIZURU_DOMESTIC",
      "UNIT_KATE_PALADIN",
      "UNIT_LUCIE_MAID",
      "UNIT_MERU_SIRIUS",
      "UNIT_RAMI_UNYIELDING",
    ],
    enemy: [
      "UNIT_KOTOHA_REBEL",
      "UNIT_LILY_SINGER",
      "UNIT_LYDIA_SUMMER",
      "UNIT_MEIYA_FATED",
      "UNIT_MIRIAM_MAGE",
    ],
    runIndex: 2,
  },
  {
    scenarioId: "FOCUS-NADYA-PS1",
    kind: "PARTY",
    ally: [
      "UNIT_NADYA_SUCCESSOR",
      "UNIT_SUIRAN_CHAOS",
      "UNIT_ANIS_TROUBLEMAKER",
      "UNIT_ELENA_MOODMAKER",
      "UNIT_JUNKA_CHILDHOOD",
    ],
    enemy: [
      "UNIT_LUCIE_MAID",
      "UNIT_MAIA_SALON",
      "UNIT_MERU_FLATSPIN",
      "UNIT_NANAE_COMMANDER",
      "UNIT_OLGA_VETERAN",
    ],
    runIndex: 9,
  },
  {
    scenarioId: "FOCUS-ROSIE-CAMPAIGN",
    kind: "EXERCISE",
    ally: [
      "UNIT_ROSIE_CAMPAIGN",
      "UNIT_LAYLA_NURSE",
      "UNIT_MAO_SUMMER",
      "UNIT_NOEL_RUMBLE",
      "UNIT_SENKA_SCHEMER",
    ],
    enemyUnitDefinitionId: "UNIT_LAYLA_NURSE_TEX",
    runIndex: 3,
  },
];

/** 焦点シナリオは探索時の乱数列（seed）を引き継ぐ。 */
const FOCUSED_SEEDS: Readonly<Record<string, string>> = {
  "FOCUS-HARRIET-CHARGE": "issue-840-focus-harriet",
  "FOCUS-CHIZURU-PS3": "fix16-focus",
  "FOCUS-NADYA-PS1": "fix16-focus",
  "FOCUS-ROSIE-CAMPAIGN": "fix16-focus",
};

/**
 * 段階Gの全シナリオ。各並べ方で84体を5体ずつの味方編成にし、同じ編成を
 * 戦術演習（演習敵1体・5ターン）と通常戦闘（次の5体が敵・10ターン）の両方で走らせる。
 */
export function stageGScenarios(exerciseEnemyIds: readonly string[]): readonly StageGScenario[] {
  const units = REVIEWED_UNIT_IDS;
  const scenarios: StageGScenario[] = [];
  GROUPING_STRIDES.forEach((stride, groupingIndex) => {
    for (let start = 0; start < units.length; start += PARTY_SIZE) {
      const partyIndex = start / PARTY_SIZE;
      const pick = (offset: number) =>
        Array.from(
          { length: PARTY_SIZE },
          (_, slot) => units[(offset + slot * stride) % units.length]!,
        );
      const runIndex = groupingIndex * 100 + partyIndex;
      scenarios.push({
        scenarioId: `EX-S${stride}-P${partyIndex}`,
        kind: "EXERCISE",
        ally: pick(start),
        enemyUnitDefinitionId:
          exerciseEnemyIds[(partyIndex + groupingIndex) % exerciseEnemyIds.length]!,
        runIndex,
      });
      scenarios.push({
        scenarioId: `PV-S${stride}-P${partyIndex}`,
        kind: "PARTY",
        ally: pick(start),
        enemy: pick(start + PARTY_SIZE),
        runIndex,
      });
    }
  });
  return [...scenarios, ...FOCUSED_SCENARIOS];
}

/** シナリオに登場する全ユニット（味方・敵の双方）。 */
export function scenarioUnitIds(scenario: StageGScenario): readonly string[] {
  return scenario.kind === "EXERCISE"
    ? [...scenario.ally, scenario.enemyUnitDefinitionId]
    : [...scenario.ally, ...scenario.enemy];
}

const provider = new Mulberry32SeededRandomSourceProvider();

export function runStageGScenario(
  catalogDir: string,
  scenario: StageGScenario,
): FullObservationBattleResult | FullObservationExerciseResult {
  const randomSourceFactory = provider.forRun(
    FOCUSED_SEEDS[scenario.scenarioId] ?? STAGE_G_SEED,
    scenario.runIndex,
  );
  const battleId = `B_STAGEG_${scenario.scenarioId}`;
  return scenario.kind === "EXERCISE"
    ? runProductionExerciseBattle(
        catalogDir,
        { ally: scenario.ally, enemyUnitDefinitionId: scenario.enemyUnitDefinitionId },
        { randomSourceFactory, battleId },
      )
    : runProductionPartyBattle(
        catalogDir,
        { ally: scenario.ally, enemy: scenario.enemy },
        { turnLimit: PARTY_TURN_LIMIT, randomSourceFactory, battleId },
      );
}
