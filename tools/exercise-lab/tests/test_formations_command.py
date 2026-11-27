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


def test_the_default_directory_is_the_shared_library_under_the_tools_root(tmp_path, monkeypatch):
    root = tmp_path / "tools"
    (root / "exercise-lab").mkdir(parents=True)
    (root / "pyproject.toml").write_text("[tool.uv.workspace]\nmembers = []\n", encoding="utf-8")
    write_entry(root / "data" / "inputs" / "formations", "shared")
    # 実行場所（ラボのディレクトリ）に依らず、tools ルートの共有ライブラリを見る。
    monkeypatch.chdir(root / "exercise-lab")

    result = runner.invoke(app, ["formations"])

    assert result.exit_code == 0, result.output
    assert "shared" in result.output


def test_outside_a_workspace_the_directory_must_be_given(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["formations"])

    assert result.exit_code == 1
    assert "--formations-dir" in result.output
