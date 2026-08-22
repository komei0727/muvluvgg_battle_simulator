"""ギアランクの梯子。並びは補正値の昇順であり、種別・ランクの字面順ではない。"""

import pytest

from exercise_lab.api import Catalog
from exercise_lab.gear.allocation import GearPiece, GearRank
from exercise_lab.gear.ranks import EMPTY_LADDER, RankLadder, rank_ladder_from_catalog

# `R-ENH-04` #3 の表から、順序の違う2ステータスだけを取る。
ATTACK_POINTS = {
    ("II", "D"): 0.75,
    ("II", "C"): 1.18,
    ("II", "B"): 1.62,
    ("II", "A"): 2.06,
    ("II", "S"): 2.49,
    ("III", "D"): 1,
    ("III", "C"): 1.58,
    ("III", "B"): 2.16,
    ("III", "A"): 2.75,
    ("III", "S"): 3.33,
}
CRITICAL_RATE_POINTS = {
    ("II", "D"): 1.5,
    ("II", "C"): 2.62,
    ("II", "B"): 3.59,
    ("II", "A"): 4.49,
    ("II", "S"): 5.25,
    ("III", "D"): 2,
    ("III", "C"): 3.5,
    ("III", "B"): 4.8,
    ("III", "A"): 6,
    ("III", "S"): 7,
}


def catalog_document(**effects) -> dict:
    return {
        "catalogRevision": "rev",
        "units": [],
        "memories": [],
        "gearEffects": [
            {
                "stat": stat,
                "application": "RATIO",
                "values": [
                    {"tier": tier, "grade": grade, "percentagePoints": points}
                    for (tier, grade), points in table.items()
                ],
            }
            for stat, table in effects.items()
        ],
    }


def ladder(**effects) -> RankLadder:
    return rank_ladder_from_catalog(Catalog.model_validate(catalog_document(**effects)))


def test_the_ladder_is_ordered_by_the_correction_value_not_by_tier():
    rungs = ladder(ATTACK=ATTACK_POINTS).ranks("ATTACK")

    assert [rank.label for rank in rungs] == [
        "II-D",
        "III-D",
        "II-C",
        "III-C",
        "II-B",
        "II-A",
        "III-B",
        "II-S",
        "III-A",
        "III-S",
    ]


def test_the_smallest_step_crosses_the_tiers():
    built = ladder(ATTACK=ATTACK_POINTS)

    step = built.step_down(GearPiece(stat="ATTACK", tier="II", grade="B"))

    assert step is not None
    assert step.lower == GearRank(tier="III", grade="C")
    assert step.higher == GearRank(tier="II", grade="B")
    assert step.points_delta == pytest.approx(0.04)


def test_each_stat_keeps_its_own_order():
    built = ladder(ATTACK=ATTACK_POINTS, CRITICAL_RATE=CRITICAL_RATE_POINTS)

    # 攻撃力では Ⅲ-C の1つ上が Ⅱ-B、会心率では Ⅱ-B の1つ上が Ⅱ-A である。
    assert built.one_lower("ATTACK", GearRank(tier="II", grade="B")) == GearRank(
        tier="III", grade="C"
    )
    assert built.one_lower("CRITICAL_RATE", GearRank(tier="II", grade="B")) == GearRank(
        tier="III", grade="C"
    )
    assert built.one_lower("CRITICAL_RATE", GearRank(tier="II", grade="A")) == GearRank(
        tier="II", grade="B"
    )
    assert built.one_lower("ATTACK", GearRank(tier="II", grade="A")) == GearRank(
        tier="II", grade="B"
    )


def test_the_bottom_of_the_ladder_has_no_step_down():
    built = ladder(ATTACK=ATTACK_POINTS)

    assert built.one_lower("ATTACK", GearRank(tier="II", grade="D")) is None
    assert built.step_down(GearPiece(stat="ATTACK", tier="II", grade="D")) is None


def test_a_stat_the_catalog_does_not_carry_has_no_ladder():
    built = ladder(ATTACK=ATTACK_POINTS)

    assert built.ranks("AFFINITY_BONUS") == ()
    assert built.step_down(GearPiece(stat="AFFINITY_BONUS", tier="III", grade="S")) is None


def test_a_catalog_without_the_effect_table_yields_an_empty_ladder():
    built = ladder()

    assert built.is_empty()
    assert EMPTY_LADDER.is_empty()
    assert not ladder(ATTACK=ATTACK_POINTS).is_empty()


def attack_ladder() -> RankLadder:
    """攻撃力だけを持つ梯子。ランク微調整のテストが共有する。"""
    return ladder(ATTACK=ATTACK_POINTS)
