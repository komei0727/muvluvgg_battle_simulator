/**
 * Nominal typing helper. `Brand<string, "UnitDefinitionId">` is structurally a
 * string but cannot be assigned from a plain string without going through a
 * constructor, preventing accidental mixing of unrelated ID kinds.
 */
export type Brand<Value, BrandName extends string> = Value & { readonly __brand: BrandName };
