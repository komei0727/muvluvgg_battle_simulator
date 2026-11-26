"""テスト用の入力データ。UIの保存形式（`apps/ui/src/features/formation/persistence.ts`）を写す。

各ラボのテストが同じ形のドラフトを作れるよう、配布物に含めて公開する
（`typer.testing` などと同じ位置付け）。実行時の入力解決からは使わない。
"""

from __future__ import annotations

from typing import Any


def slot(
    side: str,
    row: str,
    column: int,
    unit_definition_id: str | None = None,
    enhancement: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # JSON.stringify はオブジェクトの `undefined` をキーごと落とすため、
    # 空枠には `unitDefinitionId` が現れない。
    built: dict[str, Any] = {
        "slotKey": f"{side}:{row}:{column}",
        "side": side,
        "row": row,
        "column": column,
    }
    if unit_definition_id is not None:
        built["unitDefinitionId"] = unit_definition_id
    if enhancement is not None:
        built["enhancement"] = enhancement
    return built


ENHANCEMENT = {
    "level": 298,
    "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}] + [None] * 8,
}


def draft_body(**overrides: Any) -> dict[str, Any]:
    """`BattleDraft` 本体1件。味方3体（前衛0・2、後衛1）・敵1体・メモリー2件。"""
    draft: dict[str, Any] = {
        "allySlots": [
            slot("ally", "FRONT", 0, "UNIT_A", ENHANCEMENT),
            slot("ally", "FRONT", 1),
            slot("ally", "FRONT", 2, "UNIT_C"),
            slot("ally", "REAR", 0),
            slot("ally", "REAR", 1, "UNIT_D"),
            slot("ally", "REAR", 2),
        ],
        "enemySlots": [
            slot("enemy", "FRONT", 0),
            slot("enemy", "FRONT", 1, "UNIT_ENEMY"),
            slot("enemy", "FRONT", 2),
            slot("enemy", "REAR", 0),
            slot("enemy", "REAR", 1),
            slot("enemy", "REAR", 2),
        ],
        # 空枠は配列上 `null` として並ぶ。
        "allyMemoryDefinitionIds": [None, "MEM_Z", None, "MEM_A", None, None],
        "enemyMemoryDefinitionIds": [None] * 6,
        "turnLimit": 5,
        "logLevel": "SUMMARY",
        "allyEnhancement": {
            "enabled": True,
            "academyLevels": {
                "unitTypes": {"PHYSICAL": 99, "ENERGY": 100, "AGILE": 101},
                "attributes": {
                    "AGGRESSIVE": 102,
                    "SHY": 103,
                    "CUTE": 101,
                    "SMART": 102,
                    "COMICAL": 26,
                    "CLEVER": 27,
                },
            },
        },
        "enemyEnhancement": {
            "enabled": False,
            "academyLevels": {"unitTypes": {}, "attributes": {}},
        },
    }
    draft.update(overrides)
    return draft


def draft_json(**overrides: Any) -> dict[str, Any]:
    """`mlgg:last-draft` / `mlgg:last-draft:exercise` の中身（封筒付き）。"""
    return {"schemaVersion": 1, "catalogRevision": "2026-08-16.3", "draft": draft_body(**overrides)}
