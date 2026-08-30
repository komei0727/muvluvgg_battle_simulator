"""ブラウザ localStorage `mlgg:player-data` エクスポートの取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData`。
"""

import json

import pytest

from exercise_lab.models import build_evaluation_request, load_formation_config
from exercise_lab.player_data import PlayerDataError, apply_player_data, load_player_data

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {
        "unitTypes": {"PHYSICAL": 60, "ENERGY": 55, "AGILE": 50},
        "attributes": {
            "AGGRESSIVE": 40,
            "SHY": 39,
            "CUTE": 38,
            "SMART": 37,
            "COMICAL": 36,
            "CLEVER": 35,
        },
    },
    "units": {
        "UNIT_A": {
            "level": 240,
            "gears": [
                {"stat": "ATTACK", "tier": "III", "grade": "S"},
                None,
                None,
                {"stat": "DEFENSE", "tier": "II", "grade": "C"},
                None,
                None,
                None,
                None,
                None,
            ],
        }
    },
}

CONFIG_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
    - unitDefinitionId: UNIT_MISSING
      position: { column: 1, row: FRONT }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_stored_level_and_gears_are_applied_to_the_matching_unit(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert units[0]["enhancement"] == {
        "level": 240,
        "gears": [
            {"stat": "ATTACK", "tier": "III", "grade": "S"},
            {"stat": "DEFENSE", "tier": "II", "grade": "C"},
        ],
    }


def test_stored_academy_levels_enable_side_enhancement(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    formation = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]
    assert formation["enhancement"]["academyLevels"]["unitTypes"]["ENERGY"] == 55
    assert formation["enhancement"]["academyLevels"]["attributes"]["CLEVER"] == 35


def test_unit_absent_from_player_data_is_warned_and_left_at_defaults(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, warnings = apply_player_data(config, data)

    assert any("UNIT_MISSING" in warning for warning in warnings)
    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert "enhancement" not in units[1]


def test_stored_rank_is_applied_to_the_matching_unit(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": 3}},
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert units[0]["enhancement"]["rank"] == 3


def test_export_without_the_rank_field_defaults_to_five(tmp_path):
    """ランク導入前に書き出した player-data.json をそのまま読める（取り直させない）。"""
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    # rank 5 は省略時の既定と同値なので `enhancement` へは出ない。
    assert "rank" not in units[0]["enhancement"]


@pytest.mark.parametrize("rank", [0, 5])
def test_stored_rank_at_the_boundary_is_accepted(tmp_path, rank):
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": rank}},
    }

    data = load_player_data(write_json(tmp_path, player_data))

    assert data.units["UNIT_A"].rank == rank


@pytest.mark.parametrize("rank", [-1, 6])
def test_stored_rank_out_of_range_is_rejected(tmp_path, rank):
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": rank}},
    }

    with pytest.raises(PlayerDataError, match="rank"):
        load_player_data(write_json(tmp_path, player_data))


def test_yaml_rank_wins_over_the_stored_rank(tmp_path):
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      rank: 1",
        1,
    ).replace(
        "ally:\n",
        "ally:\n  academyLevels:\n    unitTypes: { PHYSICAL: 3 }\n",
        1,
    )
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": 3}},
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert units[0]["enhancement"]["rank"] == 1


def test_yaml_values_win_over_stored_values(tmp_path):
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      level: 1\n      gears: []",
        1,
    ).replace(
        "ally:\n",
        "ally:\n  academyLevels:\n    unitTypes: { PHYSICAL: 3 }\n",
        1,
    )
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    formation = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]
    assert formation["units"][0]["enhancement"] == {"level": 1, "gears": []}
    assert formation["enhancement"]["academyLevels"]["unitTypes"] == {
        "PHYSICAL": 3,
        "ENERGY": 1,
        "AGILE": 1,
    }


def test_level_link_replaces_the_stored_level_of_linked_units(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, linked(PLAYER_DATA, level=260)))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 260


def test_unit_absent_from_player_data_is_still_linked(tmp_path):
    """記録の無いユニットもリンク対象（UI側の `UI-API-024`）。

    手持ちデータへの書き戻しは直近に編集した枠だけなので、「置いただけで一度も
    強化入力を開いていないユニット」には記録が付かない。それはレベルリンクが
    狙っている母集団そのものであり、ここを既定200で評価するとUIと結論が割れる。
    """
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, linked(PLAYER_DATA, level=260)))

    applied, warnings = apply_player_data(config, data)

    units = build_evaluation_request(applied, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    assert units[1]["enhancement"] == {"level": 260, "gears": []}
    # ギアが無いことは依然として実際の欠落なので、警告自体は残す。
    assert any("UNIT_MISSING" in warning and "レベル260" in warning for warning in warnings)


def test_link_level_that_cannot_be_an_integer_is_rejected(tmp_path):
    """`""`（打ち直しのために消した状態）は保存データに現れない前提を固定する。

    UI側は未入力のリンクレベルを書き戻さない（`04_コンポーネント・状態管理設計.md`）。
    表現できない値を黙ってフォールバックで飲み込むと、`extra="forbid"` と同じ理由で
    取り違えに気づけなくなるため、読み込みごと落とす。
    """
    path = write_json(tmp_path, {**PLAYER_DATA, "levelLink": {"enabled": True, "level": ""}})

    with pytest.raises(PlayerDataError, match="levelLink"):
        load_player_data(path)


def test_link_excluded_unit_keeps_its_own_level(tmp_path):
    stored = linked(PLAYER_DATA, level=260)
    stored["units"] = {"UNIT_A": {**stored["units"]["UNIT_A"], "linkExcluded": True}}
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, stored))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 240


def test_level_link_disabled_keeps_the_stored_level(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, linked(PLAYER_DATA, level=260, enabled=False)))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 240


def test_export_without_the_level_link_fields_is_still_readable(tmp_path):
    """リンク導入前に書き出した player-data.json をそのまま読める（取り直させない）。"""
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 240


def test_link_level_out_of_range_falls_back_to_the_stored_level(tmp_path):
    # `03_API・データ連携設計.md` §3.1: リンクレベルが1以上の整数でない間は
    # リンクを適用せず枠の値を使う。UIとlabで実効レベルが割れないようにする。
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, linked(PLAYER_DATA, level=0)))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 240


def test_yaml_level_wins_over_the_link_level(tmp_path):
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      level: 1",
        1,
    ).replace(
        "ally:\n",
        "ally:\n  academyLevels:\n    unitTypes: { PHYSICAL: 3 }\n",
        1,
    )
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    data = load_player_data(write_json(tmp_path, linked(PLAYER_DATA, level=260)))

    applied, _ = apply_player_data(config, data)

    assert level_of(applied) == 1


def linked(player_data, *, level: int, enabled: bool = True):
    return {**player_data, "levelLink": {"enabled": enabled, "level": level}}


def level_of(config) -> int:
    units = build_evaluation_request(config, runs_per_candidate=1, seed="s")["candidates"][0][
        "allyFormation"
    ]["units"]
    return units[0]["enhancement"]["level"]


def test_unknown_schema_version_is_rejected(tmp_path):
    path = write_json(tmp_path, {**PLAYER_DATA, "schemaVersion": 2})

    with pytest.raises(PlayerDataError, match="schemaVersion"):
        load_player_data(path)


def write(tmp_path, name: str, text: str):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def write_json(tmp_path, value):
    return write(tmp_path, "player-data.json", json.dumps(value))
