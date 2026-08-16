"""最適化レポート。上位編成の統計と、UIへ入力できる編成表。"""

import pytest

from exercise_lab.api import Catalog
from exercise_lab.optimize.candidate import Candidate, Cell, Placement
from exercise_lab.optimize.evaluator import CandidateRecord
from exercise_lab.optimize.fitness import Objective
from exercise_lab.optimize.racing import RacedCandidate
from exercise_lab.optimize.report import (
    build_optimization_summary,
    formation_rows,
    write_best_so_far_chart,
)
from exercise_lab.optimize.search_config import load_search_config
from exercise_lab.player_data import load_player_data
from helpers import search_config_document, write_yaml

POLICY = Objective(best_of=5, expected_weight=0.5)

CATALOG = Catalog.model_validate(
    {
        "catalogRevision": "2026-08-01.1",
        "units": [
            {
                "unitDefinitionId": "UNIT_A",
                "displayName": "【反逆者】コトハ",
                "category": "PLAYABLE",
                "role": "PHYSICAL_ATTACKER",
                "positionAptitudes": ["FRONT"],
            },
            {
                "unitDefinitionId": "UNIT_B",
                "displayName": "【企業家】レイラ",
                "category": "PLAYABLE",
                "role": "SUPPORT",
                "positionAptitudes": ["BACK"],
            },
            {
                "unitDefinitionId": "UNIT_ENEMY",
                "displayName": "【敵】アニス",
                "category": "EXERCISE_ENEMY",
            },
        ],
        "memories": [
            {"memoryDefinitionId": "MEM_1", "displayName": "心の色"},
            {"memoryDefinitionId": "MEM_2", "displayName": "絶対命令"},
        ],
    }
)


def raced(scores: list[int], *, units=("UNIT_A", "UNIT_B"), memories=("MEM_2", "MEM_1")):
    candidate = Candidate(
        placements=(
            Placement(units[0], Cell(column=0, row="FRONT")),
            Placement(units[1], Cell(column=2, row="REAR")),
        ),
        memory_definition_ids=memories,
    )
    record = CandidateRecord(
        candidate=candidate,
        scores=list(scores),
        break_counts=[3] * len(scores),
        completion_reasons=["TURN_LIMIT_REACHED"] * len(scores),
    )
    return RacedCandidate(
        candidate=candidate,
        record=record,
        sample_count=len(scores),
        mean=POLICY.mean(scores),
        median=POLICY.median(scores),
        expected_best=POLICY.expected_best(scores),
        guard=POLICY.guard(scores),
        fitness=POLICY.fitness(scores),
        defeat_rate=0.25,
    )


@pytest.fixture
def config(tmp_path):
    return load_search_config(write_yaml(tmp_path, search_config_document()))


def test_summary_reports_the_statistics_of_every_top_formation(config):
    entry = raced([100] * 80 + [200] * 20)

    summary = build_optimization_summary(
        [entry],
        config=config,
        catalog=CATALOG,
        algorithm="local-search",
        seed="abc",
        budget_runs=5000,
        consumed_runs=4200,
        stopped_because="patience",
        history=(),
        catalog_revision="2026-08-01.1",
    )

    (formation,) = summary["topFormations"]
    assert formation["rank"] == 1
    assert formation["sampleCount"] == 100
    assert formation["mean"] == pytest.approx(120.0)
    # 5本引いて少なくとも1本200を引く確率は 1 − C(80,5)/C(100,5) ≈ 0.6807
    assert formation["expectedBest"] == pytest.approx(168.07, abs=0.01)
    # 日次ベストの中央値 = 1試行分布の p87 。上位20%が200なので200へ届く
    assert formation["medianBest"] == pytest.approx(200.0)
    # 25%保証値 = 1試行分布の p75.8 。200の層（上位20%）にわずかに届かない
    assert formation["guaranteedBest"] == pytest.approx(100.0)
    assert formation["mean"] < formation["fitness"] <= formation["maximum"]
    assert formation["defeatRate"] == pytest.approx(0.25)
    assert formation["ci95Low"] < formation["mean"] < formation["ci95High"]


