import { isDefeated, type BattleUnit } from "./battle-unit.js";
import { manhattanDistance } from "./position-policy.js";
import type { Side } from "./side.js";
import type { Side as SelectorSide } from "../catalog/catalog-enums.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import { DomainValidationError } from "../shared/errors.js";

const ROW_ORDER: Record<BattleUnit["position"]["row"], number> = { FRONT: 0, BACK: 1 };

/** `05_ドメインモデル.md`「TargetBinding / TargetSelector」: Catalogの`side`は使用者から見た相対陣営を表す。 */
function matchesRelativeSide(unit: BattleUnit, actor: BattleUnit, side: SelectorSide): boolean {
  if (side === "ALL") {
    return true;
  }
  const opposite: Side = actor.side === "ALLY" ? "ENEMY" : "ALLY";
  const absoluteSide = side === "ALLY" ? actor.side : opposite;
  return unit.side === absoluteSide;
}

function assertBasicFormSupported(selector: TargetSelectorDefinition): void {
  if (selector.filters.length > 0) {
    throw new DomainValidationError(
      "selector.filters",
      "non-empty filters are not supported by this basic TargetSelectionPolicy (M7 scope)",
    );
  }
  if (selector.area !== undefined) {
    throw new DomainValidationError(
      "selector.area",
      "area is not supported by this basic TargetSelectionPolicy (M7 scope)",
    );
  }
  if (selector.fallback !== undefined) {
    throw new DomainValidationError(
      "selector.fallback",
      "fallback is not supported by this basic TargetSelectionPolicy (M7 scope)",
    );
  }
  if (selector.base !== undefined) {
    throw new DomainValidationError(
      "selector.base",
      "base is not supported by this basic TargetSelectionPolicy (M7 scope)",
    );
  }
  if (selector.order.length !== 1 || selector.order[0] !== "DEFAULT") {
    throw new DomainValidationError(
      "selector.order",
      `only the DEFAULT order is supported by this basic TargetSelectionPolicy (M7 scope), got [${selector.order.join(", ")}]`,
    );
  }
  if (selector.kind !== "SELF" && selector.kind !== "SELECT") {
    throw new DomainValidationError(
      "selector.kind",
      `kind "${selector.kind}" is not supported by this basic TargetSelectionPolicy (M6/M7 scope)`,
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

/**
 * `TargetSelectionPolicy` 基本形 (`05_ドメインモデル.md`)。R-TGT-01（候補生成、
 * 自分自身のみ対象の特例、候補0体）、R-TGT-02（デフォルト順）、R-TGT-07
 * （対象数不足）を実装する。`kind: SELF/SELECT`・`order: [DEFAULT]`・空の
 * `filters`・`area`/`fallback`/`base`なしの範囲だけを扱い、それ以外は
 * 明示的に例外を投げる（M6/M7で拡張）。
 */
export function resolveTargets(
  selector: TargetSelectorDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): readonly BattleUnit[] {
  assertBasicFormSupported(selector);

  // R-TGT-01 #3: 自分自身だけを対象とするスキルでは使用者だけを候補にする。
  let pool: readonly BattleUnit[] =
    selector.kind === "SELF"
      ? [actor]
      : allUnits.filter((u) => matchesRelativeSide(u, actor, selector.side as SelectorSide));

  // R-TGT-01 #2: 戦闘不能者を明示的に含める指定がない限り除く。
  if (!selector.includeDefeated) {
    pool = pool.filter((u) => !isDefeated(u));
  }

  const ordered = [...pool].sort(compareDefaultOrder(actor));

  // R-TGT-01 #4 / R-TGT-07: countが未指定またはALLなら全件、そうでなければ
  // 先頭からcount件（不足時はそのまま存在する候補だけになる）。
  if (selector.count === undefined || selector.count === "ALL") {
    return ordered;
  }
  return ordered.slice(0, selector.count);
}
