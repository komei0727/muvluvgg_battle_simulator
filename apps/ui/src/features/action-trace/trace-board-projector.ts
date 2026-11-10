// docs/ui-design/01_UI要求・画面設計.md §8.10「画面構成」の盤面 / 04_コンポーネント・状態管理設計.md
// §3「TraceBoard／UnitTraceCard」。
//
// 範囲の前後の状態（`initialState`へ`stateTransitions`を適用して組み立て直したもの）と範囲に
// 入る処理ステップから、盤面の部品へ渡す表示用の値を作る純関数。盤面の値は状態だけから
// 読み、イベントのdetailsから状態を作らない（UI-ADR-014）。ダメージ・回復の内訳と役割・
// 矢印だけは処理ステップ（投影がpayloadをそのまま読んだ値）から作り、再計算しない。
import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import { splitDisplayName } from "../../components/display-name.js";
import type { BattleStateResponse } from "../../shared/api/api-contract.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { ActionSegment } from "./action-segment-projector.js";
import type {
  TraceArrowKind,
  TraceArrowView,
  TraceBoardRow,
  TraceBoardSide,
  TraceBoardView,
  TraceChipKind,
  TraceChipView,
  TraceDamageView,
  TraceGaugeView,
  TraceHealView,
  TraceUnitCardView,
} from "./trace-board-view.js";
import type { TraceStep, TraceStepKind } from "./trace-step-projector.js";

export interface TraceBoardInput {
  readonly before: BattleStateResponse;
  readonly after: BattleStateResponse;
  readonly segment: ActionSegment;
  /** 範囲に入る処理ステップ（`selectTraceRange`の`steps`）。 */
  readonly steps: readonly TraceStep[];
  readonly roster: RosterIndex;
  /** ユニットごとのそのターンの行動順（`selectActionOrders`）。 */
  readonly actionOrders: ReadonlyMap<string, number>;
}

type UnitRecord = Readonly<Record<string, unknown>>;

/** 対象のタグを付ける処理の種類。システム処理（リソース回復など）は全員を対象に持つため除く。 */
const TARGETING_KINDS = new Set<TraceStepKind>([
  "TARGETS_SELECTED",
  "HIT",
  "SPECIAL_DAMAGE",
  "HEAL",
  "EFFECT",
]);

/** 攻撃の矢印を引く処理の種類。 */
const ATTACK_KINDS = new Set<TraceStepKind>(["TARGETS_SELECTED", "HIT", "SPECIAL_DAMAGE"]);

const EFFECT_CATEGORIES = new Set<TraceChipKind>(["BUFF", "DEBUFF", "STATUS_ABNORMALITY"]);

const DURATION_SUFFIX: Readonly<Record<string, string>> = {
  TURN: "T",
  ACTION: "行動",
  SKILL_USE: "回",
};

function sideOf(unit: UnitRecord): TraceBoardSide | undefined {
  const side = unit["side"];
  return side === "ALLY" || side === "ENEMY" ? side : undefined;
}

function positionOf(
  unit: UnitRecord,
): { readonly column: number; readonly row: TraceBoardRow } | undefined {
  const position = unit["formationPosition"];
  if (!isRecord(position)) {
    return undefined;
  }
  const column = numberOf(position["column"]);
  const row = position["row"];
  if (column === undefined || (row !== "FRONT" && row !== "REAR")) {
    return undefined;
  }
  return { column, row };
}

function currentMaximum(
  value: unknown,
): { readonly current: number; readonly maximum: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const current = numberOf(value["current"]);
  const maximum = numberOf(value["maximum"]);
  return current === undefined || maximum === undefined ? undefined : { current, maximum };
}

function gauge(after: unknown, before: unknown): TraceGaugeView | undefined {
  const a = currentMaximum(after);
  if (a === undefined) {
    return undefined;
  }
  const b = currentMaximum(before);
  return { before: b?.current ?? a.current, after: a.current, maximum: a.maximum };
}

function resourceOf(unit: UnitRecord | undefined, key: string): unknown {
  const resources = unit?.["resources"];
  return isRecord(resources) ? resources[key] : undefined;
}

function shieldTotal(unit: UnitRecord): number {
  const shields = unit["shields"];
  if (!isRecord(shields)) {
    return 0;
  }
  return (
    (numberOf(shields["physical"]) ?? 0) +
    (numberOf(shields["energy"]) ?? 0) +
    (numberOf(shields["untyped"]) ?? 0)
  );
}

/** 総力戦では出撃中の編成番号。通常戦闘・戦術演習（`formations`を持たない）では`undefined`。 */
function activeFormationOf(state: BattleStateResponse, side: TraceBoardSide): number | undefined {
  const formations = state["formations"];
  if (!isRecord(formations)) {
    return undefined;
  }
  const entry = formations[side === "ALLY" ? "ally" : "enemy"];
  return isRecord(entry) ? numberOf(entry["activeFormationNumber"]) : undefined;
}

function isOnBoard(state: BattleStateResponse, unit: UnitRecord, side: TraceBoardSide): boolean {
  const active = activeFormationOf(state, side);
  const formationNumber = numberOf(unit["formationNumber"]);
  return active === undefined || formationNumber === undefined || formationNumber === active;
}

