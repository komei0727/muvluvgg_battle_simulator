import type { Attribute, PositionRow, Role, UnitType } from "./catalog-enums.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "./catalog-ids.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertNonEmptyArray,
  assertRange,
} from "../../shared/validate.js";

const ATTRIBUTES = ["AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER"] as const;
const UNIT_TYPES = ["PHYSICAL", "ENERGY", "AGILE"] as const;
const ROLES = ["PHYSICAL_ATTACKER", "EN_ATTACKER", "TANK", "SUPPORT", "CONTROL"] as const;
const POSITION_ROWS = ["FRONT", "BACK"] as const;

/**
 * R-TEX-11 #1: 編成プールの区分。`PLAYABLE`は通常戦闘・演習味方で編成でき、
 * `EXERCISE_ENEMY`は戦術演習の敵としてのみ編成できる。
 */
export const UNIT_CATEGORIES = ["PLAYABLE", "EXERCISE_ENEMY"] as const;
export type UnitCategory = (typeof UNIT_CATEGORIES)[number];

export interface BaseStats {
  readonly maximumHp: number;
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly criticalDamageBonus: number;
  readonly affinityBonus: number;
  readonly actionSpeed: number;
  readonly maximumAp: number;
  readonly maximumPp: number;
}

/**
 * R-ENH-05: レベル1あたりの上昇量。`baseStats`がレベル200時点の値であるため、
 * 現在レベル`L`の指定時に`(L − 200) × 成長値`として加算・減算に使う。
 */
export interface LevelGrowth {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly actionSpeed: number;
}

/**
 * R-ENH-07: ランク1段あたりの上昇量。`baseStats`が`LR+5`時点の値であるため、
 * ユニットランク`R`の指定時に`(R − 5) × rankGrowth`として加算・減算に使う。
 * `criticalRate`は内部表現の小数（`baseStats.criticalRate`と同じ単位、R-NUM-01）。
 */
export interface RankGrowth {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
}

export interface UnitMetadata {
  readonly displayName: string;
  readonly characterName: string;
  readonly characterId: string;
  readonly affiliations: readonly string[];
  readonly tags: readonly string[];
}

export interface UnitDefinition {
  readonly unitDefinitionId: UnitDefinitionId;
  /** R-TEX-11 #1: 編成プールの区分。定義書で省略された場合は`PLAYABLE`。 */
  readonly category: UnitCategory;
  /**
   * R-TEX-11 #4: 現在開催中の演習ユニットか。表示専用でシミュレーション受理条件
   * には影響しない。`EXERCISE_ENEMY`のときだけ存在する。
   */
  readonly exerciseActive?: boolean;
  readonly attribute: Attribute;
  readonly unitType: UnitType;
  readonly role: Role;
  readonly positionAptitudes: readonly PositionRow[];
  readonly baseStats: BaseStats;
  /** R-ENH-05: 実測値が未投入のユニットが存在するため任意。 */
  readonly levelGrowth?: LevelGrowth;
  /** R-ENH-07: 実測値が未投入のユニットが存在するため任意。 */
  readonly rankGrowth?: RankGrowth;
  readonly extraGaugeMaximum: number;
  readonly activeSkillDefinitionIds: readonly SkillDefinitionId[];
  readonly passiveSkillDefinitionIds: readonly SkillDefinitionId[];
  readonly extraSkillDefinitionId: SkillDefinitionId;
  readonly metadata: UnitMetadata;
}

export interface BaseStatsInput {
  readonly maximumHp: number;
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly criticalDamageBonus?: number;
  readonly affinityBonus?: number;
  readonly actionSpeed: number;
  readonly maximumAp: number;
  readonly maximumPp: number;
}

export interface UnitMetadataInput {
  readonly displayName: string;
  readonly characterName: string;
  readonly characterId: string;
  readonly affiliations?: readonly string[];
  readonly tags?: readonly string[];
}

export interface UnitDefinitionInput {
  readonly unitDefinitionId: string;
  readonly category?: string;
  readonly exerciseActive?: boolean;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
  readonly baseStats: BaseStatsInput;
  readonly levelGrowth?: LevelGrowth;
  readonly rankGrowth?: RankGrowth;
  readonly extraGaugeMaximum: number;
  readonly activeSkillDefinitionIds: readonly string[];
  readonly passiveSkillDefinitionIds: readonly string[];
  readonly extraSkillDefinitionId: string;
  readonly metadata: UnitMetadataInput;
}

function createBaseStats(input: BaseStatsInput, path: string): BaseStats {
  assertInteger(input.maximumHp, `${path}.maximumHp`, { min: 1 });
  assertInteger(input.attack, `${path}.attack`, { min: 0 });
  assertInteger(input.defense, `${path}.defense`, { min: 0 });
  assertFinite(input.criticalRate, `${path}.criticalRate`);
  if (input.criticalRate < 0) {
    throw new DomainValidationError(
      `${path}.criticalRate`,
      `must be >= 0, got ${input.criticalRate}`,
    );
  }
  const criticalDamageBonus = input.criticalDamageBonus ?? 0.5;
  assertFinite(criticalDamageBonus, `${path}.criticalDamageBonus`);
  const affinityBonus = input.affinityBonus ?? 0.25;
  assertFinite(affinityBonus, `${path}.affinityBonus`);
  assertInteger(input.actionSpeed, `${path}.actionSpeed`, { min: 0 });
  assertInteger(input.maximumAp, `${path}.maximumAp`, { min: 1 });
  assertInteger(input.maximumPp, `${path}.maximumPp`, { min: 1 });

  return {
    maximumHp: input.maximumHp,
    attack: input.attack,
    defense: input.defense,
    criticalRate: input.criticalRate,
    criticalDamageBonus,
    affinityBonus,
    actionSpeed: input.actionSpeed,
    maximumAp: input.maximumAp,
    maximumPp: input.maximumPp,
  };
}

