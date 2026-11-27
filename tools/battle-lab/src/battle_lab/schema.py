"""通常戦闘の対戦入力YAML（`match.yaml`）用の JSON Schema を Catalog から生成する。

部品は `mlgg_lab_common.inputs.schema` が持ち、ここは通常戦闘の形（両陣営の編成 +
規定ターン数）へ当てはめる。各陣営の編成はインラインか編成ライブラリの参照
（`{ library: <id> }`）で、両陣営とも `PLAYABLE`（R-TEX-11 #3）。

各陣営の配置重複はJSON Schemaで表せないため、ローダーの `ConfigError` だけが落とす。
"""

from __future__ import annotations

from typing import Any

from mlgg_lab_common.inputs.catalog import PLAYABLE, Catalog
from mlgg_lab_common.inputs.schema import (
    apply_formation_catalog,
    finish_schema,
    formation_entry,
    schema_name,
)

from .evaluation import FORMAT
from .inputs import BattleMatch

MATCH_SCHEMA = schema_name(FORMAT, "match")


def build_battle_match_json_schema(catalog: Catalog) -> dict[str, Any]:
    schema: dict[str, Any] = BattleMatch.model_json_schema(by_alias=True)
    apply_formation_catalog(schema["$defs"], catalog, PLAYABLE)
    properties = schema["properties"]
    for field in ("allyFormation", "enemyFormation"):
        properties[field] = formation_entry(properties[field])
    return finish_schema(schema, catalog, title="battle-lab match")
