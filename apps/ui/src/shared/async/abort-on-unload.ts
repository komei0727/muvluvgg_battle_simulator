import { useEffect } from "react";

/**
 * Aborts an in-flight request before the tab is closed or navigated away, and
 * again on unmount (docs/ui-design/03_API・データ連携設計.md §7). Shared by
 * `use-simulation-execution` and `use-exercise-statistics-run`; the other two
 * async hooks have no work left running once the page is about to unload.
 */
export function useAbortOnUnload(abort: () => void): void {
  useEffect(() => {
    window.addEventListener("beforeunload", abort);
    return () => {
      window.removeEventListener("beforeunload", abort);
      abort();
    };
  }, [abort]);
}