def test_summary_records_the_objective_settings_the_numbers_depend_on(config):
    summary = build_optimization_summary(
        [raced([100] * 50)],
        config=config,
        catalog=CATALOG,
        algorithm="local-search",
        seed="abc",
        budget_runs=5000,
        consumed_runs=4200,
        stopped_because="budget",
        history=(),
        catalog_revision="2026-08-01.1",
    )

    assert summary["objective"] == {
        "bestOf": 5,
        "lambda": 0.5,
        "guardQuantile": 0.25,
        "effectiveSamples": 18.0,
    }
    assert summary["seed"] == "abc"
    assert summary["algorithm"] == "local-search"
    assert summary["consumedRuns"] == 4200
    assert summary["stoppedBecause"] == "budget"


def test_summary_warns_when_the_effective_samples_are_too_thin_to_report(config):
    """実効サンプル10未満の期待日次ベストは報告値として弱い。黙って数字だけ出さない。

    n=20 だと実効サンプルは 20·9/25 = 7.2 しかない。
    """
    summary = build_optimization_summary(
        [raced([100] * 20)],
        config=config,
        catalog=CATALOG,
        algorithm="local-search",
        seed="abc",
        budget_runs=5000,
        consumed_runs=400,
        stopped_because="budget",
        history=(),
        catalog_revision="2026-08-01.1",
    )

    assert any("実効サンプル" in warning for warning in summary["warnings"])


def test_formation_rows_name_the_units_and_cells_for_the_ui(config):
    rows = formation_rows(raced([100] * 50), config=config, catalog=CATALOG)

    assert rows["units"] == [
        {
            "unitDefinitionId": "UNIT_A",
            "displayName": "【反逆者】コトハ",
            "column": 0,
            "row": "FRONT",
            "level": None,
            "gears": [],
        },
        {
            "unitDefinitionId": "UNIT_B",
            "displayName": "【企業家】レイラ",
            "column": 2,
            "row": "REAR",
            "level": None,
            "gears": [],
        },
    ]


def test_formation_rows_keep_the_memory_order(config):
    rows = formation_rows(raced([100] * 50), config=config, catalog=CATALOG)

    assert rows["memories"] == [
        {"order": 1, "memoryDefinitionId": "MEM_2", "displayName": "絶対命令"},
        {"order": 2, "memoryDefinitionId": "MEM_1", "displayName": "心の色"},
    ]


def test_formation_rows_show_the_enhancement_that_was_applied(tmp_path):
    player_data = tmp_path / "player-data.json"
    player_data.write_text(
        '{"schemaVersion":1,"academyLevels":{"unitTypes":{},"attributes":{}},'
        '"units":{"UNIT_A":{"level":275,"gears":['
        '{"stat":"ATTACK","tier":"III","grade":"S"},null]}}}',
        encoding="utf-8",
    )
    from exercise_lab.optimize.search_config import resolve_unit_enhancements

    config = load_search_config(write_yaml(tmp_path, search_config_document()))
    config, _ = resolve_unit_enhancements(config, load_player_data(player_data))

    rows = formation_rows(raced([100] * 50), config=config, catalog=CATALOG)

    assert rows["units"][0]["level"] == 275
    assert rows["units"][0]["gears"] == ["ATTACK III S"]


def test_an_unknown_id_falls_back_to_the_id_itself(config):
    rows = formation_rows(
        raced([100] * 50, units=("UNIT_A", "UNIT_GONE"), memories=("MEM_GONE",)),
        config=config,
        catalog=CATALOG,
    )

    assert rows["units"][1]["displayName"] == "UNIT_GONE"
    assert rows["memories"][0]["displayName"] == "MEM_GONE"


def test_the_best_so_far_chart_is_written(tmp_path):
    from exercise_lab.optimize.algorithms import GenerationReport

    path = tmp_path / "best-so-far.png"

    write_best_so_far_chart(
        [
            GenerationReport(generation=1, consumed_runs=100, best_fitness=10.0),
            GenerationReport(generation=2, consumed_runs=240, best_fitness=14.0),
        ],
        path,
        title="test",
    )

    assert path.exists()
    assert path.stat().st_size > 0


def test_an_empty_history_still_produces_a_chart(tmp_path):
    path = tmp_path / "best-so-far.png"

    write_best_so_far_chart([], path, title="test")

    assert path.exists()
