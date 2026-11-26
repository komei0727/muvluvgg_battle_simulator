"""ブラウザ localStorage `mlgg:player-data` エクスポートの取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `StoredPlayerData`。
"""

import json

import pytest

from mlgg_lab_common.inputs.player_data import PlayerDataError, apply_player_data, load_player_data
from mlgg_lab_common.inputs.yaml_io import load_yaml_mapping
from mlgg_lab_common.models import FormationSpec, build_formation_request, validate_formation


def load_formation_config(path):
    """YAMLの `ally` を1編成として読む。手持ちデータの適用は陣営に依らないので、
    書き慣れた演習の編成YAMLの形をそのまま入力に使う（`enemy` は読まない）。"""
    formation = FormationSpec.model_validate(load_yaml_mapping(path)["ally"])
    validate_formation(formation, path)
    return formation


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

    units = build_formation_request(applied)["units"]
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

    formation = build_formation_request(applied)
    assert formation["enhancement"]["academyLevels"]["unitTypes"]["ENERGY"] == 55
    assert formation["enhancement"]["academyLevels"]["attributes"]["CLEVER"] == 35


def test_unit_absent_from_player_data_is_warned_and_left_at_defaults(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, warnings = apply_player_data(config, data)

    assert any("UNIT_MISSING" in warning for warning in warnings)
    units = build_formation_request(applied)["units"]
    assert "enhancement" not in units[1]


def test_stored_rank_is_applied_to_the_matching_unit(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": 3}},
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert units[0]["enhancement"]["rank"] == 3


def test_export_without_the_rank_field_defaults_to_five(tmp_path):
    """ランク導入前に書き出した player-data.json をそのまま読める（取り直させない）。"""
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
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


@pytest.mark.parametrize(
    "rank",
    [
        pytest.param(True, id="bool"),
        pytest.param(3.0, id="float"),
        pytest.param("3", id="numeric-string"),
    ],
)
def test_stored_rank_that_is_not_a_strict_integer_is_rejected(tmp_path, rank):
    # `rank` は契約上「0〜5の整数」。Pydanticの標準変換だとbool・float・数値文字列まで
    # 整数として通ってしまい、`3` と `"3"` の取り違えのような入力ミスに気づけなくなる。
    player_data = {
        **PLAYER_DATA,
        "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "rank": rank}},
    }

    with pytest.raises(PlayerDataError, match="rank"):
        load_player_data(write_json(tmp_path, player_data))


# R-ENH-08: モジュール補正のリクエスト上書き。手持ちデータの `ratio` はUI表示の
# パーセント単位（`persistence.ts` の `ModuleStatOverrideInput`）で保存されている。
def test_stored_module_is_applied_and_the_ratio_is_converted_from_percent_to_the_internal_decimal(
    tmp_path,
):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    player_data = {
        **PLAYER_DATA,
        "units": {
            "UNIT_A": {
                **PLAYER_DATA["units"]["UNIT_A"],
                "module": {
                    "hp": {"fixed": 5000, "ratio": 10},
                    "attack": {"fixed": "", "ratio": ""},
                    "defense": {"fixed": "", "ratio": -5},
                },
            }
        },
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert units[0]["enhancement"]["module"] == {
        "hp": {"fixed": 5000, "ratio": 0.1},
        "defense": {"ratio": -0.05},
    }


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(float("inf"), id="inf"),
        pytest.param(float("-inf"), id="neg-inf"),
        pytest.param(float("nan"), id="nan"),
    ],
)
def test_stored_module_with_a_non_finite_value_is_rejected(tmp_path, value):
    # R-ENH-08は有限の実数だけを許可する。Pythonの`json`は`Infinity`/`NaN`を非標準
    # 拡張として読めてしまうため、pydantic側で明示的に弾く必要がある。
    player_data = {
        **PLAYER_DATA,
        "units": {
            "UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "module": {"hp": {"fixed": value}}},
        },
    }

    with pytest.raises(PlayerDataError, match="finite"):
        load_player_data(write_json(tmp_path, player_data))


def test_stored_module_with_every_field_blank_is_omitted(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    player_data = {
        **PLAYER_DATA,
        "units": {
            "UNIT_A": {
                **PLAYER_DATA["units"]["UNIT_A"],
                "module": {
                    "hp": {"fixed": "", "ratio": ""},
                    "attack": {"fixed": "", "ratio": ""},
                    "defense": {"fixed": "", "ratio": ""},
                },
            }
        },
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert "module" not in units[0]["enhancement"]


def test_export_without_the_module_field_defaults_to_no_override(tmp_path):
    """`module` 導入前に書き出した player-data.json をそのまま読める（取り直させない）。"""
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert "module" not in units[0]["enhancement"]


def test_yaml_module_wins_over_the_stored_module(tmp_path):
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n      module: { hp: { fixed: 1 } }",
        1,
    ).replace(
        "ally:\n",
        "ally:\n  academyLevels:\n    unitTypes: { PHYSICAL: 3 }\n",
        1,
    )
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    player_data = {
        **PLAYER_DATA,
        "units": {
            "UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], "module": {"hp": {"fixed": 9999}}},
        },
    }
    data = load_player_data(write_json(tmp_path, player_data))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert units[0]["enhancement"]["module"] == {"hp": {"fixed": 1}}


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

    units = build_formation_request(applied)["units"]
    assert units[0]["enhancement"]["rank"] == 1


def test_an_explicit_zero_is_kept_and_not_treated_as_unspecified(tmp_path):
    """`0` は「書かなかった」ではない。手持ちの値で上書きせず、そのまま送る。"""
    yaml_text = CONFIG_YAML.replace(
        "      position: { column: 0, row: FRONT }",
        "      position: { column: 0, row: FRONT }\n"
        "      rank: 0\n"
        "      module: { hp: { fixed: 0, ratio: 0 } }",
        1,
    ).replace("ally:\n", "ally:\n  academyLevels: {}\n", 1)
    config = load_formation_config(write(tmp_path, "formation.yaml", yaml_text))
    stored = {**PLAYER_DATA["units"]["UNIT_A"], "rank": 3}
    stored["module"] = {"hp": {"fixed": 900, "ratio": 20}}
    data = load_player_data(
        write_json(tmp_path, {**PLAYER_DATA, "units": {**PLAYER_DATA["units"], "UNIT_A": stored}})
    )

    applied, _ = apply_player_data(config, data)

    enhancement = build_formation_request(applied)["units"][0]["enhancement"]
    assert enhancement["rank"] == 0
    assert enhancement["module"] == {"hp": {"fixed": 0, "ratio": 0}}


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

    formation = build_formation_request(applied)
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

    units = build_formation_request(applied)["units"]
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
    units = build_formation_request(config)["units"]
    return units[0]["enhancement"]["level"]


def test_unknown_schema_version_is_rejected(tmp_path):
    path = write_json(tmp_path, {**PLAYER_DATA, "schemaVersion": 2})

    with pytest.raises(PlayerDataError, match="schemaVersion"):
        load_player_data(path)


def test_unknown_keys_in_the_player_data_are_rejected(tmp_path):
    """未知キーは読み飛ばさず落とす。UIが新項目を書き始めたら、ここを先に対応させる
    （`docs/ui-design/01_UI要求・画面設計.md` の互換方針）。"""
    path = write_json(tmp_path, {**PLAYER_DATA, "futureField": 1})

    with pytest.raises(PlayerDataError, match="futureField"):
        load_player_data(path)


def test_a_player_data_file_that_is_not_json_is_an_explained_error(tmp_path):
    path = write(tmp_path, "player-data.json", "{not json")

    with pytest.raises(PlayerDataError, match="JSON"):
        load_player_data(path)


def test_two_slots_of_the_same_unit_are_resolved_independently(tmp_path):
    """手持ちデータの記録はIDで引くが、編成の枠はIDで同一視しない。

    片方の枠へ明示したレベルはその枠だけのもので、もう片方は手持ちの値で埋まる。
    """
    config = load_formation_config(
        write(
            tmp_path,
            "formation.yaml",
            """
ally:
  academyLevels: {}
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
      level: 300
    - unitDefinitionId: UNIT_A
      position: { column: 1, row: FRONT }
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
""",
        )
    )
    data = load_player_data(write_json(tmp_path, PLAYER_DATA))

    applied, _ = apply_player_data(config, data)

    units = build_formation_request(applied)["units"]
    assert [unit["position"]["column"] for unit in units] == [0, 1]
    assert [unit["enhancement"]["level"] for unit in units] == [300, 240]
    # ギアは未指定の両枠へ手持ちから入る。
    assert units[0]["enhancement"]["gears"] == units[1]["enhancement"]["gears"]


def write(tmp_path, name: str, text: str):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def write_json(tmp_path, value):
    return write(tmp_path, "player-data.json", json.dumps(value))


@pytest.mark.parametrize(
    ("stored", "field"),
    [({"level": 0}, "level"), ({"level": -5}, "level")],
)
def test_stored_values_outside_the_formation_model_are_rejected_when_applied(
    tmp_path, stored, field
):
    """手持ちデータの読み込みは通っても、適用後の編成は `FormationUnitSpec` の制約を満たす。

    `model_copy` は検証を通らないため、ここで落とさないと解決済み入力が保存できて
    しまい、再読み込みで初めて失敗する。
    """
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    raw = {**PLAYER_DATA, "units": {"UNIT_A": {**PLAYER_DATA["units"]["UNIT_A"], **stored}}}
    data = load_player_data(write(tmp_path, "player-data.json", json.dumps(raw)))

    with pytest.raises(PlayerDataError, match=rf"UNIT_A.*{field}"):
        apply_player_data(config, data)


def test_a_level_link_below_one_falls_back_and_is_never_applied(tmp_path):
    config = load_formation_config(write(tmp_path, "formation.yaml", CONFIG_YAML))
    raw = {**PLAYER_DATA, "levelLink": {"enabled": True, "level": 0}}
    data = load_player_data(write(tmp_path, "player-data.json", json.dumps(raw)))

    applied, _ = apply_player_data(config, data)

    assert [unit.level for unit in applied.units] == [240, 200]
