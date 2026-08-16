"""一括評価器。共通乱数・増量評価・キャッシュ・分割送信・部分結果。"""

import csv

import pytest

from exercise_lab.api import EvaluationResponse
from exercise_lab.optimize.candidate import Candidate, Cell, Placement
from exercise_lab.optimize.evaluator import (
    FINAL_PHASE,
    SEARCH_PHASE,
    EvaluationPhase,
    Evaluator,
    common_sample_count,
)
from exercise_lab.optimize.search_config import load_search_config
from helpers import search_config_document, write_yaml


class FakeClient:
    """`POST /api/v1/tactical-exercise-evaluations` の代わり。

    スコアは (seed, runIndex) だけで決まるノイズと、編成だけで決まる実力の和にする。
    サーバーが乱数列を `runIndex` だけから導く（候補indexを混ぜない）性質を写している。
    """

    def __init__(self, *, completed_runs=None):
        self.requests: list[dict] = []
        self._completed_runs = completed_runs

    def evaluate(self, body: dict) -> EvaluationResponse:
        self.requests.append(body)
        requested = body["runsPerCandidate"]
        completed = requested if self._completed_runs is None else self._completed_runs(body)
        return EvaluationResponse.model_validate(
            {
                "catalogRevision": "test-revision",
                "seed": body["seed"],
                "runsPerCandidate": requested,
                "candidates": [
                    _candidate_response(candidate, body["seed"], completed)
                    for candidate in body["candidates"]
                ],
            }
        )


def _candidate_response(candidate: dict, seed: str, completed: int) -> dict:
    strength = 1000 * len(candidate["allyFormation"]["units"])
    scores = [strength + _noise(seed, index) for index in range(completed)]
    return {
        "completedRuns": completed,
        "scores": scores,
        "breakCounts": [index % 4 for index in range(completed)],
        "completedTurns": [5] * completed,
        "completionReasons": ["TURN_LIMIT_REACHED"] * completed,
    }


def _noise(seed: str, run_index: int) -> int:
    return (hash((seed, run_index)) % 1000) - 500


UNITS = ("UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F")


def make_candidate(*unit_ids: str) -> Candidate:
    return Candidate(
        placements=tuple(
            Placement(unit_id, Cell(column=index % 3, row="FRONT" if index < 3 else "REAR"))
            for index, unit_id in enumerate(unit_ids)
        ),
        memory_definition_ids=(),
    )


@pytest.fixture
def config(tmp_path):
    return load_search_config(write_yaml(tmp_path, search_config_document()))


def make_evaluator(config, client, **overrides):
    defaults = {"base_seed": "s", "phases": (SEARCH_PHASE, FINAL_PHASE)}
    return Evaluator(client, config, **{**defaults, **overrides})


