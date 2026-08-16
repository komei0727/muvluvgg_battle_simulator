"""`lab optimize` の入出力。モックサーバー越しに再現性と事前検証を固定する。"""

import json

import httpx
import respx
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH, EVALUATION_PATH
from exercise_lab.cli import app
from helpers import ArenaClient, search_config_document, write_yaml

BASE_URL = "http://localhost:3000"

CATALOG = {
    "schemaVersion": 1,
    "catalogRevision": "2026-08-01.1",
    "units": [
        *(
            {
                "unitDefinitionId": f"UNIT_{letter}",
                "displayName": f"味方{letter}",
                "characterName": f"{letter}",
                "category": "PLAYABLE",
                "attribute": "SHY" if letter in "ABCD" else "CUTE",
                "unitType": "PHYSICAL",
                "role": "PHYSICAL_ATTACKER",
                "positionAptitudes": ["FRONT", "BACK"],
            }
            for letter in "ABCDEFGH"
        ),
        {
            "unitDefinitionId": "UNIT_ENEMY",
            "displayName": "敵アニス",
            "characterName": "アニス",
            "category": "EXERCISE_ENEMY",
            "attribute": "SHY",
            "unitType": "PHYSICAL",
            "role": "PHYSICAL_ATTACKER",
            "positionAptitudes": ["BACK"],
        },
    ],
    "memories": [
        {"memoryDefinitionId": f"MEM_{index}", "displayName": f"記憶{index}"}
        for index in range(1, 9)
    ],
    "gearEffects": [],
}

SCHEDULE = {
    "populationSize": 8,
    "stageRuns": [4, 12],
    "finalPoolSize": 4,
    "finalStageRuns": [50],
    "topK": 3,
    "patience": 2,
}

runner = CliRunner()


