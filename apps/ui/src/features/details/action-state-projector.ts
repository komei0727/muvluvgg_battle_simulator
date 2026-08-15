// Mirrors the M5 行動ライフサイクル拡張 display contract:
// cooldown/chargeをbattleUnitId単位で追跡する。apps/api/src/application/
// simulate-battle-response-mapper.ts の finalState.units[].cooldowns/charge
// はM5実装後、Domainの実値を返す(cooldownsは残数>0のスキルだけの配列)。
// `finalState`はlogLevelに関わらず常に完全（`captureBattleState`はlogLevelを
// 見ない）なので、これを正本として読む(SUMMARYログの
// 「不明」表示問題は、finalStateを使う限りそもそも発生しない)。
//
// DMG-010（Issue #191）でシールドプール
// （`finalState.units[].shields`）とサブユニット（`subUnits`）を追加した。
// どちらも同じ後方互換規約に従い、配列・オブジェクトが無いfixtureでは
// 「なし」ではなく不明として返す。
//
// `cooldowns`はM5以降の契約で必須配列（空でも`[]`）のため、その有無で
// finalStateがM5以降の形かどうかを判別できる。`cooldowns`キー自体が無い
// unit(M5より前に録取したUI fixture)だけ、events[]のCOOLDOWN_*/CHARGE_*を
// sequence順に走査するfallbackへ回す。fallback経路では、
// logLevel=SUMMARYだとapps/api/src/application/observation/battle-log-projection.tsの
// SUMMARY_EVENT_TYPESにCooldown*/Charge*が含まれずevents[]へ載らないため、
// `cooldownChargeKnown`で呼び出し側に不明であることを伝える。

import type { RosterEntry } from "../summary/summary-projector.js";
import type { LogLevel } from "../formation/types.js";
import type { BattleLogEventResponse, BattleLogResponse } from "../simulation/api-contract.js";
import { isRecord, numberOf } from "../../lib/unknown-narrowing.js";

export interface ResourceValue {
  readonly current: number;
  readonly maximum: number;
}

export interface UnitCooldownState {
  readonly skillDefinitionId: string;
  readonly unit: string;
  readonly remaining: number;
}

export interface UnitChargeState {
  readonly skillDefinitionId: string;
}

/**
 * `10_API設計.md`「EffectStateResponse」のうち、ユニット状態の一覧表示が使う項目
 * （M7-009、Issue #182）。`statusKind`は`APPLY_STATUS`由来の効果だけが持ち、
 * 気絶等の状態異常だけでなくSTEALTH等の有利な状態にも設定される。
 * 状態異常かどうかは`category`が正本であり、`statusKind`の有無や
 * `effectKindKey`の命名からは判定しない。
 */
export interface UnitEffectState {
  readonly effectInstanceId: string;
  readonly effectKindKey: string;
  readonly category: string;
  readonly statusKind?: string;
  readonly isEffective: boolean;
  /** 永続効果は持たない（`10_API設計.md`「EffectStateResponse.duration」）。 */
  readonly duration?: { readonly unit: string; readonly remaining: number };
}

/**
 * `10_API設計.md`「ShieldStateResponse」（DMG-004、Issue #194、R-SHD-01第3項）。
 * タイプ別プールは`APPLY_SHIELD`由来の効果インスタンスからの導出値であり、
 * インスタンスごとの残量はAPIが公開しないため、UIもプール合計だけを表示する。
 */
export interface UnitShieldState {
  readonly physical: number;
  readonly energy: number;
  readonly untyped: number;
}

/**
 * `10_API設計.md`「SubUnitStateResponse」（DMG-005、Issue #190、R-SUB-01第3項）。
 * サブユニットは「消費順と固有効果を追跡するためインスタンスごとに返す」ため、
 * `shields`のようなプール合計へは合算しない。
 */
export interface UnitSubUnitState {
  readonly subUnitInstanceId: string;
  readonly subUnitDefinitionId: string;
  readonly durability: ResourceValue;
}

