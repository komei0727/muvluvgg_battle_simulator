// Mirrors docs/ui-design/03_API・データ連携設計.md §3 (UI input model) and
// §5.1/§5.3 (fixed 6 unit slots / 6 memory slots per side).
//
// 通常戦闘・戦術演習の編成入力（draft）の語彙。`shared/api`（送信リクエスト型が
// `LogLevel`等を埋め込む）と複数の feature（formation・exercise・simulation・
// catalog-selection）の双方から参照されるアプリ共通の語彙のため、
// `features/formation/types.ts`ではなく`entities`に置く（REF-055）。
// 値の初期化・派生ヘルパー（`createInitialDraft`等）と定数テーブル
// （`GEAR_STAT_LABELS`等）は編成機能固有のロジックとして`features/formation/types.ts`
// に残す。

export type Side = "ally" | "enemy";
export type UiRow = "FRONT" | "REAR";
export type UiColumn = 0 | 1 | 2;
/**
 * 用途は「大量実行して勝敗とユニット別集計だけを見る」(`SUMMARY`)と「効果発動を
 * 追う」(`DETAILED`)の2つしかない。`DIAGNOSTIC`は`DETAILED`と同一挙動の非推奨値に
 * なったため(docs/ddd/08_ドメインイベント.md「公開レベル」)、UIの選択肢から外す。
 * 保存済みドラフトの`"DIAGNOSTIC"`は`persistence.ts`が`"DETAILED"`へ読み替える。
 */
export type LogLevel = "SUMMARY" | "DETAILED";

/**
 * 戦術演習の実行の使い分け（Issue #539）。`SINGLE`は1回だけ実行してログを読む用途、
 * `STATISTICS`は同じ編成を大量に実行して統計量を見る用途である。演習では
 * `logLevel`の選択をこの2択が置き換える — 演習で`SUMMARY`を選ぶ動機だった
 * 「大量実行して集計を見る」は`STATISTICS`が担い、`SINGLE`は常に`DETAILED`で送る。
 */
export type ExerciseExecutionMode = "SINGLE" | "STATISTICS";

/**
 * 統計実行のパラメータ。`runCount`と`seed`は`STATISTICS`のときだけ送信へ効くが、
 * モードを往復しても入力し直さなくて済むよう`SINGLE`の間も保持する。
 * `seed`の空文字は「サーバー生成に任せる」を表す（`TacticalExerciseEvaluationRequest`
 * の`seed`は任意項目）。
 */
export interface ExerciseExecutionInput {
  readonly mode: ExerciseExecutionMode;
  readonly runCount: number | "";
  readonly seed: string;
}

// docs/ui-design/03_API・データ連携設計.md §3.1 (M11 強化入力).
export type EnhancementUnitType = "PHYSICAL" | "ENERGY" | "AGILE";
export type EnhancementAttribute = "AGGRESSIVE" | "SHY" | "CUTE" | "SMART" | "COMICAL" | "CLEVER";
export type GearStat =
  | "MAXIMUM_HP"
  | "ATTACK"
  | "DEFENSE"
  | "ACTION_SPEED"
  | "CRITICAL_RATE"
  | "CRITICAL_DAMAGE_BONUS"
  | "AFFINITY_BONUS";
export type GearTier = "II" | "III";
export type GearGrade = "D" | "C" | "B" | "A" | "S";

export interface GearInput {
  readonly stat: GearStat;
  readonly tier: GearTier;
  readonly grade: GearGrade;
}

export interface UnitEnhancementInput {
  readonly level: number | "";
  /**
   * ユニットランク（`LR`〜`LR+5`）。0〜5の整数（0が`LR`、5が`LR+5`）。
   * 6択のselectであり自由入力ではないため、`level`と違い`""`（未入力状態）を持たない。
   */
  readonly rank: number;
  /**
   * UI-AC-036: 陣営のレベルリンクから外した枠。リンクの反映は参照時解決
   * （`level-link.ts`）で、外れていない枠の`level`はリンク中だけ読まれない。
   */
  readonly linkExcluded: boolean;
  /** 常に9枠。空枠（`undefined`）を許容する（UI-AC-025）。 */
  readonly gears: readonly (GearInput | undefined)[];
}

/** UI-AC-035: 陣営のユニットレベルを1つの値で束ねる指定。 */
export interface LevelLinkInput {
  readonly enabled: boolean;
  readonly level: number | "";
}

export interface SideEnhancementInput {
  readonly enabled: boolean;
  readonly levelLink: LevelLinkInput;
  readonly academyLevels: {
    readonly unitTypes: Readonly<Record<EnhancementUnitType, number | "">>;
    readonly attributes: Readonly<Record<EnhancementAttribute, number | "">>;
  };
}

export interface FormationSlotInput {
  readonly slotKey: string;
  readonly side: Side;
  readonly row: UiRow;
  readonly column: UiColumn;
  readonly unitDefinitionId?: string;
  readonly enhancement?: UnitEnhancementInput;
}

export interface BattleDraft {
  readonly allySlots: readonly FormationSlotInput[];
  readonly enemySlots: readonly FormationSlotInput[];
  readonly allyMemoryDefinitionIds: readonly (string | undefined)[];
  readonly enemyMemoryDefinitionIds: readonly (string | undefined)[];
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
  /**
   * 戦術演習モードだけが読む実行指定。draft型は両モードで共有しているため通常戦闘の
   * draftにも載るが、通常戦闘のリクエスト生成も送信可否も参照しない。
   */
  readonly exerciseExecution: ExerciseExecutionInput;
  readonly allyEnhancement: SideEnhancementInput;
  readonly enemyEnhancement: SideEnhancementInput;
}
