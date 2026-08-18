"""探索設定YAMLの読み込みと、候補から編成リクエストへの変換。"""

import json
from pathlib import Path

import pytest
import yaml

from exercise_lab.models import ConfigError, build_ally_formation
from exercise_lab.optimize.candidate import Candidate, Cell, Placement
from exercise_lab.optimize.search_config import (
    load_search_config,
    resolve_unit_enhancements,
)
from exercise_lab.player_data import load_player_data

MINIMAL = {
    "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "REAR"}},
    "unitPool": ["UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F"],
    "memoryPool": ["MEM_1", "MEM_2", "MEM_3", "MEM_4", "MEM_5", "MEM_6", "MEM_7"],
}


def write(tmp_path, document, name="search.yaml"):
    path = tmp_path / name
    path.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")
    return path


def load(tmp_path, **overrides):
    return load_search_config(write(tmp_path, {**MINIMAL, **overrides}))


def test_minimal_config_fills_the_documented_defaults(tmp_path):
    config = load(tmp_path)

    assert config.objective_spec.best_of == 5
    assert config.objective_spec.expected_weight == 0.5
    assert config.objective_spec.guard_quantile == 0.25
    assert config.schedule.stage_runs == (8, 24, 72)
    assert config.schedule.population_size == 40
    assert config.schedule.final_stage_runs == (50, 100)
    assert config.schedule.top_k == 5


def test_unknown_top_level_key_is_rejected(tmp_path):
    with pytest.raises(ConfigError):
        load(tmp_path, unknownKey=1)


def test_objective_reads_lambda_under_its_yaml_name(tmp_path):
    config = load(tmp_path, objective={"bestOf": 3, "lambda": 0.25, "guardQuantile": 0.4})

    assert config.objective_spec.best_of == 3
    assert config.objective_spec.expected_weight == 0.25
    assert config.objective.best_of == 3
    assert config.objective.expected_weight == 0.25
    assert config.objective.guard_quantile == 0.4


def test_constraints_become_the_search_constraints(tmp_path):
    config = load(
        tmp_path,
        constraints={
            "allowDuplicateUnits": True,
            "fixedPlacements": [
                {"unitDefinitionId": "UNIT_A", "position": {"column": 2, "row": "FRONT"}}
            ],
            "requiredUnits": ["UNIT_B"],
            "requiredMemories": ["MEM_1"],
        },
    )

    constraints = config.constraints
    assert constraints.allow_duplicate_units is True
    assert constraints.fixed_placements == (Placement("UNIT_A", Cell(column=2, row="FRONT")),)
    assert constraints.required_units == ("UNIT_B",)
    assert constraints.required_memories == ("MEM_1",)


def test_a_fixed_unit_outside_the_pool_is_rejected_at_load(tmp_path):
    with pytest.raises(ConfigError, match="候補プールに無い"):
        load(tmp_path, constraints={"requiredUnits": ["UNIT_MISSING"]})


def test_known_formations_become_repaired_seed_candidates(tmp_path):
    config = load(
        tmp_path,
        knownFormations=[
            {
                "units": [
                    {"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}},
                    # 同じマス・プール外は種の側で壊れていても矯正して取り込む
                    {"unitDefinitionId": "UNIT_B", "position": {"column": 0, "row": "FRONT"}},
                    {"unitDefinitionId": "UNIT_UNKNOWN", "position": {"column": 2, "row": "REAR"}},
                ],
                "memoryDefinitionIds": ["MEM_1", "MEM_2"],
            }
        ],
    )

    (seed,) = config.seed_candidates()
    assert seed.unit_definition_ids == ("UNIT_A", "UNIT_B")
    assert len({placement.cell for placement in seed.placements}) == 2
    assert seed.memory_definition_ids == ("MEM_1", "MEM_2")


def test_duplicate_known_formations_are_collapsed(tmp_path):
    formation = {
        "units": [{"unitDefinitionId": "UNIT_A", "position": {"column": 0, "row": "FRONT"}}],
        "memoryDefinitionIds": ["MEM_1"],
    }
    config = load(tmp_path, knownFormations=[formation, formation])

    assert len(config.seed_candidates()) == 1


def test_schedule_stage_runs_must_increase(tmp_path):
    with pytest.raises(ConfigError, match="増える"):
        load(tmp_path, schedule={"stageRuns": [24, 8]})


def test_final_stage_must_hold_enough_effective_samples(tmp_path):
    """最終選抜は期待日次ベストで順位を決めるので、実効サンプル10未満の試行数を許さない。

    bestOf=20 だと100試行でも実効サンプルは 100·39/400 ≈ 9.75 しかない。
    """
    with pytest.raises(ConfigError, match="実効サンプル"):
        load(tmp_path, objective={"bestOf": 20}, schedule={"finalStageRuns": [50, 100]})


def test_operator_weights_default_to_a_low_unit_swap_rate(tmp_path):
    """配置・メモリーの最適化が主で、ユニット入替は適度に、という探索方針を重みで表す。"""
    weights = load(tmp_path).operator_weights

    assert 0.15 <= weights.normalized()["unit_swap"] <= 0.20
    assert sum(weights.normalized().values()) == pytest.approx(1.0)


def test_operator_weights_reject_an_all_zero_configuration(tmp_path):
    with pytest.raises(ConfigError, match="重み"):
        load(
            tmp_path, operatorWeights={key: 0 for key in load(tmp_path).operator_weights.as_dict()}
        )


def test_formation_config_places_units_in_cell_order_and_keeps_memory_order(tmp_path):
    config = load(tmp_path)
    candidate = Candidate(
        placements=(
            Placement("UNIT_B", Cell(column=1, row="REAR")),
            Placement("UNIT_A", Cell(column=0, row="FRONT")),
        ),
        memory_definition_ids=("MEM_2", "MEM_1"),
    )

    formation = config.formation_config(candidate)

    assert [unit.unit_definition_id for unit in formation.ally.units] == ["UNIT_A", "UNIT_B"]
    assert formation.ally.memory_definition_ids == ["MEM_2", "MEM_1"]
    assert formation.enemy.unit_definition_id == "UNIT_ENEMY"


def test_formation_config_omits_enhancement_without_academy_levels(tmp_path):
    config = load(tmp_path)
    candidate = Candidate((Placement("UNIT_A", Cell(column=0, row="FRONT")),), ())

    assert config.formation_config(candidate).enhancement_enabled is False


def test_academy_levels_in_the_yaml_enable_enhancement(tmp_path):
    config = load(tmp_path, academyLevels={"unitTypes": {"PHYSICAL": 99}})
    candidate = Candidate((Placement("UNIT_A", Cell(column=0, row="FRONT")),), ())

    formation = config.formation_config(candidate)

    assert formation.enhancement_enabled is True
    assert formation.ally.academy_levels.unit_types["PHYSICAL"] == 99


def player_data_file(tmp_path, *, level_link=None, link_excluded=False):
    path = tmp_path / "player-data.json"
    unit = {
        "level": 250,
        "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}, None],
    }
    if link_excluded:
        unit["linkExcluded"] = True
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "academyLevels": {"unitTypes": {"PHYSICAL": 50}, "attributes": {"SHY": 40}},
                **({} if level_link is None else {"levelLink": level_link}),
                "units": {"UNIT_A": unit},
            }
        ),
        encoding="utf-8",
    )
    return path


