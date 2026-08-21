"""探索状態の保存と復元。中断した探索を、続きから同じ軌跡で再開するために使う。

再開しても結果が変わらないためには、乱数の位置と評価済みスコアの両方を戻す必要がある。
乱数だけを戻すと、再開後に同じ候補をもう一度評価して予算の消費がずれる。スコアだけを
戻すと、次に生成する候補が変わる。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from random import Random
from typing import Any

from .candidate import Candidate, decode_candidate, encode_candidate
from .evaluator import CandidateRecord, EvaluationPhase, Evaluator

STATE_VERSION = 1


@dataclass(frozen=True)
class SearchState:
    algorithm: str
    generation: int
    stale_generations: int
    population: tuple[Candidate, ...]
    history: tuple[dict[str, Any], ...]
    rng_state: Any
    records: dict[str, list[dict[str, Any]]]
    consumed_runs: int


def capture_state(
    *,
    algorithm: str,
    generation: int,
    stale_generations: int,
    population: tuple[Candidate, ...],
    history: tuple[dict[str, Any], ...],
    rng: Random,
    evaluator: Evaluator[Candidate],
    phases: tuple[EvaluationPhase, ...],
) -> SearchState:
    return SearchState(
        algorithm=algorithm,
        generation=generation,
        stale_generations=stale_generations,
        population=population,
        history=history,
        rng_state=rng.getstate(),
        records={phase.name: _dump_records(evaluator, phase) for phase in phases},
        consumed_runs=evaluator.consumed_runs,
    )


def write_state(path: Path, state: SearchState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_encode(state), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def read_state(path: Path) -> SearchState:
    payload = json.loads(path.read_text(encoding="utf-8"))
    version = payload.get("version")
    if version != STATE_VERSION:
        raise ValueError(
            f"{path}: 未対応の状態ファイル版 {version!r}（このツールは {STATE_VERSION} だけを読む）"
        )
    return SearchState(
        algorithm=payload["algorithm"],
        generation=payload["generation"],
        stale_generations=payload["staleGenerations"],
        population=tuple(decode_candidate(entry) for entry in payload["population"]),
        history=tuple(payload["history"]),
        # `random.Random.setstate` はタプルしか受けない。JSONの配列から戻す。
        rng_state=_to_rng_state(payload["rngState"]),
        records=payload["records"],
        consumed_runs=payload["consumedRuns"],
    )


def restore_evaluator(
    evaluator: Evaluator[Candidate], state: SearchState, phases: tuple[EvaluationPhase, ...]
) -> None:
    """保存済みの評価履歴を評価器へ戻す。戻した試行は予算を消費済みとして数える。"""
    by_name = {phase.name: phase for phase in phases}
    for name, entries in state.records.items():
        phase = by_name.get(name)
        if phase is None:
            continue
        for entry in entries:
            evaluator.adopt_record(
                phase,
                CandidateRecord(
                    candidate=decode_candidate(entry["candidate"]),
                    scores=list(entry["scores"]),
                    break_counts=list(entry["breakCounts"]),
                    completion_reasons=list(entry["completionReasons"]),
                ),
            )
    evaluator.adopt_consumed_runs(state.consumed_runs)


def _dump_records(evaluator: Evaluator[Candidate], phase: EvaluationPhase) -> list[dict[str, Any]]:
    """再開に要る列だけを書き出す。

    ユニット別与ダメージ（`CandidateRecord.unit_damage_totals`）は載せない。編成探索は
    読まない列であり、状態ファイルを候補数×試行数×枠数で膨らませる意味が無い。ギア探索
    （`gear/`）は中断・再開を持たないので、落ちて困る利用者も居ない。
    """
    return [
        {
            "candidate": encode_candidate(record.candidate),
            "scores": record.scores,
            "breakCounts": record.break_counts,
            "completionReasons": record.completion_reasons,
        }
        for record in evaluator.evaluated_records(phase)
    ]


def _encode(state: SearchState) -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "algorithm": state.algorithm,
        "generation": state.generation,
        "staleGenerations": state.stale_generations,
        "population": [encode_candidate(candidate) for candidate in state.population],
        "history": list(state.history),
        "rngState": _from_rng_state(state.rng_state),
        "records": state.records,
        "consumedRuns": state.consumed_runs,
    }


def _from_rng_state(rng_state: Any) -> list[Any]:
    version, keys, gauss = rng_state
    return [version, list(keys), gauss]


def _to_rng_state(payload: list[Any]) -> tuple[Any, ...]:
    version, keys, gauss = payload
    return (version, tuple(keys), gauss)
