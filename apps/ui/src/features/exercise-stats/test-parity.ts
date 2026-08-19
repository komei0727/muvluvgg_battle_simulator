import { expect } from "vitest";

/**
 * Python実装との数値一致の許容差。exercise-lab は二項係数を厳密な整数で計算し、
 * こちらは桁溢れを避けるため係数の比を倍精度で積む（`daily-best.ts`）。両者は
 * 丸めの順序が違うだけで、差は標本数に比例した数ulpに収まる。
 */
export function expectNumericParity(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-12 + 1e-9);
}
