"""`lab gear-sensitivity` の入出力。モックサーバー越しに事前検証と再現性を固定する。"""

import json

import httpx
import respx
import yaml
from typer.testing import CliRunner

from exercise_lab.api import CATALOG_PATH, EVALUATION_PATH
from exercise_lab.cli import app

BASE_URL = "http://localhost:3000"

CATALOG = {
    "schemaVersion": 1,
    "catalogRevision": "2026-08-01.1",
    "units": [
        {
            "unitDefinitionId": "UNIT_A",
            "displayName": "味方A",
            "characterName": "A",
            "category": "PLAYABLE",
            "attribute": "SHY",
            "unitType": "PHYSICAL",
            "role": "PHYSICAL_ATTACKER",
            "positionAptitudes": ["FRONT"],
        },
        {
            "unitDefinitionId": "UNIT_B",
            "displayName": "味方B",
            "characterName": "B",
            "category": "PLAYABLE",
            "attribute": "CUTE",
            "unitType": "AGILE",
            "role": "SUPPORTER",
            "positionAptitudes": ["BACK"],
        },
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
    "memories": [{"memoryDefinitionId": "MEM_1", "displayName": "記憶1"}],
    "gearEffects": [],
}

# ステータスごとの1枚あたりの効き目。会心ダメージが最も伸びる基点にしてある。
STAT_VALUE = {
    "ATTACK": 40,
    "ACTION_SPEED": 10,
    "CRITICAL_RATE": 20,
    "CRITICAL_DAMAGE_BONUS": 90,
    "AFFINITY_BONUS": 5,
    "MAXIMUM_HP": 0,
    "DEFENSE": 0,
}


class GearArena:
    """ギアの合計効き目で決まるスコアを返す評価API。乱数は (seed, runIndex) だけで決める。"""

    def __init__(self):
        self.seeds: list[tuple[str, int]] = []

    def evaluate(self, body):
        runs = body["runsPerCandidate"]
        seed = body["seed"]
        self.seeds.append((seed, runs))
        return {
            "catalogRevision": CATALOG["catalogRevision"],
            "seed": seed,
            "runsPerCandidate": runs,
            "candidates": [
                self._one(candidate["allyFormation"], seed, runs)
                for candidate in body["candidates"]
            ],
        }

    def _one(self, formation, seed, runs):
        strength = 1000
        for unit in formation["units"]:
            for gear in unit.get("enhancement", {}).get("gears", []):
                strength += STAT_VALUE[gear["stat"]]
        scores = [max(0, strength + _noise(seed, index)) for index in range(runs)]
        return {
            "completedRuns": runs,
            "scores": scores,
            "breakCounts": [2] * runs,
            "completedTurns": [5] * runs,
            "completionReasons": ["TURN_LIMIT_REACHED"] * runs,
        }


def _noise(seed: str, run_index: int) -> int:
    return ((sum(ord(char) for char in seed) * 2654435761 + run_index * 40503) % 200) - 100


def mock_api():
    arena = GearArena()
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG))

    def evaluate(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=arena.evaluate(json.loads(request.content)))

    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(side_effect=evaluate)
    return arena


def formation_document(gears=None, academy=True):
    document = {
        "ally": {
            "units": [
                {
                    "unitDefinitionId": "UNIT_A",
                    "position": {"column": 0, "row": "FRONT"},
                    "level": 200,
                    "gears": gears
                    if gears is not None
                    else [
                        {"stat": "ATTACK", "tier": "III", "grade": "S"},
                        {"stat": "ACTION_SPEED", "tier": "III", "grade": "S"},
                    ],
                },
                {
                    "unitDefinitionId": "UNIT_B",
                    "position": {"column": 1, "row": "REAR"},
                    "level": 200,
                    "gears": [{"stat": "ATTACK", "tier": "II", "grade": "D"}],
                },
            ],
            "memoryDefinitionIds": ["MEM_1"],
        },
        "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "REAR"}},
    }
    if academy:
        document["ally"]["academyLevels"] = {"unitTypes": {"PHYSICAL": 50}, "attributes": {}}
    else:
        for unit in document["ally"]["units"]:
            unit.pop("level")
            unit.pop("gears")
    return document


