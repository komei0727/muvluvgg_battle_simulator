"""候補の評価。共通乱数法・増量評価・キャッシュ・分割送信を引き受ける。

サーバーは1リクエストの中で `runIndex` を0から振り直し、乱数列を `(seed, runIndex)` だけで
決める（候補indexを混ぜない）。したがって**同じ送信seedと同じ試行数なら、候補が違っても
同じ乱数列で比較される**——これが共通乱数法であり、順位付けの分散を大きく下げる。

この性質を保つため、試行数の増やし方を候補ごとに変えない。`checkpoints` で区切った
はしごを全候補が同じ順で登り、区間ごとに同じseed文字列を使う。区切りを候補ごとに
変えると、同じ通し試行番号に別の乱数列が当たり、共通乱数法が崩れる。

増量した区間には別のseed文字列（`<base>#<通し試行番号>`）を割り当てる。同じseedのまま
試行数だけ増やすと、サーバーが `runIndex` を0から振り直すため同じ試行をやり直すことになる。
"""

from __future__ import annotations

import csv
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Any, Protocol

from ..api import CandidateEvaluation, EvaluationResponse
from ..stats import ALLY_DEFEATED
from .search_config import (
    DEFAULT_FINAL_STAGE_RUNS,
    DEFAULT_STAGE_RUNS,
    ScheduleSpec,
)

# devサーバーの既定（`EVALUATION_MAX_CANDIDATES` / `EVALUATION_MAX_TOTAL_RUNS`）。
DEFAULT_MAX_CANDIDATES = 32
DEFAULT_MAX_TOTAL_RUNS = 300

LOG_COLUMNS = (
    "phase",
    "canonical_key",
    "chunk_seed",
    "run_index_in_chunk",
    "score",
    "break_count",
    "completed_turn",
    "completion_reason",
)


class EvaluationClient(Protocol):
    def evaluate(self, body: dict[str, Any]) -> EvaluationResponse: ...


class EvaluationCandidate(Protocol):
    """評価器が候補へ求めるものすべて。

    求めるのは等価な候補を同一視する鍵だけである。候補が「6マスへのユニット割当＋
    メモリー」なのか「ギア配分」なのかを評価器は知らない——共通乱数法・増量評価の
    はしご・キャッシュ・分割送信は遺伝子型に依らない仕組みであり、遺伝子型を1つに
    決め打つと、別の遺伝子型を探すたびに同じ仕組みを書き直すことになる。
    """

    def canonical_key(self) -> str: ...


class FormationSource[C](Protocol):
    """候補を送信JSONの編成へ直す係。評価器と候補型はここだけで繋がる。

    敵編成は候補によらず一定なので、評価器は最初に一度だけ引く。
    """

    def enemy_formation(self) -> dict[str, Any]: ...

    def ally_formation(self, candidate: C) -> dict[str, Any]: ...


@dataclass(frozen=True)
class EvaluationPhase:
    """試行数の増やし方と、使う通し試行番号の範囲。

    探索と最終選抜で範囲を分けるためにある。最終選抜が探索と同じseedを引くと、
    探索が「たまたまその乱数列に強かった候補」を選んだ偏りをそのまま追認してしまう。
    """

    name: str
    checkpoints: tuple[int, ...]
    seed_offset: int

    @property
    def span(self) -> range:
        return range(self.seed_offset, self.seed_offset + self.checkpoints[-1])

    def ladder(self) -> tuple[int, ...]:
        return (0, *self.checkpoints)


SEARCH_PHASE = EvaluationPhase(name="search", checkpoints=DEFAULT_STAGE_RUNS, seed_offset=0)
FINAL_PHASE = EvaluationPhase(
    name="final", checkpoints=DEFAULT_FINAL_STAGE_RUNS, seed_offset=DEFAULT_STAGE_RUNS[-1]
)


def phases_for(schedule: ScheduleSpec) -> tuple[EvaluationPhase, EvaluationPhase]:
    """探索設定から2つの位相を組む。最終選抜は探索が使い切った先から始める。"""
    search = EvaluationPhase(name="search", checkpoints=schedule.stage_runs, seed_offset=0)
    final = EvaluationPhase(
        name="final",
        checkpoints=schedule.final_stage_runs,
        seed_offset=schedule.stage_runs[-1],
    )
    Evaluator.validate_phases((search, final))
    return search, final


