"""`exercise-lab import-draft` の出力。

生成したYAMLはそのまま編成ローダーで読み戻せなければならない。
"""

import json

from typer.testing import CliRunner

from exercise_lab.cli import app
from exercise_lab.inputs.exercise import build_enemy_formation, load_formation_config
from mlgg_lab_common.inputs.library import load_formation_library_entry
from mlgg_lab_common.models import build_formation_request
from mlgg_lab_common.testing import draft_json

runner = CliRunner()


def test_generated_yaml_round_trips_through_the_config_loader(tmp_path):
    source = write_draft(tmp_path)
    out = tmp_path / "formation.yaml"

    result = runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert result.exit_code == 0, result.output
    config = load_formation_config(out)
    ally = build_formation_request(config.ally)
    assert [unit["unitDefinitionId"] for unit in ally["units"]] == ["UNIT_A", "UNIT_C", "UNIT_D"]
    assert ally["memoryDefinitionIds"] == ["MEM_Z", "MEM_A"]
    assert build_enemy_formation(config.enemy)["units"][0]["unitDefinitionId"] == "UNIT_ENEMY"


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


def make_workspace(tmp_path):
    root = tmp_path / "tools"
    root.mkdir()
    (root / "pyproject.toml").write_text("[tool.uv.workspace]\nmembers = []\n", encoding="utf-8")
    return root


def directive_lines(text):
    return [line for line in text.splitlines() if "yaml-language-server: $schema=" in line]


def test_library_directive_points_at_the_tools_schema_dir(tmp_path):
    root = make_workspace(tmp_path)
    source = write_draft(tmp_path)
    out = root / "data" / "inputs" / "formations" / "seed-a-c-d.yaml"

    runner.invoke(app, ["import-draft", str(source), "--library", "-o", str(out)])

    assert directive_lines(out.read_text(encoding="utf-8")) == [
        "## yaml-language-server: $schema=../../../.schema/formation-library.schema.json"
    ]


def test_match_directive_follows_where_the_file_is_written(tmp_path):
    root = make_workspace(tmp_path)
    source = write_draft(tmp_path)
    out = root / "exercise-lab" / "configs" / "formation.yaml"

    runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert directive_lines(out.read_text(encoding="utf-8")) == [
        "## yaml-language-server: $schema=../../.schema/exercise.match.schema.json"
    ]


def test_outside_the_workspace_the_directive_follows_the_working_directory(tmp_path, monkeypatch):
    root = make_workspace(tmp_path)
    monkeypatch.chdir(root)
    source = write_draft(tmp_path)
    out = tmp_path / "elsewhere" / "formation.yaml"

    runner.invoke(app, ["import-draft", str(source), "-o", str(out)])

    assert directive_lines(out.read_text(encoding="utf-8")) == [
        "## yaml-language-server: $schema=../tools/.schema/exercise.match.schema.json"
    ]


def test_without_a_known_destination_the_directive_assumes_the_recommended_place(
    tmp_path, monkeypatch
):
    # 標準出力や、出力先・実行ディレクトリのどちらからも workspace が見つからないときは
    # 置き場所が分からないので、推奨の置き場所（編成ライブラリは data/inputs/formations/、
    # 編成定義は <lab>/configs/）を前提にする。
    monkeypatch.chdir(tmp_path)
    source = write_draft(tmp_path)

    library = runner.invoke(app, ["import-draft", str(source), "--library"])
    match = runner.invoke(app, ["import-draft", str(source), "-o", str(tmp_path / "f.yaml")])

    assert directive_lines(library.output) == [
        "## yaml-language-server: $schema=../../../.schema/formation-library.schema.json"
    ]
    assert directive_lines((tmp_path / "f.yaml").read_text(encoding="utf-8")) == [
        "## yaml-language-server: $schema=../../.schema/exercise.match.schema.json"
    ]
    assert match.exit_code == 0, match.output


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
