import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { frontDirectionStep, manhattanDistance } from "./position-policy.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { Side as SelectorSide, UnitType } from "../../catalog/definitions/catalog-enums.js";
import type {
  AreaDefinition,
  TargetFilterDefinition,
  TargetOrderEntry,
  TargetOrderKey,
  TargetSelectorDefinition,
} from "../../catalog/definitions/target-selector-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type {
  MarkerId,
  TargetBindingId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

const ROW_ORDER: Record<BattleUnit["position"]["row"], number> = { FRONT: 0, BACK: 1 };

/** R-TGT-09で`base: BINDING`が参照する、同じEffectSequence内で定義順に解決済みのtargetBinding。 */
export type ResolvedTargetBindings = ReadonlyMap<TargetBindingId, readonly BattleUnit[]>;

const EMPTY_RESOLVED_BINDINGS: ResolvedTargetBindings = new Map();

/**
 * R-TGT-09/CAP_TRIGGER_CONTEXT（RES-005、Issue #172）: `selector.kind`または
 * `BINDING_DERIVED.base`が参照する`TRIGGER_SOURCE`/`TRIGGER_TARGET`の解決先。
 * 呼び出し側（`passive-activation-service.ts`）が候補検出に使った
 * `TriggerCandidateEvent`の`sourceUnitId`/`targetUnitIds`をそのまま渡す
 * （PRレビュー指摘[P2]: `BattleUnit`をここで解決・保持すると、先行する
 * EffectActionや子PS連鎖が対象のHP・combatStatsを変更した後でも古いスナップ
 * ショットを読み続けてしまう。IDだけを保持し、実際に`BattleUnit`が必要な
 * 各呼び出し元が、その時点の最新`allUnits`/`box.units`/`working`から都度
 * 解決し直す）。`skill-resolution-service.ts`もこの同じ型を再利用する。
 */
export interface TriggerContext {
  readonly triggerSourceUnitId?: BattleUnitId;
  readonly triggerTargetUnitIds?: readonly BattleUnitId[];
  /**
   * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: 候補検出に使った
   * トリガーイベント自身の`payload`。`resolution.steps`側の`EVENT_PAYLOAD`
   * 条件（`effect-step-condition-evaluator.ts`）がこれを参照できるよう、
   * `passive-activation-service.ts`が候補検出へ使ったイベントの`payload`を
   * そのまま伝搬する。
   */
  readonly triggerEventPayload?: Readonly<Record<string, unknown>>;
}

/**
 * `05_ドメインモデル.md`「TargetBinding / TargetSelector」: Catalogの`side`は使用者から見た相対陣営を表す。
 * `battle/skill`の`FormulaEvaluator`（`ALIVE_UNIT_COUNT_SCALE`、RES-001/Issue #175）も
 * 同じ相対陣営解決を再利用する（`no-restricted-imports`は`battle/skill`→`battle/targeting`
 * を許可している）。
 */
export function matchesRelativeSide(
  unit: BattleUnit,
  actor: BattleUnit,
  side: SelectorSide,
): boolean {
  return matchesRelativeSideOf(unit, actor.side, side);
}

/**
 * R-MEM-04「使用者はMemoryを指定した陣営を source side とする」: Memory由来の
 * 解決には使用者BattleUnitが存在しないため、相対陣営の基準を`Side`だけで表す版。
 * `matchesRelativeSide`（使用者ユニットを持つ通常のSkill/PS経路）はこの関数へ
 * 委譲する — 相対陣営の解決規則自体は使用者の`side`しか使わないため、両者が
 * 分岐して食い違うことがない。
 */
export function matchesRelativeSideOf(
  unit: BattleUnit,
  actorSide: Side,
  side: SelectorSide,
): boolean {
  if (side === "ALL") {
    return true;
  }
  const opposite: Side = actorSide === "ALLY" ? "ENEMY" : "ALLY";
  const absoluteSide = side === "ALLY" ? actorSide : opposite;
  return unit.side === absoluteSide;
}

/**
 * R-MEM-04「使用者はMemoryを指定した陣営を source side とし、対象参照の`SELF`は
 * 使用できない」: Memory の `triggeredEffects` 解決には使用者BattleUnitが存在
 * しないため、対象解決の基準を「陣営だけ」で表す発生源。`BattleUnit`は
 * `memorySource`フィールドを持たないため、両者は構造的に判別できる
 * （既存のSkill/PS経路は`BattleUnit`をそのまま渡し続けられる）。
 */
export interface MemoryResolutionSource {
  readonly side: Side;
  readonly memorySource: true;
}

/** 対象解決の基準（通常のSkill/PS使用者、またはMemoryのsource side）。 */
export type ResolutionSource = BattleUnit | MemoryResolutionSource;

export function createMemoryResolutionSource(side: Side): MemoryResolutionSource {
  return { side, memorySource: true };
}

export function isMemoryResolutionSource(
  source: ResolutionSource,
): source is MemoryResolutionSource {
  return "memorySource" in source;
}

/**
 * 使用者BattleUnitを必要とする対象解決（`SELF`、使用者からの距離順、
 * `SELF_LOWEST_PRIORITY`、areaのbase）から呼ぶ。Memory由来の解決では
 * 使用者が存在しないため、黙って候補0件にせず明確に拒否する
 * （R-MEM-04「具体的な発生源 BattleUnit が必要なEffectActionをMemoryから使用
 * する場合は、Catalog検証またはpreflightで拒否する」と同じ隔離方針で、
 * Catalog整合性検証／preflightが本来ここへ到達させない）。
 */
