"""探索問題・候補・候補操作・制約検証。"""

import pytest

from mlgg_lab_common.inputs.player_data import PlayerData
from mlgg_lab_common.models import Gear, Position
from mlgg_lab_common.search import operations as ops
from mlgg_lab_common.search.candidate import (
    Candidate,
    CandidateUnit,
    candidate_id,
    materialize,
)
from mlgg_lab_common.search.constraints import (
    candidate_problems,
    check_candidate,
    problem_problems,
)
from mlgg_lab_common.search.problem import (
    AllyTraining,
    SearchProblem,
    UnitTraining,
    dump_problem,
    load_problem,
)
from mlgg_lab_common.search.training import training_from_player_data
from mlgg_lab_common.testing import FakeBattleSearchAdapter

ADAPTER = FakeBattleSearchAdapter()
F0, F1, F2 = (Position(column=c, row="FRONT") for c in range(3))
R0 = Position(column=0, row="REAR")
G_ATK = Gear(stat="ATTACK", tier="III", grade="S")
G_HP = Gear(stat="MAXIMUM_HP", tier="II", grade="A")


def candidate(*units, memories=()):
    return Candidate(
        units=tuple(
            CandidateUnit(unitDefinitionId=u[0], position=u[1], gears=u[2] if len(u) > 2 else None)
            for u in units
        ),
        memoryDefinitionIds=tuple(memories),
    )


START = candidate(("UNIT_A", F0), ("UNIT_B", F1), memories=["MEM_X", "MEM_Y"])


def problem(**overrides):
    payload = {
        "format": "BATTLE",
        "fixed": {
            "enemyFormation": {
                "units": [{"unitDefinitionId": "UNIT_E", "position": {"column": 1, "row": "FRONT"}}]
            },
            "turnLimit": 5,
        },
        "training": {
            "academyLevels": {"unitTypes": {"PHYSICAL": 10}},
            "units": {
                "UNIT_A": {"level": 300, "rank": 3, "gears": [G_ATK.model_dump()]},
                "UNIT_B": {"level": 250},
                "UNIT_C": {"level": 400, "gears": []},
            },
        },
        "space": {
            "unitPool": ["UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D"],
            "memoryPool": ["MEM_X", "MEM_Y", "MEM_Z"],
        },
        "starts": [START.model_dump(by_alias=True)],
        "execution": {
            "candidateSeed": "gen-1",
            "battleSeed": "battle-1",
            "budget": {"maxSubmittedRuns": 100},
        },
        "method": {
            "proposer": {"componentId": "p", "version": "1"},
            "allocator": {"componentId": "a", "version": "1"},
            "estimator": {"componentId": "e", "version": "1"},
        },
    }
    # 探索範囲・ギア条件は既定へ足し込み、それ以外は丸ごと置き換える。
    for key, value in overrides.items():
        if key in ("space", "gear") and isinstance(payload.get(key), dict):
            payload[key] = {**payload[key], **value}
        else:
            payload[key] = value
    return SearchProblem.model_validate(payload)


# -- 探索問題 ------------------------------------------------------------------


def test_problem_round_trips_through_json_without_changing_meaning():
    original = problem(
        gear={"mode": "ADJUSTABLE", "resourceLimits": [{"tier": "III", "maxCount": 2}]}
    )
    restored = load_problem(dump_problem(original))

    assert restored == original
    assert restored.starts[0].candidate_id == START.candidate_id


def test_an_unknown_problem_format_version_is_not_read():
    payload = dump_problem(problem())
    payload["problemFormatVersion"] = 2
    with pytest.raises(ValueError, match="problemFormatVersion"):
        load_problem(payload)


def test_problem_validation_reports_inconsistent_ranges_and_illegal_starts():
    assert problem_problems(problem(), ADAPTER) == []
    broken = problem(
        space={
            "unitPool": ["UNIT_A", "UNIT_A"],
            "minUnits": 4,
            "maxUnits": 2,
            "fixedUnits": [{"unitDefinitionId": "UNIT_Z"}],
        },
        fixed={"turnLimit": 5},
    )
    problems = problem_problems(broken, ADAPTER)
    assert any("enemyFormation が無い" in p for p in problems)
    assert any("minUnits 4" in p for p in problems)
    assert any("UNIT_A が重複" in p for p in problems)
    assert any("UNIT_Z が使用可能プールに無い" in p for p in problems)

    illegal_start = problem(starts=[candidate(("UNIT_Q", F0)).model_dump(by_alias=True)])
    assert problem_problems(illegal_start, ADAPTER) == [
        "starts[0]: units[0]: UNIT_Q は使用可能プールに無い"
    ]


