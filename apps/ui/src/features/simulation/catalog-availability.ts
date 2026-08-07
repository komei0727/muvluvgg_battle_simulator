import type { CatalogAvailability } from "./api-contract.js";

// APIがCapability廃止後に両フィールドを送らなくなるため、欠落は
// 「選択可能・未対応理由なし」として解釈する。可否をUI側で再計算はしない。

export function isSelectable(entry: CatalogAvailability): boolean {
  return entry.selectable !== false;
}

export function unavailableCapabilitiesOf(entry: CatalogAvailability): readonly string[] {
  return entry.unavailableCapabilities ?? [];
}