export function requireSourceUnit(source: ResolutionSource, feature: string): BattleUnit {
  if (isMemoryResolutionSource(source)) {
    throw new DomainValidationError(
      "selector",
      `${feature} requires a source BattleUnit, which Memory triggeredEffects do not have (R-MEM-04)`,
    );
  }
  return source;
}

const EMPTY_UNIT_DEFINITIONS: ReadonlyMap<UnitDefinitionId, UnitDefinition> = new Map();

/** TGT-002（CAP_TARGET_FILTER_ORDER）: UNIT_TYPE/ROLE/AFFILIATION/CHARACTERフィルタ・UNIT_TYPE_PRIORITY orderが要る静的Catalogデータ。 */
function lookupUnitDefinition(
  unit: BattleUnit,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
): UnitDefinition {
  const definition = unitDefinitions.get(unit.unitDefinitionId);
  if (definition === undefined) {
    throw new DomainValidationError(
      "unitDefinitions",
      `no UnitDefinition found for unitDefinitionId "${unit.unitDefinitionId}"`,
    );
  }
  return definition;
}

function markerStackCount(unit: BattleUnit, markerId: MarkerId): number {
  return unit.markerStates.find((state) => state.markerId === markerId)?.stackCount ?? 0;
}

/** HP_RATIO filter/MARKER countConditionが使う数値比較（`domain/battle/targeting`は`domain/battle/skill`のcomparison-operator.tsへ依存できないため独立実装する）。 */
function compareNumeric(
  actual: number,
  op: "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ",
  expected: number,
): boolean {
  switch (op) {
    case "GT":
      return actual > expected;
    case "GTE":
      return actual >= expected;
    case "LT":
      return actual < expected;
    case "LTE":
      return actual <= expected;
    case "EQ":
      return actual === expected;
    case "NEQ":
      return actual !== expected;
  }
}

interface FilterContext {
  readonly source: ResolutionSource;
  readonly allUnits: readonly BattleUnit[];
  readonly resolvedBindings: ResolvedTargetBindings;
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
}

/** TARGET_EXCLUDE_RESOLVED_UNIT（TGT-002）: SELF/BINDINGのみ対応（TRIGGER_SOURCE/TRIGGER_TARGET/LAST_*はM7スコープ外）。 */
function resolveExcludeReferenceUnits(
  reference: TargetReference,
  source: ResolutionSource,
  resolvedBindings: ResolvedTargetBindings,
): readonly BattleUnit[] {
  if (reference.kind === "SELF") {
    return [requireSourceUnit(source, 'EXCLUDE_RESOLVED_UNIT with reference kind "SELF"')];
  }
  if (reference.kind === "BINDING") {
    const targetBindingId = reference.targetBindingId as TargetBindingId;
    const units = resolvedBindings.get(targetBindingId);
    if (units === undefined) {
      throw new DomainValidationError(
        "filter.reference.targetBindingId",
        `targetBindingId "${targetBindingId}" was not resolved from targetBindings`,
      );
    }
    return units;
  }
  throw new DomainValidationError(
    "filter.reference.kind",
    `kind "${reference.kind}" is not supported by EXCLUDE_RESOLVED_UNIT (only SELF/BINDING, M7 scope)`,
  );
}

/**
 * R-TGT-09 #3（TGT-002、CAP_TARGET_FILTER_ORDER）: `filters`を定義順にAND評価する
 * （複数filterは暗黙のAND、`AND`/`OR`/`NOT`は入れ子条件として評価する）。
 */
function matchesFilter(
  filter: TargetFilterDefinition,
  candidate: BattleUnit,
  ctx: FilterContext,
): boolean {
  switch (filter.kind) {
    case "POSITION_ROW":
      return candidate.position.row === filter.row;
    case "POSITION_COLUMN":
      return candidate.position.column === filter.column;
    case "POSITION_SLOT":
      return candidate.position.row === filter.row && candidate.position.column === filter.column;
    case "UNIT_TYPE":
      return lookupUnitDefinition(candidate, ctx.unitDefinitions).unitType === filter.unitType;
    case "ROLE":
      return lookupUnitDefinition(candidate, ctx.unitDefinitions).role === filter.role;
    case "ATTRIBUTE":
      return candidate.attribute === filter.attribute;
    case "AFFILIATION":
      return lookupUnitDefinition(candidate, ctx.unitDefinitions).metadata.affiliations.includes(
        filter.affiliationId,
      );
    case "CHARACTER":
      return (
        lookupUnitDefinition(candidate, ctx.unitDefinitions).metadata.characterId ===
        filter.characterId
      );
    case "HAS_MARKER": {
      const marker = candidate.markerStates.find((state) => state.markerId === filter.markerId);
      if (marker === undefined) {
        return false;
      }
      if (filter.countCondition === undefined) {
        return true;
      }
      return compareNumeric(
        marker.stackCount,
        filter.countCondition.op as "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ",
        filter.countCondition.value,
      );
    }
    case "HP_RATIO":
      return compareNumeric(
        candidate.currentHp / candidate.combatStats.maximumHp,
        filter.op as "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ",
        filter.value,
      );
    case "EXCLUDE_RESOLVED_UNIT": {
      const excluded = resolveExcludeReferenceUnits(
        filter.reference,
        ctx.source,
        ctx.resolvedBindings,
      );
      return !excluded.some((unit) => unit.battleUnitId === candidate.battleUnitId);
    }
    case "MARKER_IN_AREA": {
      // PR #233レビュー[P1]: 戦闘不能者にもmarkerStatesは残るため、明示的な
      // includeDefeated指定がない限り、所在判定の対象からも除外する
      // （候補自身の戦闘不能除外はR-TGT-01 #2/R-TGT-09 #2で既に済んでいる）。
      const areaPool = applyArea(filter.area, candidate, ctx.allUnits).filter(
        (unit) => !isDefeated(unit),
      );
      return areaPool.some((unit) =>
        unit.markerStates.some((state) => state.markerId === filter.markerId),
      );
    }
    case "AND":
      return filter.conditions.every((condition) => matchesFilter(condition, candidate, ctx));
    case "OR":
      return filter.conditions.some((condition) => matchesFilter(condition, candidate, ctx));
    case "NOT":
      return !matchesFilter(filter.condition, candidate, ctx);
  }
}

