/**
 * `HitPolicy` (R-HIT-01). 通常の命中率・回避率は無く、暗闇(R-HIT-03)や特別な
 * 回避効果(R-HIT-02)が無ければ必ず命中する。これらはM7未実装のため、現状は
 * 常にHITを返す。
 */
export function resolveHit(): boolean {
  return true;
}
