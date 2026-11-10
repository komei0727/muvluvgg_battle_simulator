// docs/ui-design/01_UI要求・画面設計.md §8.10「変化の表」。
//
// 範囲の前後の状態（`initialState`へ`stateTransitions`を適用して組み立て直したもの）を
// ユニットごとに比べ、変化の表の行を作る純関数。変化の無いユニットの行は出さない。
// 値は状態だけから読み、イベントのdetailsから作らない（UI-ADR-014）。
import { numberOf } from "../../lib/unknown-narrowing.js";
import type { BattleStateResponse } from "../../shared/api/api-contract.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { EffectLabeler } from "../../lib/effect-display-label.js";
import { chipSourcesOf, currentMaximum, resourceOf, shieldTotal } from "./trace-board-projector.js";

export type TraceChangeLabel = "HP" | "AP" | "PP" | "EX" | "シールド";

export interface TraceValueChange {
  readonly label: TraceChangeLabel;
  readonly before: number;
  readonly after: number;
}

/** 範囲の中で付いた（`added`）、外れた（`removed`）、残り時間・スタック数が変わった（`remaining`）。 */
export type TraceEffectChangeKind = "added" | "removed" | "remaining";

export interface TraceEffectChange {
  readonly key: string;
  /** 印と同じ名前（`TraceChipView.label`）。 */
  readonly label: string;
  /** `label`を表示名にしたときの論理名。ツールチップにだけ出す。 */
  readonly logicalName?: string;
  readonly change: TraceEffectChangeKind;
  readonly before?: string;
  readonly after?: string;
}

export interface TraceChangeRow {
  readonly battleUnitId: string;
  readonly side: string;
  readonly displayName: string;
  /** 範囲の中で出撃した（範囲の前の状態に居ない）。 */
  readonly deployed: boolean;
  /** 範囲の中で撃破された。 */
  readonly defeated: boolean;
  readonly values: readonly TraceValueChange[];
  readonly effects: readonly TraceEffectChange[];
}

type UnitRecord = Readonly<Record<string, unknown>>;

const RESOURCES: readonly { readonly key: string; readonly label: TraceChangeLabel }[] = [
  { key: "ap", label: "AP" },
  { key: "pp", label: "PP" },
  { key: "extraGauge", label: "EX" },
];

function hpOf(unit: UnitRecord): number | undefined {
  return currentMaximum(unit["hp"])?.current ?? numberOf(unit["hp"]);
}

function valueChangesOf(before: UnitRecord, after: UnitRecord): readonly TraceValueChange[] {
  const candidates: (TraceValueChange | undefined)[] = [];
  const hpBefore = hpOf(before);
  const hpAfter = hpOf(after);
  candidates.push(
    hpBefore !== undefined && hpAfter !== undefined
      ? { label: "HP", before: hpBefore, after: hpAfter }
      : undefined,
  );
  for (const { key, label } of RESOURCES) {
    const b = currentMaximum(resourceOf(before, key))?.current;
    const a = currentMaximum(resourceOf(after, key))?.current;
    candidates.push(
      b !== undefined && a !== undefined ? { label, before: b, after: a } : undefined,
    );
  }
  candidates.push({ label: "シールド", before: shieldTotal(before), after: shieldTotal(after) });
  return candidates.filter(
    (change): change is TraceValueChange => change !== undefined && change.before !== change.after,
  );
}

/** 付いたもの、残り時間が変わったもの、外れたものの順に並べる。 */
function effectChangesOf(
  before: UnitRecord,
  after: UnitRecord,
  labeler: EffectLabeler | undefined,
): readonly TraceEffectChange[] {
  const beforeChips = new Map(chipSourcesOf(before, labeler).map((chip) => [chip.key, chip]));
  const afterChips = chipSourcesOf(after, labeler);
  const afterKeys = new Set(afterChips.map((chip) => chip.key));
  const added: TraceEffectChange[] = [];
  const remaining: TraceEffectChange[] = [];
  for (const chip of afterChips) {
    const previous = beforeChips.get(chip.key);
    if (previous === undefined) {
      added.push({
        key: chip.key,
        label: chip.label,
        ...(chip.logicalName !== undefined ? { logicalName: chip.logicalName } : {}),
        change: "added",
        ...(chip.remaining !== undefined ? { after: chip.remaining } : {}),
      });
    } else if (previous.remaining !== chip.remaining) {
      remaining.push({
        key: chip.key,
        label: chip.label,
        ...(chip.logicalName !== undefined ? { logicalName: chip.logicalName } : {}),
        change: "remaining",
        ...(previous.remaining !== undefined ? { before: previous.remaining } : {}),
        ...(chip.remaining !== undefined ? { after: chip.remaining } : {}),
      });
    }
  }
  const removed = [...beforeChips.values()]
    .filter((chip) => !afterKeys.has(chip.key))
    .map(
      (chip): TraceEffectChange => ({
        key: chip.key,
        label: chip.label,
        ...(chip.logicalName !== undefined ? { logicalName: chip.logicalName } : {}),
        change: "removed",
        ...(chip.remaining !== undefined ? { before: chip.remaining } : {}),
      }),
    );
  return [...added, ...remaining, ...removed];
}

export function projectTraceChanges(
  before: BattleStateResponse,
  after: BattleStateResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
): readonly TraceChangeRow[] {
  const beforeById = new Map<string, UnitRecord>(
    before.units.map((unit) => [unit.battleUnitId, unit]),
  );
  const rows: TraceChangeRow[] = [];
  for (const unit of after.units) {
    const id = unit.battleUnitId;
    const previous = beforeById.get(id);
    const base = {
      battleUnitId: id,
      side: unit.side,
      displayName: roster.get(id)?.displayName ?? id,
    };
    if (previous === undefined) {
      rows.push({ ...base, deployed: true, defeated: false, values: [], effects: [] });
      continue;
    }
    const values = valueChangesOf(previous, unit);
    const effects = effectChangesOf(previous, unit, labeler);
    const defeated = unit.combatStatus === "DEFEATED" && previous["combatStatus"] !== "DEFEATED";
    if (values.length > 0 || effects.length > 0 || defeated) {
      rows.push({ ...base, deployed: false, defeated, values, effects });
    }
  }
  return rows;
}