/**
 * R-TGT-02: 使用者からのマンハッタン距離昇順→対象側の行（前列、後列）→対象の列
 * （絶対左、中央、右）。
 *
 * R-MEM-04（Issue #179）: Memory由来の解決には使用者が存在しないため、距離の項を
 * 持たず行→列だけで並べる（盤面上の位置は陣営内で一意なので、単一陣営を選ぶ
 * production Memoryのbindingでは常に決定的な順序になる）。距離そのものを意味に
 * 持つ`NEAREST`/`FARTHEST`は、代わりに使用者を要求して拒否する。
 */
function compareDefaultOrder(source: ResolutionSource) {
  const actor = isMemoryResolutionSource(source) ? undefined : source;
  return (a: BattleUnit, b: BattleUnit): number => {
    if (actor !== undefined) {
      const distanceA = manhattanDistance(actor.globalCoordinate, a.globalCoordinate);
      const distanceB = manhattanDistance(actor.globalCoordinate, b.globalCoordinate);
      if (distanceA !== distanceB) {
        return distanceA - distanceB;
      }
    }
    if (ROW_ORDER[a.position.row] !== ROW_ORDER[b.position.row]) {
      return ROW_ORDER[a.position.row] - ROW_ORDER[b.position.row];
    }
    return a.globalCoordinate.x - b.globalCoordinate.x;
  };
}

/** R-TGT-03: R-TGT-02の並び全体を逆順にする（距離だけでなく行・列の同点判定も反転する）。 */
function compareFarthestOrder(source: ResolutionSource) {
  const base = compareDefaultOrder(requireSourceUnit(source, 'order key "FARTHEST"'));
  return (a: BattleUnit, b: BattleUnit): number => -base(a, b);
}

/**
 * R-TGT-06「列優先」の行(前後列)版: 指定した行を先に並べ、同じ優先度の候補は
 * `compareByOrder`側で付加される`compareDefaultOrder`フォールバックへ委ねる
 * （単独の比較キーとして`order`配列内の他キーと組み合わせられる、production
 * Catalogの`["FRONT_ROW", "DEFAULT"]`のような並びに対応するため）。
 */
function compareRowPriority(priorityRow: BattleUnit["position"]["row"]) {
  return (a: BattleUnit, b: BattleUnit): number => {
    const rankA = a.position.row === priorityRow ? 0 : 1;
    const rankB = b.position.row === priorityRow ? 0 : 1;
    return rankA - rankB;
  };
}

function hpRatio(unit: BattleUnit): number {
  return unit.currentHp / unit.combatStats.maximumHp;
}

function exGaugeRatio(unit: BattleUnit): number {
  return unit.maximumExtraGauge === 0 ? 0 : unit.currentExtraGauge / unit.maximumExtraGauge;
}

/** TGT-002（CAP_TARGET_FILTER_ORDER）: R-TGT-02の距離部分のみを単独比較キーとして使う（`["FRONT_ROW", "NEAREST", "LEFT_TO_RIGHT"]`のような分解済み並びに対応）。 */
function compareNearestOrder(source: ResolutionSource) {
  const actor = requireSourceUnit(source, 'order key "NEAREST"');
  return (a: BattleUnit, b: BattleUnit): number =>
    manhattanDistance(actor.globalCoordinate, a.globalCoordinate) -
    manhattanDistance(actor.globalCoordinate, b.globalCoordinate);
}

function compareLeftToRight(a: BattleUnit, b: BattleUnit): number {
  return a.globalCoordinate.x - b.globalCoordinate.x;
}

function compareLowestHpRatio(a: BattleUnit, b: BattleUnit): number {
  return hpRatio(a) - hpRatio(b);
}

function compareHighestHpRatio(a: BattleUnit, b: BattleUnit): number {
  return hpRatio(b) - hpRatio(a);
}

function compareHighestAttack(a: BattleUnit, b: BattleUnit): number {
  return b.combatStats.attack - a.combatStats.attack;
}

function compareLowestAttack(a: BattleUnit, b: BattleUnit): number {
  return a.combatStats.attack - b.combatStats.attack;
}

function compareLowestMaxHp(a: BattleUnit, b: BattleUnit): number {
  return a.combatStats.maximumHp - b.combatStats.maximumHp;
}

function compareHighestMaxHp(a: BattleUnit, b: BattleUnit): number {
  return b.combatStats.maximumHp - a.combatStats.maximumHp;
}

function compareHighestExGaugeRatio(a: BattleUnit, b: BattleUnit): number {
  return exGaugeRatio(b) - exGaugeRatio(a);
}

