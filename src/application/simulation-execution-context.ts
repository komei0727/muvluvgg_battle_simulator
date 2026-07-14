/**
 * `09_アプリケーション設計.md`「SimulationExecutionContext」: ドメインルールではない
 * 実行上の情報。HTTPリクエストやフレームワーク固有の型は含めない。
 *
 * `deadline`は既存の`WorkerSimulationTask.deadlineEpochMs`（`worker-contract.ts`）
 * と揃えて`deadlineEpochMs`と命名する。`cancellationSignal`はスレッド境界を
 * 越えられない（`AbortSignal`は構造化クローン不可）ため、Worker内で組み立てる
 * 側（`simulation-task-runner.ts`）は常にこのフィールドを持たない値を渡す —
 * 強制キャンセルは`SimulationWorkerPool`がメインスレッド側で`Piscina.run`の
 * `signal`optionへ渡すことで実現し、Worker側の協調的な期限確認とは別経路。
 */
export interface SimulationExecutionContext {
  readonly requestId: string;
  readonly deadlineEpochMs: number;
  readonly cancellationSignal?: AbortSignal;
}
