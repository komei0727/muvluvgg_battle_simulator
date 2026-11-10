// docs/ui-design/04_コンポーネント・状態管理設計.md §3「TraceBoard／UnitTraceCard」（UI-CMP-044）。
//
// 盤面の部品が受け取る表示用の値。部品は投影（状態・区間・処理ステップ）もreducerも知らず、
// この型だけを読む。値はすべて「範囲の前」と「範囲の後」の比較を済ませた結果である。

export type TraceBoardSide = "ALLY" | "ENEMY";
export type TraceBoardRow = "FRONT" | "REAR";

/** 範囲の前後の値。範囲の中で出撃したユニットでは`before`は`after`と同じ。 */
export interface TraceGaugeView {
  readonly before: number;
  readonly after: number;
  readonly maximum: number;
}

export type TraceChipKind =
  | "BUFF"
  | "DEBUFF"
  | "STATUS_ABNORMALITY"
  | "MARKER"
  | "CHARGE"
  | "OTHER";

/** 範囲の中で付いた（`added`）、範囲の前から付いている（`kept`）、範囲の中で外れた（`removed`）。 */
export type TraceChipChange = "added" | "kept" | "removed";

export interface TraceChipView {
  readonly key: string;
  /**
   * 効果・チャージは表示名（01_UI要求・画面設計.md §8.6）、マーカーはマーカーID。
   * 表示名の解決器が無ければ定義IDのまま。
   */
  readonly label: string;
  /** `label`を表示名にしたときの論理名。ツールチップにだけ出す。 */
  readonly logicalName?: string;
  readonly kind: TraceChipKind;
  readonly change: TraceChipChange;
  /** 残り時間・スタック数の短い表記。永続効果では持たない。 */
  readonly remaining?: string;
  /** 重複なしの次点（`isEffective: false`）。 */
  readonly ineffective: boolean;
}

export interface TraceDamageView {
  /** HPダメージとシールド・サブユニットの吸収の和。 */
  readonly total: number;
  readonly hits: number;
  readonly critical: boolean;
  /** シールドの吸収だけ。サブユニットの吸収は`total`に含めるがここには含めない。 */
  readonly shieldAbsorbed: number;
}

export interface TraceHealView {
  readonly total: number;
}

export interface TraceUnitRoles {
  /** 行動区間の行動者。 */
  readonly actor: boolean;
  /** 範囲の中で発動したPS（割り込みを含む）の発動者。 */
  readonly activator: boolean;
  /** 範囲の中で対象になった（行動者・発動者を除く）。 */
  readonly target: boolean;
}

export interface TraceUnitCardView {
  readonly battleUnitId: string;
  readonly side: TraceBoardSide;
  /** 0〜2。 */
  readonly column: number;
  readonly row: TraceBoardRow;
  /** 表示名の全文（accessible name・ツールチップ）。 */
  readonly displayName: string;
  /** 表示名の【】の後ろの名前部分。 */
  readonly name: string;
  /** そのターンの行動順（1始まり）。まだ行動していなければ持たない。 */
  readonly actionOrder?: number;
  readonly hp: TraceGaugeView;
  /** シールドのプールの合計。 */
  readonly shield: { readonly before: number; readonly after: number };
  readonly ap?: TraceGaugeView;
  readonly pp?: TraceGaugeView;
  readonly extraGauge?: TraceGaugeView;
  readonly chips: readonly TraceChipView[];
  readonly damage?: TraceDamageView;
  readonly heal?: TraceHealView;
  readonly roles: TraceUnitRoles;
  readonly defeated: boolean;
}

/** 攻撃は陣営色、PS・メモリー発動は別の色の破線、回復は回復の色。 */
export type TraceArrowKind = "attack" | "passive" | "heal";

export interface TraceArrowView {
  readonly fromUnitId: string;
  readonly toUnitId: string;
  readonly kind: TraceArrowKind;
  /** 発動者の陣営（攻撃の色）。 */
  readonly side: TraceBoardSide;
}

export interface TraceBoardView {
  readonly units: readonly TraceUnitCardView[];
  readonly arrows: readonly TraceArrowView[];
}
