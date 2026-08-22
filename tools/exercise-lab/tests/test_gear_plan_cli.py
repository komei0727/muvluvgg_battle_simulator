"""`lab gear-plan` の入出力。モックサーバー越しに予算・確認・出力を固定する。"""

import json

import httpx
import pytest
import respx
import yaml
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH, EVALUATION_PATH, EXERCISE_PATH
from exercise_lab.cli import app
from test_gear_cli import CATALOG, formation_document

BASE_URL = "http://localhost:3000"

# 1枚あたりの効き目。会心ダメージが最も伸びる。
STAT_VALUE = {
    "ATTACK": 40,
    "ACTION_SPEED": 10,
    "CRITICAL_RATE": 20,
    "CRITICAL_DAMAGE_BONUS": 90,
    "AFFINITY_BONUS": 5,
    "MAXIMUM_HP": 0,
    "DEFENSE": 0,
}

runner = CliRunner()


class Server:
    """一括評価と単発実行の両方を返すモック。"""

    def __init__(self):
        self.exercise_calls: list[dict] = []
        self.evaluation_calls: list[dict] = []

    def evaluate(self, body):
        self.evaluation_calls.append(body)
        runs = body["runsPerCandidate"]
        return {
            "catalogRevision": CATALOG["catalogRevision"],
            "seed": body["seed"],
            "runsPerCandidate": runs,
            "candidates": [
                self._candidate(candidate["allyFormation"], body["seed"], runs)
                for candidate in body["candidates"]
            ],
        }

    def _candidate(self, formation, seed, runs):
        strengths = [self._unit_strength(unit) for unit in formation["units"]]
        damage = [[value * 10 + run for value in strengths] for run in range(runs)]
        scores = [sum(row) + _noise(seed, run) for run, row in enumerate(damage)]
        return {
            "completedRuns": runs,
            "scores": scores,
            "breakCounts": [2] * runs,
            "completedTurns": [5] * runs,
            "completionReasons": ["TURN_LIMIT_REACHED"] * runs,
            "allyUnitDamageTotals": damage,
            "allyUnitBreakCounts": [[0] * len(strengths) for _ in range(runs)],
        }

    @staticmethod
    def _unit_strength(unit):
        gears = unit.get("enhancement", {}).get("gears", [])
        return 100 + sum(STAT_VALUE[gear["stat"]] for gear in gears)

    def simulate(self, body):
        self.exercise_calls.append(body)
        units = body["allyFormation"]["units"]
        # 攻撃力が最も多い枠がバフの受け先になる盤面。
        attack = [
            sum(
                1
                for gear in unit.get("enhancement", {}).get("gears", [])
                if gear["stat"] == "ATTACK"
            )
            for unit in units
        ]
        recipient = attack.index(max(attack))
        roster = [
            {
                "battleUnitId": f"BU_{index}",
                "unitDefinitionId": unit["unitDefinitionId"],
                "side": "ALLY",
                "formationPosition": unit["position"],
            }
            for index, unit in enumerate(units)
        ]
        return {
            "catalogRevision": CATALOG["catalogRevision"],
            "result": {
                "completionReason": "TURN_LIMIT_REACHED",
                "completedTurn": 5,
                "totalScore": 1000,
                "breakCount": 1,
            },
            "initialState": {"units": roster},
            "events": [
                {
                    "sequence": 1,
                    "type": "ACTION_QUEUE_CREATED",
                    "category": "FACT",
                    "targetUnitIds": [],
                    "details": {
                        "cycleNumber": 1,
                        "reservations": [
                            {
                                "battleUnitId": entry["battleUnitId"],
                                "reservedActionKind": "AS",
                                "actionSpeed": 900,
                            }
                            for entry in roster
                        ],
                    },
                },
                {
                    "sequence": 2,
                    "type": "EFFECT_APPLIED",
                    "category": "FACT",
                    "targetUnitIds": [],
                    "details": {
                        "effectInstanceId": "EI_1",
                        "effectActionDefinitionId": "ACT_RANK_BUFF",
                        "targetUnitId": f"BU_{recipient}",
                    },
                },
            ],
        }