function createLevelGrowth(input: LevelGrowth, path: string): LevelGrowth {
  assertInteger(input.hp, `${path}.hp`, { min: 0 });
  assertInteger(input.attack, `${path}.attack`, { min: 0 });
  assertInteger(input.defense, `${path}.defense`, { min: 0 });
  assertInteger(input.actionSpeed, `${path}.actionSpeed`, { min: 0 });

  return {
    hp: input.hp,
    attack: input.attack,
    defense: input.defense,
    actionSpeed: input.actionSpeed,
  };
}

function createRankGrowth(input: RankGrowth, path: string): RankGrowth {
  assertInteger(input.hp, `${path}.hp`, { min: 0 });
  assertInteger(input.attack, `${path}.attack`, { min: 0 });
  assertInteger(input.defense, `${path}.defense`, { min: 0 });
  assertRange(input.criticalRate, `${path}.criticalRate`, { min: 0 });

  return {
    hp: input.hp,
    attack: input.attack,
    defense: input.defense,
    criticalRate: input.criticalRate,
  };
}

export function createUnitDefinition(input: UnitDefinitionInput, path = "unit"): UnitDefinition {
  const unitDefinitionId = createUnitDefinitionId(
    input.unitDefinitionId,
    `${path}.unitDefinitionId`,
  );
  const category = input.category ?? "PLAYABLE";
  assertEnumValue(category, UNIT_CATEGORIES, `${path}.category`);
  // R-TEX-11 #4: 開催中フラグはEXERCISE_ENEMY専用。EXERCISE_ENEMYでは開催状態の
  // 判断を省略させないため必須とする。
  if (category === "EXERCISE_ENEMY") {
    if (typeof input.exerciseActive !== "boolean") {
      throw new DomainValidationError(
        `${path}.exerciseActive`,
        "must be a boolean when category is EXERCISE_ENEMY",
      );
    }
  } else if (input.exerciseActive !== undefined) {
    throw new DomainValidationError(
      `${path}.exerciseActive`,
      "must be absent unless category is EXERCISE_ENEMY",
    );
  }
  assertEnumValue(input.attribute, ATTRIBUTES, `${path}.attribute`);
  assertEnumValue(input.unitType, UNIT_TYPES, `${path}.unitType`);
  assertEnumValue(input.role, ROLES, `${path}.role`);

  assertNonEmptyArray(input.positionAptitudes, `${path}.positionAptitudes`);
  for (const [i, row] of input.positionAptitudes.entries()) {
    assertEnumValue(row, POSITION_ROWS, `${path}.positionAptitudes[${i}]`);
  }

  assertInteger(input.extraGaugeMaximum, `${path}.extraGaugeMaximum`, { min: 1 });

  assertArray(input.activeSkillDefinitionIds, `${path}.activeSkillDefinitionIds`);
  const activeSkillDefinitionIds = input.activeSkillDefinitionIds.map((id, i) =>
    createSkillDefinitionId(id, `${path}.activeSkillDefinitionIds[${i}]`),
  );
  assertArray(input.passiveSkillDefinitionIds, `${path}.passiveSkillDefinitionIds`);
  const passiveSkillDefinitionIds = input.passiveSkillDefinitionIds.map((id, i) =>
    createSkillDefinitionId(id, `${path}.passiveSkillDefinitionIds[${i}]`),
  );
  const extraSkillDefinitionId = createSkillDefinitionId(
    input.extraSkillDefinitionId,
    `${path}.extraSkillDefinitionId`,
  );
  return deepFreeze({
    unitDefinitionId,
    category,
    ...(input.exerciseActive === undefined ? {} : { exerciseActive: input.exerciseActive }),
    attribute: input.attribute,
    unitType: input.unitType,
    role: input.role,
    positionAptitudes: input.positionAptitudes as readonly PositionRow[],
    baseStats: createBaseStats(input.baseStats, `${path}.baseStats`),
    ...(input.levelGrowth === undefined
      ? {}
      : { levelGrowth: createLevelGrowth(input.levelGrowth, `${path}.levelGrowth`) }),
    ...(input.rankGrowth === undefined
      ? {}
      : { rankGrowth: createRankGrowth(input.rankGrowth, `${path}.rankGrowth`) }),
    extraGaugeMaximum: input.extraGaugeMaximum,
    activeSkillDefinitionIds,
    passiveSkillDefinitionIds,
    extraSkillDefinitionId,
    metadata: {
      displayName: input.metadata.displayName,
      characterName: input.metadata.characterName,
      characterId: input.metadata.characterId,
      affiliations: input.metadata.affiliations ?? [],
      tags: input.metadata.tags ?? [],
    },
  });
}
