import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAbortOnUnload } from "./abort-on-unload.js";

describe("useAbortOnUnload", () => {
  it("calls abort when the page is unloaded", () => {
    const abort = vi.fn();
    renderHook(() => {
      useAbortOnUnload(abort);
    });

    window.dispatchEvent(new Event("beforeunload"));

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("calls abort once more on unmount and stops listening for unload", () => {
    const abort = vi.fn();
    const { unmount } = renderHook(() => {
      useAbortOnUnload(abort);
    });

    unmount();
    expect(abort).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("beforeunload"));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not re-register the listener when abort keeps the same identity", () => {
    const abort = vi.fn();
    const { rerender } = renderHook(() => {
      useAbortOnUnload(abort);
    });

    rerender();
    window.dispatchEvent(new Event("beforeunload"));

    expect(abort).toHaveBeenCalledTimes(1);
  });
});