def test_gear_adjustment_requires_the_enhancement_calculation():
    no_enhancement = problem(training={"units": {}}, gear={"mode": "ADJUSTABLE"}, starts=[])
    assert any("academyLevels が要る" in p for p in problem_problems(no_enhancement, ADAPTER))


# -- 候補の識別・展開 ----------------------------------------------------------


def test_candidate_identity_keeps_order_positions_and_gear_meaning():
    swapped_memories = candidate(("UNIT_A", F0), ("UNIT_B", F1), memories=["MEM_Y", "MEM_X"])
    reordered_units = candidate(("UNIT_B", F1), ("UNIT_A", F0), memories=["MEM_X", "MEM_Y"])
    no_gear = candidate(("UNIT_A", F0, ()), ("UNIT_B", F1), memories=["MEM_X", "MEM_Y"])

    ids = {c.candidate_id for c in (START, swapped_memories, reordered_units, no_gear)}
    assert len(ids) == 4
    # 内容が同じなら同じID（作り方に依らない）。
    rebuilt = Candidate.model_validate(START.model_dump(by_alias=True))
    assert candidate_id(rebuilt) == START.candidate_id


def test_materialize_applies_training_by_unit_and_keeps_order():
    formation = materialize(problem(), START)

    assert [u.unit_definition_id for u in formation.units] == ["UNIT_A", "UNIT_B"]
    assert formation.memory_definition_ids == ["MEM_X", "MEM_Y"]
    assert formation.academy_levels.unit_types == {"PHYSICAL": 10}
    a, b = formation.units
    assert (a.level, a.rank, a.gears) == (300, 3, [G_ATK])
    # 育成条件に書いていない項目は未指定のまま（APIの既定値）。
    assert (b.level, b.rank, b.gears) == (250, None, None)


def test_training_follows_the_unit_after_a_swap_not_the_slot():
    swapped = ops.replace_unit(START, 0, "UNIT_C")
    formation = materialize(problem(), swapped)

    c = formation.units[0]
    assert (c.unit_definition_id, c.position, c.level, c.gears) == ("UNIT_C", F0, 400, [])
    # 手持ちに無いユニットは育成条件も空（APIの既定値）。
    assert materialize(problem(), ops.replace_unit(START, 0, "UNIT_D")).units[0].level is None


# -- 候補操作 --------------------------------------------------------------------


def test_unit_operations_keep_untouched_slots_and_order():
    added = ops.add_unit(START, "UNIT_C", R0)
    assert added.unit_ids() == ["UNIT_A", "UNIT_B", "UNIT_C"]
    assert added.memory_definition_ids == START.memory_definition_ids

    moved = ops.move_unit(START, 1, F2)
    assert [(u.unit_definition_id, u.position) for u in moved.units] == [
        ("UNIT_A", F0),
        ("UNIT_B", F2),
    ]
    swapped = ops.swap_positions(START, 0, 1)
    assert [(u.unit_definition_id, u.position) for u in swapped.units] == [
        ("UNIT_A", F1),
        ("UNIT_B", F0),
    ]
    assert ops.remove_unit(START, 0).unit_ids() == ["UNIT_B"]
    # 元の候補は変わらない。
    assert START.unit_ids() == ["UNIT_A", "UNIT_B"]


def test_unit_operations_reject_shape_violations():
    with pytest.raises(ops.OperationError, match="埋まっている"):
        ops.move_unit(START, 0, F1)
    with pytest.raises(ops.OperationError, match="埋まっている"):
        ops.add_unit(START, "UNIT_C", F0)
    with pytest.raises(ops.OperationError, match="範囲外"):
        ops.replace_unit(START, 2, "UNIT_C")
    with pytest.raises(ops.OperationError, match="最後の1体"):
        ops.remove_unit(ops.remove_unit(START, 0), 0)
    full = START
    for position in (F2, R0, Position(column=1, row="REAR")):
        full = ops.add_unit(full, "UNIT_C", position)
    with pytest.raises(ops.OperationError, match="5体まで"):
        ops.add_unit(full, "UNIT_D", Position(column=2, row="REAR"))


