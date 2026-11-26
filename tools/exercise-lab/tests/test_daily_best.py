"""日次ベスト指標（期待日次ベストと日次ベスト分位点）。期待値は手計算した固定値で置く。"""

import pytest

from exercise_lab.statistics.daily_best import (
    MIN_RELIABLE_EFFECTIVE_SAMPLES,
    best_quantile,
    effective_samples,
    expected_best,
    is_reliable,
)

SCORES = [50, 10, 40, 20, 30]


def test_expected_best_weights_the_order_statistics():
    # n=5・k=2 。C(i-1,1)/C(5,2) = (i-1)/10 が昇順 i 番目の重み:
    # (0·10 + 1·20 + 2·30 + 3·40 + 4·50) / 10 = 40
    assert expected_best(SCORES, best_of=2) == pytest.approx(40.0)


def test_expected_best_with_another_hand_computed_case():
    # n=4・k=3 。重みは C(2,2)=1（20へ）と C(3,2)=3（30へ）、分母 C(4,3)=4
    assert expected_best([0, 10, 20, 30], best_of=3) == pytest.approx(27.5)


def test_expected_best_of_one_is_the_mean():
    assert expected_best(SCORES, best_of=1) == pytest.approx(30.0)


def test_expected_best_of_the_whole_sample_is_the_maximum():
    assert expected_best(SCORES, best_of=5) == pytest.approx(50.0)


def test_expected_best_does_not_depend_on_input_order():
    assert expected_best([30, 10, 20], best_of=2) == pytest.approx(
        expected_best([20, 30, 10], best_of=2)
    )


def test_expected_best_falls_back_to_the_maximum_when_the_sample_is_short():
    """部分結果で n < k になっても落とさない。最大値は低めに偏るが表示の入力としては壊れない。"""
    assert expected_best([10, 20], best_of=5) == pytest.approx(20.0)


def test_expected_best_rejects_an_empty_sample():
    with pytest.raises(ValueError, match="1件以上"):
        expected_best([], best_of=5)


def test_expected_best_rejects_a_non_positive_best_of():
    with pytest.raises(ValueError, match="best_of"):
        expected_best(SCORES, best_of=0)


def test_best_quantile_maps_to_a_run_quantile_in_closed_form():
    """P(日次ベスト ≤ x) = F(x)^k なので、日次ベストの q 分位点 = 1試行の q^(1/k) 分位点。

    q = 0.5^5 なら 1試行分布の中央値そのものになる（0.5^5 ^ (1/5) = 0.5）。
    """
    assert best_quantile(SCORES, best_of=5, quantile=0.5**5) == pytest.approx(30.0)
    assert best_quantile(SCORES, best_of=5, quantile=0.75**5) == pytest.approx(40.0)


def test_best_quantile_of_one_attempt_is_the_plain_quantile():
    assert best_quantile(SCORES, best_of=1, quantile=0.5) == pytest.approx(30.0)


@pytest.mark.parametrize("quantile", [0.0, 1.0, -0.1])
def test_best_quantile_rejects_a_quantile_outside_the_open_interval(quantile):
    with pytest.raises(ValueError, match="quantile"):
        best_quantile(SCORES, best_of=5, quantile=quantile)


def test_upside_variance_raises_the_expected_best():
    """平均が同じなら、上振れのある方が日次ベストは高い。"""
    steady = [30, 30, 30, 30, 30]
    spread = [10, 20, 30, 40, 50]

    assert sum(steady) == sum(spread)
    assert expected_best(spread, best_of=2) > expected_best(steady, best_of=2)


def test_median_best_is_the_run_p87_for_five_attempts():
    """日次ベストの中央値 = 1試行分布の 0.5^(1/5) ≈ p87 。"""
    scores = list(range(1, 101))

    assert best_quantile(scores, best_of=5, quantile=0.5) == pytest.approx(
        1 + 99 * (0.5 ** (1 / 5))
    )


def test_effective_samples_shrink_because_the_weights_concentrate_on_top():
    """実効サンプル数 ≈ n(2k-1)/k² 。k=5 なら n の36%しか効かない。"""
    assert effective_samples(100, best_of=5) == pytest.approx(36.0)
    assert effective_samples(100, best_of=1) == pytest.approx(100.0)


def test_reliability_gates_on_the_effective_samples():
    assert MIN_RELIABLE_EFFECTIVE_SAMPLES == 10

    assert not is_reliable(24, best_of=5)  # ESS ≈ 8.6
    assert is_reliable(28, best_of=5)  # ESS ≈ 10.1
    assert is_reliable(100, best_of=5)
