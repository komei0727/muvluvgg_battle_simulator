import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredAccessKey, writeStoredAccessKey } from "../../shared/api/access-key.js";
import { useAccessKeyGate } from "./use-access-key-gate.js";

const KEY = "k".repeat(40);

describe("useAccessKeyGate", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("UI-CT-149: starts from the stored key without asking for one", () => {
    writeStoredAccessKey(KEY);

    const { result } = renderHook(() => useAccessKeyGate());

    expect(result.current.accessKey).toBe(KEY);
    expect(result.current.status).toBe("unknown");
  });

  it("UI-CT-150: a 401 without a key asks for one; a 401 with a key marks it rejected and forgets it from storage", () => {
    const { result } = renderHook(() => useAccessKeyGate());

    act(() => {
      result.current.reportUnauthorized(undefined);
    });
    expect(result.current.status).toBe("required");

    act(() => {
      result.current.submit(KEY);
    });
    expect(result.current.status).toBe("unknown");
    expect(readStoredAccessKey()).toBe(KEY);

    act(() => {
      result.current.reportUnauthorized(KEY);
    });
    expect(result.current.status).toBe("rejected");
    // 再読込で同じ無効キーを送り続けないよう保存からは消す。画面上の状態は保ち、
    // 取得し直しの連鎖を起こさない。
    expect(readStoredAccessKey()).toBeUndefined();
    expect(result.current.accessKey).toBe(KEY);
  });

  it("UI-CT-151: submit trims the key, and reset forgets it everywhere", () => {
    const { result } = renderHook(() => useAccessKeyGate());

    act(() => {
      result.current.submit(`  ${KEY}  `);
    });
    expect(result.current.accessKey).toBe(KEY);

    act(() => {
      result.current.reset();
    });
    expect(result.current.accessKey).toBeUndefined();
    expect(result.current.status).toBe("unknown");
    expect(readStoredAccessKey()).toBeUndefined();
  });

  it("UI-CT-160: a 401 for a key that is no longer current (a request started before the key was replaced) neither rejects nor forgets the new key", () => {
    const OLD_KEY = "o".repeat(40);
    writeStoredAccessKey(OLD_KEY);
    const { result } = renderHook(() => useAccessKeyGate());

    act(() => {
      result.current.submit(KEY);
    });
    act(() => {
      result.current.reportUnauthorized(OLD_KEY);
    });
    expect(result.current.status).toBe("unknown");
    expect(readStoredAccessKey()).toBe(KEY);

    // キーなしで始まった古い要求の401も、キー保存後には無視する。
    act(() => {
      result.current.reportUnauthorized(undefined);
    });
    expect(result.current.status).toBe("unknown");
    expect(readStoredAccessKey()).toBe(KEY);
  });

  it("UI-CT-161: keySaved is true only while the current key is stored, so a rejected key no longer counts as saved", () => {
    const { result } = renderHook(() => useAccessKeyGate());
    expect(result.current.keySaved).toBe(false);

    act(() => {
      result.current.submit(KEY);
    });
    expect(result.current.keySaved).toBe(true);

    act(() => {
      result.current.reportUnauthorized(KEY);
    });
    expect(result.current.keySaved).toBe(false);
  });
});