export interface UnitActionState {
  readonly battleUnitId: string;
  readonly ap?: ResourceValue;
  readonly pp?: ResourceValue;
  readonly extraGauge?: ResourceValue;
  readonly cooldowns: readonly UnitCooldownState[];
  readonly charge?: UnitChargeState;
  /** falseの場合、cooldowns/chargeが空でも「クールタイム/チャージなし」を意味しない(SUMMARYログ)。 */
  readonly cooldownChargeKnown: boolean;
  readonly effects: readonly UnitEffectState[];
  /** falseの場合、effectsが空でも「効果なし」を意味しない(effects契約より前に録取したfixture)。 */
  readonly effectsKnown: boolean;
  /** undefinedは「シールド0」ではなく不明(shields契約より前に録取したfixture)。 */
  readonly shields?: UnitShieldState;
  readonly subUnits: readonly UnitSubUnitState[];
  /** falseの場合、subUnitsが空でも「サブユニットなし」を意味しない。 */
  readonly subUnitsKnown: boolean;
}

function readResourceValue(resources: unknown, key: string): ResourceValue | undefined {
  if (!isRecord(resources)) {
    return undefined;
  }
  const value = resources[key];
  if (
    !isRecord(value) ||
    typeof value["current"] !== "number" ||
    typeof value["maximum"] !== "number"
  ) {
    return undefined;
  }
  return { current: value["current"], maximum: value["maximum"] };
}

/** `finalUnit["cooldowns"]`がM5以降の契約通りの配列であれば、要素を`UnitCooldownState`へ変換して返す。配列でなければ(M5より前のfixture)`undefined`。 */
function readCooldownsFromFinalState(finalUnit: unknown): readonly UnitCooldownState[] | undefined {
  if (!isRecord(finalUnit) || !Array.isArray(finalUnit["cooldowns"])) {
    return undefined;
  }
  const cooldowns: UnitCooldownState[] = [];
  for (const entry of finalUnit["cooldowns"]) {
    if (
      isRecord(entry) &&
      typeof entry["skillDefinitionId"] === "string" &&
      typeof entry["unit"] === "string" &&
      typeof entry["remaining"] === "number"
    ) {
      cooldowns.push({
        skillDefinitionId: entry["skillDefinitionId"],
        unit: entry["unit"],
        remaining: entry["remaining"],
      });
    }
  }
  return cooldowns;
}

/** `finalUnit["charge"]`（`10_API設計.md`「ChargeStateResponse」）を`UnitChargeState`へ変換する。チャージ中でなければ`undefined`。 */
function readChargeFromFinalState(finalUnit: unknown): UnitChargeState | undefined {
  if (!isRecord(finalUnit)) {
    return undefined;
  }
  const charge = finalUnit["charge"];
  if (!isRecord(charge) || typeof charge["skillDefinitionId"] !== "string") {
    return undefined;
  }
  return { skillDefinitionId: charge["skillDefinitionId"] };
}

/**
 * `finalUnit["effects"]`（`10_API設計.md`「EffectStateResponse」、v1の必須配列）を
 * `UnitEffectState`へ変換する。配列でない場合（effects契約より前に手で録取した
 * UI fixture）は`undefined`を返し、呼び出し側が「効果なし」ではなく「不明」として
 * 扱えるようにする — `cooldowns`と同じ後方互換規約。個々の要素が必須項目を欠く
 * 場合はその要素だけ落とし、残りの効果は表示する（1件の契約違反で効果一覧全体を
 * 消さない）。
 */
function readEffectsFromFinalState(finalUnit: unknown): readonly UnitEffectState[] | undefined {
  if (!isRecord(finalUnit) || !Array.isArray(finalUnit["effects"])) {
    return undefined;
  }
  const effects: UnitEffectState[] = [];
  for (const entry of finalUnit["effects"]) {
    if (
      !isRecord(entry) ||
      typeof entry["effectInstanceId"] !== "string" ||
      typeof entry["effectKindKey"] !== "string" ||
      typeof entry["category"] !== "string" ||
      typeof entry["isEffective"] !== "boolean"
    ) {
      continue;
    }
    const duration = entry["duration"];
    const statusKind = entry["statusKind"];
    effects.push({
      effectInstanceId: entry["effectInstanceId"],
      effectKindKey: entry["effectKindKey"],
      category: entry["category"],
      ...(typeof statusKind === "string" ? { statusKind } : {}),
      isEffective: entry["isEffective"],
      ...(isRecord(duration) &&
      typeof duration["unit"] === "string" &&
      typeof duration["remaining"] === "number"
        ? { duration: { unit: duration["unit"], remaining: duration["remaining"] } }
        : {}),
    });
  }
  return effects;
}

