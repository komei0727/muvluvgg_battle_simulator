// DMG-010（Issue #191）: 「M8 高度ダメージ拡張」。
//
// 完了条件「calculated、shield absorbed、HP damageを混同せず表示する」に従い、
// 1ヒットの内訳（計算ダメージ → タイプありシールド吸収 / タイプなしシールド吸収 /
// サブユニット吸収 / シールド迂回直撃 / HPクランプ破棄 → HPダメージ）を1文の中で
// それぞれ別の語として出す。`08_ドメインイベント.md`の不変条件#6
// （`typedShieldAbsorbed + untypedShieldAbsorbed + subUnitAbsorbed + hitPointDamage
// + discardedDamage === calculatedDamage`）を読み手が突き合わせられる形にするのが
// 目的であり、UI側で内訳を再計算・按分しない。
//
// 各payloadの正本は apps/api/src/presentation/http/schemas/battle-log/
// battle-log-schema.ts（wire contract）と apps/api/src/domain/battle/events/
// domain-event.ts（意味）。`reason`/`damageType`/`continuousDamageKind`のような
// 列挙値は 03_API・データ連携設計.md §12 のとおり翻訳せずそのまま出す
// （UI側で列挙値の部分集合を持つとDomainの分類と黙って乖離するため）。

import { resolveDisplayName } from "./event-presentation.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";
import { isRecord, numberOf } from "../../lib/unknown-narrowing.js";

const NO_VALUE_PLACEHOLDER = "-";

/**
 * 0〜1の割合を百分率へ整形する。`0.3 * 100`のような二進浮動小数の誤差
 * （`30.000000000000004`）をそのまま見せないため、有効数字を丸めてから
 * 末尾の0を落とす。APIが返す値自体は丸めず`details`のJSONに残る。
 */
function percentText(rate: number): string {
  return `${Number((rate * 100).toPrecision(12))}%`;
}

/**
 * 複数hitのヒット番号（`hitIndex`は0始まり）。反射・リンクダメージは命中判定を
 * 通らず`hitIndex`が常に0であるため、呼び出し側がヒット番号ではなく由来ラベルを
 * 出す（R-INT-03第3項／R-LNK-03第1項）。
 */
function hitLabel(details: Record<string, unknown>): string | undefined {
  const hitIndex = numberOf(details["hitIndex"]);
  return hitIndex !== undefined ? `ヒット${hitIndex + 1}` : undefined;
}

function sourceName(event: BattleLogEventResponse, roster: RosterIndex): string {
  const sourceUnitId = event["sourceUnitId"];
  if (typeof sourceUnitId === "string") {
    return resolveDisplayName(roster, sourceUnitId);
  }
  // R-MEM-04: Memory由来のイベントは付与者ユニットを持たず陣営を持つ。
  const sourceSide = event["sourceSide"];
  return typeof sourceSide === "string" ? `${sourceSide}陣営のMemory` : NO_VALUE_PLACEHOLDER;
}

/** `label値`の並びを、値が0（または未指定）の項目を落として`（a、b）`へ組み立てる。 */
function optionalTerms(terms: readonly (string | undefined)[]): string {
  const present = terms.filter((term): term is string => term !== undefined);
  return present.length > 0 ? `（${present.join("、")}）` : "";
}

/** 0や未指定を内訳へ出さないための、正の数のときだけラベルを返すhelper。 */
function positiveTerm(label: string, value: unknown): string | undefined {
  const amount = numberOf(value);
  return amount !== undefined && amount > 0 ? `${label}${amount}` : undefined;
}

/** 既定値（多くは1倍）と異なるときだけ倍率を出す。 */
function multiplierTerm(label: string, value: unknown, neutral = 1): string | undefined {
  const multiplier = numberOf(value);
  return multiplier !== undefined && multiplier !== neutral ? `${label}${multiplier}` : undefined;
}

function rateTerm(label: string, value: unknown): string | undefined {
  const rate = numberOf(value);
  return rate !== undefined && rate > 0 ? `${label}${percentText(rate)}` : undefined;
}

/**
 * R-DMG-05 #7の適用結果（DMG-001／004／005／006／007）。M8で`calculatedDamage`の
 * 内訳（シールド・サブユニット吸収、HPクランプ破棄、シールド迂回直撃）が加わったが、
 * M4〜M7に録取したfixtureはそれらを持たないため、内訳項目はすべて任意として扱い、
 * 欠けていても「吸収0」と断定しない（値が無い項目は文からも消える）。
 */
function formatDamageApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  const sourceUnitId = event["sourceUnitId"];
  if (
    !isRecord(details) ||
    typeof sourceUnitId !== "string" ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["hitPointDamage"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const attacker = resolveDisplayName(roster, sourceUnitId);
  const target = resolveDisplayName(roster, details["targetUnitId"]);
  // 反射・リンクは介入解決の産物であり通常のヒットではない（`hitIndex`は常に0）。
  const origin =
    details["isReflectedDamage"] === true
      ? "反射ダメージ"
      : details["isLinkedDamage"] === true
        ? "リンクダメージ"
        : (hitLabel(details) ?? "ダメージ");
  const calculatedDamage = numberOf(details["calculatedDamage"]);
  const calculatedText =
    calculatedDamage !== undefined ? `計算ダメージ${calculatedDamage}` : undefined;
  const breakdown = optionalTerms([
    positiveTerm("タイプありシールド吸収", details["typedShieldAbsorbed"]),
    positiveTerm("タイプなしシールド吸収", details["untypedShieldAbsorbed"]),
    positiveTerm("サブユニット吸収", details["subUnitAbsorbed"]),
    positiveTerm("シールド迂回直撃", details["hpDirectDamage"]),
    positiveTerm("破棄", details["discardedDamage"]),
  ]);
  const head = calculatedText !== undefined ? `${calculatedText}${breakdown} → ` : "";
  const defeatedText = details["defeated"] === true ? "、戦闘不能" : "";
  return {
    title: event.type,
    summary: `${attacker} → ${target} ${origin}: ${head}HPダメージ${details["hitPointDamage"]}。HP ${details["hpBefore"]} → ${details["hpAfter"]}${defeatedText}`,
    details,
    severity: "negative",
  };
}

/**
 * R-DMG-01〜04（DMG-001／002、DMG-009のR-CFS-02）: 確定した計算内訳。混乱倍率は
 * `APPLY_DAMAGE_MOD`由来ではないため、与ダメージ倍率と同じ語にまとめず別項目で出す
 * （domain-event.ts `confusionDamageMultiplier`のコメントと同じ理由）。
 */
function formatDamageCalculated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["finalDamage"] !== "number" ||
    typeof details["effectiveDefense"] !== "number" ||
    typeof details["damageType"] !== "string"
  ) {
    return undefined;
  }
  const target = resolveDisplayName(roster, details["targetUnitId"]);
  const terms = optionalTerms([
    String(details["damageType"]),
    positiveTerm("攻撃力", details["attackerAttack"]),
    `実効防御${details["effectiveDefense"]}`,
    rateTerm("防御貫通", details["defenseIgnoreRate"]),
    rateTerm("シールド貫通", details["shieldIgnoreRate"]),
    rateTerm("軽減貫通", details["damageReductionIgnoreRate"]),
    multiplierTerm("会心倍率", details["criticalMultiplier"]),
    multiplierTerm("与ダメージ倍率", details["outgoingDamageMultiplier"]),
    multiplierTerm("被ダメージ倍率", details["incomingDamageMultiplier"]),
    multiplierTerm("Action内追加倍率", details["actionDamageMultiplier"]),
    multiplierTerm("混乱倍率", details["confusionDamageMultiplier"]),
  ]);
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? ` ${hit}` : "";
  return {
    title: event.type,
    summary: `${sourceName(event, roster)} → ${target}${hitText}: 計算ダメージ${details["finalDamage"]}${terms}`,
    details,
    severity: "neutral",
  };
}

/**
 * R-DMG-05 #4（DMG-001）／R-DMG-03（DMG-002）: ダメージ計算前のsnapshot。
 * 貫通3割合はこのイベントが最初に公開するため0でも出す（「宣言が無い」と
 * 「0%」を読み分けられるようにする）。倍率はこの時点のsnapshotに過ぎず確定値は
 * `DAMAGE_CALCULATED`側であることを、語を分けて示す。
 */
function formatDamageWillBeApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["damageType"] !== "string" ||
    typeof details["isCritical"] !== "boolean" ||
    typeof details["defenseIgnoreRate"] !== "number" ||
    typeof details["shieldIgnoreRate"] !== "number" ||
    typeof details["damageReductionIgnoreRate"] !== "number"
  ) {
    return undefined;
  }
  const target = resolveDisplayName(roster, details["targetUnitId"]);
  const terms = optionalTerms([
    String(details["damageType"]),
    details["isCritical"] ? "会心" : "会心なし",
    multiplierTerm("会心倍率", details["criticalMultiplier"]),
    `防御貫通${percentText(details["defenseIgnoreRate"])}`,
    `シールド貫通${percentText(details["shieldIgnoreRate"])}`,
    `軽減貫通${percentText(details["damageReductionIgnoreRate"])}`,
  ]);
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? ` ${hit}` : "";
  return {
    title: event.type,
    summary: `${sourceName(event, roster)} → ${target}${hitText}: ダメージ適用予定${terms}`,
    details,
    severity: "neutral",
  };
}

/** R-CRT-01（DMG-003）: 実効会心率は`min(100%, max(0%, 元会心率))`のクランプ後。 */
function formatCriticalCheckResolved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["mode"] !== "string" ||
    typeof details["baseCriticalRate"] !== "number" ||
    typeof details["effectiveCriticalRate"] !== "number" ||
    typeof details["result"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${sourceName(event, roster)}の会心判定は${details["result"] ? "会心" : "非会心"}でした（実効会心率${percentText(details["effectiveCriticalRate"])}、元会心率${percentText(details["baseCriticalRate"])}、判定方式 ${details["mode"]}）。`,
    details,
    severity: "neutral",
  };
}

/**
 * RES-005: HP変化のStateDeltaを持つのは`HitPointReduced`であり`DamageApplied`では
 * ない。両者を別イベントとして読めるよう、こちらはHPの増減だけを述べる。
 */
function formatHitPointReduced(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["hitPointDamage"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? ` ${hit}` : "";
  return {
    title: event.type,
    summary: `${sourceName(event, roster)} → ${resolveDisplayName(roster, details["targetUnitId"])}${hitText}: HPダメージ${details["hitPointDamage"]}。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
    details,
    severity: "negative",
  };
}

/**
 * R-SHD-01〜03（DMG-004）: プール単位の減少。`shieldType: null`はタイプなしプール
 * であり、`null`をそのまま見せない。`reason: DECAY`は吸収ではなく時間減衰のため
 * 動詞を分ける（`SHIELD_DECAY_OVER_TIME`）。
 */
function formatShieldConsumed(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["reason"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["absorbed"] !== "number"
  ) {
    return undefined;
  }
  const poolLabel =
    typeof details["shieldType"] === "string" ? details["shieldType"] : "タイプなし";
  const verb = details["reason"] === "DECAY" ? "減少" : "吸収";
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? `${hit}で` : "";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の${poolLabel}シールドが${hitText}${details["absorbed"]}${verb}しました（残量 ${details["before"]} → ${details["after"]}、理由: ${details["reason"]}）。`,
    details,
    severity: "neutral",
  };
}

/**
 * R-SUB-01（DMG-005）: サブユニットはプール合計ではなくインスタンス単位。
 * 消費順と固有効果を追えるよう、どの`subUnitDefinitionId`が削れたかを出す。
 */
function formatSubUnitDamaged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["subUnitDefinitionId"] !== "string" ||
    typeof details["reason"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["absorbed"] !== "number"
  ) {
    return undefined;
  }
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? `${hit}で` : "";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}のサブユニット「${details["subUnitDefinitionId"]}」が${hitText}${details["absorbed"]}吸収しました（耐久 ${details["before"]} → ${details["after"]}、理由: ${details["reason"]}）。`,
    details,
    severity: "neutral",
  };
}

