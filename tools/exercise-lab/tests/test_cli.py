"""`lab stats` の入出力。

受け入れ条件「同一 `--seed` で再実行するとレポートの数値が完全一致する」を、
モックサーバー越しに固定する。
"""

import json

import httpx
import respx
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH, EVALUATION_PATH
from exercise_lab.cli import app

BASE_URL = "http://localhost:3000"

CONFIG_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
  memoryDefinitionIds: [MEMORY_A]
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""

CATALOG = {
    "schemaVersion": 1,
    "catalogRevision": "2026-06-28.1",
    "units": [
        {"unitDefinitionId": "UNIT_A", "displayName": "A", "category": "PLAYABLE"},
        {"unitDefinitionId": "UNIT_ENEMY", "displayName": "E", "category": "EXERCISE_ENEMY"},
    ],
    "memories": [{"memoryDefinitionId": "MEMORY_A", "displayName": "M"}],
    "gearEffects": [],
}

runner = CliRunner()


@respx.mock
def test_stats_writes_the_full_report_set(tmp_path):
    _mock_api()
    out = tmp_path / "reports"

    result = _run(tmp_path, out, "abc")

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "break-count-distribution.png",
        "runs.csv",
        "score-histogram.png",
        "summary.json",
    ]


@respx.mock
def test_same_seed_reproduces_identical_numbers(tmp_path):
    _mock_api()
    first = tmp_path / "first"
    second = tmp_path / "second"

    _run(tmp_path, first, "abc")
    _run(tmp_path, second, "abc")

    assert (first / "summary.json").read_text() == (second / "summary.json").read_text()
    assert (first / "runs.csv").read_bytes() == (second / "runs.csv").read_bytes()


@respx.mock
def test_summary_records_the_reproduction_key(tmp_path):
    _mock_api()
    out = tmp_path / "reports"

    _run(tmp_path, out, "abc")

    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
    assert summary["seed"] == "abc"
    assert summary["chunkSize"] == 2
    assert summary["requestedRuns"] == 4
    assert summary["completedRuns"] == 4
    assert summary["catalogRevision"] == "2026-06-28.1"


@respx.mock
def test_catalog_violation_stops_before_any_evaluation(tmp_path):
    _mock_api()
    evaluation = respx.post(f"{BASE_URL}{EVALUATION_PATH}")
    config = tmp_path / "formation.yaml"
    config.write_text(CONFIG_YAML.replace("UNIT_A", "UNIT_TYPO"), encoding="utf-8")

    result = runner.invoke(
        app,
        ["stats", str(config), "--runs", "4", "--seed", "abc", "--out", str(tmp_path / "out")],
    )

    assert result.exit_code == 1
    assert evaluation.call_count == 0


def _mock_api() -> None:
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG))
    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(side_effect=_evaluation)


def _evaluation(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.read())
    runs = body["runsPerCandidate"]
    # seedごとに違う値を返し、チャンクの取り違えがあれば数値の並びに出るようにする。
    base = sum(ord(character) for character in body["seed"])
    return httpx.Response(
        200,
        json={
            "schemaVersion": 1,
            "catalogRevision": "2026-06-28.1",
            "seed": body["seed"],
            "runsPerCandidate": runs,
            "candidates": [
                {
                    "completedRuns": runs,
                    "scores": [base + index for index in range(runs)],
                    "breakCounts": [index % 3 for index in range(runs)],
                    "completedTurns": [5] * runs,
                    "completionReasons": ["TURN_LIMIT_REACHED"] * runs,
                }
            ],
        },
    )


def _run(tmp_path, out, seed: str):
    config = tmp_path / "formation.yaml"
    config.write_text(CONFIG_YAML, encoding="utf-8")
    return runner.invoke(
        app,
        [
            "stats",
            str(config),
            "--runs",
            "4",
            "--chunk-size",
            "2",
            "--seed",
            seed,
            "--out",
            str(out),
            "--base-url",
            BASE_URL,
        ],
    )


@respx.mock
def test_unreachable_server_is_reported_without_a_traceback(tmp_path):
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    config = tmp_path / "formation.yaml"
    config.write_text(CONFIG_YAML, encoding="utf-8")

    result = runner.invoke(
        app,
        ["stats", str(config), "--runs", "4", "--seed", "abc", "--out", str(tmp_path / "out")],
    )

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)


@respx.mock
def test_zero_completed_runs_is_reported_as_an_explained_error(tmp_path):
    # Q-TEX-18: 期限に達すると `completedRuns: 0` も正当な応答になる。統計は出せないので、
    # tracebackではなく原因と対処を書いたエラーで終える。
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG))
    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        return_value=httpx.Response(
            200,
            json={
                "schemaVersion": 1,
                "catalogRevision": "2026-06-28.1",
                "seed": "abc#0",
                "runsPerCandidate": 4,
                "candidates": [
                    {
                        "completedRuns": 0,
                        "scores": [],
                        "breakCounts": [],
                        "completedTurns": [],
                        "completionReasons": [],
                    }
                ],
            },
        )
    )
    out = tmp_path / "reports"

    result = _run(tmp_path, out, "abc")

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)
    # 中途半端なレポートを残さない。空のCSVがあると、後段が「0件の結果」と
    # 「そもそも走らなかった」を区別できない。
    assert not out.exists()