def test_ensure_brings_every_candidate_up_to_the_target(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    records = evaluator.ensure([make_candidate("UNIT_A"), make_candidate("UNIT_B")], 8)

    assert [len(record.scores) for record in records] == [8, 8]


def test_every_candidate_in_a_round_shares_the_same_seeds(config):
    """共通乱数法。候補が違っても同じ乱数列で比べる。

    サーバーは1リクエストの中で `runIndex` を0から振り直し、乱数列を `(seed, runIndex)`
    だけで決める。分割送信しても送信seedと試行数が同じなら同じ試行が回る。
    """
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    evaluator.ensure([make_candidate(unit) for unit in UNITS], 8)

    seeds = {(request["seed"], request["runsPerCandidate"]) for request in client.requests}
    assert seeds == {("s#0", 8)}


def test_raising_the_target_only_requests_the_missing_runs(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)
    candidates = [make_candidate("UNIT_A")]

    evaluator.ensure(candidates, 8)
    records = evaluator.ensure(candidates, 24)

    assert len(records[0].scores) == 24
    assert [(request["seed"], request["runsPerCandidate"]) for request in client.requests] == [
        ("s#0", 8),
        ("s#8", 16),
    ]


def test_a_candidate_that_skips_a_stage_still_walks_the_same_seed_ladder(config):
    """段を飛ばした候補にも同じ区切りでseedを割り当てる。

    区切りを候補ごとに変えると、同じ試行番号の乱数列が候補間でずれ、共通乱数法が崩れる。
    """
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    evaluator.ensure([make_candidate("UNIT_A")], 72)

    assert [(request["seed"], request["runsPerCandidate"]) for request in client.requests] == [
        ("s#0", 8),
        ("s#8", 16),
        ("s#24", 48),
    ]


def test_an_already_evaluated_candidate_is_not_requested_again(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    evaluator.ensure([make_candidate("UNIT_A")], 8)
    before = len(client.requests)
    records = evaluator.ensure([make_candidate("UNIT_A")], 8)

    assert len(client.requests) == before
    assert len(records[0].scores) == 8


def test_equivalent_formations_share_one_evaluation(config):
    """ユニットの列挙順だけが違う編成へ二重に予算を使わない。"""
    client = FakeClient()
    evaluator = make_evaluator(config, client)
    one_way = make_candidate("UNIT_A", "UNIT_B")
    reordered = Candidate(tuple(reversed(one_way.placements)), ())

    evaluator.ensure([one_way], 8)
    before = len(client.requests)
    evaluator.ensure([reordered], 8)

    assert len(client.requests) == before


def test_a_different_memory_order_is_the_same_formation(config):
    """メモリーの並びはスコアを変えないので、並べ替えへ予算を払わない。"""
    client = FakeClient()
    evaluator = make_evaluator(config, client)
    placements = make_candidate("UNIT_A").placements

    evaluator.ensure([Candidate(placements, ("MEM_1", "MEM_2"))], 8)
    before = len(client.requests)
    evaluator.ensure([Candidate(placements, ("MEM_2", "MEM_1"))], 8)

    assert len(client.requests) == before


def test_requests_are_split_by_the_candidate_limit(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client, max_candidates=2, max_total_runs=300)

    evaluator.ensure([make_candidate(unit) for unit in UNITS], 8)

    assert [len(request["candidates"]) for request in client.requests] == [2, 2, 2]


def test_requests_are_split_by_the_total_run_limit(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client, max_candidates=32, max_total_runs=16)

    evaluator.ensure([make_candidate(unit) for unit in UNITS], 8)

    # 1リクエストは 16 / 8 = 2 候補まで
    assert [len(request["candidates"]) for request in client.requests] == [2, 2, 2]


def test_a_stage_larger_than_the_server_limit_is_rejected_with_the_knob_to_turn(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client, max_total_runs=4)

    with pytest.raises(ValueError, match="EVALUATION_MAX_TOTAL_RUNS"):
        evaluator.ensure([make_candidate("UNIT_A")], 8)


def test_the_final_phase_uses_seeds_the_search_never_touched(config):
    """最終選抜は探索で使っていないseed範囲で回す（探索中seedへの過適合を排除する）。"""
    client = FakeClient()
    evaluator = make_evaluator(config, client)
    candidate = make_candidate("UNIT_A")

    evaluator.ensure([candidate], 72)
    search_seeds = {request["seed"] for request in client.requests}
    evaluator.ensure([candidate], 100, phase=FINAL_PHASE)
    final_seeds = {request["seed"] for request in client.requests} - search_seeds

    assert final_seeds == {"s#72", "s#122"}


def test_the_final_phase_keeps_its_own_samples(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)
    candidate = make_candidate("UNIT_A")

    evaluator.ensure([candidate], 72)
    (record,) = evaluator.ensure([candidate], 50, phase=FINAL_PHASE)

    assert len(record.scores) == 50


def test_partial_results_are_recorded_without_being_re_requested(config):
    client = FakeClient(completed_runs=lambda body: body["runsPerCandidate"] - 3)
    evaluator = make_evaluator(config, client)

    records = evaluator.ensure([make_candidate("UNIT_A")], 8)

    assert len(records[0].scores) == 5
    assert len(client.requests) == 1


def test_common_sample_count_is_the_shortest_history_in_the_group(config):
    """CVaRの比較は同じ試行数どうしでしか成り立たない（小標本の下方バイアスのため）。"""
    responses = iter([5, 8])
    client = FakeClient(completed_runs=lambda body: next(responses))
    evaluator = make_evaluator(config, client, max_candidates=1)

    records = evaluator.ensure([make_candidate("UNIT_A"), make_candidate("UNIT_B")], 8)

    assert common_sample_count(records) == 5


def test_consumed_runs_counts_completed_simulations(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    evaluator.ensure([make_candidate("UNIT_A"), make_candidate("UNIT_B")], 8)

    assert evaluator.consumed_runs == 16


def test_every_evaluation_is_appended_to_the_log(config, tmp_path):
    log_path = tmp_path / "evaluations.csv"
    client = FakeClient()
    evaluator = make_evaluator(config, client, log_path=log_path)

    evaluator.ensure([make_candidate("UNIT_A")], 8)
    evaluator.ensure([make_candidate("UNIT_A")], 24)

    rows = list(csv.DictReader(log_path.read_text(encoding="utf-8").splitlines()))
    assert len(rows) == 24
    assert rows[0]["phase"] == "search"
    assert rows[0]["chunk_seed"] == "s#0"
    assert rows[8]["chunk_seed"] == "s#8"
    assert rows[0]["canonical_key"] == make_candidate("UNIT_A").canonical_key()


def test_a_target_off_the_checkpoint_ladder_is_rejected(config):
    client = FakeClient()
    evaluator = make_evaluator(config, client)

    with pytest.raises(ValueError, match="評価スケジュール"):
        evaluator.ensure([make_candidate("UNIT_A")], 9)


def test_phases_reject_overlapping_seed_ranges():
    with pytest.raises(ValueError, match="重なる"):
        Evaluator.validate_phases(
            (
                EvaluationPhase(name="search", checkpoints=(8, 72), seed_offset=0),
                EvaluationPhase(name="final", checkpoints=(50,), seed_offset=8),
            )
        )
