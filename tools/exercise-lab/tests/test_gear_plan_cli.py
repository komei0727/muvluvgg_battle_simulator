"""`lab gear-plan` の入出力。モックサーバー越しに予算・確認・出力を固定する。"""

import json

import httpx
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
        "gear-plan-evaluations.csv",
        "gear-plan.json",
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
    budget = 200

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
def test_a_budget_of_exactly_one_iteration_runs_that_iteration(tmp_path):
    server = mock_api()
    # 1手近傍25手・篩い4試行・確定8試行・上位4手 = (1+25)*4 + (1+4)*8。
    budget = 144

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