function compareFastest(a: BattleUnit, b: BattleUnit): number {
  return b.combatStats.actionSpeed - a.combatStats.actionSpeed;
}

/** TARGET_ORDER_UNITTYPE_OR_SELF_EXCLUDEテーマ:「自身以外を優先」— 自身をhard excludeせず末尾へ回す（自身しかいない場合は自身が残る）。 */
function compareSelfLowestPriority(source: ResolutionSource) {
  const actor = requireSourceUnit(source, 'order key "SELF_LOWEST_PRIORITY"');
  return (a: BattleUnit, b: BattleUnit): number => {
    const rankA = a.battleUnitId === actor.battleUnitId ? 1 : 0;
    const rankB = b.battleUnitId === actor.battleUnitId ? 1 : 0;
    return rankA - rankB;
  };
}

const SINGLE_KEY_ORDER_COMPARATORS: Record<
  TargetOrderKey,
  (source: ResolutionSource) => (a: BattleUnit, b: BattleUnit) => number
> = {
  DEFAULT: compareDefaultOrder,
  NEAREST: compareNearestOrder,
  FARTHEST: compareFarthestOrder,
  FRONT_ROW: () => compareRowPriority("FRONT"),
  BACK_ROW: () => compareRowPriority("BACK"),
  LEFT_TO_RIGHT: () => compareLeftToRight,
  LOWEST_HP_RATIO: () => compareLowestHpRatio,
  HIGHEST_HP_RATIO: () => compareHighestHpRatio,
  HIGHEST_ATTACK: () => compareHighestAttack,
  LOWEST_ATTACK: () => compareLowestAttack,
  LOWEST_MAX_HP: () => compareLowestMaxHp,
  HIGHEST_MAX_HP: () => compareHighestMaxHp,
  HIGHEST_EX_GAUGE_RATIO: () => compareHighestExGaugeRatio,
  FASTEST: () => compareFastest,
  SELF_LOWEST_PRIORITY: compareSelfLowestPriority,
};

/** TARGET_ORDER_MARKER_COUNTテーマ: Marker所持数（`markerId`指定）を比較キーにする。 */
function compareMarkerCount(markerId: MarkerId, direction: "ASC" | "DESC") {
  const sign = direction === "ASC" ? 1 : -1;
  return (a: BattleUnit, b: BattleUnit): number =>
    sign * (markerStackCount(a, markerId) - markerStackCount(b, markerId));
}

/** TARGET_ORDER_UNITTYPE_OR_SELF_EXCLUDEテーマ: 指定unitTypeを優先する。 */
function compareUnitTypePriority(
  unitType: UnitType,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
) {
  const rank = (unit: BattleUnit): number =>
    lookupUnitDefinition(unit, unitDefinitions).unitType === unitType ? 0 : 1;
  return (a: BattleUnit, b: BattleUnit): number => rank(a) - rank(b);
}

/**
 * R-TGT-09 #5: `order`を上から順に比較キーとして適用し、候補順を一意にする。
 * 各キーは単独の比較（同点なら0を返す）で、production Catalogの
 * `["FRONT_ROW", "DEFAULT"]`のように配列内で組み合わせられることを前提とする
 * （`FARTHEST`は例外的にR-TGT-03の全体反転そのものであり単独で一意な順序になる）。
 * 指定された全キーが同点の場合も、盤面上の位置は一意なため`compareDefaultOrder`
 * で必ず順序を確定する。`MARKER_COUNT`/`UNIT_TYPE_PRIORITY`はパラメータ付き
 * オブジェクト形式の`TargetOrderEntry`（TGT-002）。
 */
function compareByOrder(
  orderEntries: readonly TargetOrderEntry[],
  source: ResolutionSource,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
) {
  const comparators = orderEntries.map((entry) => {
    if (typeof entry !== "string") {
      return entry.kind === "MARKER_COUNT"
        ? compareMarkerCount(entry.markerId, entry.direction)
        : compareUnitTypePriority(entry.unitType, unitDefinitions);
    }
    const factory = SINGLE_KEY_ORDER_COMPARATORS[entry];
    if (factory === undefined) {
      throw new DomainValidationError(
        "selector.order",
        `order key "${entry}" is not supported by this TargetSelectionPolicy (TGT-002/CAP_TARGET_FILTER_ORDER scope)`,
      );
    }
    return factory(source);
  });
  const fallback = compareDefaultOrder(source);
  return (a: BattleUnit, b: BattleUnit): number => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) {
        return result;
      }
    }
    return fallback(a, b);
  };
}

/**
 * R-TGT-09 #1 `BINDING_DERIVED`の`base`解決。`kind: BINDING_DERIVED`以外は
 * 常に使用者(`actor`)を暗黙のbaseとする（`UT-CAT-TSEL-007`: `kind: SELF`と
 * `area: SAME_ROW_AS_BASE`のような組み合わせもCatalog上は許容されるため）。
 */
function findUnit(allUnits: readonly BattleUnit[], id: BattleUnitId): BattleUnit | undefined {
  return allUnits.find((candidate) => candidate.battleUnitId === id);
}

