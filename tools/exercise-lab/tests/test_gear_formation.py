"""基点編成とギア配分の橋渡し。送信JSONの組み立ては編成定義と同じ経路を通す。"""

import pytest
import yaml

from exercise_lab.gear.allocation import Allocation, GearPiece, UnitAllocation
from exercise_lab.gear.formation import GearFormationSource, base_allocation
from exercise_lab.models import ConfigError, load_formation_config


def write_formation(tmp_path, *, academy=True, gears=None):
    unit = {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}
    if academy:
        unit["level"] = 250
        unit["gears"] = (
            gears if gears is not None else [{"stat": "ATTACK", "tier": "III", "grade": "S"}]
        )
    document = {
        "ally": {
            "units": [
                unit,
                {"unitDefinitionId": "UNIT_B", "position": {"column": 1, "row": "REAR"}},
            ],
            "memoryDefinitionIds": ["MEM_1"],
        },
        "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "REAR"}},
    }
    if academy:
        document["ally"]["academyLevels"] = {"unitTypes": {"PHYSICAL": 50}, "attributes": {}}
    path = tmp_path / "formation.yaml"
    path.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")
    return load_formation_config(path)


def test_the_base_allocation_follows_the_formation_order(tmp_path):
    config = write_formation(tmp_path)

    allocation = base_allocation(config)

    assert [unit.unit_definition_id for unit in allocation.units] == ["UNIT_A", "UNIT_B"]
    assert allocation.units[0].pieces == (GearPiece(stat="ATTACK", tier="III", grade="S"),)
    assert allocation.units[1].pieces == ()


def test_the_allocation_replaces_the_gears_of_the_sent_formation(tmp_path):
    source = GearFormationSource(write_formation(tmp_path))
    allocation = Allocation(
        (
            UnitAllocation("UNIT_A", (GearPiece(stat="CRITICAL_RATE", tier="II", grade="D"),)),
            UnitAllocation("UNIT_B", (GearPiece(stat="ATTACK", tier="III", grade="A"),)),
        )
    )

    formation = source.ally_formation(allocation)

    assert [unit["enhancement"]["gears"] for unit in formation["units"]] == [
        [{"stat": "CRITICAL_RATE", "tier": "II", "grade": "D"}],
        [{"stat": "ATTACK", "tier": "III", "grade": "A"}],
    ]
    # レベル・メモリー・敵は基点のまま固定する（探索変数はギア配分だけ）。
    assert formation["units"][0]["enhancement"]["level"] == 250
    assert formation["memoryDefinitionIds"] == ["MEM_1"]
    assert source.enemy_formation()["units"][0]["unitDefinitionId"] == "UNIT_ENEMY"


def test_a_formation_without_academy_levels_is_rejected(tmp_path):
    config = write_formation(tmp_path, academy=False)

    with pytest.raises(ConfigError) as error:
        GearFormationSource(config)

    assert "academyLevels" in str(error.value)


def test_a_base_allocation_that_breaks_the_rule_is_rejected_before_any_request(tmp_path):
    config = write_formation(
        tmp_path,
        gears=[{"stat": "ATTACK", "tier": "III", "grade": grade} for grade in "SABC"],
    )

    with pytest.raises(ConfigError) as error:
        GearFormationSource(config)

    assert "R-ENH-04" in str(error.value)