def test_player_data_supplies_level_and_gears_for_the_pool(tmp_path):
    config = load(tmp_path)
    data = load_player_data(player_data_file(tmp_path))

    enhanced, warnings = resolve_unit_enhancements(config, data)
    candidate = Candidate(
        (
            Placement("UNIT_A", Cell(column=0, row="FRONT")),
            Placement("UNIT_B", Cell(column=1, row="FRONT")),
        ),
        (),
    )
    sent = build_ally_formation(enhanced.formation_config(candidate))

    unit_a, unit_b = sent["units"]
    assert unit_a["enhancement"] == {
        "level": 250,
        "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}],
    }
    # 手持ちに無いユニットは既定（レベル200・ギアなし）で評価する。既定と同値の強化は
    # キーごと落とすのが `lab stats` と同じ規則で、そのことを警告に残す。
    assert "enhancement" not in unit_b
    assert any("UNIT_B" in warning for warning in warnings)


def test_level_link_resolves_the_pool_levels(tmp_path):
    config = load(tmp_path)
    data = load_player_data(player_data_file(tmp_path, level_link={"enabled": True, "level": 275}))

    enhanced, _ = resolve_unit_enhancements(config, data)

    assert enhanced.unit_enhancements["UNIT_A"].level == 275


def test_link_excluded_unit_keeps_its_own_level_in_the_pool(tmp_path):
    config = load(tmp_path)
    data = load_player_data(
        player_data_file(tmp_path, level_link={"enabled": True, "level": 275}, link_excluded=True)
    )

    enhanced, _ = resolve_unit_enhancements(config, data)

    assert enhanced.unit_enhancements["UNIT_A"].level == 250


def test_pool_levels_are_unchanged_without_a_level_link(tmp_path):
    config = load(tmp_path)
    data = load_player_data(player_data_file(tmp_path))

    enhanced, _ = resolve_unit_enhancements(config, data)

    assert enhanced.unit_enhancements["UNIT_A"].level == 250


def test_player_data_enables_enhancement_when_the_yaml_has_no_academy_levels(tmp_path):
    config = load(tmp_path)
    data = load_player_data(player_data_file(tmp_path))

    enhanced, _ = resolve_unit_enhancements(config, data)

    assert enhanced.academy_levels is not None
    assert enhanced.academy_levels.unit_types["PHYSICAL"] == 50


def test_the_bundled_example_is_loadable():
    """同梱サンプルがそのまま実行できること。読めなくなったら実IDへ差し替える合図。"""
    example = Path(__file__).parent.parent / "configs" / "search.example.yaml"

    config = load_search_config(example)

    assert len(config.unit_pool) >= 6
    assert config.memory_pool
    # 件数は決め打ちしない。サンプルは実運用の設定で上書きされることがある。
    assert config.seed_candidates()
    # 種は候補プールの中から組まれている（プール外を書くと探索されないまま消える）
    for seed in config.seed_candidates():
        assert set(seed.unit_definition_ids).issubset(config.unit_pool)
        assert set(seed.memory_definition_ids).issubset(config.memory_pool)


def test_yaml_academy_levels_win_over_the_player_data(tmp_path):
    config = load(tmp_path, academyLevels={"unitTypes": {"PHYSICAL": 99}})
    data = load_player_data(player_data_file(tmp_path))

    enhanced, _ = resolve_unit_enhancements(config, data)

    assert enhanced.academy_levels.unit_types["PHYSICAL"] == 99
