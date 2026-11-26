"""`exercise-lab formations` の一覧表示。"""

from typer.testing import CliRunner

from exercise_lab.cli import app

ENTRY_YAML = """\
note: 属性デバフ特化
units:
  - unitDefinitionId: UNIT_B
    position: { column: 2, row: REAR }
  - unitDefinitionId: UNIT_A
    position: { column: 0, row: FRONT }
memoryDefinitionIds: [MEM_Z, MEM_A]
"""

runner = CliRunner()


def write_entry(formations_dir, formation_id, text=ENTRY_YAML):
    formations_dir.mkdir(parents=True, exist_ok=True)
    path = formations_dir / f"{formation_id}.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_the_formations_command_lists_the_entries(tmp_path):
    write_entry(tmp_path, "noted")

    result = runner.invoke(app, ["formations", "--formations-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert "noted" in result.output
    assert "属性デバフ特化" in result.output


def test_the_formations_command_reports_a_malformed_entry_without_a_traceback(tmp_path):
    write_entry(tmp_path, "bad", "- not-a-mapping\n")

    result = runner.invoke(app, ["formations", "--formations-dir", str(tmp_path)])

    assert result.exit_code == 1
    assert "マッピング" in result.output
    assert result.exception is None or isinstance(result.exception, SystemExit)
