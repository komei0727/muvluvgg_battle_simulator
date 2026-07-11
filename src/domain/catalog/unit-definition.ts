import type { Attribute, PositionRow, Role, UnitType } from "./catalog-enums.js";
import {
  createCapabilityId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type CapabilityId,
  type SkillDefinitionId,
  type UnitDefinitionId,
} from "./catalog-ids.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DomainValidationError } from "../shared/errors.js";
import {
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertNonEmptyArray,
} from "../shared/validate.js";

const ATTRIBUTES = ["AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER"] as const;
const UNIT_TYPES = ["PHYSICAL", "ENERGY", "AGILE"] as const;
const ROLES = ["PHYSICAL_ATTACKER", "EN_ATTACKER", "TANK", "SUPPORT", "CONTROL"] as const;
const POSITION_ROWS = ["FRONT", "BACK"] as const;

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

export interface UnitMetadata {
  readonly displayName: string;
  readonly characterName: string;
  readonly characterId: string;
  readonly affiliations: readonly string[];
  readonly tags: readonly string[];
}

export interface UnitDefinition {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly attribute: Attribute;
  readonly unitType: UnitType;
  readonly role: Role;
  readonly positionAptitudes: readonly PositionRow[];
  readonly baseStats: BaseStats;
  readonly extraGaugeMaximum: number;
  readonly activeSkillDefinitionIds: readonly SkillDefinitionId[];
  readonly passiveSkillDefinitionIds: readonly SkillDefinitionId[];
  readonly extraSkillDefinitionId: SkillDefinitionId;
  readonly requiredCapabilities: readonly CapabilityId[];
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
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
  readonly baseStats: BaseStatsInput;
  readonly extraGaugeMaximum: number;
  readonly activeSkillDefinitionIds: readonly string[];
  readonly passiveSkillDefinitionIds: readonly string[];
  readonly extraSkillDefinitionId: string;
  readonly requiredCapabilities?: readonly string[];
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

export function createUnitDefinition(input: UnitDefinitionInput, path = "unit"): UnitDefinition {
  const unitDefinitionId = createUnitDefinitionId(
    input.unitDefinitionId,
    `${path}.unitDefinitionId`,
  );
  assertEnumValue(input.attribute, ATTRIBUTES, `${path}.attribute`);
  assertEnumValue(input.unitType, UNIT_TYPES, `${path}.unitType`);
  assertEnumValue(input.role, ROLES, `${path}.role`);

  assertNonEmptyArray(input.positionAptitudes, `${path}.positionAptitudes`);
  for (const [i, row] of input.positionAptitudes.entries()) {
    assertEnumValue(row, POSITION_ROWS, `${path}.positionAptitudes[${i}]`);
  }

  assertInteger(input.extraGaugeMaximum, `${path}.extraGaugeMaximum`, { min: 1 });

  const activeSkillDefinitionIds = input.activeSkillDefinitionIds.map((id, i) =>
    createSkillDefinitionId(id, `${path}.activeSkillDefinitionIds[${i}]`),
  );
  const passiveSkillDefinitionIds = input.passiveSkillDefinitionIds.map((id, i) =>
    createSkillDefinitionId(id, `${path}.passiveSkillDefinitionIds[${i}]`),
  );
  const extraSkillDefinitionId = createSkillDefinitionId(
    input.extraSkillDefinitionId,
    `${path}.extraSkillDefinitionId`,
  );
  const requiredCapabilities = (input.requiredCapabilities ?? []).map((id, i) =>
    createCapabilityId(id, `${path}.requiredCapabilities[${i}]`),
  );

  return deepFreeze({
    unitDefinitionId,
    attribute: input.attribute,
    unitType: input.unitType,
    role: input.role,
    positionAptitudes: input.positionAptitudes as readonly PositionRow[],
    baseStats: createBaseStats(input.baseStats, `${path}.baseStats`),
    extraGaugeMaximum: input.extraGaugeMaximum,
    activeSkillDefinitionIds,
    passiveSkillDefinitionIds,
    extraSkillDefinitionId,
    requiredCapabilities,
    metadata: {
      displayName: input.metadata.displayName,
      characterName: input.metadata.characterName,
      characterId: input.metadata.characterId,
      affiliations: input.metadata.affiliations ?? [],
      tags: input.metadata.tags ?? [],
    },
  });
}