/**
 * DMG-010（Issue #191）: `finalUnit["shields"]`を`UnitShieldState`へ変換する。
 * 3プールが揃った数値でない場合（shields契約より前に手で録取したUI fixture、
 * または契約違反）は`undefined`を返し、呼び出し側が「シールド0」ではなく
 * 「不明」として扱えるようにする — `cooldowns`/`effects`と同じ後方互換規約。
 */
function readShieldsFromFinalState(finalUnit: unknown): UnitShieldState | undefined {
  if (!isRecord(finalUnit)) {
    return undefined;
  }
  const shields = finalUnit["shields"];
  if (
    !isRecord(shields) ||
    typeof shields["physical"] !== "number" ||
    typeof shields["energy"] !== "number" ||
    typeof shields["untyped"] !== "number"
  ) {
    return undefined;
  }
  return {
    physical: shields["physical"],
    energy: shields["energy"],
    untyped: shields["untyped"],
  };
}

/**
 * DMG-010（Issue #191）: `finalUnit["subUnits"]`（`10_API設計.md`
 * 「SubUnitStateResponse」）を`UnitSubUnitState`へ変換する。配列でない場合は
 * `undefined`を返して「なし」と「不明」を区別する。個々の要素が必須項目を欠く
 * 場合はその要素だけ落とす（`effects`と同じ規約 — 1件の契約違反で一覧全体を
 * 消さない）。APIは付与順（＝消費順、R-SUB-01）で返すため並べ替えない。
 */
function readSubUnitsFromFinalState(finalUnit: unknown): readonly UnitSubUnitState[] | undefined {
  if (!isRecord(finalUnit) || !Array.isArray(finalUnit["subUnits"])) {
    return undefined;
  }
  const subUnits: UnitSubUnitState[] = [];
  for (const entry of finalUnit["subUnits"]) {
    if (
      !isRecord(entry) ||
      typeof entry["subUnitInstanceId"] !== "string" ||
      typeof entry["subUnitDefinitionId"] !== "string"
    ) {
      continue;
    }
    const durability = readResourceValue(entry, "durability");
    if (durability === undefined) {
      continue;
    }
    subUnits.push({
      subUnitInstanceId: entry["subUnitInstanceId"],
      subUnitDefinitionId: entry["subUnitDefinitionId"],
      durability,
    });
  }
  return subUnits;
}

interface MutableUnitAccumulator {
  readonly cooldowns: Map<string, { unit: string; remaining: number }>;
  charge: UnitChargeState | undefined;
}

function accumulatorFor(
  byUnit: Map<string, MutableUnitAccumulator>,
  battleUnitId: string,
): MutableUnitAccumulator {
  let accumulator = byUnit.get(battleUnitId);
  if (accumulator === undefined) {
    accumulator = { cooldowns: new Map(), charge: undefined };
    byUnit.set(battleUnitId, accumulator);
  }
  return accumulator;
}

function applyCooldownStarted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["unit"] !== "string" ||
    typeof details["initialRemaining"] !== "number"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.cooldowns.set(details["skillDefinitionId"], {
    unit: details["unit"],
    remaining: details["initialRemaining"],
  });
}

function applyCooldownReduced(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["after"] !== "number"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  const current = accumulator.cooldowns.get(details["skillDefinitionId"]);
  accumulator.cooldowns.set(details["skillDefinitionId"], {
    unit: current?.unit ?? "TURN",
    remaining: details["after"],
  });
}

function applyCooldownCompleted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.cooldowns.delete(details["skillDefinitionId"]);
}

function applyChargeStarted(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.charge = { skillDefinitionId: details["skillDefinitionId"] };
}

