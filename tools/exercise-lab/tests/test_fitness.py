"""適応度（経験CVaRとmean-CVaR複合）。期待値は手計算した固定値で置く。"""

import pytest

from exercise_lab.optimize.fitness import (
    MIN_RELIABLE_TAIL_SAMPLES,
    RiskPolicy,
    cvar,
    cvar_is_reliable,
    tail_size,
)

SCORES = [50, 10, 40, 20, 30]


def test_cvar_averages_the_worst_ceil_alpha_n_scores():
    # n=5・alpha=0.4 → k=2 、下位2件は 10 と 20
    assert cvar(SCORES, alpha=0.4) == pytest.approx(15.0)


def test_cvar_rounds_the_tail_size_up():
    # ceil(0.21 * 5) = 2 。境界をまたぐと下位2件へ増える
    assert tail_size(5, alpha=0.2) == 1
    assert tail_size(5, alpha=0.21) == 2
    assert cvar(SCORES, alpha=0.2) == pytest.approx(10.0)
    assert cvar(SCORES, alpha=0.21) == pytest.approx(15.0)


def test_cvar_keeps_at_least_one_sample_in_the_tail():
    # ceil(0.01 * 5) = 1 。alphaをいくら小さくしても最悪値そのものへ縮むだけで、0件にはならない
    assert tail_size(5, alpha=0.01) == 1
    assert cvar(SCORES, alpha=0.01) == pytest.approx(10.0)


def test_cvar_at_alpha_one_is_the_mean():
    assert cvar(SCORES, alpha=1.0) == pytest.approx(30.0)


def test_cvar_does_not_depend_on_input_order():
    assert cvar([30, 10, 20], alpha=0.7) == pytest.approx(cvar([20, 30, 10], alpha=0.7))


def test_cvar_rejects_an_empty_sample():
    with pytest.raises(ValueError, match="1件以上"):
        cvar([], alpha=0.2)


@pytest.mark.parametrize("alpha", [0.0, -0.1, 1.1])
def test_cvar_rejects_an_alpha_outside_the_unit_interval(alpha):
    with pytest.raises(ValueError, match="alpha"):
        cvar(SCORES, alpha=alpha)


def test_fitness_mixes_the_mean_and_the_cvar():
    policy = RiskPolicy(alpha=0.4, mean_weight=0.5)

    # 0.5 * 30（平均） + 0.5 * 15（CVaR_0.4）
    assert policy.fitness(SCORES) == pytest.approx(22.5)


def test_fitness_at_mean_weight_one_ignores_the_tail():
    assert RiskPolicy(alpha=0.4, mean_weight=1.0).fitness(SCORES) == pytest.approx(30.0)


def test_fitness_at_mean_weight_zero_is_the_cvar():
    assert RiskPolicy(alpha=0.4, mean_weight=0.0).fitness(SCORES) == pytest.approx(15.0)


def test_fitness_penalises_a_candidate_whose_tail_collapses():
    """平均が同じでも、稀に大きく崩れる側の適応度が下がる。下振れペナルティの核。"""
    steady = [30, 30, 30, 30, 30]
    volatile = [50, 40, 30, 30, 0]
    policy = RiskPolicy(alpha=0.2, mean_weight=0.5)

    assert sum(steady) == sum(volatile)
    assert policy.fitness(volatile) < policy.fitness(steady)


def test_mean_statistic_ignores_the_tail_entirely():
    """第1段（実効サンプル不足）で使う統計量。CVaRを混ぜない。"""
    policy = RiskPolicy(alpha=0.2, mean_weight=0.5)

    assert policy.mean(SCORES) == pytest.approx(30.0)


def test_risk_policy_rejects_a_mean_weight_outside_the_unit_interval():
    with pytest.raises(ValueError, match="mean_weight"):
        RiskPolicy(alpha=0.2, mean_weight=1.5)


def test_cvar_is_reliable_only_once_the_tail_holds_enough_samples():
    """実効サンプル数は n ではなく αn 。この境界が評価スケジュールの根拠になる。"""
    assert MIN_RELIABLE_TAIL_SAMPLES == 10
    assert not cvar_is_reliable(24, alpha=0.2)  # tail=5
    assert cvar_is_reliable(50, alpha=0.2)  # tail=10
    assert cvar_is_reliable(72, alpha=0.2)  # tail=15