function resolveBase(
  selector: TargetSelectorDefinition,
  source: ResolutionSource,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings,
  triggerContext?: TriggerContext,
): BattleUnit | undefined {
  if (selector.kind !== "BINDING_DERIVED") {
    return requireSourceUnit(source, "an area whose base is the implicit source unit");
  }
  const reference = selector.base as TargetReference;
  if (reference.kind === "SELF") {
    return requireSourceUnit(source, 'an area base of kind "SELF"');
  }
  if (reference.kind === "BINDING") {
    const targetBindingId = reference.targetBindingId as TargetBindingId;
    const units = resolvedBindings.get(targetBindingId);
    if (units === undefined) {
      throw new DomainValidationError(
        "selector.base.targetBindingId",
        `targetBindingId "${targetBindingId}" was not resolved from targetBindings`,
      );
    }
    return units[0];
  }
  if (reference.kind === "TRIGGER_SOURCE") {
    const unit =
      triggerContext?.triggerSourceUnitId !== undefined
        ? findUnit(allUnits, triggerContext.triggerSourceUnitId)
        : undefined;
    if (unit === undefined) {
      throw new DomainValidationError(
        "selector.base.kind",
        'kind "TRIGGER_SOURCE" requires a triggerContext.triggerSourceUnitId resolvable in allUnits (CAP_TRIGGER_CONTEXT/RES-005)',
      );
    }
    return unit;
  }
  if (reference.kind === "TRIGGER_TARGET") {
    // R-TGT-10「先頭の1体を基準対象とする」と同じ規約: `TRIGGER_TARGET`が複数
    // ユニットを指す場合も、areaの基準は先頭の1体とする。
    const firstId = triggerContext?.triggerTargetUnitIds?.[0];
    const unit = firstId !== undefined ? findUnit(allUnits, firstId) : undefined;
    if (unit === undefined) {
      throw new DomainValidationError(
        "selector.base.kind",
        'kind "TRIGGER_TARGET" requires a triggerContext.triggerTargetUnitIds resolvable in allUnits (CAP_TRIGGER_CONTEXT/RES-005)',
      );
    }
    return unit;
  }
  throw new DomainValidationError(
    "selector.base.kind",
    `kind "${reference.kind}" is not supported by this TargetSelectionPolicy (M7 scope, see CAP_TRIGGER_CONTEXT/RES-005)`,
  );
}

/** R-TGT-04/05/09: baseを基準にした範囲。baseが存在しない場合は候補0件とする。 */
function applyArea(
  area: AreaDefinition,
  base: BattleUnit | undefined,
  pool: readonly BattleUnit[],
): readonly BattleUnit[] {
  if (base === undefined) {
    return [];
  }
  switch (area.kind) {
    // R-TGT-04: 基準対象と同じ陣営の盤面内で、上下左右1マス（陣営境界は越えない、斜めは含めない）。
    case "ADJACENT_ORTHOGONAL":
      return pool.filter(
        (u) =>
          u.side === base.side &&
          manhattanDistance(u.globalCoordinate, base.globalCoordinate) === 1,
      );
    // R-TGT-05: 基準対象と同じ陣営の盤面内で、同じ列の1マス前。前列が基準なら候補なし。
    case "DIRECTLY_AHEAD_OF_BASE": {
      const targetY = base.globalCoordinate.y + frontDirectionStep(base.side);
      return pool.filter(
        (u) =>
          u.side === base.side &&
          u.globalCoordinate.x === base.globalCoordinate.x &&
          u.globalCoordinate.y === targetY,
      );
    }
    case "BEHIND_BASE": {
      const targetY = base.globalCoordinate.y - frontDirectionStep(base.side);
      return pool.filter(
        (u) =>
          u.side === base.side &&
          u.globalCoordinate.x === base.globalCoordinate.x &&
          u.globalCoordinate.y === targetY,
      );
    }
    case "SAME_ROW_AS_BASE":
      return pool.filter(
        (u) =>
          u.side === base.side &&
          u.globalCoordinate.y === base.globalCoordinate.y &&
          (area.includeBase || u.battleUnitId !== base.battleUnitId),
      );
    case "SAME_COLUMN_AS_BASE":
      return pool.filter(
        (u) =>
          u.side === base.side &&
          u.globalCoordinate.x === base.globalCoordinate.x &&
          (area.includeBase || u.battleUnitId !== base.battleUnitId),
      );
    default:
      throw new DomainValidationError(
        "selector.area.kind",
        `area kind "${area.kind}" is not supported by this TargetSelectionPolicy (M7 scope)`,
      );
  }
}

/**
 * `TargetSelectionPolicy` (`05_ドメインモデル.md`)。R-TGT-01（候補生成、自分自身のみ
 * 対象の特例、候補0体）、R-TGT-02（デフォルト順）、R-TGT-03（最も遠い）、R-TGT-04
 * （隣接）、R-TGT-05（目の前）、R-TGT-06（前後列優先順）、R-TGT-07（対象数不足）、
 * R-TGT-09（`kind`→戦闘不能除外→`filters`→`area`→`order`→`count`→`fallback`の評価順、
 * `BINDING_DERIVED`の`base`解決）、R-TGT-10/CAP_TARGET_BINDING_FALLBACK（Issue #168/
 * TGT-003: `count`適用後の候補が0件かつ`fallback`があれば、`fallback`自身を同じ
 * `resolveTargets`で再帰的に評価する）を実装する。`filters`（非空）と`order`の
 * 残り全キー・パラメータ付きエントリ（TGT-002、`CAP_TARGET_FILTER_ORDER`、
 * Issue #169）は`matchesFilter`/`compareByOrder`が評価する。`filter.reference`の
 * `EXCLUDE_RESOLVED_UNIT`はSELF/BINDINGのみ対応し、`selector.kind`/`base`の
 * `TRIGGER_SOURCE`/`TRIGGER_TARGET`は`triggerContext`（`CAP_TRIGGER_CONTEXT`、
 * RES-005、Issue #172）から解決する。`base`の`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`参照は引き続き未対応のため例外を投げる。
 */
