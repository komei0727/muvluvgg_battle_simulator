/**
 * Recursively freezes an object graph so converted Definitions cannot be
 * mutated by callers. Only plain objects and arrays are descended into;
 * branded primitives and other value types are already immutable.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
