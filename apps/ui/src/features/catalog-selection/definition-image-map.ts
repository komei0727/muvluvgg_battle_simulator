// Builds definitionId -> asset URL maps from locally-synced character art
// (see apps/ui/scripts/sync-character-images.mjs). The source directories are
// gitignored and may be empty or absent (CI, other machines, GitHub Pages
// builds) — import.meta.glob then resolves to an empty map and every
// DefinitionImage falls back to its initials, per docs/ui-design/01_UI要求・
// 画面設計.md §9.
const unitModules = import.meta.glob("../../assets/units/*.webp", {
  eager: true,
  import: "default",
}) as Readonly<Record<string, string>>;

const memoryModules = import.meta.glob("../../assets/memories/*.webp", {
  eager: true,
  import: "default",
}) as Readonly<Record<string, string>>;

export function toDefinitionIdMap(
  modules: Readonly<Record<string, string>>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [modulePath, url] of Object.entries(modules)) {
    const filename = modulePath.split("/").at(-1) ?? "";
    const definitionId = filename.replace(/\.webp$/, "");
    map[definitionId] = url;
  }
  return map;
}

export const unitImageMap: Readonly<Record<string, string>> = toDefinitionIdMap(unitModules);
export const memoryImageMap: Readonly<Record<string, string>> = toDefinitionIdMap(memoryModules);

// unitDefinitionId/memoryDefinitionId prefixes never collide, so this is safe
// to hand to components (e.g. FormationEditor) that render both kinds behind
// one shared imageMap prop.
export const definitionImageMap: Readonly<Record<string, string>> = {
  ...unitImageMap,
  ...memoryImageMap,
};