function resolveTriggerPool(
  kind: "TRIGGER_SOURCE" | "TRIGGER_TARGET",
  source: ResolutionSource,
  selector: TargetSelectorDefinition,
  allUnits: readonly BattleUnit[],
  triggerContext: TriggerContext | undefined,
): readonly BattleUnit[] {
  const ids =
    kind === "TRIGGER_SOURCE"
      ? triggerContext?.triggerSourceUnitId !== undefined
        ? [triggerContext.triggerSourceUnitId]
        : undefined
      : triggerContext?.triggerTargetUnitIds;
  if (ids === undefined) {
    throw new DomainValidationError(
      "selector.kind",
      `kind "${kind}" requires a matching triggerContext (CAP_TRIGGER_CONTEXT/RES-005)`,
    );
  }
  const units = ids.map((id) => {
    const unit = findUnit(allUnits, id);
    if (unit === undefined) {
      throw new DomainValidationError(
        "selector.kind",
        `kind "${kind}" referenced battleUnitId "${id}" that is not present in allUnits`,
      );
    }
    return unit;
  });
  return selector.side === undefined
    ? units
    : units.filter((u) => matchesRelativeSideOf(u, source.side, selector.side as SelectorSide));
}

/** R-TGT-08（TGT-004、Issue #167）: 消費された（第一優先対象として移動された）Stealth AppliedEffectインスタンス。 */
export interface StealthConsumption {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
}

interface ResolveTargetsCoreResult {
  readonly selected: readonly BattleUnit[];
  readonly stealthConsumption?: StealthConsumption;
}

const EMPTY_CONSUMED_STEALTH_EFFECT_INSTANCE_IDS: ReadonlySet<EffectInstanceId> = new Set();

/**
 * PR #237再々レビュー[P1]: `filters`（`POSITION_SLOT`、`AND`で組み合わされた
 * 場合も含む）が候補集合を定義上最大1体へ限定するかどうか。`POSITION_SLOT`は
 * row+columnの組で一意なスロットを指すため、選択対象が単一の陣営
 * （`side: "ALLY"`/`"ENEMY"`）に絞られている限り、そのスロットに存在しうる
 * ユニットは最大1体になる（呼び出し側`isStructurallySingleCandidateSelector`が
 * `side`側の絞り込みを別途確認する）。
 */
function filterStructurallyLimitsToSingleCandidate(filter: TargetFilterDefinition): boolean {
  switch (filter.kind) {
    case "POSITION_SLOT":
      return true;
    case "AND":
      // ANDは条件を狭める方向にしか働かないため、いずれか1つが単一候補への
      // 限定を保証すれば全体も保証される。
      return filter.conditions.some((condition) =>
        filterStructurallyLimitsToSingleCandidate(condition),
      );
    default:
      // OR/NOTを含むその他のkindは候補数の上限を一般に保証できないため、
      // 構造的な限定とはみなさない（安全側: Q-TGT-05の通常経路へ進める）。
      return false;
  }
}

/**
 * PR #237再々レビュー[P1]: `area`が候補集合を定義上最大1体へ限定するかどうか。
 * `DIRECTLY_AHEAD_OF_BASE`/`BEHIND_BASE`は`applyArea`内部で`u.side === base.side`
 * かつ単一の(x, y)座標に絞り込むため、`selector.side`の値に関わらず常に最大1体
 * （その座標を占有できるユニットは高々1体）。他のarea kindは複数座標に及びうる
 * ため対象外。
 */
function areaStructurallyLimitsToSingleCandidate(area: AreaDefinition): boolean {
  return area.kind === "DIRECTLY_AHEAD_OF_BASE" || area.kind === "BEHIND_BASE";
}

/**
 * PR #237再レビュー[P1]・再々レビュー[P1]: R-TGT-08 #6（自身を対象とする自身の
 * スキル）と#7（イベント／条件によって対象範囲が構造的に1体へ限定されている
 * 場合）が指す「構造的に1体」のselector。`kind`が`SELF`/`TRIGGER_SOURCE`/
 * `TRIGGER_TARGET`の場合は候補集合が使用者自身またはtrigger eventが渡した
 * 固定集合から構造的に導かれる。`SELECT`/`BINDING_DERIVED`は候補が盤面の
 * 生存状況に依存するため原則対象外だが（たとえ現在1件しかなくても、それは
 * Q-TGT-05の「代替対象なし」であり#7の「構造的な限定」ではない）、`filters`に
 * `POSITION_SLOT`（単一陣営に絞られている場合）や`area`に`DIRECTLY_AHEAD_OF_BASE`/
 * `BEHIND_BASE`を持つ場合は、盤面の生存状況とは無関係に候補が定義上1体以下へ
 * 限定されるため、これらも#7の「構造的な限定」として扱う。
 */
function isStructurallySingleCandidateSelector(selector: TargetSelectorDefinition): boolean {
  if (
    selector.kind === "SELF" ||
    selector.kind === "TRIGGER_SOURCE" ||
    selector.kind === "TRIGGER_TARGET"
  ) {
    return true;
  }
  const isSingleSideSelector = selector.side === "ALLY" || selector.side === "ENEMY";
  if (
    isSingleSideSelector &&
    selector.filters.some((filter) => filterStructurallyLimitsToSingleCandidate(filter))
  ) {
    return true;
  }
  if (selector.area !== undefined && areaStructurallyLimitsToSingleCandidate(selector.area)) {
    return true;
  }
  return false;
}

