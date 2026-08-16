"""`lab import-draft` の出力。生成したYAMLはそのまま `lab stats` へ渡せなければならない。"""

import json

from typer.testing import CliRunner

from exercise_lab.cli import app
from exercise_lab.models import build_evaluation_request, load_formation_config
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
