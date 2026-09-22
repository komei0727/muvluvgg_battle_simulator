"""`lab import-draft` の出力。生成したYAMLはそのまま `lab stats` へ渡せなければならない。"""

import json

from typer.testing import CliRunner

from exercise_lab.cli import app
from exercise_lab.models import build_evaluation_request, load_formation_config
from exercise_lab.optimize.search_config import load_formation_library_entry
from test_draft import draft_json

runner = CliRunner()


def test_generated_yaml_round_trips_through_the_config_loader(tmp_path):
    source = write_draft(tmp_path)
    out = tmp_path / "formation.yaml"

    result = runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert result.exit_code == 0, result.output
    config = load_formation_config(out)
    request = build_evaluation_request(config, runs_per_candidate=1, seed="s")
    ally = request["candidates"][0]["allyFormation"]
    assert [unit["unitDefinitionId"] for unit in ally["units"]] == ["UNIT_A", "UNIT_C", "UNIT_D"]
    assert ally["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert request["enemyFormation"]["units"][0]["unitDefinitionId"] == "UNIT_ENEMY"


def test_generated_yaml_is_stable_for_the_same_draft(tmp_path):
    source = write_draft(tmp_path)
    first = tmp_path / "a.yaml"
    second = tmp_path / "b.yaml"

    runner.invoke(app, ["import-draft", str(source), "-o", str(first)])
    runner.invoke(app, ["import-draft", str(source), "-o", str(second)])

    assert first.read_bytes() == second.read_bytes()


def test_generated_yaml_carries_no_enhancement(tmp_path):
    source = write_draft(tmp_path)
    out = tmp_path / "formation.yaml"

    runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    text = out.read_text(encoding="utf-8")
    assert "academyLevels:" not in text
    assert "gears:" not in text
    assert "level:" not in text


def test_unusable_draft_is_reported_without_writing_a_file(tmp_path):
    stored = draft_json()
    stored["schemaVersion"] = 2
    source = tmp_path / "draft.json"
    source.write_text(json.dumps(stored), encoding="utf-8")
    out = tmp_path / "formation.yaml"

    result = runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)
    assert not out.exists()


def test_library_yaml_round_trips_through_the_formation_library_loader(tmp_path):
    source = write_draft(tmp_path)
    formations_dir = tmp_path / "formations"
    out = formations_dir / "seed-a-c-d.yaml"

    result = runner.invoke(app, ["import-draft", str(source), "--library", "-o", str(out)])

    assert result.exit_code == 0, result.output
    spec = load_formation_library_entry(formations_dir, "seed-a-c-d")
    assert [unit.unit_definition_id for unit in spec.units] == ["UNIT_A", "UNIT_C", "UNIT_D"]
    assert spec.memory_definition_ids == ["MEM_Z", "MEM_A"]
    assert spec.note is None


def test_library_yaml_carries_no_enemy_or_enhancement(tmp_path):
    source = write_draft(tmp_path)
    out = tmp_path / "formations" / "seed-a-c-d.yaml"

    runner.invoke(app, ["import-draft", str(source), "--library", "-o", str(out)])

    text = out.read_text(encoding="utf-8")
    assert "enemy" not in text
    assert "academyLevels:" not in text
    assert "gears:" not in text
    assert "level:" not in text


def test_library_note_option_is_carried_into_the_spec(tmp_path):
    source = write_draft(tmp_path)
    formations_dir = tmp_path / "formations"
    out = formations_dir / "seed-a-c-d.yaml"

    result = runner.invoke(
        app,
        ["import-draft", str(source), "--library", "--note", "属性デバフ特化", "-o", str(out)],
    )

    assert result.exit_code == 0, result.output
    spec = load_formation_library_entry(formations_dir, "seed-a-c-d")
    assert spec.note == "属性デバフ特化"


def test_note_without_library_is_rejected(tmp_path):
    source = write_draft(tmp_path)
    out = tmp_path / "formation.yaml"

    result = runner.invoke(
        app, ["import-draft", str(source), "--note", "属性デバフ特化", "-o", str(out)]
    )

    assert result.exit_code == 1
    assert not out.exists()


def test_library_schema_directive_points_two_levels_up(tmp_path):
    """編成ライブラリは `configs/` の1つ下（`configs/formations/`）にあるため、
    他の2つのSchemaディレクティブ（`../.schema/...`）と違い `../../` になる。"""
    source = write_draft(tmp_path)
    out = tmp_path / "formations" / "seed-a-c-d.yaml"

    runner.invoke(app, ["import-draft", str(source), "--library", "-o", str(out)])

    lines = out.read_text(encoding="utf-8").splitlines()
    assert not any(line.startswith("# yaml-language-server:") for line in lines)
    assert "## yaml-language-server: $schema=../../.schema/formation-seed.schema.json" in lines


def write_draft(tmp_path):
    path = tmp_path / "last-draft-exercise.json"
    path.write_text(json.dumps(draft_json()), encoding="utf-8")
    return path


def test_schema_directive_is_inert_until_the_schema_exists(tmp_path):
    # `# yaml-language-server:` はコメントではなく有効なディレクティブなので、
    # 生成直後に効いていると、まだ作っていないSchemaを指してエディタが赤くなる。
    source = write_draft(tmp_path)
    out = tmp_path / "formation.yaml"

    runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    lines = out.read_text(encoding="utf-8").splitlines()
    assert not any(line.startswith("# yaml-language-server:") for line in lines)
    assert any(line.startswith("## yaml-language-server:") for line in lines)


def test_six_ally_draft_is_reported_without_a_traceback(tmp_path):
    six = [
        {
            "slotKey": f"ally:{row}:{column}",
            "side": "ally",
            "row": row,
            "column": column,
            "unitDefinitionId": f"UNIT_{row}_{column}",
        }
        for row in ("FRONT", "REAR")
        for column in (0, 1, 2)
    ]
    source = tmp_path / "draft.json"
    source.write_text(json.dumps(draft_json(allySlots=six)), encoding="utf-8")
    out = tmp_path / "formation.yaml"

    result = runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert result.exit_code == 1
    assert result.exception is None or isinstance(result.exception, SystemExit)
    assert not out.exists()
