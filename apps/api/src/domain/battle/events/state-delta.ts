import type { BattleStatus } from "../model/battle-status.js";
import type { CooldownUnit } from "../../catalog/definitions/skill-definition.js";
import type { VictoryResult } from "../outcome/victory-policy.js";
import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { ActionId } from "../../shared/event-ids.js";

export interface ValueChange<T> {
  readonly before: T;
  readonly after: T;
}

/** `Battle.result`と同じ形。`battle.js`からの循環importを避けるため独立に定義する。 */
export type BattleResultSnapshot = VictoryResult & { readonly completedTurn: number };

/**
 * `06_戦闘状態遷移.md`「クールタイム状態」の外部公開形。`setActionId`/`setTurnNumber`は
 * 「設定した同じ行動・ターンでは減算しない」(R-SKL-04)の設定scopeを、`unit`に応じて
 * どちらか一方だけ持つ（`cooldown-state.ts`の`CooldownEntry`と同じXOR）。
 * `UnitStateDelta.cooldowns`にも同じ形で運ばれ、`08_ドメインイベント.md`
 * 「状態復元」の`stateTransitions`単体（`events`のlogLevelによる間引きに
 * 依存しない）から独立Reducerで復元できる。
 */
export interface CooldownState {
  readonly unit: CooldownUnit;
  readonly remaining: number;
  readonly setActionId?: ActionId;
  readonly setTurnNumber?: number;
}

/** `06_戦闘状態遷移.md`「チャージ状態」の外部公開形。 */
export interface ChargeState {
  readonly skillDefinitionId: SkillDefinitionId;
  readonly startedActionId: ActionId;
}

/**
 * `10_API設計.md`「EffectStateResponse」の外部公開形（PR #155レビュー[P1]）。
 * `category`/`stackMode`/`isEffective`/`value`はwire形状への変換であり、
 * `CooldownState`と同じ方針でここでは持たない — 未加工に近い値
 * （`duplicate`/`active`/`magnitude`）だけを保持し、Response Mapperが
 * `toEffectStateResponseBody`で導出する。
 *
 * `duration`は`AppliedEffect.duration.definition.timeLimit.unit`が
 * `ACTION`/`TURN`の場合だけ持つ。`10_API設計.md`の`EffectStateResponse.duration`
 * は`{ unit: "ACTION" | "TURN", remaining }`しか表現できず、`BATTLE`/`HIT`/
 * `SKILL_USE`スコープの残り回数を運べない（API契約側の既知の未対応範囲。
 * `14_Catalog定義スキーマ.md`のDurationDefinitionが先に対応scopeを広げている）。
 * その場合は`duration`自体を省略する（あたかも永続効果であるかのように
 * 偽装しない代わりに、表現不能な残り回数を黙って捨てる — このPRの
 * スコープでは契約自体の拡張までは行わない）。
 */
export interface EffectSnapshot {
  readonly effectInstanceId: string;
  readonly effectDefinitionId: string;
  readonly sourceUnitId?: BattleUnitId;
  readonly effectKindKey: string;
  readonly duplicate: boolean;
  readonly active: boolean;
  readonly magnitude: number;
  readonly duration?: { readonly unit: "ACTION" | "TURN"; readonly remaining: number };
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: ActionId;
}

/** `08_ドメインイベント.md`「StateDelta」: 変更した項目だけを持つ。 */
export interface UnitStateDelta {
  readonly hp?: ValueChange<number>;
  readonly ap?: ValueChange<number>;
  readonly pp?: ValueChange<number>;
  readonly extraGauge?: ValueChange<number>;
  /**
   * R-SKL-04: SkillDefinitionIdをキーとする、変更されたクールタイムだけを持つ。
   * `unit`(ACTION/TURN)はスキル使用開始時から不変だが、ReducerはCatalogを
   * 参照できないため、初回設定(`CooldownStarted`)以降の全ての変更でも
   * 一緒に運ぶ（`before`のみのValueChangeでは初回設定時に`unit`を復元できない）。
   * `setActionId`/`setTurnNumber`は初回設定(`CooldownStarted`)時だけ`unit`に
   * 応じてどちらか一方を持ち、以降の変更(`CooldownReduced`等)では省略する
   * （設定scope自体は変わらないため、独立Reducerは既存値を保持する）。
   */
  readonly cooldowns?: Readonly<
    Record<
      SkillDefinitionId,
      {
        readonly unit: CooldownUnit;
        readonly setActionId?: ActionId;
        readonly setTurnNumber?: number;
      } & ValueChange<number>
    >
  >;
  /** R-SKL-05: チャージ開始(`undefined`→値)・解放/中断(値→`undefined`)。 */
  readonly charge?: ValueChange<ChargeState | undefined>;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」の`SkillRuntime`スコープ（M6最小実装、
   * Issue #143）。`SkillDefinitionId`→`RuntimeCounterId`の2段キーで、変更された
   * counterの`value`だけを持つ（`RuntimeCounterChanged`/`RuntimeCounterReset`が
   * 単独で所有する`stateDelta`）。値が変化しなかった更新（carryのみの変化）では
   * このキー自体を持たない（`skillCounterCarry`を参照）。
   *
   * レビュー指摘[P1]: `after: undefined`は`RuntimeCounterReset`によるcounter
   * キー自体の削除を表す（`0`という値ではなく、実状態の`resetRuntimeCounter`が
   * キーを`delete`することと対応させる — `after: 0`のままだと独立Reducerが
   * `{ counter: 0 }`を復元してしまい、実状態の`{}`と一致しなくなる）。
   */
  readonly skillCounters?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
  /**
   * `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（`carry`）専用の差分
   * （レビュー再々レビュー[P2]、Issue #143: `carry`はStateDeltaから除外されて
   * いたため、次回の閾値判定に必要な内部状態がStateDelta単独から復元できな
   * かった）。`skillCounters`と同じ2段キーだが独立に変化するため別フィールドと
   * する（`INCREMENT`は常に`carry`が0のままのためこのキーを持たない）。
   * `after: undefined`は`RuntimeCounterReset`によるキー削除を表す。
   */
  readonly skillCounterCarry?: Readonly<
    Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>
  >;
}

/**
 * `08_ドメインイベント.md`「StateDelta」: 変更した戦闘ユニットIDや状態区分だけを
 * キーとして記録する。配列位置に依存するJSON Patchではなく、安定したドメインID
 * で差分対象を識別する。
 */
export interface StateDelta {
  readonly units?: Readonly<Record<BattleUnitId, UnitStateDelta>>;
  readonly turnNumber?: ValueChange<number>;
  readonly battleStatus?: ValueChange<BattleStatus>;
  /** 勝敗確定（`BattleCompleted`）のみが持つ。`before`は常に`undefined`（未確定）。 */
  readonly result?: ValueChange<BattleResultSnapshot | undefined>;
}
