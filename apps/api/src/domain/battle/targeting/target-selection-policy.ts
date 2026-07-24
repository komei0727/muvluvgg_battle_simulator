import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { frontDirectionStep, manhattanDistance } from "./position-policy.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side as SelectorSide } from "../../catalog/definitions/catalog-enums.js";
import type {
  AreaDefinition,
  TargetOrderKey,
  TargetSelectorDefinition,
} from "../../catalog/definitions/target-selector-definition.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type { TargetBindingId } from "../../catalog/definitions/catalog-ids.js";
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
  if (side === "ALL") {
    return true;
  }
  const opposite: Side = actor.side === "ALLY" ? "ENEMY" : "ALLY";
  const absoluteSide = side === "ALLY" ? actor.side : opposite;
  return unit.side === absoluteSide;
}

function assertNoFilters(selector: TargetSelectorDefinition): void {
  if (selector.filters.length > 0) {
    throw new DomainValidationError(
      "selector.filters",
      "non-empty filters are not supported by this TargetSelectionPolicy (TGT-002/CAP_TARGET_FILTER_ORDER scope)",
    );
  }
}

/** R-TGT-02: 使用者からのマンハッタン距離昇順→対象側の行（前列、後列）→対象の列（絶対左、中央、右）。 */
function compareDefaultOrder(actor: BattleUnit) {
  return (a: BattleUnit, b: BattleUnit): number => {
    const distanceA = manhattanDistance(actor.globalCoordinate, a.globalCoordinate);
    const distanceB = manhattanDistance(actor.globalCoordinate, b.globalCoordinate);
    if (distanceA !== distanceB) {
      return distanceA - distanceB;
    }
    if (ROW_ORDER[a.position.row] !== ROW_ORDER[b.position.row]) {
      return ROW_ORDER[a.position.row] - ROW_ORDER[b.position.row];
    }
    return a.globalCoordinate.x - b.globalCoordinate.x;
  };
}

