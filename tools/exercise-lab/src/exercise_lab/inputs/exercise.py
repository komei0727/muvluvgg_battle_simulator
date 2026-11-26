"""戦術演習の既存入力形式のアダプター。

演習の編成YAML（味方 + 敵1体）と、UIの演習ドラフト（localStorage
`mlgg:last-draft:exercise`）の受理条件はここに閉じ込める。値型・手持ちデータ・
ドラフトの読み取り自体は戦闘種別に依らないモジュールが持つ。

通常戦闘のドラフト（`mlgg:last-draft`）との取り違えは、保存形式が同じ `BattleDraft` で
あるため完全には判別できない。敵が2体以上のときと敵メモリーを持つときはここで
落とせるが、敵1体・敵メモリーなしの通常戦闘ドラフトは通る。それは Catalog との
突き合わせ（{@link validate_against_catalog}）が捕まえる——通常戦闘の敵は `PLAYABLE`
であり、演習の敵プール（`EXERCISE_ENEMY`）に合わないため R-TEX-11 #1 で弾かれる。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import Field, ValidationError

from .catalog import EXERCISE_ENEMY, PLAYABLE, Catalog, memory_errors, unit_errors
from .draft import DraftError, StoredDraft, StoredSlot, load_draft
from .models import (
    MAX_ALLY_UNITS,
    AllySpec,
    AllyUnitSpec,
    ConfigError,
    FlowMapping,
    Position,
    Spec,
    dump_yaml,
    load_yaml_mapping,
    placement_documents,
    validate_ally,
)
from .player_data import PlayerData
from .player_data import apply_player_data as apply_player_data_to_ally

EXERCISE_DRAFT_STORAGE_KEY = "mlgg:last-draft:exercise"
EXERCISE_ENEMY_UNIT_COUNT = 1


class EnemySpec(Spec):
    """`R-TEX-01` #3: 敵はちょうど1体でメモリーを持たない。強化も指定できない。"""

    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position


class FormationConfig(Spec):
    ally: AllySpec
    enemy: EnemySpec


def load_formation_config(path: Path) -> FormationConfig:
    raw = load_yaml_mapping(path)
    try:
        config = FormationConfig.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    validate_ally(config.ally, path)
    return config


def dump_formation_config(config: FormationConfig) -> str:
    """編成YAMLを書き出す。`load_formation_config` が読み戻せる形だけを出す。

    強化情報（`academyLevels` / `level` / `gears`）は出力しない。育成状態の正本は
    手持ちデータであり、YAMLへ焼くと同じ値が2か所に生まれる。
    """
    return dump_yaml(
        {
            "ally": {
                "units": placement_documents(config.ally.units),
                "memoryDefinitionIds": list(config.ally.memory_definition_ids),
            },
            "enemy": {
                "unitDefinitionId": config.enemy.unit_definition_id,
                "position": FlowMapping(
                    column=config.enemy.position.column, row=config.enemy.position.row
                ),
            },
        }
    )


def build_enemy_formation(enemy: EnemySpec) -> dict[str, Any]:
    """`FormationRequest`（演習の敵）。メモリー・強化を持たない（`R-TEX-01` #3）。"""
    return {
        "units": [
            {
                "unitDefinitionId": enemy.unit_definition_id,
                "position": enemy.position.model_dump(),
            }
        ],
        "memoryDefinitionIds": [],
    }


def apply_player_data(
    config: FormationConfig, data: PlayerData
) -> tuple[FormationConfig, list[str]]:
    """味方側にだけ手持ちデータを適用する。演習の敵は強化を持たない。"""
    ally, warnings = apply_player_data_to_ally(config.ally, data)
    return config.model_copy(update={"ally": ally}), warnings


def validate_against_catalog(config: FormationConfig, catalog: Catalog) -> list[str]:
    """編成YAMLをカタログと突き合わせ、見つかった問題をすべて返す。

    最初の1件で止めない。IDの打ち間違いが複数あるときに1件ずつ往復させると、
    devサーバー起動込みの試行錯誤が長くなる。
    """
    errors: list[str] = []
    for unit in config.ally.units:
        errors.extend(unit_errors(unit.unit_definition_id, "ally", PLAYABLE, catalog))
    errors.extend(unit_errors(config.enemy.unit_definition_id, "enemy", EXERCISE_ENEMY, catalog))
    errors.extend(
        memory_errors(config.ally.memory_definition_ids, "ally.memoryDefinitionIds", catalog)
    )
    return errors


def load_exercise_draft(path: Path) -> FormationConfig:
    draft = load_draft(path, storage_key=EXERCISE_DRAFT_STORAGE_KEY)
    _reject_unusable(draft, path)
    # UIの盤面は6枠あり、R-FRM-01の上限（5体）を超えたドラフトも保存され得る。
    # 編成モデル側の宣言的な制約はここで初めて効くので、`ValidationError` を
    # そのまま外へ出さず利用者向けのエラーへ畳む。
    try:
        return _config_of(draft)
    except ValidationError as error:
        raise DraftError(f"{path}: 演習の編成として成立しない: {_reasons(error)}") from error


def _reasons(error: ValidationError) -> str:
    return "; ".join(detail["msg"] for detail in error.errors())


def _config_of(draft: StoredDraft) -> FormationConfig:
    enemy = draft.enemy_slots[0]
    return FormationConfig(
        ally=AllySpec(
            units=[_ally_unit(slot) for slot in draft.ally_slots],
            memoryDefinitionIds=list(draft.ally_memory_definition_ids),
        ),
        enemy=EnemySpec(
            unitDefinitionId=enemy.unit_definition_id,
            position=Position(column=enemy.column, row=enemy.row),
        ),
    )


def _ally_unit(slot: StoredSlot) -> AllyUnitSpec:
    return AllyUnitSpec(
        unitDefinitionId=slot.unit_definition_id,
        position=Position(column=slot.column, row=slot.row),
    )


def _reject_unusable(draft: StoredDraft, path: Path) -> None:
    ally, enemy = draft.ally_slots, draft.enemy_slots
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
        # ここで現れることがある。体数だけでなく渡すべきキーまで名指しする。
        raise DraftError(
            f"{path}: 敵が{len(enemy)}体ある。演習の敵はちょうど1体（R-TEX-01 #3）。"
            f"通常戦闘の `mlgg:last-draft` ではなく `{EXERCISE_DRAFT_STORAGE_KEY}` を書き出す"
        )
    if draft.enemy_memory_definition_ids:
        # 演習の敵はメモリーを持てず（R-TEX-01 #3）、UIも演習モードでは敵メモリー枠を
        # 出さない。1件でも入っていれば通常戦闘の `mlgg:last-draft` である。
        raise DraftError(
            f"{path}: 敵メモリーが入っている。演習の敵はメモリーを持たない（R-TEX-01 #3）。"
            f"通常戦闘の `mlgg:last-draft` ではなく `{EXERCISE_DRAFT_STORAGE_KEY}` を書き出す"
        )