@dataclass
class CandidateRecord[C]:
    """1候補ぶんの評価履歴。位相ごとに別々に積む。"""

    candidate: C
    scores: list[int] = field(default_factory=list)
    break_counts: list[int] = field(default_factory=list)
    completion_reasons: list[str] = field(default_factory=list)
    # 試行ごとの、味方枠別の与ダメージ（`allyUnitDamageTotals` の1行）。ギア探索の篩いが
    # 「自ユニットの与ダメージ」で順位を付けるために要る——総スコアより分散が小さく、
    # 動かした1枠の効果を切り出せる。応答に無ければ空のままで、読む側が扱う。
    unit_damage_totals: list[tuple[int, ...]] = field(default_factory=list)

    @property
    def sample_count(self) -> int:
        return len(self.scores)

    def unit_damage_at(self, slot_index: int, *, count: int) -> list[int]:
        """1枠ぶんの、先頭 `count` 試行の与ダメージ。候補間で試行数を揃えて比べる。"""
        return [row[slot_index] for row in self.unit_damage_totals[:count]]

    def scores_at(self, count: int) -> list[int]:
        """先頭 `count` 件。候補間で試行数を揃えて比べるために使う。"""
        return self.scores[:count]

    def defeat_rate(self, count: int | None = None) -> float:
        reasons = self.completion_reasons[: count or len(self.completion_reasons)]
        if not reasons:
            return 0.0
        return sum(1 for reason in reasons if reason == ALLY_DEFEATED) / len(reasons)


def _unit_damage_rows(
    evaluation: CandidateEvaluation, formation: dict[str, Any]
) -> list[tuple[int, ...]]:
    """応答のユニット別与ダメージを、試行ごとの行として取り出す。

    列番号と編成順の対応は `CandidateEvaluation.ally_unit_series` に集約されている
    （`10_API設計.md`「内側はリクエストの `allyFormation.units` と同じ順」）。ここで
    二重配列を直接読むと、その対応を2か所で組むことになる。
    """
    if not evaluation.ally_unit_damage_totals:
        return []
    unit_ids = [unit["unitDefinitionId"] for unit in formation["units"]]
    series = evaluation.ally_unit_series(unit_ids)
    return [
        tuple(entry.damage_totals[run] for entry in series)
        for run in range(evaluation.completed_runs)
    ]


def common_sample_count(records: Sequence[CandidateRecord[Any]]) -> int:
    """比較に使える試行数。

    順序統計量ベースの適応度は標本数で偏りが変わるため、試行数の違う候補どうしを
    生の値で比べると順位が試行数の差で決まってしまう。期限で欠けた候補が混ざっても
    公平に比べられるよう、そのラウンドで最も短い履歴へ揃える。
    """
    if not records:
        return 0
    return min(record.sample_count for record in records)