/**
 * R-TGT-08「ステルス」#1〜#5: `order`適用後・`count`適用前の候補順に対し、
 * 第一優先対象（先頭）がStealth状態（`APPLY_STATUS`由来の`AppliedEffect`、
 * `statusKind === "STEALTH"`、R-ACTN-03）を持つ場合に限りそれを候補順の末尾へ
 * 移動する（非先頭のStealth所持者は順序を変更しない、#5）。TGT-004フェーズ2
 * （Issue #167、PR #236以降の再レビューを受け、フェーズ1でMarkerState経由の
 * 予約IDアプローチから`AppliedEffect.statusKind`ベースへ設計変更——`APPLY_STATUS`は
 * `MarkerState`ではなく`AppliedEffect`として保持するR-ACTN-03に合わせた）。#6/#7
 * は`isStructurallySingleCandidateSelector`が真になるselectorで、かつ候補が1件
 * しかない場合だけ適用しない。それ以外（候補2件以上、またはSELECT/BINDING_DERIVEDで
 * 候補1件かつ構造的な限定なし）は#2〜#4（Q-TGT-05「移動後に代替対象が存在しない
 * 場合は、ステルスを消費したうえで元の対象へ発動する」を含む）へ進む（候補0件は
 * `selected.length === 0`のfallback判定へ委ねるため、ここでは扱わない）。移動は
 * Stealthの消費（`resolveEffectSequence`の呼び出し元が`EffectExpired`/
 * reason:"CONSUMPTION"として実際に失効させる、`expireEffects`）を伴うが、
 * この関数自体は純粋関数のため、消費対象（`StealthConsumption`）を返すだけで
 * `appliedEffects`を変更しない。
 */
function applyStealthRedirect(
  ordered: readonly BattleUnit[],
  selector: TargetSelectorDefinition,
  alreadyConsumedEffectInstanceIds: ReadonlySet<EffectInstanceId>,
): {
  readonly ordered: readonly BattleUnit[];
  readonly consumption?: StealthConsumption;
} {
  if (ordered.length === 0) {
    return { ordered };
  }
  // R-TGT-08 #6/#7: 候補が1件だけで、かつそれがselector自体によって構造的に
  // 導かれた候補集合（SELF/TRIGGER_SOURCE/TRIGGER_TARGET、または
  // POSITION_SLOT filter・DIRECTLY_AHEAD_OF_BASE/BEHIND_BASE areaによる
  // 定義上の1体限定）の場合は適用しない。候補が2件以上ある場合や、候補が1件
  // でもそのような構造的限定を持たないSELECT/BINDING_DERIVED（盤面の生存状況
  // 依存）の場合は、以降の通常処理（#2〜#4、Q-TGT-05の「代替対象なし」を含む）
  // へ進む。
  if (ordered.length === 1 && isStructurallySingleCandidateSelector(selector)) {
    return { ordered };
  }
  const [firstPriority, ...rest] = ordered as [BattleUnit, ...BattleUnit[]];
  const stealthEffect = firstPriority.appliedEffects.find(
    (effect) =>
      effect.statusKind === "STEALTH" &&
      !alreadyConsumedEffectInstanceIds.has(effect.effectInstanceId),
  );
  if (stealthEffect === undefined) {
    return { ordered };
  }
  return {
    // R-TGT-08 #3: 第一優先対象を候補順の最後へ移動する。
    ordered: [...rest, firstPriority],
    consumption: {
      battleUnitId: firstPriority.battleUnitId,
      effectInstanceId: stealthEffect.effectInstanceId,
    },
  };
}