def _noise(seed: str, run: int) -> int:
    return ((sum(ord(char) for char in seed) * 2654435761 + run * 40503) % 20) - 10


def mock_api():
    server = Server()
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG))
    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        side_effect=lambda request: httpx.Response(
            200, json=server.evaluate(json.loads(request.content))
        )
    )
    respx.post(f"{BASE_URL}{EXERCISE_PATH}").mock(
        side_effect=lambda request: httpx.Response(
            200, json=server.simulate(json.loads(request.content))
        )
    )
    return server


def write_formation(tmp_path, **kwargs):
    path = tmp_path / "formation.yaml"
    path.write_text(
        yaml.safe_dump(formation_document(**kwargs), allow_unicode=True), encoding="utf-8"
    )
    return path


def run(tmp_path, out, *extra, **kwargs):
    return runner.invoke(
        app,
        [
            "gear-plan",
            str(write_formation(tmp_path, **kwargs)),
            "--seed",
            "abc",
            "--out",
            str(out),
            "--budget",
            "4000",
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--survivors",
            "4",
            "--max-iterations",
            "3",
            "--restarts",
            "1",
            "--push-steps",
            "2",
            "--rank-steps",
            "2",
            "--yes",
            *extra,
        ],
    )


@respx.mock
def test_it_writes_the_plan_report(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "best-so-far.png",
        "evaluations.csv",
        "gear-plan.json",
        "steps.csv",
    ]


