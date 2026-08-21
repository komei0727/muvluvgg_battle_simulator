"""一括評価レスポンスのユニット別配列。編成順とユニットIDの対応を取り違えないこと。"""

import pytest

from exercise_lab.api import EvaluationResponse, LabApiError

UNITS = ("UNIT_A", "UNIT_B", "UNIT_C")


def response(**overrides):
    candidate = {
        "completedRuns": 2,
        "scores": [1000, 1100],
        "breakCounts": [3, 2],
        "completedTurns": [5, 5],
        "completionReasons": ["TURN_LIMIT_REACHED", "TURN_LIMIT_REACHED"],
        "allyUnitDamageTotals": [[500, 300, 200], [520, 340, 240]],
        "allyUnitBreakCounts": [[2, 1, 0], [1, 1, 0]],
    }
    candidate.update(overrides)
    # 値 None は「そのキーごと欠けた応答」を意味する。
    candidate = {key: value for key, value in candidate.items() if value is not None}
    return EvaluationResponse.model_validate(
        {
            "catalogRevision": "test-revision",
            "seed": "s#0",
            "runsPerCandidate": 2,
            "candidates": [candidate],
        }
    )


def test_unit_arrays_are_read_from_the_response():
    (evaluation,) = response().candidates

    assert evaluation.ally_unit_damage_totals == [[500, 300, 200], [520, 340, 240]]
    assert evaluation.ally_unit_break_counts == [[2, 1, 0], [1, 1, 0]]


def test_each_column_is_paired_with_the_unit_at_that_place_in_the_formation():
    """内側の並びはリクエストの `allyFormation.units` と同じ順（`10_API設計.md`）。"""
    (evaluation,) = response().candidates

    series = evaluation.ally_unit_series(UNITS)

    assert [entry.unit_definition_id for entry in series] == list(UNITS)
    assert [entry.formation_index for entry in series] == [0, 1, 2]
    assert series[1].damage_totals == (300, 340)
    assert series[1].break_counts == (1, 1)


def test_the_same_unit_in_two_places_keeps_two_separate_series():
    """同じユニットを2マスへ置ける（`allowDuplicateUnits`）。IDで畳むと片方が消える。"""
    (evaluation,) = response(
        allyUnitDamageTotals=[[500, 300, 200], [520, 340, 240]],
        allyUnitBreakCounts=[[2, 1, 0], [1, 1, 0]],
    ).candidates

    series = evaluation.ally_unit_series(("UNIT_A", "UNIT_A", "UNIT_C"))

    assert [entry.damage_totals for entry in series] == [(500, 520), (300, 340), (200, 240)]


def test_a_partial_result_pairs_only_the_completed_runs():
    """期限に達した候補は完了ぶんだけを返す（Q-TEX-18）。"""
    (evaluation,) = response(
        completedRuns=1,
        scores=[1000],
        breakCounts=[3],
        completedTurns=[5],
        completionReasons=["TURN_LIMIT_REACHED"],
        allyUnitDamageTotals=[[500, 300, 200]],
        allyUnitBreakCounts=[[2, 1, 0]],
    ).candidates

    series = evaluation.ally_unit_series(UNITS)

    assert [entry.damage_totals for entry in series] == [(500,), (300,), (200,)]


def test_a_candidate_that_completed_nothing_has_empty_series():
    (evaluation,) = response(
        completedRuns=0,
        scores=[],
        breakCounts=[],
        completedTurns=[],
        completionReasons=[],
        allyUnitDamageTotals=[],
        allyUnitBreakCounts=[],
    ).candidates

    assert [entry.damage_totals for entry in evaluation.ally_unit_series(UNITS)] == [(), (), ()]


def test_rows_that_do_not_match_the_completed_runs_are_rejected():
    (evaluation,) = response(allyUnitDamageTotals=[[500, 300, 200]]).candidates

    with pytest.raises(LabApiError, match="allyUnitDamageTotals"):
        evaluation.ally_unit_series(UNITS)


def test_columns_that_do_not_match_the_formation_are_rejected():
    (evaluation,) = response().candidates

    with pytest.raises(LabApiError, match="allyUnitDamageTotals"):
        evaluation.ally_unit_series(("UNIT_A", "UNIT_B"))


def test_a_response_without_the_unit_arrays_is_rejected_only_when_they_are_read():
    """ユニット別配列を読まない用途（`lab stats`）は、欠けていても動き続ける。"""
    evaluation = response(allyUnitDamageTotals=None, allyUnitBreakCounts=None).candidates[0]

    assert evaluation.scores == [1000, 1100]
    with pytest.raises(LabApiError, match="allyUnitDamageTotals"):
        evaluation.ally_unit_series(UNITS)
