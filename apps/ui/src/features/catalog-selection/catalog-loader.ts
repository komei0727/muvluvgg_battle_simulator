import { useCallback, useEffect, useReducer } from "react";
import { getCatalog as defaultGetCatalog } from "../../shared/api/api-client.js";
import type { BattleSimulationCatalogResponse, UiApiError } from "../../shared/api/api-contract.js";
import { useTokenedRequest } from "../../shared/async/abortable-request.js";

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

type ReadyCatalogLoadState = Extract<CatalogLoadState, { status: "ready" }>;

export function useCatalogLoader(
  baseUrl: string,
  options: UseCatalogLoaderOptions = {},
): UseCatalogLoaderResult {
  const getCatalogImpl = options.getCatalogImpl ?? defaultGetCatalog;
  const [state, dispatch] = useReducer(reducer, { status: "loading" });
  const asyncRequest = useTokenedRequest();

  // 条件付き取得に使う直前のready snapshotは呼び出し側が引数で渡す。stateを
  // `load`の依存に含めるとmount effectが毎回再実行され、レンダー中にrefへ
  // stateを写すと並行レンダリング下で書き込みが破棄され得るため、どちらも取らない。
  const load = useCallback(
    (priorReady: ReadyCatalogLoadState | undefined) => {
      const { signal, token } = asyncRequest.start();

      dispatch({ type: "started" });

      void getCatalogImpl({
        baseUrl,
        signal,
        ...(priorReady?.etag !== undefined ? { etag: priorReady.etag } : {}),
      }).then((result) => {
        if (!asyncRequest.isCurrent(token)) {
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
    },
    [baseUrl, getCatalogImpl, asyncRequest],
  );

  useEffect(() => {
    // mount時はready snapshotが存在しないため無条件取得。
    load(undefined);
    return () => {
      asyncRequest.abort();
    };
  }, [load, asyncRequest]);

  const reload = useCallback(() => {
    load(state.status === "ready" ? state : undefined);
  }, [load, state]);

  return { state, reload };
}
