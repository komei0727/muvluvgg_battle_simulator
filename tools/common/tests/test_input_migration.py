"""既存の入力データを `data/inputs` へ写す移行。元ファイルを消さず、同名ファイルを上書きしない。"""

import json
from pathlib import Path

from mlgg_lab_common.inputs.migration import apply_migration, plan_migration, verify_migration
from mlgg_lab_common.testing import draft_json

PLAYER_DATA = {
    "schemaVersion": 1,
    "academyLevels": {"unitTypes": {}, "attributes": {}},
    "units": {},
}
LIBRARY = "units:\n  - { unitDefinitionId: UNIT_A, position: { column: 0, row: FRONT } }\n"


def legacy_tree(root: Path) -> Path:
    lab = root / "exercise-lab"
    (lab / "local_storage" / "draft").mkdir(parents=True)
    (lab / "local_storage" / "player-data.json").write_text(
        json.dumps(PLAYER_DATA), encoding="utf-8"
    )
    (lab / "local_storage" / "formation.json").write_text(
        json.dumps(draft_json()), encoding="utf-8"
    )
    (lab / "local_storage" / "draft" / "kotoha.json").write_text(
        json.dumps(draft_json()), encoding="utf-8"
    )
    (lab / "local_storage" / "notes.json").write_text('["not an input"]', encoding="utf-8")
    (lab / "configs" / "formations").mkdir(parents=True)
    (lab / "configs" / "formations" / "pair.yaml").write_text(LIBRARY, encoding="utf-8")
    return root


def test_plan_classifies_legacy_files_by_content(tmp_path):
    items = plan_migration(legacy_tree(tmp_path))

    assert {i.source.name: (i.kind, i.status) for i in items} == {
        "player-data.json": ("PLAYER_DATA", "COPY"),
        "formation.json": ("DRAFT", "COPY"),
        "kotoha.json": ("DRAFT", "COPY"),
        "notes.json": ("UNRECOGNIZED", "SKIP"),
        "pair.yaml": ("FORMATION", "COPY"),
    }
    by_name = {i.source.name: i.destination for i in items if i.destination}
    data = tmp_path / "data" / "inputs"
    assert by_name["player-data.json"] == data / "player-data" / "player-data.json"
    assert by_name["kotoha.json"] == data / "drafts" / "kotoha.json"
    assert by_name["pair.yaml"] == data / "formations" / "pair.yaml"


def test_dry_run_writes_nothing(tmp_path):
    plan_migration(legacy_tree(tmp_path))

    assert not (tmp_path / "data").exists()


def test_apply_copies_keeps_sources_and_resolves_identically(tmp_path):
    root = legacy_tree(tmp_path)

    applied = apply_migration(plan_migration(root))

    assert {i.status for i in applied if i.kind != "UNRECOGNIZED"} == {"COPIED"}
    assert (root / "exercise-lab" / "local_storage" / "player-data.json").is_file()
    assert verify_migration(applied) == []
    # 2回目は同じ内容なので何もしない。
    again = plan_migration(root)
    assert {i.status for i in again if i.kind != "UNRECOGNIZED"} == {"ALREADY_PRESENT"}


def test_existing_files_with_other_content_are_not_overwritten(tmp_path):
    root = legacy_tree(tmp_path)
    target = root / "data" / "inputs" / "formations" / "pair.yaml"
    target.parent.mkdir(parents=True)
    target.write_text("units: []\n", encoding="utf-8")

    applied = apply_migration(plan_migration(root))

    (conflict,) = [i for i in applied if i.source.name == "pair.yaml"]
    assert conflict.status == "CONFLICT"
    assert target.read_text(encoding="utf-8") == "units: []\n"


def test_draft_name_collisions_between_folders_are_reported_not_merged(tmp_path):
    root = legacy_tree(tmp_path)
    (root / "exercise-lab" / "local_storage" / "kotoha.json").write_text(
        json.dumps(draft_json(turnLimit=9)), encoding="utf-8"
    )

    items = plan_migration(root)

    statuses = sorted(i.status for i in items if i.source.name == "kotoha.json")
    assert statuses == ["CONFLICT", "COPY"]


def test_verification_reports_semantic_differences(tmp_path):
    root = legacy_tree(tmp_path)
    applied = apply_migration(plan_migration(root))
    copied = root / "data" / "inputs" / "player-data" / "player-data.json"
    copied.write_text(
        json.dumps({**PLAYER_DATA, "units": {"UNIT_A": {"level": 300}}}), encoding="utf-8"
    )

    problems = verify_migration(applied)

    assert len(problems) == 1
    assert "player-data.json" in problems[0]
