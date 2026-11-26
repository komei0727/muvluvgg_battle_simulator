"""移設前（`exercise_lab.inputs` 単独の実装、`main` の 6e640158）と同じ入力から、同じ
APIリクエストと警告が出る。

`fixtures/pre_migration_requests.json` は移設前の実装で書き出した。手持ちデータの適用
（明示値の優先・レベルリンクと除外・ランク・ギアの空枠除去・モジュールのパーセント→
小数変換・手持ちに無いユニット）と、編成の順序・同一定義の複数枠・強化指定の省略と
空指定を1回で踏む入力にしてある。移設は振る舞いを変えない前提なので、この値は
再生成しない。
"""

import json
from pathlib import Path

import pytest

from exercise_lab.inputs.exercise import (
    apply_player_data,
    build_exercise_request,
    dump_resolved_exercise_input,
    load_formation_config,
    load_resolved_exercise_input,
    resolve_exercise_input,
)
from mlgg_lab_common.inputs.player_data import load_player_data

EXPECTED = json.loads(
    (Path(__file__).parent / "fixtures" / "pre_migration_requests.json").read_text(encoding="utf-8")
)

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {
        "unitTypes": {"PHYSICAL": 120, "ENERGY": 110},
        "attributes": {"CUTE": 30, "SMART": 120},
    },
    "levelLink": {"enabled": True, "level": 400},
    "units": {
        "UNIT_A": {
            "level": 240,
            "rank": 3,
            "gears": [
                {"stat": "ATTACK", "tier": "III", "grade": "S"},
                None,
                {"stat": "DEFENSE", "tier": "II", "grade": "C"},
            ]
            + [None] * 6,
            "module": {
                "hp": {"fixed": 4288, "ratio": 10},
                "attack": {"fixed": "", "ratio": 12.5},
                "defense": {"fixed": "", "ratio": ""},
            },
        },
        "UNIT_B": {"level": 310, "linkExcluded": True, "gears": [None] * 9},
        "UNIT_C": {"level": 200, "rank": 5, "gears": [None] * 9},
    },
}
YAMLS = {
    "plain": """
ally:
  units:
    - {unitDefinitionId: UNIT_C, position: {column: 2, row: REAR}}
    - {unitDefinitionId: UNIT_A, position: {column: 0, row: FRONT}}
    - {unitDefinitionId: UNIT_A, position: {column: 1, row: FRONT}}
    - {unitDefinitionId: UNIT_MISSING, position: {column: 0, row: REAR}}
    - {unitDefinitionId: UNIT_B, position: {column: 1, row: REAR}}
  memoryDefinitionIds: [MEM_Z, MEM_A, MEM_M]
enemy: {unitDefinitionId: UNIT_ENEMY_TEX, position: {column: 1, row: FRONT}}
""",
    "explicit": """
ally:
  academyLevels: {unitTypes: {}, attributes: {}}
  units:
    - {unitDefinitionId: UNIT_A, position: {column: 0, row: FRONT}, level: 1, rank: 0, gears: []}
    - {unitDefinitionId: UNIT_A, position: {column: 1, row: FRONT}}
    - {unitDefinitionId: UNIT_B, position: {column: 2, row: FRONT}, module: {attack: {ratio: 0.2}}}
  memoryDefinitionIds: []
enemy: {unitDefinitionId: UNIT_ENEMY_TEX, position: {column: 0, row: REAR}}
""",
}


CASES = [(name, with_player_data) for name in YAMLS for with_player_data in (False, True)]


def case_key(name, with_player_data):
    return f"{name}/{'player-data' if with_player_data else 'none'}"


@pytest.fixture
def files(tmp_path):
    player_data = tmp_path / "player-data.json"
    player_data.write_text(json.dumps(PLAYER_DATA), encoding="utf-8")
    configs = {}
    for name, text in YAMLS.items():
        configs[name] = tmp_path / f"{name}.yaml"
        configs[name].write_text(text, encoding="utf-8")
    return configs, player_data


@pytest.mark.parametrize(("name", "with_player_data"), CASES)
def test_the_request_and_warnings_match_the_pre_migration_implementation(
    files, name, with_player_data
):
    configs, player_data = files
    config = load_formation_config(configs[name])
    warnings = []
    if with_player_data:
        config, warnings = apply_player_data(config, load_player_data(player_data))

    expected = EXPECTED[case_key(name, with_player_data)]
    assert build_exercise_request(config) == expected["request"]
    assert warnings == expected["warnings"]


@pytest.mark.parametrize(("name", "with_player_data"), CASES)
def test_the_resolved_input_round_trips_to_the_same_request(
    files, tmp_path, name, with_player_data
):
    configs, player_data = files
    resolved = resolve_exercise_input(
        configs[name], player_data_path=player_data if with_player_data else None
    )
    saved = tmp_path / "resolved.json"
    saved.write_text(dump_resolved_exercise_input(resolved), encoding="utf-8")
    # 元ファイルを消しても読み戻せる（解決済み入力は自己完結している）。
    configs[name].unlink()
    player_data.unlink()

    reloaded = load_resolved_exercise_input(saved)

    expected = EXPECTED[case_key(name, with_player_data)]
    assert reloaded == resolved
    assert reloaded.to_request() == expected["request"]
    assert reloaded.provenance.warnings == expected["warnings"]
