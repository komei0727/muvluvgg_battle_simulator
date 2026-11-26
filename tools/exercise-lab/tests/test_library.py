"""編成ライブラリ（`configs/formations/<id>.yaml`）の一覧・読み書き。"""

import pytest
from typer.testing import CliRunner

from exercise_lab.cli import app
from exercise_lab.inputs.library import (
    FormationLibraryEntry,
    dump_formation_library_entry,
    list_formation_ids,
    load_formation_library_entry,
)
from exercise_lab.inputs.models import ConfigError

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


def test_ids_are_the_yaml_file_names_in_sorted_order(tmp_path):
    write_entry(tmp_path, "zeta")
    write_entry(tmp_path, "alpha")
    (tmp_path / "notes.txt").write_text("not an entry", encoding="utf-8")

    assert list_formation_ids(tmp_path) == ["alpha", "zeta"]


def test_a_missing_directory_has_no_ids(tmp_path):
    assert list_formation_ids(tmp_path / "absent") == []


def test_an_entry_keeps_the_unit_and_memory_order_and_the_note(tmp_path):
    write_entry(tmp_path, "noted")

    entry = load_formation_library_entry(tmp_path, "noted")

    assert entry.note == "属性デバフ特化"
    assert [unit.unit_definition_id for unit in entry.units] == ["UNIT_B", "UNIT_A"]
    # メモリーはID順へ並べ替えない。
    assert entry.memory_definition_ids == ["MEM_Z", "MEM_A"]


def test_an_unknown_id_points_at_the_listing_command(tmp_path):
    with pytest.raises(ConfigError, match="lab formations"):
        load_formation_library_entry(tmp_path, "does-not-exist")


def test_a_malformed_entry_is_rejected(tmp_path):
    write_entry(tmp_path, "bad", "- not-a-mapping\n")

    with pytest.raises(ConfigError, match="マッピング"):
        load_formation_library_entry(tmp_path, "bad")


def test_an_entry_with_an_enemy_is_rejected(tmp_path):
    """ライブラリは敵に依らない編成だけを持つ。演習の編成YAMLを取り違えて置くと落ちる。"""
    write_entry(
        tmp_path,
        "with-enemy",
        ENTRY_YAML + "enemy:\n  unitDefinitionId: UNIT_ENEMY\n  position: {column: 1, row: REAR}\n",
    )

    with pytest.raises(ConfigError, match="enemy"):
        load_formation_library_entry(tmp_path, "with-enemy")


def test_the_dump_round_trips_and_omits_an_absent_note(tmp_path):
    entry = load_formation_library_entry(write_entry(tmp_path, "src").parent, "src")
    without_note = FormationLibraryEntry(
        units=entry.units, memory_definition_ids=entry.memory_definition_ids
    )

    text = dump_formation_library_entry(without_note)
    write_entry(tmp_path, "dumped", text)

    assert "note" not in text
    assert load_formation_library_entry(tmp_path, "dumped") == without_note


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
