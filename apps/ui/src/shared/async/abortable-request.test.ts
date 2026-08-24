import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAbortableRequest, useTokenedRequest } from "./abortable-request.js";

describe("useAbortableRequest", () => {
  it("returns a fresh, non-aborted signal for the first start", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    let signal: AbortSignal | undefined;
    act(() => {
      signal = result.current.start("a");
    });

    expect(signal?.aborted).toBe(false);
    expect(result.current.isCurrent("a")).toBe(true);
  });

  it("aborts the previous signal when a new request starts", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    let first: AbortSignal | undefined;
    act(() => {
      first = result.current.start("a");
    });
    act(() => {
      result.current.start("b");
    });

    expect(first?.aborted).toBe(true);
  });

  it("treats only the most recently started id as current", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    act(() => {
      result.current.start("a");
      result.current.start("b");
    });

    expect(result.current.isCurrent("a")).toBe(false);
    expect(result.current.isCurrent("b")).toBe(true);
  });

  it("aborts the in-flight signal without changing which id is current", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    let signal: AbortSignal | undefined;
    act(() => {
      signal = result.current.start("a");
    });
    act(() => {
      result.current.abort();
    });

    expect(signal?.aborted).toBe(true);
    expect(result.current.isCurrent("a")).toBe(true);
  });

  it("reports no current id before the first start", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    expect(result.current.current()).toBeNull();
  });

  it("reports the most recently started id as current", () => {
    const { result } = renderHook(() => useAbortableRequest<string>());

    act(() => {
      result.current.start("a");
    });

    expect(result.current.current()).toBe("a");
  });

  it("keeps the same start/isCurrent/abort/current identities across renders", () => {
    const { result, rerender } = renderHook(() => useAbortableRequest<string>());
    const before = result.current;
    rerender();

    expect(result.current.start).toBe(before.start);
    expect(result.current.isCurrent).toBe(before.isCurrent);
    expect(result.current.abort).toBe(before.abort);
    expect(result.current.current).toBe(before.current);
    expect(result.current).toBe(before);
  });
});

describe("useTokenedRequest", () => {
  it("issues a fresh token per start and aborts the previous signal", () => {
    const { result } = renderHook(() => useTokenedRequest());

    let firstSignal: AbortSignal | undefined;
    let firstToken: number | undefined;
    act(() => {
      const started = result.current.start();
      firstSignal = started.signal;
      firstToken = started.token;
    });

    let secondToken: number | undefined;
    act(() => {
      secondToken = result.current.start().token;
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(firstToken).not.toBe(secondToken);
    expect(result.current.isCurrent(firstToken as number)).toBe(false);
    expect(result.current.isCurrent(secondToken as number)).toBe(true);
  });

  it("invalidates the current token via abort without issuing a new one", () => {
    const { result } = renderHook(() => useTokenedRequest());

    let token: number | undefined;
    let signal: AbortSignal | undefined;
    act(() => {
      const started = result.current.start();
      token = started.token;
      signal = started.signal;
    });
    act(() => {
      result.current.abort();
    });

    expect(signal?.aborted).toBe(true);
    expect(result.current.isCurrent(token as number)).toBe(false);
  });
});