def test_memory_operations_select_swap_and_reorder():
    assert ops.add_memory(START, "MEM_Z").memory_definition_ids == ("MEM_X", "MEM_Y", "MEM_Z")
    assert ops.add_memory(START, "MEM_Z", 0).memory_definition_ids == ("MEM_Z", "MEM_X", "MEM_Y")
    assert ops.replace_memory(START, 1, "MEM_Z").memory_definition_ids == ("MEM_X", "MEM_Z")
    assert ops.swap_memories(START, 0, 1).memory_definition_ids == ("MEM_Y", "MEM_X")
    three = ops.add_memory(START, "MEM_Z")
    assert ops.move_memory(three, 2, 0).memory_definition_ids == ("MEM_Z", "MEM_X", "MEM_Y")
    assert ops.remove_memory(START, 0).memory_definition_ids == ("MEM_Y",)
    with pytest.raises(ops.OperationError, match="範囲外"):
        ops.remove_memory(START, 2)


def test_replacing_a_unit_does_not_carry_slot_gears_to_the_new_unit():
    tuned = ops.set_gears(START, 0, [G_HP])
    assert tuned.units[0].gears == (G_HP,)
    assert ops.replace_unit(tuned, 0, "UNIT_C").units[0].gears is None
    # ギアは移動・配置交換では枠のユニットに付いたまま。
    assert ops.swap_positions(tuned, 0, 1).units[0].gears == (G_HP,)
    assert ops.set_gears(tuned, 0, None).units[0].gears is None


def test_empty_positions_respect_the_allowed_positions():
    assert len(ops.empty_positions(START)) == 4
    assert ops.empty_positions(START, [F0, F2]) == [F2]


# -- 制約 --------------------------------------------------------------------------


def test_pool_count_duplicate_and_position_constraints():
    p = problem(
        space={
            "maxUnits": 2,
            "allowedPositions": [F0.model_dump(), F1.model_dump(), F2.model_dump()],
        }
    )
    assert candidate_problems(p, START) == []

    too_many = ops.add_unit(START, "UNIT_C", R0)
    problems = candidate_problems(p, too_many)
    assert any("ユニット数 3" in x for x in problems)
    assert any("row=REAR は許可されていない" in x for x in problems)

    duplicated = ops.replace_unit(START, 1, "UNIT_A")
    assert any("UNIT_A が 2 枠" in x for x in candidate_problems(p, duplicated))
    allowed = problem(space={"allowDuplicateUnits": True})
    assert candidate_problems(allowed, duplicated) == []

    outsider = ops.replace_unit(START, 1, "UNIT_Q")
    assert candidate_problems(p, outsider) == ["units[1]: UNIT_Q は使用可能プールに無い"]


def test_fixed_units_and_memories_must_stay_where_they_are_fixed():
    p = problem(
        space={
            "fixedUnits": [{"unitDefinitionId": "UNIT_A", "position": F0.model_dump()}],
            "fixedMemories": [{"memoryDefinitionId": "MEM_X", "index": 0}],
        }
    )
    assert candidate_problems(p, START) == []
    assert candidate_problems(p, ops.move_unit(START, 0, F2)) == [
        "固定ユニット UNIT_A が固定した配置（column=0, row=FRONT）に無い"
    ]
    assert candidate_problems(p, ops.replace_unit(START, 0, "UNIT_C")) == [
        "固定ユニット UNIT_A が無い"
    ]
    assert candidate_problems(p, ops.swap_memories(START, 0, 1)) == [
        "固定メモリー MEM_X が固定した位置 0 に無い"
    ]


def test_memory_pool_count_and_duplicates():
    p = problem(space={"maxMemories": 2})
    assert candidate_problems(p, ops.add_memory(START, "MEM_Z")) == ["メモリー数 3 が 0～2 の外"]
    assert candidate_problems(p, ops.replace_memory(START, 1, "MEM_X")) == [
        "メモリー MEM_X が 2 件ある（重複を許していない）"
    ]
    assert candidate_problems(p, ops.replace_memory(START, 1, "MEM_Q")) == [
        "memoryDefinitionIds[1]: MEM_Q は使用可能プールに無い"
    ]


def test_fixed_gear_mode_rejects_any_gear_change():
    p = problem()
    assert candidate_problems(p, ops.set_gears(START, 0, [G_ATK])) == [
        "units[0]: ギア固定の探索でギアを変更している（UNIT_A）"
    ]
    # 固定モードで送るのは育成条件のギアそのもの。
    assert materialize(p, START).units[0].gears == [G_ATK]


