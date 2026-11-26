"""戦術演習の既存入力形式のアダプター。

演習の編成YAML（味方 + 敵1体）と、UIの演習ドラフト（localStorage
`mlgg:last-draft:exercise`）の受理条件はここに閉じ込める。値型・手持ちデータ・
ドラフトの読み取り自体は戦闘形式に依らない `mlgg_lab_common` が持つ。

演習の対戦条件は「味方編成 + 演習対象（敵1体と配置）」である。規定ターン数は5で固定
（R-TEX-01 #4）なので持たない。最終的な受理判定はAPIが行う。

通常戦闘のドラフト（`mlgg:last-draft`）との取り違えは、保存形式が同じ `BattleDraft` で
あるため完全には判別できない。敵が2体以上のときと敵メモリーを持つときはここで
落とせるが、敵1体・敵メモリーなしの通常戦闘ドラフトは通る。それは Catalog との
突き合わせ（`validate_against_catalog`）が捕まえる——通常戦闘の敵は `PLAYABLE`
であり、演習の敵プール（`EXERCISE_ENEMY`）に合わないため R-TEX-11 #1 で弾かれる。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError

from mlgg_lab_common.inputs.catalog import (
    EXERCISE_ENEMY,
    PLAYABLE,
    Catalog,
    memory_errors,
    unit_errors,
)
from mlgg_lab_common.inputs.draft import DraftError, StoredDraft, formation_of, load_draft
from mlgg_lab_common.inputs.player_data import PlayerData
from mlgg_lab_common.inputs.player_data import apply_player_data as apply_player_data_to_formation
from mlgg_lab_common.inputs.resolution import load_player_data_input, raise_if_invalid
from mlgg_lab_common.inputs.sources import load_formation_entry
from mlgg_lab_common.inputs.yaml_io import (
    FlowMapping,
    dump_yaml,
    load_yaml_mapping,
    placement_documents,
)
from mlgg_lab_common.models import (
    MAX_FORMATION_UNITS,
    ConfigError,
    FormationSpec,
    FormationUnitSpec,
    InputProvenance,
    InputSource,
    ParticipantSlot,
    Position,
    ResolvedInput,
    Spec,
    build_formation_request,
    dump_resolved_input,
    load_resolved_input,
    participant_slots,
    revalidated,
    validate_formation,
)

EXERCISE_DRAFT_STORAGE_KEY = "mlgg:last-draft:exercise"
EXERCISE_ENEMY_UNIT_COUNT = 1
# 演習の編成プール: 味方は `PLAYABLE`、敵は `EXERCISE_ENEMY`。
EXERCISE_POOL_RULE = "R-TEX-11 #1"


class EnemySpec(Spec):
    """`R-TEX-01` #3: 敵はちょうど1体でメモリーを持たない。強化も指定できない。"""

    unit_definition_id: str = Field(alias="unitDefinitionId", min_length=1)
    position: Position


class FormationConfig(Spec):
    """演習の対戦条件（編成定義YAMLの形）。"""

    ally: FormationSpec
    enemy: EnemySpec


def load_formation_config(path: Path) -> FormationConfig:
    raw = load_yaml_mapping(path)
    try:
        config = FormationConfig.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    validate_formation(config.ally, f"{path}: ally")
    return config


_MATCH_FILE_KEYS = frozenset({"ally", "enemy"})


def load_exercise_match_file(
    path: Path, *, formations_dir: Path | None = None
) -> tuple[FormationConfig, list[InputSource]]:
    """評価設定が参照する演習の対戦入力（YAML）を読む。

    形は編成定義YAML（`ally` + `enemy`）と同じで、`ally` に編成ライブラリの参照
    （`{ library: <id> }`、`formations_dir` から展開）も書ける。ライブラリは import-draft が
    書き出す味方編成だけのファイルなので、演習の敵はここで組み合わせる。
    """
    raw = load_yaml_mapping(path)
    unknown = sorted(set(raw) - _MATCH_FILE_KEYS)
    if unknown:
        # 規定ターン数（R-TEX-01 #4）のような演習に無い指定を、黙って捨てない。
        raise ConfigError(f"{path}: 未知のキーがある: {', '.join(unknown)}")
    if "ally" not in raw or "enemy" not in raw:
        raise ConfigError(f"{path}: ally と enemy の両方を書く")
    sources = [InputSource(role="MATCH_FILE", path=str(path))]
    loaded = load_formation_entry(raw["ally"], f"{path}: ally", formations_dir=formations_dir)
    if loaded.source is not None:
        sources.append(loaded.source.model_copy(update={"applies_to": "ally"}))
    try:
        config = FormationConfig.model_validate({"ally": loaded.formation, "enemy": raw["enemy"]})
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    return config, sources


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
    ally, warnings = apply_player_data_to_formation(config.ally, data)
    return config.model_copy(update={"ally": ally}), warnings


