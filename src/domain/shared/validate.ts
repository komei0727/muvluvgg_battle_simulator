import { DomainValidationError } from "./errors.js";

/** Shared structural-validation helpers for Definition factory functions. */

export function assertEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  path: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new DomainValidationError(path, `must be one of [${allowed.join(", ")}], got "${value}"`);
  }
}

export function assertFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new DomainValidationError(path, `must be a finite number, got ${JSON.stringify(value)}`);
  }
}

export function assertRange(
  value: number,
  path: string,
  options: { min?: number; max?: number } = {},
): void {
  assertFinite(value, path);
  if (options.min !== undefined && value < options.min) {
    throw new DomainValidationError(path, `must be >= ${options.min}, got ${value}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new DomainValidationError(path, `must be <= ${options.max}, got ${value}`);
  }
}

export function assertInteger(
  value: number,
  path: string,
  options: { min?: number; max?: number } = {},
): void {
  assertRange(value, path, options);
  if (!Number.isInteger(value)) {
    throw new DomainValidationError(path, `must be an integer, got ${value}`);
  }
}

export function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainValidationError(path, `must be an array, got ${typeof value}`);
  }
}

export function assertNonEmptyArray(value: unknown, path: string): void {
  assertArray(value, path);
  if (value.length === 0) {
    throw new DomainValidationError(path, "must contain at least one element");
  }
}

export function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new DomainValidationError(path, `must be a boolean, got ${typeof value}`);
  }
}

export function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new DomainValidationError(path, `must be a string, got ${typeof value}`);
  }
}

export function assertNullableInteger(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): asserts value is number | null {
  if (value === null) {
    return;
  }
  if (typeof value !== "number") {
    throw new DomainValidationError(path, `must be an integer or null, got ${typeof value}`);
  }
  assertInteger(value, path, options);
}

export function assertNullableString(value: unknown, path: string): asserts value is string | null {
  if (value === null) {
    return;
  }
  if (typeof value !== "string") {
    throw new DomainValidationError(path, `must be a string or null, got ${typeof value}`);
  }
}

/**
 * Rejects properties outside `allowedKeys`. Used for the recursive/polymorphic
 * regions (`payload`, `traits`, `resolution.steps`, ...) that the Catalog v2
 * JSON Schema deliberately leaves as generic objects — this is the Domain
 * layer's counterpart to `additionalProperties: false`, catching typos like
 * `hitCoutn` that would otherwise be silently dropped instead of applied.
 */
export function assertKnownKeys(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainValidationError(path, `must be an object, got ${typeof value}`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new DomainValidationError(
      path,
      `contains unknown propert${unknownKeys.length === 1 ? "y" : "ies"}: ${unknownKeys.join(", ")}`,
    );
  }
}