def mock_api(catalog=None):
    # 実サーバーは両エンドポイントで同じrevisionを返す。レポートは評価応答側を採る。
    arena = ArenaClient(catalog_revision=(catalog or CATALOG)["catalogRevision"])
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(
        return_value=httpx.Response(200, json=catalog or CATALOG)
    )

    def evaluate(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        response = arena.evaluate(body)
        return httpx.Response(
            200, json=json.loads(response.model_dump_json(by_alias=True, exclude_none=True))
        )

    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(side_effect=evaluate)
    return arena


def config_path(tmp_path, **overrides):
    return write_yaml(tmp_path, search_config_document(schedule=SCHEDULE, **overrides))


def run(tmp_path, out, *extra):
    return runner.invoke(
        app,
        [
            "optimize",
            str(config_path(tmp_path)),
            "--budget",
            "2000",
            "--seed",
            "abc",
            "--out",
            str(out),
            *extra,
        ],
    )


@respx.mock
def test_optimize_writes_the_full_report_set(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "best-so-far.png",
        "evaluations.csv",
        "optimization.json",
        "state.json",
    ]


@respx.mock
def test_the_summary_lists_the_requested_number_of_formations(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    summary = json.loads((out / "optimization.json").read_text(encoding="utf-8"))
    assert len(summary["topFormations"]) == 3
    assert summary["seed"] == "abc"
    assert summary["algorithm"] == "local-search"
    assert summary["catalogRevision"] == "2026-08-01.1"


@respx.mock
def test_the_same_seed_reproduces_identical_numbers(tmp_path):
    mock_api()
    first_out = tmp_path / "first"
    second_out = tmp_path / "second"

    run(tmp_path, first_out)
    run(tmp_path, second_out)

    first = json.loads((first_out / "optimization.json").read_text(encoding="utf-8"))
    second = json.loads((second_out / "optimization.json").read_text(encoding="utf-8"))
    assert first["topFormations"] == second["topFormations"]
    assert first["consumedRuns"] == second["consumedRuns"]


@respx.mock
def test_the_console_shows_the_top_formations(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports")

    assert "味方" in result.output
    assert "記憶" in result.output


@respx.mock
def test_a_unit_pool_entry_outside_the_playable_pool_stops_before_any_evaluation(tmp_path):
    catalog = json.loads(json.dumps(CATALOG))
    catalog["units"][0]["category"] = "EXERCISE_ENEMY"
    mock_api(catalog)
    route = respx.post(f"{BASE_URL}{EVALUATION_PATH}")

    result = run(tmp_path, tmp_path / "reports")

    assert result.exit_code == 1
    assert "R-TEX-11" in result.output
    assert route.call_count == 0


@respx.mock
def test_an_unknown_memory_in_the_pool_is_reported_with_the_search_command(tmp_path):
    catalog = json.loads(json.dumps(CATALOG))
    catalog["memories"] = catalog["memories"][:2]
    mock_api(catalog)

    result = run(tmp_path, tmp_path / "reports")

    assert result.exit_code == 1
    assert "lab memories" in result.output


@respx.mock
def test_an_unreachable_server_is_reported_without_a_traceback(tmp_path):
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(side_effect=httpx.ConnectError("refused"))

    result = run(tmp_path, tmp_path / "reports")

    assert result.exit_code == 1
    # 長いメッセージは端末幅で折り返るので、途中で切れない語だけで照合する
    assert "APIへ到達できない" in result.output
    assert result.exception is None or isinstance(result.exception, SystemExit)


@respx.mock
def test_a_budget_below_the_final_selection_cost_is_reported_as_an_explained_error(tmp_path):
    mock_api()

    result = runner.invoke(
        app,
        [
            "optimize",
            str(config_path(tmp_path)),
            "--budget",
            "10",
            "--seed",
            "abc",
            "--out",
            str(tmp_path / "reports"),
        ],
    )

    assert result.exit_code == 1
    assert "最終選抜" in result.output


@respx.mock
def test_resume_continues_from_the_saved_state(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)
    consumed = json.loads((out / "optimization.json").read_text(encoding="utf-8"))["consumedRuns"]

    result = run(tmp_path, out, "--resume", "--budget", "4000")

    assert result.exit_code == 0, result.output
    resumed = json.loads((out / "optimization.json").read_text(encoding="utf-8"))
    assert resumed["consumedRuns"] >= consumed


@respx.mock
def test_the_algorithm_can_be_switched_for_the_comparison(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out, "--algorithm", "random")

    assert result.exit_code == 0, result.output
    summary = json.loads((out / "optimization.json").read_text(encoding="utf-8"))
    assert summary["algorithm"] == "random"


@respx.mock
def test_an_unknown_algorithm_is_rejected_with_the_available_names(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports", "--algorithm", "nope")

    assert result.exit_code != 0
    assert "local-search" in result.output


@respx.mock
def test_compare_runs_every_algorithm_on_the_same_budget(tmp_path):
    """採用アルゴリズムを決めるための比較。同じ予算・同じseedで並べる。"""
    mock_api()
    out = tmp_path / "compare"

    result = runner.invoke(
        app,
        [
            "compare",
            str(config_path(tmp_path)),
            "--budget",
            "2000",
            "--seed",
            "abc",
            "--out",
            str(out),
        ],
    )

    assert result.exit_code == 0, result.output
    comparison = json.loads((out / "comparison.json").read_text(encoding="utf-8"))
    assert {entry["algorithm"] for entry in comparison["algorithms"]} == {
        "local-search",
        "random",
        "optuna",
    }
    assert all(entry["consumedRuns"] <= 2000 for entry in comparison["algorithms"])
    assert (out / "comparison.png").exists()


@respx.mock
def test_compare_keeps_each_algorithms_report_separately(tmp_path):
    mock_api()
    out = tmp_path / "compare"

    runner.invoke(
        app,
        [
            "compare",
            str(config_path(tmp_path)),
            "--budget",
            "2000",
            "--seed",
            "abc",
            "--out",
            str(out),
        ],
    )

    for algorithm in ("local-search", "random", "optuna"):
        assert (out / algorithm / "optimization.json").exists()
        assert (out / algorithm / "evaluations.csv").exists()


@respx.mock
def test_compare_can_be_narrowed_to_the_algorithms_of_interest(tmp_path):
    mock_api()
    out = tmp_path / "compare"

    result = runner.invoke(
        app,
        [
            "compare",
            str(config_path(tmp_path)),
            "--budget",
            "2000",
            "--seed",
            "abc",
            "--out",
            str(out),
            "--algorithm",
            "local-search",
            "--algorithm",
            "random",
        ],
    )

    assert result.exit_code == 0, result.output
    comparison = json.loads((out / "comparison.json").read_text(encoding="utf-8"))
    assert {entry["algorithm"] for entry in comparison["algorithms"]} == {"local-search", "random"}


@respx.mock
def test_the_evaluation_log_records_every_run(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    lines = (out / "evaluations.csv").read_text(encoding="utf-8").splitlines()
    summary = json.loads((out / "optimization.json").read_text(encoding="utf-8"))
    assert len(lines) - 1 == summary["consumedRuns"]
