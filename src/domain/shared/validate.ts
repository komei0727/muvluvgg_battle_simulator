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

export function assertNonEmptyArray(value: readonly unknown[], path: string): void {
  if (value.length === 0) {
    throw new DomainValidationError(path, "must contain at least one element");
  }
}