function applyChargeReleased(
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
): void {
  const details = event["details"];
  if (!isRecord(details) || typeof details["actorUnitId"] !== "string") {
    return;
  }
  const accumulator = accumulatorFor(byUnit, details["actorUnitId"]);
  accumulator.charge = undefined;
}

type ActionStateEventAdapter = (
  event: BattleLogEventResponse,
  byUnit: Map<string, MutableUnitAccumulator>,
) => void;

const actionStateAdapters: Readonly<Record<string, ActionStateEventAdapter>> = {
  COOLDOWN_STARTED: applyCooldownStarted,
  COOLDOWN_REDUCED: applyCooldownReduced,
  COOLDOWN_COMPLETED: applyCooldownCompleted,
  CHARGE_STARTED: applyChargeStarted,
  CHARGE_RELEASED: applyChargeReleased,
};

// M5 行動ライフサイクル拡張の完了条件「cooldown/charge状態を
// battleUnitId単位で追跡できる」。roster順で1エントリずつ返す。`finalState`が
// M5以降の形（`cooldowns`が配列）を持つunitはそれを正本として使い、
// 持たないunit(M5より前のUI fixture)だけevents[]からの再構築へfallbackする。
export function selectUnitActionStates(
  response: BattleLogResponse,
  roster: readonly RosterEntry[],
  logLevel: LogLevel,
): readonly UnitActionState[] {
  // `finalState`はサーバーが`SUMMARY`実行で省略しうる（Issue #464）。このタブ自体が
  // `DETAILED`実行時にしか表示されないため実際には常に届くが、不在時も既存の
  // 「finalStateにそのunitが無い」経路（events[]からの再構築）へそのまま落ちる。
  const finalUnitsById = new Map(
    (response.finalState?.units ?? []).map((unit) => [unit.battleUnitId, unit] as const),
  );

  const byUnit = new Map<string, MutableUnitAccumulator>();
  const sortedEvents = [...response.events].sort(
    (a, b) => (numberOf(a["sequence"]) ?? 0) - (numberOf(b["sequence"]) ?? 0),
  );
  for (const event of sortedEvents) {
    const adapter = actionStateAdapters[event.type];
    adapter?.(event, byUnit);
  }

  return roster.map((entry) => {
    const finalUnit = finalUnitsById.get(entry.battleUnitId);
    const resources = finalUnit?.["resources"];
    const ap = readResourceValue(resources, "ap");
    const pp = readResourceValue(resources, "pp");
    const extraGauge = readResourceValue(resources, "extraGauge");

    const cooldownsFromFinalState = readCooldownsFromFinalState(finalUnit);
    // `finalState`はlogLevelに関わらず常に完全なので、そこから読めた時点で
    // 不明な点はない。events[]へのfallback時だけSUMMARYログの間引きが影響する。
    const cooldownChargeKnown = cooldownsFromFinalState !== undefined || logLevel !== "SUMMARY";
    const accumulator = byUnit.get(entry.battleUnitId);
    const cooldowns =
      cooldownsFromFinalState ??
      (accumulator !== undefined
        ? [...accumulator.cooldowns.entries()].map(([skillDefinitionId, state]) => ({
            skillDefinitionId,
            unit: state.unit,
            remaining: state.remaining,
          }))
        : []);
    const charge =
      cooldownsFromFinalState !== undefined
        ? readChargeFromFinalState(finalUnit)
        : accumulator?.charge;
    const effects = readEffectsFromFinalState(finalUnit);
    const shields = readShieldsFromFinalState(finalUnit);
    const subUnits = readSubUnitsFromFinalState(finalUnit);
    return {
      battleUnitId: entry.battleUnitId,
      ...(ap !== undefined ? { ap } : {}),
      ...(pp !== undefined ? { pp } : {}),
      ...(extraGauge !== undefined ? { extraGauge } : {}),
      cooldowns,
      ...(charge !== undefined ? { charge } : {}),
      cooldownChargeKnown,
      effects: effects ?? [],
      effectsKnown: effects !== undefined,
      ...(shields !== undefined ? { shields } : {}),
      subUnits: subUnits ?? [],
      subUnitsKnown: subUnits !== undefined,
    };
  });
}
