"""陣営に依らない編成モデルの意味の保持。

- 強化指定の省略（`None`）と空の指定（`{}` / `[]`）を混同しない
- 手持ちデータの適用は値の解決であり、もう一度当てても変わらない（単位変換が二重に掛からない）
- 解決済み入力のJSON往復で意味が変わらない
"""

import json
from typing import Literal

import pytest

from mlgg_lab_common.inputs.player_data import PlayerData, apply_player_data
from mlgg_lab_common.models import (
    AcademyLevels,
    ConfigError,
    FormationSpec,
    ResolvedInput,
    build_formation_request,
    dump_resolved_input,
    load_resolved_input,
    revalidated,
    validate_formation,
)


def formation(**fields):
    return FormationSpec.model_validate(
        {
            "units": [
                {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
                {"unitDefinitionId": "UNIT_A", "position": {"column": 1, "row": "FRONT"}},
            ],
            "memoryDefinitionIds": ["MEM_Z", "MEM_A"],
            **fields,
        }
    )


PLAYER_DATA = PlayerData.model_validate(
    {
        "schemaVersion": 1,
        "academyLevels": {"unitTypes": {"PHYSICAL": 50}, "attributes": {}},
        "units": {
            "UNIT_A": {
                "level": 250,
                "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}] + [None] * 8,
                "module": {"attack": {"fixed": "", "ratio": 10}},
            }
        },
    }
)


class Document(ResolvedInput):
    format: Literal["TEST"] = "TEST"
    formation: FormationSpec


def round_trip(spec: FormationSpec) -> FormationSpec:
    text = dump_resolved_input(Document(formation=spec))
    return load_resolved_input(Document, text, where="test").formation


def test_an_omitted_side_enhancement_sends_no_enhancement():
    assert "enhancement" not in build_formation_request(formation())


def test_an_empty_academy_levels_enables_enhancement_at_level_one():
    request = build_formation_request(formation(academyLevels={}))

    assert request["enhancement"]["academyLevels"]["unitTypes"] == {
        "PHYSICAL": 1,
        "ENERGY": 1,
        "AGILE": 1,
    }


def test_player_data_does_not_replace_an_explicitly_empty_academy_levels():
    applied, _ = apply_player_data(formation(academyLevels={}), PLAYER_DATA)

    assert applied.academy_levels == AcademyLevels()


def test_explicitly_no_gears_is_kept_apart_from_unspecified_gears():
    spec = formation(academyLevels={})
    spec.units[0].gears = []

    applied, _ = apply_player_data(spec, PLAYER_DATA)

    assert applied.units[0].gears == []
    assert applied.units[1].gears is not None and len(applied.units[1].gears) == 1


def test_applying_player_data_twice_changes_nothing():
    once, _ = apply_player_data(formation(), PLAYER_DATA)
    twice, _ = apply_player_data(once, PLAYER_DATA)

    assert twice == once
    # 手持ちのパーセント（10）は1回だけ小数へ変換される。
    module = build_formation_request(twice)["units"][0]["enhancement"]["module"]
    assert module == {"attack": {"ratio": 0.1}}


@pytest.mark.parametrize(
    "spec",
    [
        formation(),
        formation(academyLevels={}),
        apply_player_data(formation(), PLAYER_DATA)[0],
        apply_player_data(formation(academyLevels={}), PLAYER_DATA)[0],
    ],
    ids=["no-enhancement", "empty-academy", "applied", "applied-over-empty"],
)
def test_the_json_round_trip_keeps_the_model_and_the_request(spec):
    reloaded = round_trip(spec)

    assert reloaded == spec
    assert build_formation_request(reloaded) == build_formation_request(spec)


def test_the_round_trip_keeps_empty_gears_distinct_from_unspecified():
    spec = formation(academyLevels={})
    spec.units[0].gears = []

    reloaded = round_trip(spec)

    assert reloaded.units[0].gears == []
    assert reloaded.units[1].gears is None


def test_the_dump_keeps_unit_and_memory_order():
    payload = json.loads(dump_resolved_input(Document(formation=formation())))

    assert payload["formation"]["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert [u["position"]["column"] for u in payload["formation"]["units"]] == [0, 1]


def test_an_unknown_resolved_schema_version_is_rejected():
    text = json.dumps({"schemaVersion": 2, "format": "TEST", "formation": {}})

    with pytest.raises(ConfigError, match="schemaVersion=2"):
        load_resolved_input(Document, text, where="saved.json")


def test_duplicate_positions_within_a_formation_are_rejected():
    spec = formation()
    spec.units[1].position = spec.units[0].position

    with pytest.raises(ConfigError, match="配置が重複"):
        validate_formation(spec, "ally")


def test_the_same_definition_may_fill_several_slots():
    validate_formation(formation(), "ally")


def test_a_document_built_from_unvalidated_instances_is_caught_before_it_is_saved():
    """インスタンスを渡して組み立てた解決済み入力は内側が再検証されないので、
    保存前に読み戻しと同じ検証へ通す。"""
    spec = formation().model_copy(
        update={"units": [formation().units[0].model_copy(update={"level": 0})]}
    )
    document = Document(formation=spec)

    with pytest.raises(ConfigError, match="level"):
        revalidated(document)
    with pytest.raises(ConfigError):
        load_resolved_input(Document, dump_resolved_input(document), where="saved.json")


def test_revalidating_a_valid_document_keeps_it_equal():
    document = Document(formation=apply_player_data(formation(), PLAYER_DATA)[0])

    assert revalidated(document) == document
