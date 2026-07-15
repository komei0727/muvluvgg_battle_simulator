import { useCallback, useEffect, useReducer, useRef } from "react";
import { getCatalog as defaultGetCatalog } from "../simulation/api-client.js";
import type { BattleSimulationCatalogResponse, UiApiError } from "../simulation/api-contract.js";

// docs/ui-design/04_コンポーネント・状態管理設計.md §4: CatalogLoadState.
export type CatalogLoadState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly response: BattleSimulationCatalogResponse;
      readonly etag?: string;
      readonly requestId?: string;
    }
  | { readonly status: "failed"; readonly error: UiApiError; readonly requestId?: string };

type GetCatalogFn = typeof defaultGetCatalog;

type Action =
  | { readonly type: "started" }
  | {
      readonly type: "succeeded";
      readonly response: BattleSimulationCatalogResponse;
      readonly etag?: string;
      readonly requestId?: string;
    }
  | { readonly type: "failed"; readonly error: UiApiError; readonly requestId?: string };

function reducer(_state: CatalogLoadState, action: Action): CatalogLoadState {
  switch (action.type) {
    case "started":
      return { status: "loading" };
    case "succeeded":
      return {
        status: "ready",
        response: action.response,
        ...(action.etag !== undefined ? { etag: action.etag } : {}),
        ...(action.requestId !== undefined ? { requestId: action.requestId } : {}),
      };
    case "failed":
      return {
        status: "failed",
        error: action.error,
        ...(action.requestId !== undefined ? { requestId: action.requestId } : {}),
      };
  }
}

export interface UseCatalogLoaderOptions {
  readonly getCatalogImpl?: GetCatalogFn;
}

export interface UseCatalogLoaderResult {
  readonly state: CatalogLoadState;
  readonly reload: () => void;
}

export function useCatalogLoader(
  baseUrl: string,
  options: UseCatalogLoaderOptions = {},
): UseCatalogLoaderResult {
  const getCatalogImpl = options.getCatalogImpl ?? defaultGetCatalog;
  const [state, dispatch] = useReducer(reducer, { status: "loading" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);

  const load = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const token = ++requestTokenRef.current;
    const priorReady = stateRef.current.status === "ready" ? stateRef.current : undefined;

    dispatch({ type: "started" });

    void getCatalogImpl({
      baseUrl,
      signal: controller.signal,
      ...(priorReady?.etag !== undefined ? { etag: priorReady.etag } : {}),
    }).then((result) => {
      if (requestTokenRef.current !== token) {
        return;
      }

      if (!result.ok) {
        dispatch({
          type: "failed",
          error: result.error,
          ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        });
        return;
      }

      if ("notModified" in result) {
        if (priorReady !== undefined) {
          dispatch({
            type: "succeeded",
            response: priorReady.response,
            etag: result.etag,
            ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
          });
        }
        return;
      }

      dispatch({
        type: "succeeded",
        response: result.response,
        ...(result.etag !== undefined ? { etag: result.etag } : {}),
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
      });
    });
  }, [baseUrl, getCatalogImpl]);

  useEffect(() => {
    load();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [load]);

  return { state, reload: load };
}
