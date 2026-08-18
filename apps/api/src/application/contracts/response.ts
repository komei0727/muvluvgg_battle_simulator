import type { BattleLogEventResponseBody } from "./battle-log.js";

/**
 * `10_API設計.md`の外部JSON契約と同じ形の、ブランド型を含まないプレーンな型群。
 * Presentation層（Fastify JSON Schema・ルートハンドラ）はこのファイルだけを
 * importすればよく、domain層のbranded typeへ直接触れずに済む
 * （`no-restricted-imports`によるpresentation→domain遮断を維持するため）。
 *
 * ここに定義する型はワイヤーフォーマットの正本であり、値の生成ロジックは
 * 持たない。Result→Responseの変換は`simulate-battle-response-mapper.ts`が担う。
 *
 * `POST /api/v1/battle-simulations`のsimulation response body契約型を持つ。
 */

export interface ValueChangeBody<T> {
  readonly before: T;
  readonly after: T;
}

export interface CurrentMaximumValueBody {
  readonly current: number;
  readonly maximum: number;
}

export interface ResourceStateResponseBody {
  readonly ap: CurrentMaximumValueBody;
  readonly pp: CurrentMaximumValueBody;
  readonly extraGauge: CurrentMaximumValueBody;
}

export interface CombatStatsResponseBody {
  readonly attack: number;
  readonly defense: number;
  readonly criticalRate: number;
  readonly actionSpeed: number;
  readonly affinityBonus: number;
  readonly criticalDamageBonus: number;
}

export interface ShieldStateResponseBody {
  readonly physical: number;
  readonly energy: number;
  readonly untyped: number;
}

export interface FormationPositionResponseBody {
  readonly column: number;
  readonly row: string;
}

export interface GlobalCoordinateResponseBody {
  readonly x: number;
  readonly y: number;
}

/**
 * `10_API設計.md`「SubUnitStateResponse」。DMG-005（Issue #190、R-SUB-01第3項）で
 * `APPLY_SUBUNIT`由来の効果インスタンスへ配線した — サブユニットは「消費順と固有効果を
 * 追跡するためインスタンスごとに返す」ため、`shields`のようなプール合計へは合算しない。
 */
export interface SubUnitStateResponseBody {
  readonly subUnitInstanceId: string;
  readonly subUnitDefinitionId: string;
  readonly sourceUnitId?: string;
  readonly durability: CurrentMaximumValueBody;
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: string;
}

/**
 * `10_API設計.md`「EffectStateResponse」。`value`は効果種別ごとの構造化された
 * 値で、M7で`effectKindKey`ごとの具体Schemaが定まるまでは未確定のため
 * 開いたまま(`unknown`)にする。M7まではResponse Mapperが要素を追加することはない。
 */
export interface EffectStateResponseBody {
  readonly effectInstanceId: string;
  readonly effectDefinitionId: string;
  readonly sourceUnitId?: string;
  /** R-MEM-04（M7-006、Issue #179）: Memory由来の効果は付与者ユニットを持たず、付与元の陣営を持つ。 */
  readonly sourceSide?: string;
  readonly category: string;
  readonly effectKindKey: string;
  /**
   * M7-009（Issue #182）: `APPLY_STATUS`由来の効果だけが持つ状態の種別。気絶等の
   * 状態異常（`category: STATUS_ABNORMALITY`）だけでなく、STEALTH等の対象に有利な
   * 状態（`category: BUFF`）も持つ。どの状態かをクライアントが
   * `effectDefinitionId`の命名から推測せずに表示できるようにするための値であり、
   * 状態異常かどうかの判定には`category`を使う。`effectKindKey`はR-STA-03の
   * 同種グループ鍵（Issue #519）であって定義識別子でも分類軸でもなく、
   * Catalogが`kindKey`を宣言した定義群では複数の定義が同じ値を共有する。
   */
  readonly statusKind?: string;
  readonly stackMode: string;
  readonly isEffective: boolean;
  readonly value: unknown;
  readonly duration?: { readonly unit: string; readonly remaining: number };
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: string;
}

/**
 * `10_API設計.md`「MarkerStateResponse」(R-EFF-10、EFF-004)。`EffectStateResponse`
 * と対になる形だが、`AppliedEffect`と異なり`stackCount`/`stackMax`を持ち、
 * `kindKey`/`category`/`isEffective`/`value`（重複あり・なし選択、効果種別ごとの
 * 構造化値）を持たない — MarkerはR-EFF-05の重複解決対象ではなく、対象ごとに
 * 常に1インスタンスだけが存在する。
 */
