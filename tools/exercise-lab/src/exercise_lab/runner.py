"""大量試行をチャンクへ分割して直列に回し、試行ごとの生値を積む。

サーバーは1リクエストの中で `runIndex` を 0 から振り直し、乱数列を
`deriveRunSeed(hashSeedString(seed), runIndex)` で決める
（`apps/api/src/infrastructure/random/seeded-random-source.ts`）。したがって同じ `seed`
のままリクエストを分割すると、全チャンクがまったく同じ試行を繰り返す。チャンクごとに
通し試行番号（`run_offset`）を埋め込んだ別のseed文字列を送ることで重複を避ける。

この規約の帰結として、レポートを再現する鍵は `--seed` 単独ではなく
`(--seed, --chunk-size, --runs)` の3つになる。3つが同じなら送信seedもチャンク境界も
同じになり、同じ数値が出る。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass

from .api import LabApiClient
from .models import FormationConfig, build_evaluation_request


@dataclass(frozen=True)
class ChunkPlan:
    index: int
    seed: str
    runs: int
    run_offset: int


@dataclass(frozen=True)
class RunRecord:
    """1試行分の生値。`runs.csv` の1行であり、後段の分析の正本になる。"""

    run_index: int
    chunk_index: int
    chunk_seed: str
    run_index_in_chunk: int
    score: int
    break_count: int
    completed_turn: int
    completion_reason: str


@dataclass(frozen=True)
class EvaluationRun:
    requested_runs: int
    records: list[RunRecord]
    catalog_revision: str

    @property
    def completed_runs(self) -> int:
        return len(self.records)

    @property
    def is_partial(self) -> bool:
        return self.completed_runs < self.requested_runs


def plan_chunks(*, total_runs: int, base_seed: str, chunk_size: int) -> list[ChunkPlan]:
    if chunk_size <= 0:
        raise ValueError(f"chunk_size は1以上でなければならない（{chunk_size}）")
    if total_runs <= 0:
        raise ValueError(f"total_runs は1以上でなければならない（{total_runs}）")
    chunks: list[ChunkPlan] = []
    offset = 0
    while offset < total_runs:
        runs = min(chunk_size, total_runs - offset)
        chunks.append(
            ChunkPlan(index=len(chunks), seed=f"{base_seed}#{offset}", runs=runs, run_offset=offset)
        )
        offset += runs
    return chunks


def run_evaluation(
    client: LabApiClient,
    config: FormationConfig,
    chunks: Sequence[ChunkPlan],
    *,
    on_chunk_done: Callable[[ChunkPlan, int], None] | None = None,
) -> EvaluationRun:
    """チャンクを直列に投げて結果を積む。

    部分結果（`completedRuns` が要求未満）のチャンクは再送しない。再送すると同じ
    seedで同じ試行をやり直すことになり、期限に間に合わなかった原因も変わらないため
    同じところで切れる。不足はレポートへ実試行数として書く。
    """
    records: list[RunRecord] = []
    catalog_revision = ""
    for chunk in chunks:
        body = build_evaluation_request(config, runs_per_candidate=chunk.runs, seed=chunk.seed)
        response = client.evaluate(body)
        catalog_revision = response.catalog_revision
        candidate = response.candidates[0]
        records.extend(_records_of(chunk, candidate))
        if on_chunk_done is not None:
            on_chunk_done(chunk, candidate.completed_runs)
    return EvaluationRun(
        requested_runs=sum(chunk.runs for chunk in chunks),
        records=records,
        catalog_revision=catalog_revision,
    )


def _records_of(chunk: ChunkPlan, candidate) -> Iterable[RunRecord]:
    # 4つの配列は同じ試行を同じ添字で指す（`10_API設計.md`）。サーバーは `runIndex` の
    # 昇順で埋めて期限で打ち切るため、添字はそのまま chunk 内の試行番号になる。
    for index in range(candidate.completed_runs):
        yield RunRecord(
            run_index=chunk.run_offset + index,
            chunk_index=chunk.index,
            chunk_seed=chunk.seed,
            run_index_in_chunk=index,
            score=candidate.scores[index],
            break_count=candidate.break_counts[index],
            completed_turn=candidate.completed_turns[index],
            completion_reason=candidate.completion_reasons[index],
        )
