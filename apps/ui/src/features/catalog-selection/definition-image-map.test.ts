import { describe, expect, it } from "vitest";
import { toDefinitionIdMap } from "./definition-image-map.js";

// Exercises the pure key-derivation logic against fabricated
// import.meta.glob-shaped input, independent of whatever character art
// happens to be synced locally (apps/ui/scripts/sync-character-images.mjs
// output is gitignored and absent in CI).
describe("toDefinitionIdMap", () => {
  it("keys entries by the definitionId derived from the module path", () => {
    const modules = {
      "../../assets/units/UNIT_ANIS_TROUBLEMAKER.webp":
        "/assets/UNIT_ANIS_TROUBLEMAKER-abc123.webp",
      "../../assets/units/UNIT_LUNA_HUNGRY.webp": "/assets/UNIT_LUNA_HUNGRY-def456.webp",
    };

    expect(toDefinitionIdMap(modules)).toEqual({
      UNIT_ANIS_TROUBLEMAKER: "/assets/UNIT_ANIS_TROUBLEMAKER-abc123.webp",
      UNIT_LUNA_HUNGRY: "/assets/UNIT_LUNA_HUNGRY-def456.webp",
    });
  });

  it("returns an empty map when there are no modules (e.g. images not synced locally)", () => {
    expect(toDefinitionIdMap({})).toEqual({});
  });
});