class Evaluator[C: EvaluationCandidate]:
    """一括評価APIの薄いラッパー。予算の消費と評価ログの記録もここが持つ。"""

    def __init__(
        self,
        client: EvaluationClient,
        formations: FormationSource[C],
        *,
        base_seed: str,
        phases: Sequence[EvaluationPhase],
        max_candidates: int = DEFAULT_MAX_CANDIDATES,
        max_total_runs: int = DEFAULT_MAX_TOTAL_RUNS,
        log_path: Path | None = None,
    ) -> None:
        self.validate_phases(phases)
        self._client = client
        self._formations = formations
        self._base_seed = base_seed
        self._phases = tuple(phases)
        self._max_candidates = max_candidates
        self._max_total_runs = max_total_runs
        self._log_path = log_path
        self._records: dict[tuple[str, str], CandidateRecord[C]] = {}
        self._consumed_runs = 0
        self._catalog_revision = ""
        self._enemy_formation = formations.enemy_formation()

    @staticmethod
    def validate_phases(phases: Sequence[EvaluationPhase]) -> None:
        used: list[EvaluationPhase] = []
        for phase in phases:
            for other in used:
                if phase.span.start < other.span.stop and other.span.start < phase.span.stop:
                    raise ValueError(
                        f"位相 {phase.name} と {other.name} の通し試行番号が重なる"
                        f"（{phase.span} と {other.span}）。最終選抜が探索と同じ乱数列を引く"
                    )
            used.append(phase)

    @property
    def consumed_runs(self) -> int:
        return self._consumed_runs

    @property
    def catalog_revision(self) -> str:
        return self._catalog_revision

    def evaluated_records(self, phase: EvaluationPhase) -> list[CandidateRecord[C]]:
        return [record for (name, _), record in self._records.items() if name == phase.name]

    def record_for(self, candidate: C, phase: EvaluationPhase) -> CandidateRecord[C] | None:
        return self._records.get((phase.name, candidate.canonical_key()))

    def adopt_record(self, phase: EvaluationPhase, record: CandidateRecord[C]) -> None:
        """保存済みの評価履歴を取り込む（中断からの再開）。

        取り込んだ試行はもう一度投げない。同じ候補を評価し直すと予算の消費が
        中断なしの実行とずれ、同じseedでも違う結果になる。
        """
        self._records[(phase.name, record.candidate.canonical_key())] = record

    def adopt_consumed_runs(self, consumed_runs: int) -> None:
        self._consumed_runs = consumed_runs

    def ensure(
        self,
        candidates: Sequence[C],
        target: int,
        *,
        phase: EvaluationPhase | None = None,
    ) -> list[CandidateRecord[C]]:
        """すべての候補を `target` 件まで評価して履歴を返す。

        すでに足りている候補は再評価しない。探索中の再評価はノイズ対策として割に合わず
        （同じ候補へ予算を二重に払う）、必要な精度は段を上げることで得る。
        """
        phase = phase or self._phases[0]
        if target not in phase.checkpoints:
            raise ValueError(
                f"試行数 {target} は位相 {phase.name} の評価スケジュール "
                f"{phase.checkpoints} に無い。段の途中で止めると候補ごとに"
                "seedの区切りがずれ、共通乱数法が崩れる"
            )

        records = self._records_for(candidates, phase)
        ladder = phase.ladder()
        for start, end in pairwise(ladder):
            if start >= target:
                break
            pending = [record for record in records if record.sample_count == start]
            if pending:
                self._run_segment(phase, pending, start=start, runs=end - start)
        return records

    def _records_for(
        self, candidates: Sequence[C], phase: EvaluationPhase
    ) -> list[CandidateRecord[C]]:
        """正準キーで同一視して履歴を引く。等価な編成へ二度予算を使わない。"""
        records: list[CandidateRecord[C]] = []
        seen: set[str] = set()
        for candidate in candidates:
            key = (phase.name, candidate.canonical_key())
            record = self._records.get(key)
            if record is None:
                record = CandidateRecord(candidate=candidate)
                self._records[key] = record
            if key[1] not in seen:
                seen.add(key[1])
                records.append(record)
        return records

    def _run_segment(
        self,
        phase: EvaluationPhase,
        records: Sequence[CandidateRecord[C]],
        *,
        start: int,
        runs: int,
    ) -> None:
        if runs > self._max_total_runs:
            raise ValueError(
                f"1候補あたり {runs} 試行は1リクエストの上限 {self._max_total_runs} を超える。"
                "devサーバーの EVALUATION_MAX_TOTAL_RUNS を上げるか、"
                "探索設定の stageRuns / finalStageRuns を下げる"
            )
        seed = f"{self._base_seed}#{phase.seed_offset + start}"
        per_request = max(1, min(self._max_candidates, self._max_total_runs // runs))
        for index in range(0, len(records), per_request):
            self._send(phase, records[index : index + per_request], seed=seed, runs=runs)

    def _send(
        self,
        phase: EvaluationPhase,
        batch: Sequence[CandidateRecord[C]],
        *,
        seed: str,
        runs: int,
    ) -> None:
        formations = [self._formations.ally_formation(record.candidate) for record in batch]
        response = self._client.evaluate(
            {
                "enemyFormation": self._enemy_formation,
                "candidates": [{"allyFormation": formation} for formation in formations],
                "runsPerCandidate": runs,
                "seed": seed,
            }
        )
        self._catalog_revision = response.catalog_revision
        rows: list[dict[str, Any]] = []
        # 応答の候補はリクエストと同じ順・同じ件数で返る（`10_API設計.md`）。
        for record, evaluation, formation in zip(
            batch, response.candidates, formations, strict=True
        ):
            record.unit_damage_totals.extend(_unit_damage_rows(evaluation, formation))
            for index in range(evaluation.completed_runs):
                record.scores.append(evaluation.scores[index])
                record.break_counts.append(evaluation.break_counts[index])
                record.completion_reasons.append(evaluation.completion_reasons[index])
                rows.append(
                    {
                        "phase": phase.name,
                        "canonical_key": record.candidate.canonical_key(),
                        "chunk_seed": seed,
                        "run_index_in_chunk": index,
                        "score": evaluation.scores[index],
                        "break_count": evaluation.break_counts[index],
                        "completed_turn": evaluation.completed_turns[index],
                        "completion_reason": evaluation.completion_reasons[index],
                    }
                )
            self._consumed_runs += evaluation.completed_runs
        self._append_log(rows)

    def _append_log(self, rows: Iterable[dict[str, Any]]) -> None:
        """全評価結果を追記する。探索後に横断分析できるのはこのファイルだけである。"""
        if self._log_path is None:
            return
        exists = self._log_path.exists()
        self._log_path.parent.mkdir(parents=True, exist_ok=True)
        with self._log_path.open("a", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(LOG_COLUMNS), lineterminator="\n")
            if not exists:
                writer.writeheader()
            writer.writerows(rows)