export interface MarkerStateResponseBody {
  readonly markerInstanceId: string;
  readonly markerId: string;
  /** 直近の付与者。R-MEM-04のMemory由来Markerは代わりに`sourceSide`を持つ。 */
  readonly sourceUnitId?: string;
  /** R-MEM-04（REL-008、Issue #263）: Memory由来Markerだけが持つ付与元の陣営。 */
  readonly sourceSide?: string;
  readonly stackCount: number;
  readonly stackMax: number | null;
  readonly duration?: { readonly unit: string; readonly remaining: number };
}

/**
 * `10_API設計.md`「CooldownStateResponse」。`setAtActionId`/`setAtTurnNumber`は
 * 設定scopeは`unit`(ACTION/TURN)に対応する側だけが現れ、反対側は現れない
 * （Domainの`CooldownEntry`と同じ対応。`state-delta.ts`の`CooldownState`コメント参照）。
 * discriminated unionにして反対側フィールドを`?: never`にしているのは、
 * オブジェクトリテラル直書き以外（変数経由の代入）でもexcess property check を
 * 回避できないようにするため（`never`が無いと構造的部分型付けにより両方の
 * フィールドを持つ値も代入できてしまう）。`remaining`は残数があるスキルだけを
 * 返す契約のため1以上。
 *
 * 対応する側も任意なのは、PSが行動外のトップレベルイベントから発動した
 * クールタイムが設定scopeを持たないため（R-SKL-04、`cooldown-state.ts`の
 * `startCooldown`）。必須にしていた間、この状態を持つ実在Unitのレスポンスは
 * serialize時に落ちて`500`になっていた（REL-004 / Issue #203）。
 */
export type CooldownStateResponseBody =
  | {
      readonly skillDefinitionId: string;
      readonly unit: "ACTION";
      readonly remaining: number;
      readonly setAtActionId?: string;
      readonly setAtTurnNumber?: never;
    }
  | {
      readonly skillDefinitionId: string;
      readonly unit: "TURN";
      readonly remaining: number;
      readonly setAtTurnNumber?: number;
      readonly setAtActionId?: never;
    };

/** `10_API設計.md`「ChargeStateResponse」。`status`はM5時点でCHARGING以外の値を取り得ない（RELEASE_READY/HELD_BY_FREEZEはM6/M7で追加されるイベント発行後に初めて成立する）。 */
export interface ChargeStateResponseBody {
  readonly skillDefinitionId: string;
  readonly startedActionId: string;
  readonly status: string;
}

/**
 * `10_API設計.md`「BattleUnitStateResponse」。`subUnits`はDMG-005（Issue #190）で
 * `APPLY_SUBUNIT`由来の効果インスタンスへ配線した（それ以前は対応するDomain機構が
 * 無いため常に空配列だった）。`effects`はEFF-002
 * （R-EFF-05の重複なし最強選択・CombatStat再計算）で`snapshot.effects`
 * （`isEffective`を含む）を実際にマップする。`APPLY_STAT_MOD`の
 * `stacking.mode: NON_STACKABLE`はM7-012（Issue #266）でCatalogスキーマ・
 * resolverへ配線済みだが、それを宣言するproduction定義は現時点で存在しないため、
 * productionで観測される`effects`は引き続き常に`isEffective: true`・
 * `stackMode: "STACKABLE"`になる（重複なし側は`effect-action-group-resolver.test.ts`
 * のUT-R-EFF-05-017/018等が実ライフサイクル経由で到達する）。`markers`はEFF-004（R-EFF-10）で`snapshot.markers`を
 * 実際にマップする。`cooldowns`/`charge`はM5で実装済みのDomain状態
 * （`BattleUnitSnapshot`）をそのまま反映する。
 */