function resolveTargetsCore(
  selector: TargetSelectorDefinition,
  source: ResolutionSource,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings,
  triggerContext: TriggerContext | undefined,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  alreadyConsumedStealthEffectInstanceIds: ReadonlySet<EffectInstanceId>,
): ResolveTargetsCoreResult {
  // R-TGT-09 #5相当の事前検証: orderは並べ替え前に検証する（候補0/1件でも不正なorderは拒否する）。
  const compare = compareByOrder(selector.order, source, unitDefinitions);

  // R-TGT-09 #1: kindに基づき初期候補を作る。
  let pool: readonly BattleUnit[];
  switch (selector.kind) {
    case "SELF":
      // R-MEM-04「対象参照の`SELF`は使用できない」: Memory由来の解決では使用者が
      // 存在しないため、`requireSourceUnit`が明確に拒否する。
      pool = [requireSourceUnit(source, 'selector kind "SELF"')];
      break;
    case "SELECT":
      pool = allUnits.filter((u) =>
        matchesRelativeSideOf(u, source.side, selector.side as SelectorSide),
      );
      break;
    case "BINDING_DERIVED":
      pool =
        selector.side === undefined
          ? allUnits
          : allUnits.filter((u) =>
              matchesRelativeSideOf(u, source.side, selector.side as SelectorSide),
            );
      break;
    case "TRIGGER_SOURCE":
    case "TRIGGER_TARGET":
      pool = resolveTriggerPool(selector.kind, source, selector, allUnits, triggerContext);
      break;
  }

  // R-TGT-01 #2 / R-TGT-09 #2: 戦闘不能者を明示的に含める指定がない限り除く。
  if (!selector.includeDefeated) {
    pool = pool.filter((u) => !isDefeated(u));
  }

  // R-TGT-09 #3（TGT-002、CAP_TARGET_FILTER_ORDER）: filtersを定義順（AND）に適用する。
  if (selector.filters.length > 0) {
    const filterContext: FilterContext = { source, allUnits, resolvedBindings, unitDefinitions };
    pool = pool.filter((candidate) =>
      selector.filters.every((filter) => matchesFilter(filter, candidate, filterContext)),
    );
  }

  // R-TGT-09 #4: areaが指定されている場合、baseを基準に候補を範囲で絞る。
  if (selector.area !== undefined) {
    const base = resolveBase(selector, source, allUnits, resolvedBindings, triggerContext);
    pool = applyArea(selector.area, base, pool);
  }

  // R-TGT-09 #5: orderを比較キーとして適用し、候補順を一意にする。
  const ordered = [...pool].sort(compare);

  // R-TGT-01 #4 / R-TGT-07 / R-TGT-09 #6: countが未指定またはALLなら全件、そうでなければ
  // 先頭からcount件（不足時はそのまま存在する候補だけになる）。orderはcount適用前後で
  // 候補数を変えないため、fallback判定（#7）は0/1件の場合と同じ結果になるここで行う。
  // R-TGT-08: Stealth所持者が第一優先対象の場合、候補順の末尾へ移動する。
  // 候補の集合・件数は変えないため、直後のcount適用・fallback判定（#6/#7）には影響しない。
  const stealthResult = applyStealthRedirect(
    ordered,
    selector,
    alreadyConsumedStealthEffectInstanceIds,
  );

  // R-TGT-01 #4 / R-TGT-07 / R-TGT-09 #6: countが未指定またはALLなら全件、そうでなければ
  // 先頭からcount件（不足時はそのまま存在する候補だけになる）。orderはcount適用前後で
  // 候補数を変えないため、fallback判定（#7）は0/1件の場合と同じ結果になるここで行う。
  const selected =
    selector.count === undefined || selector.count === "ALL"
      ? stealthResult.ordered
      : stealthResult.ordered.slice(0, selector.count);

  // R-TGT-09 #7/R-TGT-10（CAP_TARGET_BINDING_FALLBACK、Issue #168/TGT-003）:
  // 候補が0件かつfallbackがあれば、fallback自身を独立したTargetSelectorDefinition
  // として同じ評価順（kind→戦闘不能除外→filters→area→order→Stealth→count→fallback）で
  // 評価する。fallbackが自身のfallbackを持つ場合も同じ規約で連鎖する。
  if (selected.length === 0 && selector.fallback !== undefined) {
    return resolveTargetsCore(
      selector.fallback,
      source,
      allUnits,
      resolvedBindings,
      triggerContext,
      unitDefinitions,
      alreadyConsumedStealthEffectInstanceIds,
    );
  }
  return {
    selected,
    ...(stealthResult.consumption !== undefined
      ? { stealthConsumption: stealthResult.consumption }
      : {}),
  };
}

export function resolveTargets(
  selector: TargetSelectorDefinition,
  source: ResolutionSource,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings = EMPTY_RESOLVED_BINDINGS,
  triggerContext?: TriggerContext,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition> = EMPTY_UNIT_DEFINITIONS,
): readonly BattleUnit[] {
  return resolveTargetsCore(
    selector,
    source,
    allUnits,
    resolvedBindings,
    triggerContext,
    unitDefinitions,
    EMPTY_CONSUMED_STEALTH_EFFECT_INSTANCE_IDS,
  ).selected;
}

/**
 * `resolveTargets`と同じ解決を行うが、R-TGT-08で発生したStealthの消費
 * （あれば）も返す。実際の失効・`EffectExpired`（reason:"CONSUMPTION"）発行は
 * 呼び出し側（`resolveEffectSequence`が集約し、`resolveEffectSequencePlan`が
 * `expireEffects`で適用する）の責務であり、この関数自身は`appliedEffects`を
 * 変更しない。AS選択時のフィージビリティ判定（`hasResolvableTargets`）や
 * `TargetsSelected`イベントpayload用の監査再解決（`resolveBindingSelections`）は
 * 消費を確定させてはならないため、引き続き`resolveTargets`を使う。
 * `alreadyConsumedStealthEffectInstanceIds`（PR #234レビュー[P2]、フェーズ2で
 * `EffectInstanceId`ベースへ移行）: 呼び出し元（`resolveEffectSequence`）が
 * 同じ`EffectSequence`内で先行する`targetBindings`から検出済みの消費を渡す
 * ことで、複数のbindingが同じStealth所持者を第一優先対象に選ぶ場合でも
 * 移動・消費が1回だけ成立するようにする。
 */
export function resolveTargetsWithStealthConsumption(
  selector: TargetSelectorDefinition,
  source: ResolutionSource,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings = EMPTY_RESOLVED_BINDINGS,
  triggerContext?: TriggerContext,
  unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition> = EMPTY_UNIT_DEFINITIONS,
  alreadyConsumedStealthEffectInstanceIds: ReadonlySet<EffectInstanceId> = EMPTY_CONSUMED_STEALTH_EFFECT_INSTANCE_IDS,
): { readonly units: readonly BattleUnit[]; readonly stealthConsumption?: StealthConsumption } {
  const result = resolveTargetsCore(
    selector,
    source,
    allUnits,
    resolvedBindings,
    triggerContext,
    unitDefinitions,
    alreadyConsumedStealthEffectInstanceIds,
  );
  return {
    units: result.selected,
    ...(result.stealthConsumption !== undefined
      ? { stealthConsumption: result.stealthConsumption }
      : {}),
  };
}
