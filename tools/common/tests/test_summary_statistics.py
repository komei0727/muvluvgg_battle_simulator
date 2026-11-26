"""保存結果の確認に使う記述統計。UIの参照実装（numpy）と同じ分位点の定義になる。"""

import pytest

from mlgg_lab_common.statistics.descriptive import summarize_scores
from mlgg_lab_common.statistics.summary import category_counts, frequency, numeric_summary


def test_numeric_summary_matches_the_ui_reference_definition():
    scores = [120, 5, 77, 77, 300, 41, 9, 210, 64]
    mine = numeric_summary(scores)
    reference = summarize_scores(scores)

    assert mine.count == reference.count == 9
    for field in ("mean", "median", "stdev", "p05", "p25", "p75", "p95"):
        assert getattr(mine, field) == pytest.approx(getattr(reference, field)), field
    assert (mine.minimum, mine.maximum) == (5, 300)


def test_a_single_sample_has_no_stdev_and_empty_samples_are_rejected():
    single = numeric_summary([42])

    assert single.stdev is None
    assert single.p05 == single.p95 == single.median == 42
    with pytest.raises(ValueError):
        numeric_summary([])
    with pytest.raises(ValueError):
        category_counts([])
    with pytest.raises(ValueError):
        frequency([])


def test_category_counts_keep_listed_categories_even_when_absent():
    counts = category_counts(["ALLY_WIN", "DRAW", "ALLY_WIN", "OTHER"], ["ALLY_WIN", "ALLY_LOSE"])

    assert list(counts) == ["ALLY_WIN", "ALLY_LOSE", "DRAW", "OTHER"]
    assert counts["ALLY_WIN"] == {"count": 2, "ratio": 0.5}
    assert counts["ALLY_LOSE"] == {"count": 0, "ratio": 0.0}


def test_frequency_is_sorted_by_value():
    assert frequency([3, 1, 3, 2]) == [
        {"value": 1, "count": 1, "ratio": 0.25},
        {"value": 2, "count": 1, "ratio": 0.25},
        {"value": 3, "count": 2, "ratio": 0.5},
    ]