def test_adjustable_gears_respect_allowed_ranges_and_resource_limits():
    p = problem(
        gear={
            "mode": "ADJUSTABLE",
            "adjustableUnitIds": ["UNIT_B"],
            "allowedTiers": ["II"],
            "maxGearsPerUnit": 2,
            "resourceLimits": [{"stat": "ATTACK", "maxCount": 1}],
        }
    )
    ok = ops.set_gears(START, 1, [G_HP, G_HP])
    assert candidate_problems(p, ok) == []
    assert materialize(p, ok).units[1].gears == [G_HP, G_HP]

    problems = candidate_problems(p, ops.set_gears(START, 0, [G_ATK, G_ATK, G_ATK]))
    assert "units[0]（UNIT_A）: ギアを調整してよいユニットではない" in problems
    assert "units[0]（UNIT_A）: ギア 3 個が上限 2 を超える" in problems
    assert "units[0]（UNIT_A）.gears[0]: 段階 III は許可されていない" in problems
    # 資源は実際に送るギア（調整していないユニットの育成条件のギアも）で数える。
    attack_on_b = ops.set_gears(START, 1, [Gear(stat="ATTACK", tier="II", grade="A")])
    assert candidate_problems(p, attack_on_b) == ["ギア資源の上限を超える（ATTACK: 2 個 > 1 個）"]


def test_format_adapter_checks_run_after_the_common_constraints():
    p = problem()
    assert check_candidate(p, ADAPTER, START) == []
    # 共通の制約で落ちた候補は対戦入力を組み立てない。
    assert check_candidate(p, ADAPTER, ops.replace_unit(START, 0, "UNIT_Q")) == [
        "units[0]: UNIT_Q は使用可能プールに無い"
    ]
    # 共通の制約は通るが形式の受理条件（強化計算なしで育成値）で落ちる組み合わせ。
    inconsistent = problem(training={"units": {"UNIT_A": {"level": 1}}})
    assert check_candidate(inconsistent, ADAPTER, START)[0].startswith("対戦入力として成立しない")


# -- 育成条件 --------------------------------------------------------------------


def test_training_from_player_data_resolves_every_pool_unit_once():
    data = PlayerData.model_validate(
        {
            "schemaVersion": 1,
            "academyLevels": {"unitTypes": {"ENERGY": 50}, "attributes": {}},
            "levelLink": {"enabled": True, "level": 350},
            "units": {
                "UNIT_A": {"level": 200, "rank": 4, "gears": [G_ATK.model_dump(), None]},
                "UNIT_B": {"level": 210, "linkExcluded": True, "gears": []},
            },
        }
    )
    training, warnings = training_from_player_data(["UNIT_A", "UNIT_B", "UNIT_C", "UNIT_A"], data)

    assert training.academy_levels.unit_types == {"ENERGY": 50}
    assert training.units["UNIT_A"] == UnitTraining(level=350, rank=4, gears=[G_ATK])
    assert training.units["UNIT_B"] == UnitTraining(level=210, rank=5, gears=[])
    # 手持ちに無いユニットもリンクのレベルで評価する（警告は残す）。
    assert training.units["UNIT_C"].level == 350
    assert training.units["UNIT_C"].gears is None
    assert len(warnings) == 1 and "UNIT_C" in warnings[0]
    assert isinstance(training, AllyTraining)


def test_resource_limits_apply_to_the_training_gears_in_fixed_mode_too():
    # ギアを変えなくても、ユニット選抜で編成全体のギア使用量は変わる。
    p = problem(gear={"mode": "FIXED", "resourceLimits": [{"maxCount": 0}]}, starts=[])
    assert candidate_problems(p, START) == ["ギア資源の上限を超える（全ギア: 1 個 > 0 個）"]
    without_geared_unit = ops.replace_unit(START, 0, "UNIT_D")
    assert candidate_problems(p, without_geared_unit) == []
    # 起点が上限を超える探索問題は作れない。
    assert problem_problems(
        problem(gear={"mode": "FIXED", "resourceLimits": [{"maxCount": 0}]}), ADAPTER
    ) == ["starts[0]: ギア資源の上限を超える（全ギア: 1 個 > 0 個）"]
