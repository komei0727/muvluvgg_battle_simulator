import type { Brand } from "../../shared/brand.js";
import { DomainValidationError } from "../../shared/errors.js";

/**
 * Catalog v2 IDs are ASCII letters, digits, hyphen, or underscore only
 * (`14_Catalog定義スキーマ.md` ID体系). Cross-catalog uniqueness is verified
 * by the integrity validator, not here.
 */
const ID_CHARSET_PATTERN = /^[A-Za-z0-9_-]+$/;

function createId<BrandName extends string>(
  brandName: BrandName,
  path: string,
  value: string,
): Brand<string, BrandName> {
  if (!ID_CHARSET_PATTERN.test(value)) {
    throw new DomainValidationError(
      path,
      `${brandName} must contain only ASCII letters, digits, hyphen, or underscore: "${value}"`,
    );
  }
  return value as Brand<string, BrandName>;
}

function createPrefixedId<BrandName extends string>(
  brandName: BrandName,
  prefix: string,
  path: string,
  value: string,
): Brand<string, BrandName> {
  const id = createId(brandName, path, value);
  if (!value.startsWith(prefix)) {
    throw new DomainValidationError(path, `${brandName} must start with "${prefix}": "${value}"`);
  }
  return id;
}

export type UnitDefinitionId = Brand<string, "UnitDefinitionId">;
export function createUnitDefinitionId(value: string, path = "unitDefinitionId"): UnitDefinitionId {
  return createPrefixedId("UnitDefinitionId", "UNIT_", path, value);
}

export type SkillDefinitionId = Brand<string, "SkillDefinitionId">;
export function createSkillDefinitionId(
  value: string,
  path = "skillDefinitionId",
): SkillDefinitionId {
  return createPrefixedId("SkillDefinitionId", "SKL_", path, value);
}

export type EffectActionDefinitionId = Brand<string, "EffectActionDefinitionId">;
export function createEffectActionDefinitionId(
  value: string,
  path = "effectActionDefinitionId",
): EffectActionDefinitionId {
  return createPrefixedId("EffectActionDefinitionId", "ACT_", path, value);
}

export type MemoryDefinitionId = Brand<string, "MemoryDefinitionId">;
export function createMemoryDefinitionId(
  value: string,
  path = "memoryDefinitionId",
): MemoryDefinitionId {
  return createPrefixedId("MemoryDefinitionId", "MEM_", path, value);
}

export type TargetBindingId = Brand<string, "TargetBindingId">;
export function createTargetBindingId(value: string, path = "targetBindingId"): TargetBindingId {
  return createPrefixedId("TargetBindingId", "TGT_", path, value);
}

export type MarkerId = Brand<string, "MarkerId">;
export function createMarkerId(value: string, path = "markerId"): MarkerId {
  return createPrefixedId("MarkerId", "MARKER_", path, value);
}

/** No fixed prefix; unique within its counter scope (`05_ドメインモデル.md`). */
export type RuntimeCounterId = Brand<string, "RuntimeCounterId">;
export function createRuntimeCounterId(value: string, path = "runtimeCounterId"): RuntimeCounterId {
  return createId("RuntimeCounterId", path, value);
}

/** `Q-*` (pending spec) or `CAP_*` (implementation-tracked). */
export type CapabilityId = Brand<string, "CapabilityId">;
export function createCapabilityId(value: string, path = "capabilityId"): CapabilityId {
  const id = createId("CapabilityId", path, value);
  if (!value.startsWith("CAP_") && !value.startsWith("Q-")) {
    throw new DomainValidationError(
      path,
      `CapabilityId must start with "CAP_" or "Q-": "${value}"`,
    );
  }
  return id;
}
