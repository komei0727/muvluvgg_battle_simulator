import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions } from "../simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
} from "../simulation/api-contract.js";
import { useCatalogLoader } from "./catalog-loader.js";

function catalogResponse(catalogRevision: string): BattleSimulationCatalogResponse {
  return { schemaVersion: 1, catalogRevision, units: [], memories: [] };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useCatalogLoader", () => {
  it("starts loading and transitions to ready on success", async () => {
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
      Promise.resolve({
        ok: true,
        response: catalogResponse("rev-1"),
        etag: '"etag-1"',
        requestId: "req-1",
      }),
    );

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );

    expect(result.current.state.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });
    expect(result.current.state).toEqual({
      status: "ready",
      response: catalogResponse("rev-1"),
      etag: '"etag-1"',
      requestId: "req-1",
    });
  });

  it("transitions to failed with the normalized error on failure", async () => {
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        requestId: "req-err",
        error: { kind: "CAPACITY", message: "Server busy." },
      }),
    );

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state).toEqual({
      status: "failed",
      error: { kind: "CAPACITY", message: "Server busy." },
      requestId: "req-err",
    });
  });

  it("sends the previous etag from a ready state when reload() is called", async () => {
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
      Promise.resolve({ ok: true, response: catalogResponse("rev-1"), etag: '"etag-1"' }),
    );

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
    const secondCallOptions = getCatalogImpl.mock.calls[1]![0];
    expect(secondCallOptions.etag).toBe('"etag-1"');
  });

  it("keeps the previous response on a 304 while updating etag and requestId", async () => {
    const firstResponse = catalogResponse("rev-1");
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>();
    getCatalogImpl.mockResolvedValueOnce({ ok: true, response: firstResponse, etag: '"etag-1"' });
    getCatalogImpl.mockResolvedValueOnce({
      ok: true,
      notModified: true,
      etag: '"etag-1"',
      requestId: "req-304",
    });

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.state.status === "ready" && result.current.state.requestId).toBe(
        "req-304",
      );
    });
    expect(result.current.state).toEqual({
      status: "ready",
      response: firstResponse,
      etag: '"etag-1"',
      requestId: "req-304",
    });
  });

  it("aborts the previous in-flight request when reload() is called again before it resolves", async () => {
    const first = deferred<CatalogApiResult>();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true, response: catalogResponse("rev-2") });

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(1);
    });
    const firstSignal = getCatalogImpl.mock.calls[0]![0].signal;
    expect(firstSignal.aborted).toBe(false);

    act(() => {
      result.current.reload();
    });

    expect(firstSignal.aborted).toBe(true);
  });

  it("aborts the in-flight request on unmount", async () => {
    const pending = deferred<CatalogApiResult>();
    const getCatalogImpl = vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(
      () => pending.promise,
    );

    const { result, unmount } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(1);
    });
    const signal = getCatalogImpl.mock.calls[0]![0].signal;

    unmount();

    expect(signal.aborted).toBe(true);
    expect(result.current.state.status).toBe("loading");
  });

  it("ignores a stale response from a superseded reload call", async () => {
    const first = deferred<CatalogApiResult>();
    const second = deferred<CatalogApiResult>();
    const getCatalogImpl = vi
      .fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useCatalogLoader("https://api.example.com", { getCatalogImpl }),
    );
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });

    second.resolve({ ok: true, response: catalogResponse("rev-new") });
    await waitFor(() => {
      expect(result.current.state.status).toBe("ready");
    });

    // The stale first call resolves after the second — it must not overwrite state.
    first.resolve({ ok: true, response: catalogResponse("rev-stale") });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.state).toMatchObject({
      status: "ready",
      response: catalogResponse("rev-new"),
    });
  });
});
