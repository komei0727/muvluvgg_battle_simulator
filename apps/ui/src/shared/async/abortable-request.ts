import { useCallback, useMemo, useRef } from "react";

/**
 * Consolidates the abort-and-supersede plumbing duplicated across the async
 * data hooks (catalog-loader / formation-stat-preview / simulation-execution /
 * exercise-statistics-run): abort the in-flight request before starting a new
 * one, and let a late response recognize it has been superseded.
 *
 * `TId` is whatever the caller already uses to name a request — a numeric
 * token (`useTokenedRequest`) or a domain id shown in state (`executionId`,
 * `runId`). This hook only tracks it; it never generates one itself.
 */
export interface AbortableRequest<TId> {
  /** Aborts any in-flight request, tracks `id` as current, and returns a fresh signal. */
  readonly start: (id: TId) => AbortSignal;
  /** True while `id` is still the most recently started request. */
  readonly isCurrent: (id: TId) => boolean;
  /** The most recently started id, or `null` before the first `start`. */
  readonly current: () => TId | null;
  /** Aborts the in-flight request. Does not change which id is current. */
  readonly abort: () => void;
}

export function useAbortableRequest<TId>(): AbortableRequest<TId> {
  const controllerRef = useRef<AbortController | null>(null);
  const currentIdRef = useRef<TId | null>(null);

  const start = useCallback((id: TId): AbortSignal => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    currentIdRef.current = id;
    return controller.signal;
  }, []);

  const isCurrent = useCallback((id: TId): boolean => currentIdRef.current === id, []);

  const current = useCallback((): TId | null => currentIdRef.current, []);

  const abort = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  return useMemo(() => ({ start, isCurrent, current, abort }), [start, isCurrent, current, abort]);
}

export interface TokenedRequest {
  /** Aborts any in-flight request and starts a new one under a fresh token. */
  readonly start: () => { readonly signal: AbortSignal; readonly token: number };
  /** True while `token` is still the most recently started request. */
  readonly isCurrent: (token: number) => boolean;
  /** Aborts the in-flight request and invalidates it: no token is current afterward. */
  readonly abort: () => void;
}

// No token returned by `start()` is ever 0 (the counter is pre-incremented from 0),
// so starting the tracked request under this sentinel makes every real token stale
// without a caller having to name one.
const NO_TOKEN = 0;

/**
 * Thin wrapper over {@link useAbortableRequest} for callers that only need to
 * tell "this response is stale" apart from "this one is current" and have no
 * domain meaning to give the id — `catalog-loader` and `use-formation-stat-preview`.
 */
export function useTokenedRequest(): TokenedRequest {
  const request = useAbortableRequest<number>();
  const counterRef = useRef(0);

  const start = useCallback((): { signal: AbortSignal; token: number } => {
    const token = (counterRef.current += 1);
    const signal = request.start(token);
    return { signal, token };
  }, [request]);

  const abort = useCallback((): void => {
    request.start(NO_TOKEN);
  }, [request]);

  return useMemo(
    () => ({ start, isCurrent: request.isCurrent, abort }),
    [start, request.isCurrent, abort],
  );
}
