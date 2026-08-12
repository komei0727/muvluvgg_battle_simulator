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
