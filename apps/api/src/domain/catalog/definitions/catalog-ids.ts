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

/**
 * `07_戦闘ルール詳細.md` R-STA-03／R-EFF-05が「同種」を括る単位。
 * `EffectActionDefinition.kindKey`としてCatalogが宣言し、宣言の無い定義は
 * `EffectActionDefinitionId`そのものをこの鍵として扱う（`applied-effect.ts`の
 * `effectKindKeyOf`が正本）。定義IDと同じ値域を取り得るため、`EffectKindKey`を
 * 定義の一意識別子として扱ってはならない — 複数の定義が同じ鍵を共有するのが
 * この型の目的である。
 *
 * `EffectActionDefinitionId`と混同せず「宣言された鍵かどうか」をIDの見た目から
 * 判別できるよう、宣言する場合の prefix は`KIND_`に固定する。
 */
export type EffectKindKey = Brand<string, "EffectKindKey">;
export function createEffectKindKey(value: string, path = "kindKey"): EffectKindKey {
  return createPrefixedId("EffectKindKey", "KIND_", path, value);
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
