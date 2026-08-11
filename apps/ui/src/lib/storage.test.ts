import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonItem, removeJsonItem, writeJsonItem } from "./storage.js";

const KEY = "mlgg:test";

/** `localStorage`をアクセスしただけでthrowする環境（プライバシー設定など）を作る。 */
function withLocalStorage(descriptor: PropertyDescriptor): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, ...descriptor });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(window, "localStorage");
      return;
    }
    Object.defineProperty(window, "localStorage", original);
  };
}

describe("storage", () => {
  const restores: (() => void)[] = [];

  afterEach(() => {
    while (restores.length > 0) {
      restores.pop()?.();
    }
    window.localStorage.clear();
  });

  it("writes and reads back a JSON value", () => {
    writeJsonItem(KEY, { a: 1, b: ["x"] });

    expect(readJsonItem(KEY)).toStrictEqual({ a: 1, b: ["x"] });
  });

  it("reads undefined for a missing key", () => {
    expect(readJsonItem(KEY)).toBeUndefined();
  });

  it("removes a stored value", () => {
    writeJsonItem(KEY, { a: 1 });
    removeJsonItem(KEY);

    expect(readJsonItem(KEY)).toBeUndefined();
  });

  // UI-UT-PST-003: JSONとして壊れた値は破棄する。
  it("reads undefined for a value that is not valid JSON", () => {
    window.localStorage.setItem(KEY, "{not json");

    expect(readJsonItem(KEY)).toBeUndefined();
  });

  // UI-UT-PST-001
  it("degrades to undefined when localStorage access throws", () => {
    restores.push(
      withLocalStorage({
        get() {
          throw new Error("access denied");
        },
      }),
    );

    expect(() => {
      readJsonItem(KEY);
    }).not.toThrow();
    expect(readJsonItem(KEY)).toBeUndefined();
  });

  // UI-UT-PST-001
  it("does not throw when localStorage is absent", () => {
    restores.push(withLocalStorage({ value: undefined, writable: true }));

    expect(readJsonItem(KEY)).toBeUndefined();
    expect(() => {
      writeJsonItem(KEY, { a: 1 });
      removeJsonItem(KEY);
    }).not.toThrow();
  });

  // UI-UT-PST-002: 容量超過で呼び出し側を止めない。
  it("swallows a failing write", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("exceeded", "QuotaExceededError");
    });
    restores.push(
      withLocalStorage({
        value: { ...window.localStorage, setItem },
        writable: true,
      }),
    );

    expect(() => {
      writeJsonItem(KEY, { a: 1 });
    }).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing remove", () => {
    const removeItem = vi.fn(() => {
      throw new Error("denied");
    });
    restores.push(
      withLocalStorage({
        value: { ...window.localStorage, removeItem },
        writable: true,
      }),
    );

    expect(() => {
      removeJsonItem(KEY);
    }).not.toThrow();
  });

  // 値が循環参照でJSON化できない場合も、保存失敗として握り潰す。
  it("swallows a value that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => {
      writeJsonItem(KEY, cyclic);
    }).not.toThrow();
    expect(readJsonItem(KEY)).toBeUndefined();
  });
});
