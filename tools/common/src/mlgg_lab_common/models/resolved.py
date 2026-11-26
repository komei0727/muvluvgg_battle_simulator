"""解決済みの対戦入力の入れ物と、そのJSON往復。

解決済み入力は「実際に評価する編成・育成条件」を自己完結で持つ。元の編成ファイルや
手持ちデータを読み直さずに確認・保存・再読み込みでき、再読み込み後もAPIへ送る
内容が一致する。

元ファイルのパス・警告などの由来情報（`InputProvenance`）は対戦条件と分けて持つ。
パスは「どこから作ったか」の記録であり、対戦条件の代わりにはならない（ファイルは
後から書き換わり得る）。保存先・実行IDなど、後続の保存基盤に属する情報はここへ
入れない。
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import Field, ValidationError

from .formation import ConfigError, Spec

RESOLVED_INPUT_SCHEMA_VERSION = 1

InputSourceRole = Literal["MATCH_FILE", "DRAFT", "FORMATION_LIBRARY", "PLAYER_DATA"]


class InputSource(Spec):
    role: InputSourceRole
    path: str
    # 入力内のどこへ効いたか（例: `ally.formations[1]`）。ファイル全体なら省略する。
    applies_to: str | None = Field(default=None, alias="appliesTo")


class InputProvenance(Spec):
    sources: list[InputSource] = Field(default_factory=list)
    # 参照検証に使ったCatalogの版。検証せずに解決した場合は `None`。
    catalog_revision: str | None = Field(default=None, alias="catalogRevision")
    # 解決時の警告（手持ちデータに無いユニット等）。握り潰さず入力と一緒に残す。
    warnings: list[str] = Field(default_factory=list)


class ResolvedInput(Spec):
    """各ラボの解決済み入力の基底。サブクラスが `format` と対戦条件の項目を足す。"""

    schema_version: Literal[1] = Field(default=RESOLVED_INPUT_SCHEMA_VERSION, alias="schemaVersion")
    provenance: InputProvenance = Field(default_factory=InputProvenance)


def dump_resolved_input(document: ResolvedInput) -> str:
    """JSONへ書き出す。

    `None` の項目はキーごと落とす。読み戻すと `None` に戻るので意味は変わらない。
    一方で空のリスト・空のマッピング（ギアなしの明示、全系統1の学園レベル）は残す——
    これを落とすと「未指定」と区別できなくなる。
    """
    payload = document.model_dump(mode="json", by_alias=True, exclude_none=True)
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def revalidated[ResolvedT: ResolvedInput](document: ResolvedT) -> ResolvedT:
    """解決済み入力を、保存して読み戻したときと同じ検証に通し直したものを返す。

    既存のモデルインスタンスを渡して組み立てると、内側の値は再検証されない
    （pydanticはインスタンスをそのまま受け取る）。解決時にここを通すことで
    「解決できたのに読み戻せない」入力を作らない。
    """
    try:
        return type(document).model_validate(
            document.model_dump(mode="json", by_alias=True, exclude_none=True)
        )
    except ValidationError as error:
        raise ConfigError(f"解決した入力がモデルの制約を満たさない: {error}") from error


def load_resolved_input[ResolvedT: ResolvedInput](
    model: type[ResolvedT], text: str, *, where: str
) -> ResolvedT:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        raise ConfigError(f"{where}: JSONとして読めない: {error}") from error
    if not isinstance(raw, dict) or raw.get("schemaVersion") != RESOLVED_INPUT_SCHEMA_VERSION:
        version = raw.get("schemaVersion") if isinstance(raw, dict) else None
        raise ConfigError(
            f"{where}: 未対応の schemaVersion={version!r}"
            f"（{RESOLVED_INPUT_SCHEMA_VERSION} だけを読む）"
        )
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{where}: {error}") from error
