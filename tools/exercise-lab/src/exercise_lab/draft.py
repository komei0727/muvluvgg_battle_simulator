"""UIで組んだ演習編成（localStorage `mlgg:last-draft:exercise`）の取り込み。

保存形式は `apps/ui/src/features/formation/persistence.ts` の `toStoredDraft` /
`BattleDraft` を写す。UIには編成エディタ（ユニット選択・配置・適性表示）が既にあり、
それをそのまま入力手段として使えるようにする——IDを手で書き写す作業が消える。

**強化情報（レベル・ギア・学園レベル）は読まない。** ドラフトにも育成状態は入っているが、
このツールでの正本は `--player-data` 側に一本化する。両方から取れるようにすると、
同じ値が2か所にあって食い違ったときにどちらで評価されたのか追えなくなる。

通常戦闘のドラフト（`mlgg:last-draft`）との取り違えは、保存形式が同じ `BattleDraft` で
あるため完全には判別できない。敵が2体以上のとき（{@link _reject_unusable}）と敵メモリーを
持つとき（{@link _reject_enemy_memories}）はここで落とせるが、敵1体・敵メモリーなしの
通常戦闘ドラフトは通る。それは `lab stats` のCatalog検証が捕まえる——通常戦闘の敵は
`PLAYABLE` であり、演習の敵プール（`EXERCISE_ENEMY`）に合わないため R-TEX-11 #1 で弾かれる。
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from .models import (
    MAX_ALLY_UNITS,
    AllySpec,
    AllyUnitSpec,
    Column,
    EnemySpec,
    FormationConfig,
    Position,
    Row,
    _Spec,
)

# `persistence.ts` の `PERSISTENCE_SCHEMA_VERSION`。異なる版は読み替えず落とす。
SUPPORTED_SCHEMA_VERSION = 1

EXERCISE_DRAFT_STORAGE_KEY = "mlgg:last-draft:exercise"

# `request-mapper.ts` の `ROW_ORDER`。前衛→後衛、各列は column 昇順。
ROW_ORDER: dict[str, int] = {"FRONT": 0, "REAR": 1}

EXERCISE_ENEMY_UNIT_COUNT = 1


class DraftError(Exception):
    """ドラフトが契約から外れている、または演習編成として成立しない。"""


class StoredSlot(_Spec):
    """枠1つ。読むのは配置とユニットIDだけで、`enhancement` は意図的に見ない。"""

    row: Row
    column: Column
    # JSON.stringify はオブジェクトの `undefined` をキーごと落とすため、空枠には現れない。
    unit_definition_id: str | None = None


def _slot_of(value: object) -> StoredSlot:
    if not isinstance(value, dict):
        raise DraftError(f"枠がオブジェクトではない: {value!r}")
    try:
        return StoredSlot.model_validate(
            {
                "row": value.get("row"),
                "column": value.get("column"),
                "unit_definition_id": value.get("unitDefinitionId"),
            }
        )
    except ValidationError as error:
        raise DraftError(f"枠の形が契約と合わない: {error}") from error


def load_exercise_draft(path: Path) -> FormationConfig:
    stored = _stored_object(path)
    draft = stored.get("draft")
    if not isinstance(draft, dict):
        raise DraftError(f"{path}: `draft` が無い（{EXERCISE_DRAFT_STORAGE_KEY} の中身を渡す）")

    ally = _filled_slots(draft.get("allySlots"), "allySlots", path)
    enemy = _filled_slots(draft.get("enemySlots"), "enemySlots", path)
    _reject_unusable(ally, enemy, path)
    _reject_enemy_memories(draft.get("enemyMemoryDefinitionIds"), path)

    # UIの盤面は6枠あり、R-FRM-01の上限（5体）を超えたドラフトも保存され得る。
    # 編成モデル側の宣言的な制約はここで初めて効くので、`ValidationError` を
    # そのまま外へ出さず利用者向けのエラーへ畳む。
    try:
        return _config_of(ally, enemy, draft, path)
    except ValidationError as error:
        raise DraftError(f"{path}: 演習の編成として成立しない: {_reasons(error)}") from error


def _reasons(error: ValidationError) -> str:
    return "; ".join(detail["msg"] for detail in error.errors())


def _config_of(
    ally: list[StoredSlot], enemy: list[StoredSlot], draft: dict[str, object], path: Path
) -> FormationConfig:
    return FormationConfig(
        ally=AllySpec(
            units=[
                AllyUnitSpec(
                    unitDefinitionId=slot.unit_definition_id,
                    position=Position(column=slot.column, row=slot.row),
                )
                for slot in ally
            ],
            memoryDefinitionIds=_memory_ids(draft.get("allyMemoryDefinitionIds"), path),
        ),
        enemy=EnemySpec(
            unitDefinitionId=enemy[0].unit_definition_id,
            position=Position(column=enemy[0].column, row=enemy[0].row),
        ),
    )


def _stored_object(path: Path) -> dict[str, object]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DraftError(f"{path}: JSONとして読めない: {error}") from error
    if not isinstance(raw, dict):
        raise DraftError(f"{path}: トップレベルはオブジェクトでなければならない")
    version = raw.get("schemaVersion")
    if version != SUPPORTED_SCHEMA_VERSION:
        raise DraftError(
            f"{path}: 未対応の schemaVersion={version!r}"
            f"（このツールは {SUPPORTED_SCHEMA_VERSION} だけを読む）"
        )
    return raw


def _filled_slots(value: object, field: str, path: Path) -> list[StoredSlot]:
    if not isinstance(value, list):
        raise DraftError(f"{path}: `{field}` が配列ではない")
    slots = [_slot_of(entry) for entry in value]
    filled = [slot for slot in slots if slot.unit_definition_id]
    # 保存された配列順ではなく行・列で並べ替える。送信順はUIの生成物と揃えたいが、
    # 保存順がその規則である保証はない（`buildFormation` は毎回並べ替えている）。
    return sorted(filled, key=lambda slot: (ROW_ORDER[slot.row], slot.column))


def _reject_unusable(ally: list[StoredSlot], enemy: list[StoredSlot], path: Path) -> None:
    if not ally:
        raise DraftError(f"{path}: 味方が0体のドラフトからは編成を作れない")
    if len(ally) > MAX_ALLY_UNITS:
        # UIの盤面は6枠あるので、6体埋めたドラフトも保存できてしまう。
        raise DraftError(
            f"{path}: 味方が{len(ally)}体ある。編成できるのは{MAX_ALLY_UNITS}体まで（R-FRM-01）"
        )
    if not enemy:
        raise DraftError(f"{path}: 敵が置かれていない（演習は敵1体が要る）")
    if len(enemy) > EXERCISE_ENEMY_UNIT_COUNT:
        # 通常戦闘のドラフト（`mlgg:last-draft`）は敵を最大5体持つため、キーの取り違えが
        # ここで現れることがある。体数だけでなく渡すべきキーまで名指しする（ただし
        # 敵1体の通常戦闘ドラフトはここを通る——`_reject_enemy_memories` 参照）。
        raise DraftError(
            f"{path}: 敵が{len(enemy)}体ある。演習の敵はちょうど1体（R-TEX-01 #3）。"
            f"通常戦闘の `mlgg:last-draft` ではなく `{EXERCISE_DRAFT_STORAGE_KEY}` を書き出す"
        )


def _reject_enemy_memories(value: object, path: Path) -> None:
    """敵メモリーを持つドラフトは通常戦闘のもの。

    演習の敵はメモリーを持てず（R-TEX-01 #3）、UIも演習モードでは敵メモリー枠を
    出さない。したがって1件でも入っていれば通常戦闘の `mlgg:last-draft` である。
    ただし逆は言えない——敵1体・敵メモリーなしの通常戦闘ドラフトは保存形式だけでは
    演習用と区別できず、ここは通る。その取り違えは `lab stats` のCatalog検証が
    捕まえる（通常戦闘の敵は `PLAYABLE` なので R-TEX-11 #1 で弾かれる）。
    """
    if not isinstance(value, list):
        return
    if any(isinstance(entry, str) and entry for entry in value):
        raise DraftError(
            f"{path}: 敵メモリーが入っている。演習の敵はメモリーを持たない（R-TEX-01 #3）。"
            f"通常戦闘の `mlgg:last-draft` ではなく `{EXERCISE_DRAFT_STORAGE_KEY}` を書き出す"
        )


def _memory_ids(value: object, path: Path) -> list[str]:
    if not isinstance(value, list):
        raise DraftError(f"{path}: `allyMemoryDefinitionIds` が配列ではない")
    # 空枠は配列上 `null`。除いたうえで枠順のまま返す。
    return [entry for entry in value if isinstance(entry, str) and entry]
