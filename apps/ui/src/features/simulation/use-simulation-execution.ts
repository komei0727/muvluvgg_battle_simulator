import { useCallback, useEffect, useRef, useState } from "react";
import { simulate as defaultSimulate } from "./api-client.js";
import { createInitialExecutionState, executionReducer } from "./execution-reducer.js";
import type { ExecutionState } from "./execution-reducer.js";
import type { BattleSimulationRequest } from "../formation/request-mapper.js";

// docs/ui-design/03_API・データ連携設計.md §7 「タイムアウトとキャンセル」:
// AbortControllerを1実行につき1つ作り、利用者キャンセル・page unload・UI待機
// 上限でabortする。Abort後に到着した結果はexecutionReducerがexecutionIdの
// 不一致で無視するため、この層は「最新のcontrollerをabortする」ことだけを保証する。

let executionCounter = 0;
function generateExecutionId(): string {
  executionCounter += 1;
  return `exec-${Date.now()}-${executionCounter}`;
}

function generateRequestId(): string | undefined {
  try {
    return `ui-${crypto.randomUUID()}`;
  } catch {
    return undefined;
  }
}

type SimulateFn = typeof defaultSimulate;

export interface UseSimulationExecutionOptions {
  readonly simulateImpl?: SimulateFn;
  readonly timeoutMs?: number;
}

export interface UseSimulationExecutionResult {
  readonly state: ExecutionState;
  readonly submit: (request: BattleSimulationRequest) => void;
  readonly cancel: () => void;
}

export function useSimulationExecution(
  baseUrl: string,
  options: UseSimulationExecutionOptions = {},
): UseSimulationExecutionResult {
  const simulateImpl = options.simulateImpl ?? defaultSimulate;
  const [state, setState] = useState<ExecutionState>(createInitialExecutionState);
  const abortControllerRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    (request: BattleSimulationRequest) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const executionId = generateExecutionId();
      const startedAt = Date.now();

      setState((previous) =>
        executionReducer(previous, { type: "submissionStarted", executionId, request, startedAt }),
      );

      const requestId = generateRequestId();
      void simulateImpl(request, {
        baseUrl,
        signal: controller.signal,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      }).then((result) => {
        if (result.ok) {
          setState((previous) =>
            executionReducer(previous, {
              type: "submissionSucceeded",
              executionId,
              response: result.response,
              completedAt: Date.now(),
              ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
            }),
          );
          return;
        }
        if (result.error.kind === "CANCELLED") {
          setState((previous) =>
            executionReducer(previous, { type: "submissionCancelled", executionId }),
          );
          return;
        }
        setState((previous) =>
          executionReducer(previous, {
            type: "submissionFailed",
            executionId,
            error: result.error,
            ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
          }),
        );
      });
    },
    [baseUrl, simulateImpl, options.timeoutMs],
  );

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    // page unload: an in-flight battle POST must not keep running after the
    // tab is closed/navigated away (03_API・データ連携設計.md §7).
    const handleUnload = () => {
      abortControllerRef.current?.abort();
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      abortControllerRef.current?.abort();
    };
  }, []);

  return { state, submit, cancel };
}
