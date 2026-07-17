/**
 * `10_API設計.md`の外部JSON契約と同じ形の、ブランド型を含まないプレーンな型群。
 * Presentation層（Fastify JSON Schema・ルートハンドラ）はこのファイルだけを
 * importすればよく、domain層のbranded typeへ直接触れずに済む
 * （`no-restricted-imports`によるpresentation→domain遮断を維持するため）。
 *
 * ここに定義する型はワイヤーフォーマットの正本であり、値の生成ロジックは
 * 持たない。DTO↔Command / Result↔Responseの変換は
 * `simulate-battle-request-mapper.ts` / `simulate-battle-response-mapper.ts`
 * が担う。
 */

export interface FormationPositionRequestBody {
  readonly column: number;
  readonly row: string;
}

export interface FormationUnitRequestBody {
  readonly unitDefinitionId: string;
  readonly position: FormationPositionRequestBody;
}

export interface FormationRequestBody {
  readonly units: readonly FormationUnitRequestBody[];
  readonly memoryDefinitionIds: readonly string[];
}

export interface SimulationOptionsRequestBody {
  readonly logLevel?: string;
}

export interface BattleSimulationRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly turnLimit: number;
  readonly options?: SimulationOptionsRequestBody;
}

/** `10_API設計.md`「CatalogUnitSummaryResponse」。 */
export interface CatalogUnitSummaryResponseBody {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

/** `10_API設計.md`「CatalogMemorySummaryResponse」。 */
export interface CatalogMemorySummaryResponseBody {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

/** `10_API設計.md`「BattleSimulationCatalogResponse」。 */
export interface BattleSimulationCatalogResponseBody {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
  readonly units: readonly CatalogUnitSummaryResponseBody[];
  readonly memories: readonly CatalogMemorySummaryResponseBody[];
}

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

/** `10_API設計.md`「SubUnitStateResponse」。M8まではResponse Mapperが要素を追加することはない。 */
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
  readonly category: string;
  readonly effectKindKey: string;
  readonly stackMode: string;
  readonly isEffective: boolean;
  readonly value: unknown;
  readonly duration?: { readonly unit: string; readonly remaining: number };
  readonly appliedTurnNumber: number;
  readonly appliedActionId?: string;
}

/**
 * `10_API設計.md`「CooldownStateResponse」。`setAtActionId`/`setAtTurnNumber`は
 * `unit`(ACTION/TURN)に応じてどちらか一方だけ存在する（Domainの`CooldownEntry`と
 * 同じXOR。`state-delta.ts`の`CooldownState`コメント参照）。discriminated union
 * にすることで、両方欠落・両方存在という不正な組み合わせをコンパイル時に防ぐ
 * （M5レビュー3巡目[P2]）。`remaining`は残数があるスキルだけを返す契約のため
 * 1以上。
 */
export type CooldownStateResponseBody =
  | {
      readonly skillDefinitionId: string;
      readonly unit: "ACTION";
      readonly remaining: number;
      readonly setAtActionId: string;
    }
  | {
      readonly skillDefinitionId: string;
      readonly unit: "TURN";
      readonly remaining: number;
      readonly setAtTurnNumber: number;
    };

/** `10_API設計.md`「ChargeStateResponse」。`status`はM5時点でCHARGING以外の値を取り得ない（RELEASE_READY/HELD_BY_FREEZEはM6/M7で追加されるイベント発行後に初めて成立する）。 */
export interface ChargeStateResponseBody {
  readonly skillDefinitionId: string;
  readonly startedActionId: string;
  readonly status: string;
}

/**
 * `10_API設計.md`「BattleUnitStateResponse」。`subUnits`/`effects`は対応するDomain
 * 機構がM7〜M8で実装されるまで常に空配列（`未実装機能を仮の値で成功扱いにしない`
 * の対象は「実際には効いていない補正を有効な値で偽装する」ことであり、「まだ何も
 * 付与されていない」ことを表す空配列は事実そのもの）。`cooldowns`/`charge`はM5で
 * 実装済みのDomain状態（`BattleUnitSnapshot`）をそのまま反映する。
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

export interface BattleLogEventResponseBody {
  readonly sequence: number;
  readonly type: string;
  readonly category: string;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: string;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly rootSequence: number;
  readonly sourceUnitId?: string;
  readonly targetUnitIds: readonly string[];
  readonly details: unknown;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly stateTransitionIndex?: number;
}

export interface UnitResourcesDeltaResponseBody {
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
 * 拡張できるよう、フィールド自体は先に外部契約へ持たせておく）。
 */
export interface UnitStateDeltaResponseBody {
  readonly combatStatus?: ValueChangeBody<string>;
  readonly hp?: ValueChangeBody<number>;
  readonly resources?: UnitResourcesDeltaResponseBody;
  readonly combatStats?: Readonly<Record<string, ValueChangeBody<number>>>;
  readonly shields?: Readonly<Record<string, ValueChangeBody<number>>>;
  readonly subUnits?: EntityCollectionDeltaResponseBody;
  readonly effects?: EntityCollectionDeltaResponseBody;
  readonly cooldowns?: EntityCollectionDeltaResponseBody;
  readonly charge?: ValueChangeBody<unknown>;
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

export interface BattleStateDeltaResponseBody {
  readonly battle?: BattleDeltaResponseBody;
  readonly units?: Readonly<Record<string, UnitStateDeltaResponseBody>>;
  readonly actionQueue?: ActionQueueDeltaResponseBody;
}

export interface StateTransitionResponseBody {
  readonly causedBySequence: number;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly delta: BattleStateDeltaResponseBody;
}

export interface BattleSimulationResponseBody {
  readonly schemaVersion: number;
  readonly battleId: string;
  readonly catalogRevision: string;
  readonly result: BattleResultResponseBody;
  readonly initialState: BattleStateResponseBody;
  readonly finalState: BattleStateResponseBody;
  readonly events: readonly BattleLogEventResponseBody[];
  readonly stateTransitions: readonly StateTransitionResponseBody[];
}

export interface ViolationResponseBody {
  readonly path?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  readonly message: string;
}

export interface ErrorObjectResponseBody {
  readonly code: string;
  readonly message: string;
  readonly violations: readonly ViolationResponseBody[];
  readonly diagnosticId?: string;
}

export interface ErrorResponseBody {
  readonly schemaVersion: number;
  readonly error: ErrorObjectResponseBody;
}
