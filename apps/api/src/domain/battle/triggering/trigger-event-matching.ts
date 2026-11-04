import type { Side } from "../../shared/side.js";

/**
 * `08_ドメインイベント.md`「戦術演習イベント」／R-TEX-03 #2: ブレイクは撃破として扱う。
 * `eventType: "UnitDefeated"` を宣言した既存の `TriggerDefinition`（「敵撃破時」契機の
 * PS・メモリー効果・RuntimeCounter更新）は、**Catalog定義を変更することなく**
 * `UnitBroken` にも照合する。
 *
 * 対応は一方向である。`UnitBroken` を明示的に宣言したtriggerは `UnitDefeated` では
 * 発動しない — 「撃破として扱う」のはブレイク側であり、通常戦闘の撃破が演習固有の
 * 契機を満たすわけではないためである。
 *
 * `TriggerDefinition.eventType` を実際のイベント種別と突き合わせる箇所は、この関数
 * だけを使うこと。素の `===` が1か所でも残ると、その照合器でだけブレイクが撃破として
 * 扱われないという食い違いになる。
 */
export function matchesTriggerEventType(
  declaredEventType: string,
  actualEventType: string,
): boolean {
  if (declaredEventType === actualEventType) {
    return true;
  }
  return declaredEventType === "UnitDefeated" && actualEventType === "UnitBroken";
}

/**
 * R-TWR-05 #2: 総力戦の2番目以降の編成は、戦闘開始時Memory（`eventType: BattleStarted`）を
 * **Catalog定義を変更することなく**その編成自身の `FormationDeployed` へ照合する。
 * 出撃した陣営（`payload.side`）のMemoryだけが対象で、相手陣営の出撃では照合しない —
 * 勝ち残った編成の戦闘開始時Memoryは再び候補化しない（同 #3）。
 *
 * 照合対象のMemoryは呼び出し側が出撃中の編成のものへ絞り込み済みであるため（同 #1）、
 * 出撃した陣営の出撃中の編成はちょうど今出撃した編成である。PSには適用しない —
 * 出撃したユニットの戦闘開始時PSを出撃時に発動させる規則は無い。
 */
export function matchesMemoryTriggerEventType(
  declaredEventType: string,
  event: { readonly eventType: string; readonly payload: Readonly<Record<string, unknown>> },
  memorySide: Side,
): boolean {
  if (declaredEventType === "BattleStarted" && event.eventType === "FormationDeployed") {
    return event.payload["side"] === memorySide;
  }
  return matchesTriggerEventType(declaredEventType, event.eventType);
}
