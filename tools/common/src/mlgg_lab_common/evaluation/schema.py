"""評価設定（`evaluation.yaml`。`format` / `seed` / `cases` …）の JSON Schema。

形は3形式で共通なので、骨格は `config` の読み込みモデルから起こし、`format` だけを
ラボの形式に固定する。別形式の評価設定を開いたまま気付かずに書き進めないため。

ケースの `match` / `draft` の排他・`runs` と `runIndices` の組み合わせは読み込み時の
`ConfigError` で落ちる（Schemaへは移していない）。
"""

from __future__ import annotations

from typing import Any

from ..inputs.catalog import Catalog
from ..inputs.schema import finish_schema
from .config import _ConfigFile


def build_evaluation_config_json_schema(catalog: Catalog, *, format: str) -> dict[str, Any]:
    schema: dict[str, Any] = _ConfigFile.model_json_schema(by_alias=True)
    schema["properties"]["format"] = {
        "const": format,
        "description": "このラボの形式。別形式の評価設定は別のラボで扱う。",
    }
    return finish_schema(schema, catalog, title=f"{format} evaluation config")