def validate_against_catalog(config: FormationConfig, catalog: Catalog) -> list[str]:
    """編成YAMLをカタログと突き合わせ、見つかった問題をすべて返す。

    最初の1件で止めない。IDの打ち間違いが複数あるときに1件ずつ往復させると、
    devサーバー起動込みの試行錯誤が長くなる。
    """
    errors: list[str] = []
    for unit in config.ally.units:
        errors.extend(
            unit_errors(unit.unit_definition_id, "ally", PLAYABLE, catalog, rule=EXERCISE_POOL_RULE)
        )
    errors.extend(
        unit_errors(
            config.enemy.unit_definition_id,
            "enemy",
            EXERCISE_ENEMY,
            catalog,
            rule=EXERCISE_POOL_RULE,
        )
    )
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
        ally=formation_of(draft.ally_slots, draft.ally_memory_definition_ids),
        enemy=EnemySpec(
            unitDefinitionId=enemy.unit_definition_id,
            position=Position(column=enemy.column, row=enemy.row),
        ),
    )


def _reject_unusable(draft: StoredDraft, path: Path) -> None:
    ally, enemy = draft.ally_slots, draft.enemy_slots
    if not ally:
        raise DraftError(f"{path}: 味方が0体のドラフトからは編成を作れない")
    if len(ally) > MAX_FORMATION_UNITS:
        # UIの盤面は6枠あるので、6体埋めたドラフトも保存できてしまう。
        raise DraftError(
            f"{path}: 味方が{len(ally)}体ある。"
            f"編成できるのは{MAX_FORMATION_UNITS}体まで（R-FRM-01）"
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


def build_exercise_request(config: FormationConfig) -> dict[str, Any]:
    """`TacticalExerciseRequest` の対戦条件部分（`options` を除く）。

    評価API（`TacticalExerciseEvaluationCaseRequest`）もケースごとに同じ2編成を持つので、
    そのまま評価のケースへ載る。
    """
    return {
        "allyFormation": build_formation_request(config.ally),
        "enemyFormation": build_enemy_formation(config.enemy),
    }


def exercise_participant_slots(config: FormationConfig) -> list[ParticipantSlot]:
    enemy = FormationSpec(
        units=[
            FormationUnitSpec(
                unitDefinitionId=config.enemy.unit_definition_id,
                position=config.enemy.position,
            )
        ]
    )
    return participant_slots("ALLY", [config.ally], numbered=False) + participant_slots(
        "ENEMY", [enemy], numbered=False
    )


class ResolvedExerciseInput(ResolvedInput):
    """解決済みの演習入力。手持ちデータ適用後の編成をそのまま持つ。"""

    format: Literal["TACTICAL_EXERCISE"] = "TACTICAL_EXERCISE"
    match: FormationConfig

    def validate_match(self, where: str) -> None:
        validate_formation(self.match.ally, f"{where}: match.ally")

    def to_request(self) -> dict[str, Any]:
        return build_exercise_request(self.match)

    def participant_slots(self) -> list[ParticipantSlot]:
        return exercise_participant_slots(self.match)


def resolve_exercise_input(
    config_path: Path,
    *,
    player_data_path: Path | None = None,
    catalog: Catalog | None = None,
) -> ResolvedExerciseInput:
    """編成定義YAML（+ 手持ちデータ・Catalog）から解決済みの演習入力を作る。

    `catalog` を渡すと参照（未知ID・編成プール）を事前検証し、問題があればすべて
    まとめて `InputValidationError` で落とす。渡さない場合は検証をAPIへ委ねる。
    """
    config = load_formation_config(config_path)
    return resolve_exercise_config(
        config,
        origin=InputSource(role="MATCH_FILE", path=str(config_path)),
        player_data_path=player_data_path,
        catalog=catalog,
    )


def resolve_exercise_config(
    config: FormationConfig,
    *,
    origin: InputSource | list[InputSource],
    player_data_path: Path | None = None,
    catalog: Catalog | None = None,
) -> ResolvedExerciseInput:
    """読み込み済みの演習入力（YAML・ドラフトのどちらから作ったものでもよい）を解決する。

    `origin` は入力の由来。編成ライブラリから展開した対戦入力は、ライブラリも並べて渡す。
    """
    sources = list(origin) if isinstance(origin, list) else [origin]
    warnings: list[str] = []
    if player_data_path is not None:
        player_data = load_player_data_input(player_data_path)
        config, warnings = apply_player_data(config, player_data.data)
        sources.append(player_data.source.model_copy(update={"applies_to": "ally"}))
    if catalog is not None:
        raise_if_invalid(validate_against_catalog(config, catalog))
    return revalidated(
        ResolvedExerciseInput(
            match=config,
            provenance=InputProvenance(
                sources=sources,
                catalogRevision=None if catalog is None else catalog.catalog_revision,
                warnings=warnings,
            ),
        )
    )


def dump_resolved_exercise_input(resolved: ResolvedExerciseInput) -> str:
    return dump_resolved_input(resolved)


def load_resolved_exercise_input(path: Path) -> ResolvedExerciseInput:
    return load_resolved_input(
        ResolvedExerciseInput, path.read_text(encoding="utf-8"), where=str(path)
    )