/** R-INT-01 #1/#2・R-INT-02（DMG-006）: 引き寄せ（挑発）と肩代わりを読み分ける。 */
function formatDamageRedirected(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["reason"] !== "string" ||
    typeof details["originalTargetUnitId"] !== "string" ||
    typeof details["newTargetUnitId"] !== "string" ||
    typeof details["causeEffectActionDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  const reasonLabel =
    details["reason"] === "TARGET_REDIRECT"
      ? "引き寄せ"
      : details["reason"] === "COVER"
        ? "肩代わり"
        : details["reason"];
  const terms = optionalTerms([
    `要因: ${details["causeEffectActionDefinitionId"]}`,
    rateTerm("肩代わり率", details["damageShareRate"]),
    rateTerm("軽減率", details["guardRate"]),
  ]);
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? `への${hit}` : "へのダメージ";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["originalTargetUnitId"])}${hitText}が${reasonLabel}により${resolveDisplayName(roster, details["newTargetUnitId"])}へ移りました${terms}。`,
    details,
    severity: "neutral",
  };
}

/** R-INT-03（DMG-006）: 反射は元ダメージを巻き戻さずに発生する別ダメージ。 */
function formatReflectedDamageGenerated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["reflectedByUnitId"] !== "string" ||
    typeof details["reflectToUnitId"] !== "string" ||
    typeof details["sourceDamage"] !== "number" ||
    typeof details["reflectedDamage"] !== "number" ||
    typeof details["damageType"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["reflectedByUnitId"])}が受けたダメージを${resolveDisplayName(roster, details["reflectToUnitId"])}へ反射しました（元ダメージ${details["sourceDamage"]}、反射ダメージ${details["reflectedDamage"]}、${details["damageType"]}）。`,
    details,
    severity: "neutral",
  };
}

/**
 * R-LNK-01〜03（DMG-007）: リンク元の量はシールド・HPへの振り分け**前**の
 * `calculatedDamage`。`shieldApplicable: false`ならリンク先でもシールド・
 * サブユニットで受けないため、その可否を明示する。
 */
function formatLinkedDamageGenerated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["linkedFromUnitId"] !== "string" ||
    typeof details["linkToUnitId"] !== "string" ||
    typeof details["sourceDamage"] !== "number" ||
    typeof details["linkRate"] !== "number" ||
    typeof details["linkedDamage"] !== "number" ||
    typeof details["shieldApplicable"] !== "boolean"
  ) {
    return undefined;
  }
  const damageType = details["damageType"];
  const terms = optionalTerms([
    `元ダメージ${details["sourceDamage"]}`,
    `リンク率${percentText(details["linkRate"])}`,
    `リンクダメージ${details["linkedDamage"]}`,
    typeof damageType === "string" ? damageType : undefined,
    details["shieldApplicable"] ? "シールド適用あり" : "シールド適用なし",
  ]);
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["linkedFromUnitId"])}が受けたダメージが${resolveDisplayName(roster, details["linkToUnitId"])}へリンクしました${terms}。`,
    details,
    severity: "neutral",
  };
}

/** R-INT-01 #5（DMG-006）: 致死耐え。HP自体は`HIT_POINT_REDUCED`が確定させている。 */
function formatLethalDamageSurvived(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["effectActionDefinitionId"] !== "string" ||
    typeof details["lethalDamage"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["survivalHp"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}が致死ダメージ${details["lethalDamage"]}を耐えました（${details["effectActionDefinitionId"]}）。HP ${details["hpBefore"]} → ${details["survivalHp"]}`,
    details,
    severity: "positive",
  };
}

/**
 * R-DTH-01（DMG-009）: 幻惑はダメージの適用の代わりに回復を適用する
 * （`DamageApplied`とは排他）。ダメージ行として読まれないよう回復として述べる。
 */
