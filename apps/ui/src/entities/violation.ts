// docs/ui-design/04_コンポーネント・状態管理設計.md §9 (UiViolation shape).
//
// クライアント検証（`features/formation/draft-validation.ts`）とサーバー422の
// 写し替え（`features/simulation/violation-mapper.ts`）の両方が同じ形へ正規化する、
// 陣営を横断する読みモデル。1つのfeatureが所有すると他方が逆流importになるため
// `entities` に置く（REF-055）。

export type UiViolationSeverity = "error" | "warning";

export interface UiViolation {
  readonly path: string;
  readonly slotKey?: string;
  /**
   * M11: ギア違反が指すUIのギア枠index（03_API・データ連携設計.md §13）。
   * 送信配列は空枠を除外するため、サーバーの`gears[m]`をそのまま枠番号として
   * 使えない。`slotKey`と対で、ユニット強化ダイアログの該当selectへ表示する。
   */
  readonly gearIndex?: number;
  /**
   * 総力戦の違反が指す編成index（編成番号 - 1。03_API・データ連携設計.md §6・§13）。
   * `slotKey`は組の間で同じ文字列になるため、どの編成の枠かはこれで区別する。
   * 通常戦闘・戦術演習の違反は持たない。
   */
  readonly formationIndex?: number;
  readonly code: string;
  readonly message: string;
  readonly severity: UiViolationSeverity;
}