runner = CliRunner()


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
            "gear-sensitivity",
            str(write_formation(tmp_path, **kwargs)),
            "--seed",
            "abc",
            "--out",
            str(out),
            "--screen-runs",
            "10",
            "--confirm-runs",
            "20",
            "--verify-runs",
            "20",
            "--survivors",
            "4",
            "--top",
            "2",
            *extra,
        ],
    )


@respx.mock
def test_it_writes_the_full_report_set(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    assert result.exit_code == 0, result.output
    assert sorted(path.name for path in out.iterdir()) == [
        "gear-evaluations.csv",
        "gear-moves.csv",
        "gear-sensitivity.json",
    ]


@respx.mock
def test_the_marginal_utility_map_covers_every_unit_and_searched_stat(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    run(tmp_path, out)

    summary = json.loads((out / "gear-sensitivity.json").read_text(encoding="utf-8"))
    cells = summary["utilityMap"]
    assert {cell["slotIndex"] for cell in cells} == {0, 1}
    assert len(cells) == 2 * 5
    assert {cell["displayName"] for cell in cells} == {"味方A", "味方B"}


@respx.mock
def test_the_strongest_stat_of_the_arena_leads_the_top_moves(tmp_path):
    mock_api()
    out = tmp_path / "reports"

    result = run(tmp_path, out)

    summary = json.loads((out / "gear-sensitivity.json").read_text(encoding="utf-8"))
    assert summary["topMoves"][0]["gainedStat"] == "CRITICAL_DAMAGE_BONUS"
    assert summary["topMoves"][0]["verify"]["runs"] == 20
    assert summary["combined"] is not None
    assert "同時適用" in result.output


@respx.mock
def test_the_confirmation_run_never_reuses_a_seed_from_the_earlier_stages(tmp_path):
    arena = mock_api()

    run(tmp_path, tmp_path / "reports")

    stages = {}
    for seed, _ in arena.seeds:
        offset = int(seed.split("#")[1])
        stages.setdefault(offset, 0)
    # 篩い10試行・確定20試行・確認走20試行なので、区間の先頭は 0 / 10 / 30 になる。
    assert sorted(stages) == [0, 10, 30]


@respx.mock
def test_the_same_seed_reproduces_identical_numbers(tmp_path):
    mock_api()
    first, second = tmp_path / "first", tmp_path / "second"

    run(tmp_path, first)
    run(tmp_path, second)

    left = json.loads((first / "gear-sensitivity.json").read_text(encoding="utf-8"))
    right = json.loads((second / "gear-sensitivity.json").read_text(encoding="utf-8"))
    assert left == right


@respx.mock
def test_the_budget_and_the_detectable_margin_are_shown_before_the_sweep(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports")

    assert "予算の内訳" in result.output
    assert "見える差" in result.output
    assert result.output.index("見える差") < result.output.index("限界効用マップ")


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


@respx.mock
def test_every_sent_formation_satisfies_the_gear_rule(tmp_path):
    sent: list[dict] = []
    respx.get(f"{BASE_URL}{CATALOG_PATH}").mock(return_value=httpx.Response(200, json=CATALOG))
    arena = GearArena()

    def evaluate(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.extend(body["candidates"])
        return httpx.Response(200, json=arena.evaluate(body))

    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(side_effect=evaluate)

    run(tmp_path, tmp_path / "reports", "--include-rank")

    assert sent
    for candidate in sent:
        for unit in candidate["allyFormation"]["units"]:
            gears = unit.get("enhancement", {}).get("gears", [])
            assert len(gears) <= 9
            counts = {gear["stat"]: 0 for gear in gears}
            for gear in gears:
                counts[gear["stat"]] += 1
            assert max(counts.values(), default=0) <= 3


@respx.mock
def test_a_formation_without_academy_levels_is_reported_as_a_fixable_error(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports", academy=False)

    assert result.exit_code == 1
    assert "academyLevels" in result.output


@respx.mock
def test_an_unknown_add_rank_lists_the_accepted_forms(tmp_path):
    mock_api()

    result = run(tmp_path, tmp_path / "reports", "--add-rank", "IV-S")

    assert result.exit_code == 1
    assert "III-S" in result.output