function formatDamageConvertedToHeal(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["calculatedDamage"] !== "number" ||
    typeof details["healRate"] !== "number" ||
    typeof details["healAmount"] !== "number" ||
    typeof details["appliedHeal"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const hit = hitLabel(details);
  const hitText = hit !== undefined ? ` ${hit}` : "";
  return {
    title: event.type,
    summary: `${sourceName(event, roster)} → ${resolveDisplayName(roster, details["targetUnitId"])}${hitText}: 計算ダメージ${details["calculatedDamage"]}が回復へ変換されました（変換率${percentText(details["healRate"])}、要求回復量${details["healAmount"]}、実回復${details["appliedHeal"]}）。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
    details,
    severity: "positive",
  };
}

/**
 * R-DOT-01〜04（DMG-008）: 継続ダメージはR-DMG-01〜05のpipelineを通らないため、
 * ヒット番号を持たず`continuousDamageKind`で種別を区別する。R-DOT-03の炎上2倍と
 * R-DOT-04の付与時攻撃力上限は、量の由来として読めるよう明示する。
 */
function formatContinuousDamageApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["continuousDamageKind"] !== "string" ||
    typeof details["calculatedDamage"] !== "number" ||
    typeof details["hitPointDamage"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const damageType = details["damageType"];
  const damageTypeText = typeof damageType === "string" ? `（${damageType}）` : "";
  // R-SUB-01第1項「通常シールドをすべて適用した後にサブユニットがダメージを受ける」
  // （DMG-010）: `FIXED`はサブユニットへも吸収されるため、この項が
  // 無いと`calculatedDamage`と`hitPointDamage`の差を説明できない。`BURN`/`POISON`は
  // 第2項によりサブユニットで受けず常に0なので、0を落とす規則のまま文からも消える。
  const breakdown = optionalTerms([
    positiveTerm("タイプありシールド吸収", details["typedShieldAbsorbed"]),
    positiveTerm("タイプなしシールド吸収", details["untypedShieldAbsorbed"]),
    positiveTerm("サブユニット吸収", details["subUnitAbsorbed"]),
    positiveTerm("破棄", details["discardedDamage"]),
  ]);
  const notes = optionalTerms([
    // R-DOT-03: 対象が炎上を3つ保持している場合だけ2倍になる。
    numberOf(details["burnStackMultiplier"]) === 2 ? "炎上3スタックで2倍" : undefined,
    details["cappedBySnapshotAttack"] === true ? "付与時攻撃力の上限に到達" : undefined,
    details["defeated"] === true ? "戦闘不能" : undefined,
  ]);
  return {
    title: event.type,
    summary: `${sourceName(event, roster)} → ${resolveDisplayName(roster, details["targetUnitId"])} 継続ダメージ ${details["continuousDamageKind"]}${damageTypeText}: 計算ダメージ${details["calculatedDamage"]}${breakdown} → HPダメージ${details["hitPointDamage"]}。HP ${details["hpBefore"]} → ${details["hpAfter"]}${notes}`,
    details,
    severity: "negative",
  };
}

/**
 * R-DOT-04（DMG-008）: 毒の再付与は新規インスタンスを足さず既存へ統合する
 * （`EffectApplied`は発行されない）。「期間は長い方、効果量は大きい方」の採用結果を
 * そのまま出し、どちらの付与元が採られたかをUIで推測しない。
 */
function formatEffectMerged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["effectActionDefinitionId"] !== "string" ||
    typeof details["reason"] !== "string" ||
    typeof details["magnitudeBefore"] !== "number" ||
    typeof details["magnitudeAfter"] !== "number"
  ) {
    return undefined;
  }
  const remainingBefore = numberOf(details["remainingBefore"]);
  const remainingAfter = numberOf(details["remainingAfter"]);
  const terms = optionalTerms([
    `理由: ${details["reason"]}`,
    `効果量 ${details["magnitudeBefore"]} → ${details["magnitudeAfter"]}`,
    remainingBefore !== undefined && remainingAfter !== undefined
      ? `残り期間 ${remainingBefore} → ${remainingAfter}`
      : undefined,
  ]);
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の効果「${details["effectActionDefinitionId"]}」を既存インスタンスへ統合しました${terms}。`,
    details,
    severity: "neutral",
  };
}

/**
 * 「M8 高度ダメージ拡張」（DMG-010）の追加表示。`DAMAGE_APPLIED`は
 * M4から存在するtypeだが、M8で内訳フィールドが加わったためこちらへ移した。
 */
export const damageEventFormatters: Readonly<Record<string, EventFormatter>> = {
  CRITICAL_CHECK_RESOLVED: formatCriticalCheckResolved,
  DAMAGE_WILL_BE_APPLIED: formatDamageWillBeApplied,
  DAMAGE_CALCULATED: formatDamageCalculated,
  DAMAGE_REDIRECTED: formatDamageRedirected,
  SHIELD_CONSUMED: formatShieldConsumed,
  SUB_UNIT_DAMAGED: formatSubUnitDamaged,
  HIT_POINT_REDUCED: formatHitPointReduced,
  DAMAGE_APPLIED: formatDamageApplied,
  DAMAGE_CONVERTED_TO_HEAL: formatDamageConvertedToHeal,
  LINKED_DAMAGE_GENERATED: formatLinkedDamageGenerated,
  REFLECTED_DAMAGE_GENERATED: formatReflectedDamageGenerated,
  LETHAL_DAMAGE_SURVIVED: formatLethalDamageSurvived,
  CONTINUOUS_DAMAGE_APPLIED: formatContinuousDamageApplied,
  EFFECT_MERGED: formatEffectMerged,
};
