"""編成ライブラリ（`configs/formations/<id>.yaml`）。

1ファイルが敵に依らない味方編成1件で、ファイル名がそのままIDになる。対戦相手や
評価の設定は持たない——それらは編成を使う側が別に与える。
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, ValidationError

from .models import (
    MAX_ALLY_UNITS,
    MAX_MEMORIES,
    AllyUnitSpec,
    ConfigError,
    Spec,
    dump_yaml,
    load_yaml_mapping,
    placement_documents,
)

DEFAULT_FORMATIONS_DIR = Path("configs/formations")


class FormationLibraryEntry(Spec):
    """編成ライブラリ1件。演習の編成YAMLの `ally` と同じ形にして写せるようにする。"""

    # 任意の自由記述。この編成を組んだ意図・狙いを残す場所（例:「属性デバフ特化」）。
    # `lab formations` が一覧に出すだけの記録用の項目。
    note: str | None = Field(
        default=None, description="この編成を組んだ意図・狙い（任意、自由記述）。"
    )
    units: list[AllyUnitSpec] = Field(min_length=1, max_length=MAX_ALLY_UNITS)
    memory_definition_ids: list[str] = Field(
        default_factory=list, alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )


def list_formation_ids(formations_dir: Path) -> list[str]:
    """登録済みのIDを列挙する（`lab formations` が使う）。"""
    if not formations_dir.is_dir():
        return []
    return sorted(entry.stem for entry in formations_dir.glob("*.yaml"))


def formation_path(formations_dir: Path, formation_id: str) -> Path:
    return formations_dir / f"{formation_id}.yaml"


def load_formation_library_entry(formations_dir: Path, formation_id: str) -> FormationLibraryEntry:
    path = formation_path(formations_dir, formation_id)
    if not path.is_file():
        raise ConfigError(
            f"編成 '{formation_id}' が {path} に無い（`lab formations` で登録済みのIDを確認する）"
        )
    raw = load_yaml_mapping(path)
    try:
        return FormationLibraryEntry.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error


def dump_formation_library_entry(entry: FormationLibraryEntry) -> str:
    """1ファイルぶんのYAMLを書き出す（`lab import-draft --library` が使う）。

    `note` はドラフト側に無い項目なので、付いている場合だけ出す（無ければキー自体を出さない）。
    強化情報は出さない（`models.placement_documents`）。
    """
    document: dict[str, object] = {}
    if entry.note is not None:
        document["note"] = entry.note
    document["units"] = placement_documents(entry.units)
    document["memoryDefinitionIds"] = list(entry.memory_definition_ids)
    return dump_yaml(document)
