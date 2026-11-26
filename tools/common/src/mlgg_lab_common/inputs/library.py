"""編成ライブラリ（`configs/formations/<id>.yaml`）。

1ファイルが対戦相手に依らない編成1件で、ファイル名がそのままIDになる。対戦相手や
評価の設定は持たない——それらは編成を使う側が別に与える。陣営にも依らないので、
通常戦闘・総力戦では敵の編成としても参照できる。

既定の置き場所は `tools/exercise-lab/configs/formations/`（既存の個人ファイルの
場所）で、他のラボはディレクトリを明示して同じ場所を参照する。ツールはこの
ディレクトリの中身を移動・削除しない。
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, ValidationError

from ..models.formation import (
    MAX_FORMATION_UNITS,
    MAX_MEMORIES,
    ConfigError,
    FormationSpec,
    FormationUnitSpec,
    Spec,
)
from .yaml_io import dump_yaml, load_yaml_mapping, placement_documents

DEFAULT_FORMATIONS_DIR = Path("configs/formations")


class FormationLibraryEntry(Spec):
    """編成ライブラリ1件。演習の編成YAMLの `ally` と同じ形にして写せるようにする。

    育成状態（学園レベル・レベル・ギア）は持たない。正本は手持ちデータである。
    """

    # 任意の自由記述。この編成を組んだ意図・狙いを残す場所（例:「属性デバフ特化」）。
    # 一覧表示に出すだけの記録用の項目で、対戦入力には載らない。
    note: str | None = Field(
        default=None, description="この編成を組んだ意図・狙い（任意、自由記述）。"
    )
    units: list[FormationUnitSpec] = Field(min_length=1, max_length=MAX_FORMATION_UNITS)
    memory_definition_ids: list[str] = Field(
        default_factory=list, alias="memoryDefinitionIds", max_length=MAX_MEMORIES
    )

    def to_formation(self) -> FormationSpec:
        """対戦入力として使う編成へ変える。`note` は記録用なので持ち越さない。"""
        return FormationSpec(
            units=list(self.units), memoryDefinitionIds=list(self.memory_definition_ids)
        )


def list_formation_ids(formations_dir: Path) -> list[str]:
    """登録済みのIDを列挙する。"""
    if not formations_dir.is_dir():
        return []
    return sorted(entry.stem for entry in formations_dir.glob("*.yaml"))


def formation_path(formations_dir: Path, formation_id: str) -> Path:
    return formations_dir / f"{formation_id}.yaml"


def load_formation_library_entry(formations_dir: Path, formation_id: str) -> FormationLibraryEntry:
    path = formation_path(formations_dir, formation_id)
    if not path.is_file():
        raise ConfigError(
            f"編成 '{formation_id}' が {path} に無い"
            "（`exercise-lab formations --formations-dir <dir>` で登録済みのIDを確認する）"
        )
    raw = load_yaml_mapping(path)
    # 配置の重複などの編成としての検証は、対戦入力として使う側（`sources`）で行う。
    # 一覧の表示まで止めると、壊れた1件のために他の編成を引けなくなる。
    try:
        return FormationLibraryEntry.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error


def dump_formation_library_entry(entry: FormationLibraryEntry) -> str:
    """1ファイルぶんのYAMLを書き出す。

    `note` はドラフト側に無い項目なので、付いている場合だけ出す（無ければキー自体を出さない）。
    強化情報は出さない（`yaml_io.placement_documents`）。
    """
    document: dict[str, object] = {}
    if entry.note is not None:
        document["note"] = entry.note
    document["units"] = placement_documents(entry.units)
    document["memoryDefinitionIds"] = list(entry.memory_definition_ids)
    return dump_yaml(document)
