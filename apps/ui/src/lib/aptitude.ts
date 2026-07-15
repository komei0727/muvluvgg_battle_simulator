export type UiAptitude = "FRONT" | "REAR";

// docs/ui-design/03_API・データ連携設計.md §4: CatalogのpositionAptitudesは
// FRONT/BACKを使うが、UIはREARを「後衛適性」と表示する。この名称差異を
// 1つの変換関数に閉じ込める(request-mapperと検索filterの両方から使う)。
export function aptitudeMatches(
  uiAptitude: UiAptitude,
  positionAptitudes: readonly string[],
): boolean {
  return positionAptitudes.includes(uiAptitude === "REAR" ? "BACK" : "FRONT");
}