export interface BattleUnitStateResponseBody {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly side: string;
  readonly formationPosition: FormationPositionResponseBody;
  readonly coordinate: GlobalCoordinateResponseBody;
  readonly combatStatus: string;
  readonly hp: CurrentMaximumValueBody;
  readonly resources: ResourceStateResponseBody;
  readonly combatStats: CombatStatsResponseBody;
  readonly shields: ShieldStateResponseBody;
  readonly subUnits: readonly SubUnitStateResponseBody[];
  readonly effects: readonly EffectStateResponseBody[];
  /**
   * `10_API設計.md`「schemaVersion」の後方互換規則は
   * 「任意プロパティの追加」だけを許す。`effects`等は元々v1契約の必須項目だが、
   * `markers`はEFF-004でv1のまま新規追加したフィールドのため、既存の厳密な
   * v1デコーダ（`additionalProperties: false`のschemaを保持するクライアント）を
   * 壊さないよう任意にする — Response Mapperは常に値を設定する（`effects`と
   * 同じ「まだ何も付与されていない」を表す空配列を含む）。
   */
  readonly markers?: readonly MarkerStateResponseBody[];
  readonly cooldowns: readonly CooldownStateResponseBody[];
  readonly charge?: ChargeStateResponseBody;
}

export interface ActionReservationResponseBody {
  readonly order: number;
  readonly battleUnitId: string;
  readonly actionSpeedAtOrdering: number;
  readonly reservedActionType: string;
}

export interface BattleStateResponseBody {
  readonly stateVersion: number;
  readonly battleStatus: string;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly units: readonly BattleUnitStateResponseBody[];
  readonly actionQueue: readonly ActionReservationResponseBody[];
}

export interface BattleResultResponseBody {
  readonly outcome: string;
  readonly completionReason: string;
  readonly completedTurn: number;
}

export interface UnitResourcesDeltaResponseBody {
  readonly ap?: ValueChangeBody<number>;
  readonly pp?: ValueChangeBody<number>;
  readonly extraGauge?: ValueChangeBody<number>;
}

/**
 * G-09（M7-002A／Issue #255）: `BattleUnitStateResponse.resources.{ap,pp,extraGauge}.maximum`
 * の差分。`UnitResourcesDeltaResponseBody`（現在値）とは独立に変化するため別キーにする。
 * HPの最大値は`MAXIMUM_HP` CombatStatであり`combatStats`側が表す。
 */
export interface UnitResourceMaximumsDeltaResponseBody {
  readonly ap?: ValueChangeBody<number>;
  readonly pp?: ValueChangeBody<number>;
  readonly extraGauge?: ValueChangeBody<number>;
}

