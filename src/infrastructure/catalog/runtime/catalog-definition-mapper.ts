import type { ErrorObject } from "ajv";
import {
  createCapabilityDefinition,
  type CapabilityDefinition,
  type CapabilityDefinitionInput,
} from "../../../domain/catalog/capability-definition.js";
import {
  createEffectActionDefinition,
  type EffectActionDefinition,
  type EffectActionDefinitionInput,
} from "../../../domain/catalog/effect-action-definition.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
  type MemoryDefinitionInput,
} from "../../../domain/catalog/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
  type SkillDefinitionInput,
} from "../../../domain/catalog/skill-definition.js";
import {
  createUnitDefinition,
  type UnitDefinition,
  type UnitDefinitionInput,
} from "../../../domain/catalog/unit-definition.js";
import {
  validateCapabilityDefinitionDto,
  validateEffectActionDefinitionDto,
  validateMemoryDefinitionDto,
  validateSkillDefinitionDto,
  validateUnitDefinitionDto,
} from "./catalog-schema.js";

/**
 * Raised by the "Shape" stage (JSON Schema) before the Mapper attempts to
 * resolve references and build a Domain Definition. Distinct from
 * `DomainValidationError`, which the Mapper's Domain factories raise for
 * "Resolve"-stage failures (`11_インフラストラクチャ設計.md` の読み込み段階).
 */
export class CatalogShapeValidationError extends Error {
  readonly artifact: string;
  readonly errors: readonly ErrorObject[];

  constructor(artifact: string, errors: readonly ErrorObject[]) {
    super(`${artifact}: failed JSON Schema shape validation (${errors.length} error(s))`);
    this.name = "CatalogShapeValidationError";
    this.artifact = artifact;
    this.errors = errors;
  }
}

export function mapUnitDefinition(dto: unknown): UnitDefinition {
  if (!validateUnitDefinitionDto(dto)) {
    throw new CatalogShapeValidationError("UnitDefinition", validateUnitDefinitionDto.errors ?? []);
  }
  return createUnitDefinition(dto as UnitDefinitionInput);
}

export function mapSkillDefinition(dto: unknown): SkillDefinition {
  if (!validateSkillDefinitionDto(dto)) {
    throw new CatalogShapeValidationError(
      "SkillDefinition",
      validateSkillDefinitionDto.errors ?? [],
    );
  }
  return createSkillDefinition(dto as SkillDefinitionInput);
}

export function mapEffectActionDefinition(dto: unknown): EffectActionDefinition {
  if (!validateEffectActionDefinitionDto(dto)) {
    throw new CatalogShapeValidationError(
      "EffectActionDefinition",
      validateEffectActionDefinitionDto.errors ?? [],
    );
  }
  return createEffectActionDefinition(dto as EffectActionDefinitionInput, "effectAction");
}

export function mapMemoryDefinition(dto: unknown): MemoryDefinition {
  if (!validateMemoryDefinitionDto(dto)) {
    throw new CatalogShapeValidationError(
      "MemoryDefinition",
      validateMemoryDefinitionDto.errors ?? [],
    );
  }
  return createMemoryDefinition(dto as MemoryDefinitionInput);
}

export function mapCapabilityDefinition(dto: unknown): CapabilityDefinition {
  if (!validateCapabilityDefinitionDto(dto)) {
    throw new CatalogShapeValidationError(
      "CapabilityDefinition",
      validateCapabilityDefinitionDto.errors ?? [],
    );
  }
  return createCapabilityDefinition(dto as CapabilityDefinitionInput);
}