interface ChipSource {
  readonly key: string;
  readonly label: string;
  readonly kind: TraceChipKind;
  readonly remaining?: string;
  readonly ineffective: boolean;
}

function durationText(duration: unknown): string | undefined {
  if (!isRecord(duration)) {
    return undefined;
  }
  const unit = stringOf(duration["unit"]);
  const remaining = numberOf(duration["remaining"]);
  if (unit === undefined || remaining === undefined) {
    return undefined;
  }
  return `${remaining.toString()}${DURATION_SUFFIX[unit] ?? unit}`;
}

function chipSourcesOf(unit: UnitRecord): readonly ChipSource[] {
  const chips: ChipSource[] = [];
  const effects = unit["effects"];
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (!isRecord(effect)) {
      continue;
    }
    const id = stringOf(effect["effectInstanceId"]);
    const label = stringOf(effect["effectDefinitionId"]);
    if (id === undefined || label === undefined) {
      continue;
    }
    const category = stringOf(effect["category"]) as TraceChipKind | undefined;
    const remaining = durationText(effect["duration"]);
    chips.push({
      key: `effect:${id}`,
      label,
      kind: category !== undefined && EFFECT_CATEGORIES.has(category) ? category : "OTHER",
      ...(remaining !== undefined ? { remaining } : {}),
      ineffective: effect["isEffective"] === false,
    });
  }
  const markers = unit["markers"];
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (!isRecord(marker)) {
      continue;
    }
    const id = stringOf(marker["markerInstanceId"]);
    const label = stringOf(marker["markerId"]);
    if (id === undefined || label === undefined) {
      continue;
    }
    const stackCount = numberOf(marker["stackCount"]);
    chips.push({
      key: `marker:${id}`,
      label,
      kind: "MARKER",
      ...(stackCount !== undefined ? { remaining: `×${stackCount.toString()}` } : {}),
      ineffective: false,
    });
  }
  const charge = unit["charge"];
  const chargeSkill = isRecord(charge) ? stringOf(charge["skillDefinitionId"]) : undefined;
  if (chargeSkill !== undefined) {
    chips.push({ key: "charge", label: chargeSkill, kind: "CHARGE", ineffective: false });
  }
  return chips;
}

/** 範囲の後の印（付いた・続いている）の後に、範囲の中で外れた印を並べる。 */
function chipsOf(after: UnitRecord, before: UnitRecord | undefined): readonly TraceChipView[] {
  const afterChips = chipSourcesOf(after);
  // 範囲の中で出撃したユニットは、範囲の前に付いていた印を持たない
  const beforeChips = before === undefined ? afterChips : chipSourcesOf(before);
  const beforeKeys = new Set(beforeChips.map((chip) => chip.key));
  const afterKeys = new Set(afterChips.map((chip) => chip.key));
  return [
    ...afterChips.map((chip) => ({
      ...chip,
      change: beforeKeys.has(chip.key) ? ("kept" as const) : ("added" as const),
    })),
    ...beforeChips
      .filter((chip) => !afterKeys.has(chip.key))
      .map((chip) => ({ ...chip, change: "removed" as const })),
  ];
}

interface MutableDamage {
  total: number;
  hits: number;
  critical: boolean;
  shieldAbsorbed: number;
}

function damageByUnit(steps: readonly TraceStep[]): ReadonlyMap<string, TraceDamageView> {
  const byUnit = new Map<string, MutableDamage>();
  for (const step of steps) {
    const hit = step.hit;
    const application = hit?.application;
    const target = hit?.appliedTargetUnitId ?? hit?.targetUnitId;
    if (application === undefined || target === undefined) {
      continue;
    }
    const absorbed =
      (application.typedShieldAbsorbed ?? 0) +
      (application.untypedShieldAbsorbed ?? 0) +
      (application.subUnitAbsorbed ?? 0);
    const entry = byUnit.get(target) ?? { total: 0, hits: 0, critical: false, shieldAbsorbed: 0 };
    entry.total += (application.hitPointDamage ?? 0) + absorbed;
    entry.hits += 1;
    entry.critical ||= hit?.critical === true;
    entry.shieldAbsorbed += absorbed;
    byUnit.set(target, entry);
  }
  return byUnit;
}

function healByUnit(steps: readonly TraceStep[]): ReadonlyMap<string, TraceHealView> {
  const byUnit = new Map<string, number>();
  for (const heal of steps.flatMap((step) => step.heals ?? [])) {
    if (heal.targetUnitId !== undefined) {
      byUnit.set(heal.targetUnitId, (byUnit.get(heal.targetUnitId) ?? 0) + heal.appliedAmount);
    }
  }
  return new Map([...byUnit].map(([id, total]) => [id, { total }]));
}

/** PS・メモリーの発動、またはその発動に属する処理（割り込み）。 */
function isActivation(step: TraceStep): boolean {
  return step.kind === "ACTIVATION" || step.interruptDepth > 0;
}

