import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_KEY_STORAGE_KEY,
  readStoredAccessKey,
  removeStoredAccessKey,
  writeStoredAccessKey,
} from "./access-key.js";

describe("access key storage", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("UI-API-039: round-trips a saved key and forgets it on removal", () => {
    expect(readStoredAccessKey()).toBeUndefined();

    writeStoredAccessKey("k".repeat(40));
    expect(readStoredAccessKey()).toBe("k".repeat(40));

    removeStoredAccessKey();
    expect(readStoredAccessKey()).toBeUndefined();
  });

  it.each([
    ["a non-string value", 42],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ])(
    "UI-API-040: treats %s in storage as no key, so a corrupted entry never becomes an Authorization header",
    (_case, stored) => {
      localStorage.setItem(ACCESS_KEY_STORAGE_KEY, JSON.stringify(stored));

      expect(readStoredAccessKey()).toBeUndefined();
    },
  );
});