/** R-TGT-03: R-TGT-02の並び全体を逆順にする（距離だけでなく行・列の同点判定も反転する）。 */
function compareFarthestOrder(actor: BattleUnit) {
  const base = compareDefaultOrder(actor);
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

const SINGLE_KEY_ORDER_COMPARATORS: Partial<
  Record<TargetOrderKey, (actor: BattleUnit) => (a: BattleUnit, b: BattleUnit) => number>
> = {
  DEFAULT: compareDefaultOrder,
  FARTHEST: compareFarthestOrder,
  FRONT_ROW: () => compareRowPriority("FRONT"),
  BACK_ROW: () => compareRowPriority("BACK"),
};

/**
 * R-TGT-09 #5: `order`を上から順に比較キーとして適用し、候補順を一意にする。
 * 各キーは単独の比較（同点なら0を返す）で、production Catalogの
 * `["FRONT_ROW", "DEFAULT"]`のように配列内で組み合わせられることを前提とする
 * （`FARTHEST`は例外的にR-TGT-03の全体反転そのものであり単独で一意な順序になる）。
 * 指定された全キーが同点の場合も、盤面上の位置は一意なため`compareDefaultOrder`
 * で必ず順序を確定する。
 */
function compareByOrder(orderKeys: readonly TargetOrderKey[], actor: BattleUnit) {
  const comparators = orderKeys.map((key) => {
    const factory = SINGLE_KEY_ORDER_COMPARATORS[key];
    if (factory === undefined) {
      throw new DomainValidationError(
        "selector.order",
        `order key "${key}" is not supported by this TargetSelectionPolicy (TGT-002/CAP_TARGET_FILTER_ORDER scope)`,
      );
    }
    return factory(actor);
  });
  const fallback = compareDefaultOrder(actor);
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
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings,
  triggerContext?: TriggerContext,
): BattleUnit | undefined {
  if (selector.kind !== "BINDING_DERIVED") {
    return actor;
  }
  const reference = selector.base as TargetReference;
  if (reference.kind === "SELF") {
    return actor;
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
 * `resolveTargets`で再帰的に評価する）を実装する。`filters`（非空）は引き続き
 * TGT-002（`CAP_TARGET_FILTER_ORDER`）のスコープのため明示的に例外を投げる
 * （`fallback`が持つ`filters`も同じ理由で再帰評価時に例外となる）。`selector.kind`/
 * `base`の`TRIGGER_SOURCE`/`TRIGGER_TARGET`は`triggerContext`（`CAP_TRIGGER_CONTEXT`、
 * RES-005、Issue #172）から解決する。`base`の`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`参照は引き続き未対応のため例外を投げる。
 */
function resolveTriggerPool(
  kind: "TRIGGER_SOURCE" | "TRIGGER_TARGET",
  actor: BattleUnit,
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
    : units.filter((u) => matchesRelativeSide(u, actor, selector.side as SelectorSide));
}

export function resolveTargets(
  selector: TargetSelectorDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
  resolvedBindings: ResolvedTargetBindings = EMPTY_RESOLVED_BINDINGS,
  triggerContext?: TriggerContext,
): readonly BattleUnit[] {
  assertNoFilters(selector);

  // R-TGT-09 #5相当の事前検証: orderは並べ替え前に検証する（候補0/1件でも不正なorderは拒否する）。
  const compare = compareByOrder(selector.order, actor);

  // R-TGT-09 #1: kindに基づき初期候補を作る。
  let pool: readonly BattleUnit[];
  switch (selector.kind) {
    case "SELF":
      pool = [actor];
      break;
    case "SELECT":
      pool = allUnits.filter((u) => matchesRelativeSide(u, actor, selector.side as SelectorSide));
      break;
    case "BINDING_DERIVED":
      pool =
        selector.side === undefined
          ? allUnits
          : allUnits.filter((u) => matchesRelativeSide(u, actor, selector.side as SelectorSide));
      break;
    case "TRIGGER_SOURCE":
    case "TRIGGER_TARGET":
      pool = resolveTriggerPool(selector.kind, actor, selector, allUnits, triggerContext);
      break;
  }

  // R-TGT-01 #2 / R-TGT-09 #2: 戦闘不能者を明示的に含める指定がない限り除く。
  if (!selector.includeDefeated) {
    pool = pool.filter((u) => !isDefeated(u));
  }

  // R-TGT-09 #4: areaが指定されている場合、baseを基準に候補を範囲で絞る。
  if (selector.area !== undefined) {
    const base = resolveBase(selector, actor, allUnits, resolvedBindings, triggerContext);
    pool = applyArea(selector.area, base, pool);
  }

  // R-TGT-09 #5: orderを比較キーとして適用し、候補順を一意にする。
  const ordered = [...pool].sort(compare);

  // R-TGT-01 #4 / R-TGT-07 / R-TGT-09 #6: countが未指定またはALLなら全件、そうでなければ
  // 先頭からcount件（不足時はそのまま存在する候補だけになる）。orderはcount適用前後で
  // 候補数を変えないため、fallback判定（#7）は0/1件の場合と同じ結果になるここで行う。
  const selected =
    selector.count === undefined || selector.count === "ALL"
      ? ordered
      : ordered.slice(0, selector.count);

  // R-TGT-09 #7/R-TGT-10（CAP_TARGET_BINDING_FALLBACK、Issue #168/TGT-003）:
  // 候補が0件かつfallbackがあれば、fallback自身を独立したTargetSelectorDefinition
  // として同じ評価順（kind→戦闘不能除外→filters→area→order→count→fallback）で
  // 評価する。fallbackが自身のfallbackを持つ場合も同じ規約で連鎖する。
  if (selected.length === 0 && selector.fallback !== undefined) {
    return resolveTargets(selector.fallback, actor, allUnits, resolvedBindings, triggerContext);
  }
  return selected;
}