function targetsOf(step: TraceStep): readonly string[] {
  const applied = step.hit?.appliedTargetUnitId;
  const heals = (step.heals ?? []).flatMap((heal) =>
    heal.targetUnitId !== undefined ? [heal.targetUnitId] : [],
  );
  return [...step.targetUnitIds, ...(applied !== undefined ? [applied] : []), ...heals];
}

function arrowKindOf(step: TraceStep): TraceArrowKind | undefined {
  if (step.kind === "HEAL") {
    return "heal";
  }
  if (isActivation(step) && (ATTACK_KINDS.has(step.kind) || step.kind === "EFFECT")) {
    return "passive";
  }
  return ATTACK_KINDS.has(step.kind) ? "attack" : undefined;
}

function arrowsOf(
  steps: readonly TraceStep[],
  sides: ReadonlyMap<string, TraceBoardSide>,
): readonly TraceArrowView[] {
  const arrows: TraceArrowView[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const from = step.sourceUnitId;
    const kind = arrowKindOf(step);
    const side = from === undefined ? undefined : sides.get(from);
    if (from === undefined || kind === undefined || side === undefined) {
      continue;
    }
    // 肩代わり・引き寄せのヒットは、元の対象ではなく実際に受けた防御側へ引く
    const targets =
      step.hit?.appliedTargetUnitId !== undefined
        ? [step.hit.appliedTargetUnitId]
        : targetsOf(step);
    for (const to of targets) {
      // 対象選択と各ヒットは同じ発動者・対象の組を繰り返すため、1本にまとめる
      const key = `${from}>${to}>${kind}`;
      if (to === from || seen.has(key) || !sides.has(to)) {
        continue;
      }
      seen.add(key);
      arrows.push({ fromUnitId: from, toUnitId: to, kind, side });
    }
  }
  return arrows;
}

/** そのターンの行動区間から、ユニットごとの最初の行動順を求める。 */
export function selectActionOrders(
  segments: readonly ActionSegment[],
  turnNumber: number,
): ReadonlyMap<string, number> {
  const orders = new Map<string, number>();
  for (const segment of segments) {
    if (
      segment.kind === "ACTION" &&
      segment.turnNumber === turnNumber &&
      segment.actorUnitId !== undefined &&
      !orders.has(segment.actorUnitId)
    ) {
      orders.set(segment.actorUnitId, segment.actionOrderInTurn);
    }
  }
  return orders;
}

export function projectTraceBoard(input: TraceBoardInput): TraceBoardView {
  const { before, after, segment, steps, roster, actionOrders } = input;
  const beforeById = new Map<string, UnitRecord>(
    before.units.map((unit) => [unit.battleUnitId, unit]),
  );
  const damage = damageByUnit(steps);
  const heals = healByUnit(steps);
  const actor = segment.kind === "ACTION" ? segment.actorUnitId : undefined;
  const activators = new Set(
    steps
      .filter(isActivation)
      .flatMap((step) => (step.sourceUnitId !== undefined ? [step.sourceUnitId] : [])),
  );
  const targets = new Set(
    steps.filter((step) => TARGETING_KINDS.has(step.kind)).flatMap(targetsOf),
  );

  const units: TraceUnitCardView[] = [];
  const sides = new Map<string, TraceBoardSide>();
  for (const unit of after.units) {
    const side = sideOf(unit);
    const position = positionOf(unit);
    if (side === undefined || position === undefined || !isOnBoard(after, unit, side)) {
      continue;
    }
    const id = unit.battleUnitId;
    sides.set(id, side);
    const previous = beforeById.get(id);
    const displayName = roster.get(id)?.displayName ?? id;
    const order = actionOrders.get(id);
    const ap = gauge(resourceOf(unit, "ap"), resourceOf(previous, "ap"));
    const pp = gauge(resourceOf(unit, "pp"), resourceOf(previous, "pp"));
    const extraGauge = gauge(resourceOf(unit, "extraGauge"), resourceOf(previous, "extraGauge"));
    const unitDamage = damage.get(id);
    const unitHeal = heals.get(id);
    const isActor = id === actor;
    const isActivator = activators.has(id);
    units.push({
      battleUnitId: id,
      side,
      column: position.column,
      row: position.row,
      displayName,
      name: splitDisplayName(displayName).name,
      ...(order !== undefined ? { actionOrder: order } : {}),
      hp: gauge(unit.hp, previous?.hp) ?? { before: 0, after: 0, maximum: 0 },
      shield: {
        before: previous === undefined ? shieldTotal(unit) : shieldTotal(previous),
        after: shieldTotal(unit),
      },
      ...(ap !== undefined ? { ap } : {}),
      ...(pp !== undefined ? { pp } : {}),
      ...(extraGauge !== undefined ? { extraGauge } : {}),
      chips: chipsOf(unit, previous),
      ...(unitDamage !== undefined ? { damage: unitDamage } : {}),
      ...(unitHeal !== undefined ? { heal: unitHeal } : {}),
      roles: {
        actor: isActor,
        activator: isActivator,
        target: !isActor && !isActivator && targets.has(id),
      },
      defeated: unit.combatStatus === "DEFEATED",
    });
  }
  return { units, arrows: arrowsOf(steps, sides) };
}
