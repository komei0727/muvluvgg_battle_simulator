"""統計量。期待値は手計算した固定値で置き、実装の計算式を書き写さない。"""

import math

import pytest

from exercise_lab.stats import (
    break_count_distribution,
    defeat_rate,
    summarize_scores,
)

SCORES = [10, 20, 30, 40, 50]


def test_central_tendency_and_spread():
    summary = summarize_scores(SCORES)

    assert summary.count == 5
    assert summary.mean == 30.0
    assert summary.median == 30.0
    assert summary.minimum == 10
    assert summary.maximum == 50
    # 標本標準偏差（不偏、ddof=1）: sqrt(1000 / 4)
    assert summary.stdev == pytest.approx(math.sqrt(250.0))


def test_percentiles_use_linear_interpolation():
    summary = summarize_scores(SCORES)

    assert summary.p05 == pytest.approx(12.0)
    assert summary.p25 == pytest.approx(20.0)
    assert summary.p75 == pytest.approx(40.0)
    assert summary.p95 == pytest.approx(48.0)


def test_confidence_interval_of_the_mean_is_the_normal_approximation():
    summary = summarize_scores(SCORES)

    # 30 ± z(0.975) * sqrt(250) / sqrt(5) 、z(0.975) = 1.959963984540054
    assert summary.ci_low == pytest.approx(16.140961756503224)
    assert summary.ci_high == pytest.approx(43.859038243496776)


def test_single_run_has_no_spread_estimate():
    summary = summarize_scores([42])

    assert summary.count == 1
    assert summary.mean == 42.0
    assert summary.stdev is None
    assert summary.ci_low is None
    assert summary.ci_high is None


def test_empty_scores_are_rejected():
    with pytest.raises(ValueError, match="1件以上"):
        summarize_scores([])


def test_defeat_rate_counts_ally_defeated_only():
    reasons = ["ALLY_DEFEATED", "TURN_LIMIT_REACHED", "ALLY_DEFEATED", "TURN_LIMIT_REACHED"]

    assert defeat_rate(reasons) == pytest.approx(0.5)


def test_break_count_distribution_is_ordered_by_break_count():
    distribution = break_count_distribution([3, 1, 3, 2, 3])

    assert list(distribution.items()) == [(1, 1), (2, 1), (3, 3)]