@respx.mock
def test_the_report_lists_the_reached_signatures(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    assert summary["baseSignature"]["assignments"]["ACT_RANK_BUFF"].endswith("UNIT_A")
    assert summary["signatures"]
    assert {entry["origin"] for entry in summary["signatures"]} >= {"base", "base-climb"}
    assert summary["restarts"]


@respx.mock
def test_the_climb_improves_the_allocation(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    best = {entry["slotIndex"]: entry["counts"] for entry in summary["best"]}
    start = {entry["slotIndex"]: entry["gears"] for entry in summary["baseFormation"]["units"]}
    # 会心ダメージが最も効くので、そこへ積む手が採用される。
    assert best[0]["CRITICAL_DAMAGE_BONUS"] > 0
    assert summary["baseClimb"]["steps"]
    assert start[0]
    assert "Phase B" in result.output


@respx.mock
def test_the_budget_and_the_time_estimate_are_shown_before_the_search(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports")

    assert "予算の内訳" in result.output
    assert "校正" in result.output
    assert "見積り" in result.output
    assert result.output.index("見積り") < result.output.index("到達したギア配分")


@respx.mock
def test_declining_the_confirmation_stops_before_the_search(tmp_path):
    server = mock_api()

    result = runner.invoke(
        app,
        [
            "gear-plan",
            str(write_formation(tmp_path)),
            "--seed",
            "abc",
            "--out",
            str(tmp_path / "reports"),
            "--budget",
            "4000",
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--max-iterations",
            "2",
            "--restarts",
            "0",
        ],
        input="n\n",
    )

    assert result.exit_code == 0
    # 校正の1リクエストだけで止まる。探索は始まっていない。
    assert len(server.evaluation_calls) == 1
    assert not (tmp_path / "reports" / "gear-plan.json").exists()


@respx.mock
def test_a_budget_below_one_iteration_stops_before_any_evaluation(tmp_path):
    server = mock_api()

    result = runner.invoke(
        app,
        [
            "gear-plan",
            str(write_formation(tmp_path)),
            "--seed",
            "abc",
            "--out",
            str(tmp_path / "reports"),
            "--budget",
            "1",
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--max-iterations",
            "2",
            "--restarts",
            "0",
            "--yes",
        ],
    )

    assert result.exit_code == 1
    # 校正リクエストも予算の内である。1反復を回せない予算では1試行も投げない。
    assert server.evaluation_calls == []
    assert server.exercise_calls == []
    assert "--budget" in result.output


@respx.mock
def test_the_evaluated_runs_stay_within_the_budget(tmp_path):
    server = mock_api()
    budget = 2000

    result = runner.invoke(
        app,
        [
            "gear-plan",
            str(write_formation(tmp_path)),
            "--seed",
            "abc",
            "--out",
            str(tmp_path / "reports"),
            "--budget",
            str(budget),
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--survivors",
            "4",
            "--max-iterations",
            "5",
            "--restarts",
            "1",
            "--yes",
        ],
    )

    assert result.exit_code == 0, result.output
    consumed = sum(
        len(body["candidates"]) * body["runsPerCandidate"] for body in server.evaluation_calls
    )
    # 校正リクエストのぶんも含めて上限を超えない。
    assert consumed <= budget


@respx.mock
def test_a_budget_of_exactly_the_minimum_runs_one_iteration(tmp_path):
    server = mock_api()
    # 1反復 = (1+25)*4 + (1+4)*8 = 144。取り置き = 最終選抜 2×8 + 到達手順 (1+2*18)*8。
    budget = 144 + 2 * 8 + (1 + 2 * 18) * 8

    result = runner.invoke(
        app,
        [
            "gear-plan",
            str(write_formation(tmp_path)),
            "--seed",
            "abc",
            "--out",
            str(tmp_path / "reports"),
            "--budget",
            str(budget),
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--survivors",
            "4",
            "--max-iterations",
            "5",
            "--restarts",
            "0",
            "--final-pool",
            "2",
            "--final-runs",
            "8",
            "--yes",
        ],
    )

    assert result.exit_code == 0, result.output
    summary = json.loads((tmp_path / "reports" / "gear-plan.json").read_text(encoding="utf-8"))
    # 校正のぶんを二重に要求していれば、ここで拒まれるか1反復も回らない。
    assert summary["baseClimb"]["steps"]
    consumed = sum(
        len(body["candidates"]) * body["runsPerCandidate"] for body in server.evaluation_calls
    )
    assert consumed <= budget


@respx.mock
def test_the_minimum_budget_is_shown_with_the_breakdown(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports")

    assert "最低予算" in result.output


@respx.mock
def test_no_request_exceeds_the_evaluation_api_limits(tmp_path):
    server = mock_api()

    run(tmp_path, tmp_path / "reports")

    for body in server.evaluation_calls:
        assert len(body["candidates"]) <= 32
        assert len(body["candidates"]) * body["runsPerCandidate"] <= 300


@respx.mock
def test_every_sent_allocation_satisfies_the_gear_rule(tmp_path):
    server = mock_api()

    run(tmp_path, tmp_path / "reports", "--include-rank")

    bodies = [
        candidate["allyFormation"]
        for body in server.evaluation_calls
        for candidate in body["candidates"]
    ] + [body["allyFormation"] for body in server.exercise_calls]
    assert bodies
    for formation in bodies:
        for unit in formation["units"]:
            gears = unit.get("enhancement", {}).get("gears", [])
            assert len(gears) <= 9
            counts: dict[str, int] = {}
            for gear in gears:
                counts[gear["stat"]] = counts.get(gear["stat"], 0) + 1
            assert max(counts.values(), default=0) <= 3


@respx.mock
def test_the_single_run_asks_for_the_detailed_log(tmp_path):
    server = mock_api()

    run(tmp_path, tmp_path / "reports")

    assert server.exercise_calls
    assert all(body["options"]["logLevel"] == "DETAILED" for body in server.exercise_calls)


@respx.mock
def test_the_same_seed_reproduces_identical_numbers(tmp_path):
    mock_api()
    first, second = tmp_path / "first", tmp_path / "second"

    run(tmp_path, first)
    run(tmp_path, second)

    left = json.loads((first / "gear-plan.json").read_text(encoding="utf-8"))
    right = json.loads((second / "gear-plan.json").read_text(encoding="utf-8"))
    assert left == right


@respx.mock
def test_a_base_allocation_that_breaks_the_gear_rule_stops_before_any_evaluation(tmp_path):
    mock_api()
    route = respx.post(f"{BASE_URL}{EVALUATION_PATH}")

    result = run(
        tmp_path,
        tmp_path / "reports",
        gears=[{"stat": "ATTACK", "tier": "III", "grade": grade} for grade in "SABC"],
    )

    assert result.exit_code == 1
    assert "R-ENH-04" in result.output
    assert route.call_count == 0


# --- Phase D: ランク微調整 ---------------------------------------------------


@respx.mock
def test_the_report_carries_the_rank_pass_and_its_price_table(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    # 再スタートを両方向とも回すと、DOWN 側で受け先が 0:UNIT_A → 1:UNIT_B へ動く。
    result = run(tmp_path, out, "--restarts", "2", "--budget", "20000")

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    tuning = summary["rankTuning"]
    assert tuning is not None
    # 単発実行のモックは攻撃力の枚数で受け先を決める。再スタートでそこが動いた枠だけが対象。
    assert tuning["targets"]
    assert all(target["stat"] in ("ATTACK", "ACTION_SPEED") for target in tuning["targets"])
    assert summary["settings"]["rankSteps"] == 2
    # UNIT_B の Ⅲ-D(1.0) を1段下げると Ⅱ-D(0.75)。段と補正差はCatalogの効果表から出る。
    price = next(entry for entry in tuning["prices"] if entry["slotIndex"] == 1)
    assert price["step"] == "II-D → III-D"
    assert price["pointsDelta"] == pytest.approx(0.25)
    assert price["runs"] == 8
    assert "ランク1段の単価" in result.output


@respx.mock
def test_the_rank_pass_never_touches_a_slot_outside_the_boundary(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out, "--restarts", "2", "--budget", "20000")

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    tuning = summary["rankTuning"]
    focused = {target["slotIndex"] for target in tuning["targets"]}
    assert focused
    assert {walk["slotIndex"] for walk in tuning["walks"]} <= focused


@respx.mock
def test_turning_the_rank_pass_off_leaves_it_out_of_the_report(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out, "--rank-steps", "0")

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    assert summary["rankTuning"] is None
    assert result.exit_code == 0


# --- 最終選抜・到達手順・書き戻し --------------------------------------------

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {"PHYSICAL": 50}, "attributes": {}},
    "levelLink": {"enabled": True, "level": 210},
    "units": {
        "UNIT_A": {
            "level": 240,
            "linkExcluded": True,
            "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}, *([None] * 8)],
        },
        "UNIT_BENCH": {"level": 120, "gears": [None] * 9},
    },
}


def write_player_data(tmp_path):
    path = tmp_path / "player-data.json"
    path.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")
    return path


@respx.mock
def test_it_writes_every_artifact(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out, "--player-data", str(write_player_data(tmp_path)))

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "best-so-far.png",
        "evaluations.csv",
        "gear-plan.json",
        "player-data.json",
        "steps.csv",
    ]


@respx.mock
def test_no_write_back_without_the_player_data_to_overlay(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    assert not (out / "player-data.json").exists()
    assert (out / "steps.csv").exists()


@respx.mock
def test_the_written_player_data_carries_the_theoretical_gears(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out, "--player-data", str(write_player_data(tmp_path)))

    written = json.loads((out / "player-data.json").read_text(encoding="utf-8"))
    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    best = {entry["unitDefinitionId"]: entry["gears"] for entry in summary["best"]}
    stored = [
        f"{gear['stat']}:{gear['tier']}-{gear['grade']}"
        for gear in written["units"]["UNIT_A"]["gears"]
        if gear
    ]
    assert sorted(stored) == sorted(best["UNIT_A"])
    # 編成外の記録・レベル・学園レベル・レベルリンクは入力のまま残る。
    assert written["units"]["UNIT_BENCH"] == PLAYER_DATA["units"]["UNIT_BENCH"]
    assert written["units"]["UNIT_A"]["level"] == 240
    assert written["academyLevels"] == PLAYER_DATA["academyLevels"]
    assert written["levelLink"] == PLAYER_DATA["levelLink"]


@respx.mock
def test_the_written_player_data_is_accepted_as_input(tmp_path):
    mock_api()
    out = tmp_path / "reports"
    run(tmp_path, out, "--player-data", str(write_player_data(tmp_path)))

    # 書き戻したものをそのまま次の実行へ渡せる（`lab optimize` も同じ読み手を使う）。
    second = run(tmp_path, tmp_path / "again", "--player-data", str(out / "player-data.json"))

    assert second.exit_code == 0, second.output


@respx.mock
def test_the_final_selection_sends_seeds_the_search_never_used(tmp_path):
    server = mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out, "--final-runs", "12", "--final-pool", "3")

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    assert summary["finalSelection"]["candidates"]
    # 篩い4 + 確定8 の先から始まる。探索が使った通し試行番号とは重ならない。
    assert any(body["seed"] == "abc#12" for body in server.evaluation_calls)
    assert all(body["seed"] in ("abc#0", "abc#4", "abc#12") for body in server.evaluation_calls)


@respx.mock
def test_the_reach_path_is_reported_with_groups_and_a_cumulative_delta(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    rows = summary["steps"]["rows"]
    assert rows
    assert [row["index"] for row in rows] == list(range(1, len(rows) + 1))
    assert all(row["group"] >= 1 for row in rows)
    assert rows[-1]["cumulativeExpectedBestDelta"] is not None
    assert "到達手順" in result.output

    written = (out / "steps.csv").read_text(encoding="utf-8").splitlines()
    assert written[0].startswith("index,group,slot_index")
    assert len(written) == len(rows) + 1


@respx.mock
def test_an_answer_identical_to_the_current_allocation_reports_no_difference(tmp_path):
    mock_api()
    out = tmp_path / "reports"
    # 人工目的関数の最適配分そのもの（効き目の高い3ステータス×各3枚＝9枠）。1手近傍の
    # どの手も損になるので、探索は基点から動かない。
    optimal = [
        {"stat": stat, "tier": "III", "grade": grade}
        for stat in ("CRITICAL_DAMAGE_BONUS", "ATTACK", "CRITICAL_RATE")
        for grade in ("S", "A", "B")
    ]

    document = formation_document(gears=optimal)
    for unit in document["ally"]["units"]:
        unit["gears"] = optimal
    path = tmp_path / "formation.yaml"
    path.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "gear-plan",
            str(path),
            "--seed",
            "abc",
            "--out",
            str(out),
            "--budget",
            "4000",
            "--screen-runs",
            "4",
            "--confirm-runs",
            "8",
            "--survivors",
            "4",
            "--max-iterations",
            "3",
            "--restarts",
            "0",
            "--rank-steps",
            "0",
            "--yes",
        ],
    )
    assert result.exit_code == 0, result.output

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    assert summary["steps"]["rows"] == []
    assert summary["steps"]["startIsAnswer"] is True
    assert "差分なし" in result.output
    # 見出しだけの steps.csv を残す（走っていないのか差分が無いのかを区別できるように）。
    assert (out / "steps.csv").read_text(encoding="utf-8").strip().count("\n") == 0


@respx.mock
def test_the_best_so_far_curve_is_written(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    summary = json.loads((out / "gear-plan.json").read_text(encoding="utf-8"))
    curve = summary["bestSoFar"]
    assert curve
    assert [point["bestFitness"] for point in curve] == sorted(
        point["bestFitness"] for point in curve
    )
    assert (out / "best-so-far.png").stat().st_size > 0
