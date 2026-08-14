/**
 * `10_API設計.md`「BattleUnitStateResponse.combatStatus」: 現在HPが0のユニットを
 * `DEFEATED`、それ以外を`ACTIVE`とする公開表現の規則。
 *
 * 戦闘状態（`toBattleStateResponseBody`）とユニット別集計
 * （`unit-battle-summary-projector.ts`）が同じ`finalState`から別々にこの値を出すため、
 * 規則を1箇所に置く — 2つの導出が並ぶと、片方だけ境界が変わっても同一レスポンス内で
 * `finalState.units[].combatStatus`と`unitSummaries[].combatStatus`が食い違いうる。
 */
export type CombatStatus = "ACTIVE" | "DEFEATED";

export function combatStatusOf(hp: number): CombatStatus {
  return hp === 0 ? "DEFEATED" : "ACTIVE";
}