/** `10_API設計.md`「BattleStateDeltaResponse」の`EntityCollectionDelta`。 */
export interface EntityCollectionDeltaResponseBody {
  readonly added: readonly unknown[];
  readonly updated: readonly {
    readonly id: string;
    readonly before: unknown;
    readonly after: unknown;
  }[];
  readonly removed: readonly { readonly id: string; readonly before: unknown }[];
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse」の全項目。`combatStats`/`shields`/
 * `subUnits`/`effects`/`cooldowns`/`charge`は対応するDomain機構が実装される
 * M5〜M8まで、Response Mapperが値を設定することはない
 * （現行v1のRequest/Response契約を`additionalProperties: false`のまま将来へ
 * 拡張できるよう、フィールド自体は先に外部契約へ持たせておく）。`markers`は
 * EFF-004（R-EFF-10）でResponse Mapperが`delta.markers`から実際に値を設定する
 * （`effects`同様の`EntityCollectionDelta`変換）。
 */
export interface UnitStateDeltaResponseBody {
  readonly combatStatus?: ValueChangeBody<string>;
  readonly hp?: ValueChangeBody<number>;
  readonly resources?: UnitResourcesDeltaResponseBody;
  readonly resourceMaximums?: UnitResourceMaximumsDeltaResponseBody;
  /**
   * `BattleUnitStateResponse.hp.maximum`の差分。Domainでは`MAXIMUM_HP` CombatStatの
   * 差分（`stateDelta.combatStats.maximumHp`）だが、公開レスポンスはHP上限を
   * `CombatStatsResponse`ではなく`hp.maximum`として持つため、差分も同じ場所へ運ぶ
   * （`CombatStatsResponse`は`maximumHp`を持たない）。`APPLY_STAT_MOD(MAXIMUM_HP)`と
   * `MODIFY_RESOURCE_CAPACITY(resource: HP)`（G-09／M7-002A・Issue #255）の両方が
   * この差分を生む。
   */
  readonly hpMaximum?: ValueChangeBody<number>;
  /** `BattleUnitStateResponse.combatStats`の差分。`maximumHp`は`hpMaximum`が持つため含まない。 */
  readonly combatStats?: Readonly<Record<string, ValueChangeBody<number>>>;
  readonly shields?: Readonly<Record<string, ValueChangeBody<number>>>;
  readonly subUnits?: EntityCollectionDeltaResponseBody;
  readonly effects?: EntityCollectionDeltaResponseBody;
  readonly markers?: EntityCollectionDeltaResponseBody;
  readonly cooldowns?: EntityCollectionDeltaResponseBody;
  readonly charge?: ValueChangeBody<unknown>;
  /**
   * R-TEX-04のブレイク強化（`UnitRevived`が所有）が書き換えた**基礎**戦闘ステータスの
   * 差分。戦術演習のレスポンスにだけ現れる（通常戦闘では基礎値が不変）。実効値の
   * 差分（`combatStats`／`hpMaximum`）とは独立に起き、公開状態へ適用先を持たない
   * 監査用の差分であるため、`UNIT_REVIVED.details.baseCombatStats`と同じく比率のまま
   * 運ぶ（`CombatStatsResponse`のパーセントポイント表記へは直さない）。`maximumHp`も
   * 基礎値の一部としてそのままキーに含む。
   */
  readonly baseCombatStats?: Readonly<Record<string, ValueChangeBody<number>>>;
}

export interface BattleDeltaResponseBody {
  readonly battleStatus?: ValueChangeBody<string>;
  readonly turnNumber?: ValueChangeBody<number>;
  readonly cycleNumber?: ValueChangeBody<number>;
}

export interface ActionQueueDeltaResponseBody {
  readonly before: readonly ActionReservationResponseBody[];
  readonly after: readonly ActionReservationResponseBody[];
}

/**
 * `10_API設計.md`「BattleStateDeltaResponse」の`exercise`。戦術演習だけで現れる
 * （R-TEX-02／03）。累計スコアとブレイク回数は別々のイベントが所有するため独立に変わる。
 */
export interface ExerciseDeltaResponseBody {
  readonly totalScore?: ValueChangeBody<number>;
  readonly breakCount?: ValueChangeBody<number>;
}

export interface BattleStateDeltaResponseBody {
  readonly battle?: BattleDeltaResponseBody;
  readonly units?: Readonly<Record<string, UnitStateDeltaResponseBody>>;
  readonly actionQueue?: ActionQueueDeltaResponseBody;
  readonly exercise?: ExerciseDeltaResponseBody;
}

export interface StateTransitionResponseBody {
  readonly causedBySequence: number;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly delta: BattleStateDeltaResponseBody;
}

/**
 * `10_API設計.md`「UnitBattleSummaryResponse」。編成検討のための大量実行が必要と
 * する「勝敗＋ユニット別集計」をサーバーが確定させる。公開レベルに依存しない。
 */
export interface UnitBattleSummaryResponseBody {
  readonly battleUnitId: string;
  readonly side: string;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly finalHp: number;
  readonly maximumHp: number;
  readonly combatStatus: string;
}

export interface BattleSimulationResponseBody {
  readonly schemaVersion: number;
  readonly battleId: string;
  readonly catalogRevision: string;
  readonly result: BattleResultResponseBody;
  readonly initialState: BattleStateResponseBody;
  /**
   * `10_API設計.md`「公開レベル」: `SUMMARY`ではキーごと省略する。表示に要る最終HP・
   * 戦闘状態は`unitSummaries`が運ぶ（`initialState`はロースター解決のため常に返す）。
   */
  readonly finalState?: BattleStateResponseBody;
  readonly unitSummaries: readonly UnitBattleSummaryResponseBody[];
  readonly events: readonly BattleLogEventResponseBody[];
  readonly stateTransitions: readonly StateTransitionResponseBody[];
}

/** `10_API設計.md`「ExerciseBreakResponse」（R-TEX-10 #2）。 */
export interface ExerciseBreakResponseBody {
  readonly breakNumber: number;
  readonly turnNumber: number;
  readonly cumulativeScoreAtBreak: number;
  /**
   * ブレイクを起こしたユニットの定義ID（R-TEX-03 #2の発生源）。メモリー由来の
   * 継続ダメージのように発生源ユニットを持たないブレイクでは省略する（R-MEM-04）。
   */
  readonly sourceUnitDefinitionId?: string;
}

/**
 * `10_API設計.md`「ExerciseResultResponse」。勝敗（`outcome`）を持たない —
 * 戦術演習は勝敗を確定しない（R-TEX-10 #1）。
 */
export interface ExerciseResultResponseBody {
  readonly completionReason: string;
  readonly completedTurn: number;
  readonly totalScore: number;
  readonly breakCount: number;
  readonly breaks: readonly ExerciseBreakResponseBody[];
}

/**
 * `10_API設計.md`「TacticalExerciseResponse」。`BattleSimulationResponse`と同じ構造を
 * 再利用し、`result`だけを演習結果へ差し替える。
 */
export interface TacticalExerciseResponseBody {
  readonly schemaVersion: number;
  readonly battleId: string;
  readonly catalogRevision: string;
  readonly result: ExerciseResultResponseBody;
  readonly initialState: BattleStateResponseBody;
  /**
   * `10_API設計.md`「公開レベル」: `SUMMARY`ではキーごと省略する。表示に要る最終HP・
   * 戦闘状態は`unitSummaries`が運ぶ（`initialState`はロースター解決のため常に返す）。
   */
  readonly finalState?: BattleStateResponseBody;
  readonly unitSummaries: readonly UnitBattleSummaryResponseBody[];
  readonly events: readonly BattleLogEventResponseBody[];
  readonly stateTransitions: readonly StateTransitionResponseBody[];
}

/**
 * `10_API設計.md`「FormationStatPreviewUnitResponse」。`maximumHp`は
 * `CombatStatsResponse`が持たない（公開上の置き場所が`hp.maximum`である）ため
 * ユニット直下へ置き、`BattleUnitStateResponse.hp.maximum`と同じく丸めない。
 */
export interface FormationStatPreviewUnitResponseBody {
  readonly side: string;
  readonly unitDefinitionId: string;
  readonly formationPosition: FormationPositionResponseBody;
  readonly maximumHp: number;
  readonly combatStats: CombatStatsResponseBody;
  readonly enhancedBaseStats: FormationStatPreviewBaseStatsResponseBody;
}

/**
 * `10_API設計.md`「FormationStatPreviewUnitResponse」: R-ENH-06の強化後基本
 * ステータス（編成補正・適性補正の適用前）。単位は `CombatStatsResponse` と同じで、
 * 比率3項目はパーセントポイントで公開する。
 *
 * `maximumHp` は `combatStats` 側と違って内側に置く —— 外側へ出す理由（`hp.maximum`
 * との公開上の対応）が補正前の値には無く、1オブジェクトで完結させたほうが
 * クライアントの取り違えが起きにくいため。AP/PPはプレビューの表示対象外なので含めない。
 */
export interface FormationStatPreviewBaseStatsResponseBody extends CombatStatsResponseBody {
  readonly maximumHp: number;
}

export interface FormationStatPreviewResponseBody {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
  /** 味方、敵の順。各陣営内はリクエストの`units`と同じ順序。 */
  readonly units: readonly FormationStatPreviewUnitResponseBody[];
}

/**
 * `10_API設計.md`「TacticalExerciseCandidateEvaluationResponse」。統計量ではなく
 * 試行ごとの生値を返す——どの統計を採るかは利用側が決める。
 * 6つの配列は同じ試行を同じ添字で指し、いずれも長さが`completedRuns`に一致する。
 */
export interface TacticalExerciseCandidateEvaluationResponseBody {
  readonly completedRuns: number;
  readonly scores: readonly number[];
  readonly breakCounts: readonly number[];
  readonly completedTurns: readonly number[];
  readonly completionReasons: readonly string[];
  /** 試行ごと・味方ユニットごとの与ダメージ合計。内側はリクエストの編成順。 */
  readonly allyUnitDamageTotals: readonly (readonly number[])[];
  /**
   * 試行ごと・味方ユニットごとの、そのユニットの攻撃で発生したブレイク回数。内側は
   * リクエストの編成順。数えるのは味方ユニットが起こしたブレイクだけであり、内側の和は
   * 同じ添字の`breakCounts`以下になる。
   */
  readonly allyUnitBreakCounts: readonly (readonly number[])[];
}

/** `10_API設計.md`「TacticalExerciseEvaluationResponse」。 */
export interface TacticalExerciseEvaluationResponseBody {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
  /** 実際に使われたseed。省略された場合の生成分もここに載る。 */
  readonly seed: string;
  readonly runsPerCandidate: number;
  readonly candidates: readonly TacticalExerciseCandidateEvaluationResponseBody[];
}
