"""通常戦闘（`NORMAL`）の対戦入力。

対戦条件は「両陣営の編成 + 規定ターン数」で、`BattleSimulationRequest`／
`BattleEvaluationCaseRequest` の対戦条件部分と同じ形を持つ。編成そのものは
`mlgg_lab_common` の陣営に依らないモデルを使い、ここは通常戦闘に固有の条件だけを持つ。

- 規定ターン数は1～99（R-FRM-05）。
- 編成プールは両陣営とも `PLAYABLE`（R-TEX-11 #3）。
- 同じ `unitDefinitionId` を同一陣営へ複数置ける（R-FRM-03）。参加枠は定義IDではなく
  `(side, unitIndex)` で区別する。
- 演習の制約（敵1体・敵メモリーなし・敵は `EXERCISE_ENEMY`）は持ち込まない。

ここの検証は事前検証であり、最終的な受理判定はAPIが行う。

入力は次のいずれかから作る。

- 対戦入力ファイル（YAML）: キーはAPIと同じ `allyFormation` / `enemyFormation` /
  `turnLimit`。編成はインラインか編成ライブラリの参照（`{ library: <id> }`）で書く。
- UIの通常戦闘ドラフト（localStorage `mlgg:last-draft`）: 配置・ユニット・メモリー順と
  規定ターン数を読む。強化入力は読まない（育成状態の正本は手持ちデータ）。
"""

from __future__ import annotations

from collections.abc import Collection
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, StrictInt, ValidationError

from mlgg_lab_common.inputs.catalog import PLAYABLE, Catalog, formation_reference_errors
from mlgg_lab_common.inputs.draft import DraftError, formation_of, load_draft
from mlgg_lab_common.inputs.resolution import (
    apply_player_data_at,
    load_player_data_input,
    raise_if_invalid,
)
from mlgg_lab_common.inputs.sources import load_formation_entry
from mlgg_lab_common.inputs.yaml_io import load_yaml_mapping
from mlgg_lab_common.models import (
    ConfigError,
    FormationSpec,
    InputProvenance,
    InputSource,
    ParticipantSlot,
    ResolvedInput,
    Side,
    Spec,
    build_formation_request,
    dump_resolved_input,
    load_resolved_input,
    participant_slots,
    revalidated,
    validate_formation,
)

BATTLE_DRAFT_STORAGE_KEY = "mlgg:last-draft"
# R-FRM-05
MIN_TURN_LIMIT = 1
MAX_TURN_LIMIT = 99
# 通常戦闘の編成プール: 両陣営とも `PLAYABLE`。
NORMAL_POOL_RULE = "R-TEX-11 #3"

_SIDE_FIELDS: dict[Side, str] = {"ALLY": "allyFormation", "ENEMY": "enemyFormation"}


class BattleMatch(Spec):
    ally_formation: FormationSpec = Field(alias="allyFormation")
    enemy_formation: FormationSpec = Field(alias="enemyFormation")
    # `StrictInt`: `true` や `"10"`・`10.0` を黙ってターン数として読まない。
    turn_limit: StrictInt = Field(alias="turnLimit", ge=MIN_TURN_LIMIT, le=MAX_TURN_LIMIT)

    def formation(self, side: Side) -> FormationSpec:
        return self.ally_formation if side == "ALLY" else self.enemy_formation


def validate_battle_match(match: BattleMatch, where: str) -> None:
    """pydanticの宣言で表せない受理条件（各陣営の配置重複・強化指定の組み合わせ）。"""
    for side, field in _SIDE_FIELDS.items():
        validate_formation(match.formation(side), f"{where}: {field}")


def build_battle_request(match: BattleMatch) -> dict[str, Any]:
    """`BattleSimulationRequest` の対戦条件部分（`options` を除く）。

    大量試行API（`BattleEvaluationCaseRequest`）は、これに `caseId` と `runIndices` を
    足した形になる。
    """
    return {
        "allyFormation": build_formation_request(match.ally_formation),
        "enemyFormation": build_formation_request(match.enemy_formation),
        "turnLimit": match.turn_limit,
    }


def battle_participant_slots(match: BattleMatch) -> list[ParticipantSlot]:
    return participant_slots("ALLY", [match.ally_formation], numbered=False) + participant_slots(
        "ENEMY", [match.enemy_formation], numbered=False
    )


def validate_against_catalog(match: BattleMatch, catalog: Catalog) -> list[str]:
    """両陣営の参照をCatalogと突き合わせ、見つかった問題をすべて返す。"""
    errors: list[str] = []
    for side, field in _SIDE_FIELDS.items():
        errors.extend(
            formation_reference_errors(
                match.formation(side),
                field,
                catalog,
                required_category=PLAYABLE,
                rule=NORMAL_POOL_RULE,
            )
        )
    return errors


class LoadedBattleMatch(Spec):
    match: BattleMatch
    sources: list[InputSource]


_MATCH_FILE_KEYS = frozenset({"allyFormation", "enemyFormation", "turnLimit"})


def load_battle_match_file(path: Path, *, formations_dir: Path | None = None) -> LoadedBattleMatch:
    """対戦入力ファイル（YAML）を読む。編成ライブラリの参照は `formations_dir` から展開する。"""
    raw = load_yaml_mapping(path)
    unknown = sorted(set(raw) - _MATCH_FILE_KEYS)
    if unknown:
        # 綴り違いを既定動作へすり替えない。
        raise ConfigError(f"{path}: 未知のキーがある: {', '.join(unknown)}")
    sources = [InputSource(role="MATCH_FILE", path=str(path))]
    formations: dict[str, FormationSpec] = {}
    for field in _SIDE_FIELDS.values():
        if field not in raw:
            raise ConfigError(f"{path}: {field} が無い")
        loaded = load_formation_entry(raw[field], f"{path}: {field}", formations_dir=formations_dir)
        formations[field] = loaded.formation
        if loaded.source is not None:
            sources.append(loaded.source.model_copy(update={"applies_to": field}))
    try:
        match = BattleMatch.model_validate({**formations, "turnLimit": raw.get("turnLimit")})
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    return LoadedBattleMatch(match=match, sources=sources)


def load_battle_draft(path: Path, *, turn_limit: int | None = None) -> LoadedBattleMatch:
    """UIの通常戦闘ドラフト（`mlgg:last-draft`）を読む。

    `turn_limit` を渡すとドラフトの規定ターン数より優先する（ドラフト側が未入力でも
    読めるようにするため）。
    """
    draft = load_draft(path, storage_key=BATTLE_DRAFT_STORAGE_KEY)
    if not draft.ally_slots or not draft.enemy_slots:
        raise DraftError(f"{path}: 通常戦闘は両陣営に1体以上が要る（R-FRM-01）")
    resolved_turn_limit = draft.turn_limit if turn_limit is None else turn_limit
    if resolved_turn_limit is None:
        raise DraftError(f"{path}: 規定ターン数が入力されていない（turn_limit を指定する）")
    try:
        match = BattleMatch(
            allyFormation=formation_of(draft.ally_slots, draft.ally_memory_definition_ids),
            enemyFormation=formation_of(draft.enemy_slots, draft.enemy_memory_definition_ids),
            turnLimit=resolved_turn_limit,
        )
    except ValidationError as error:
        reasons = "; ".join(detail["msg"] for detail in error.errors())
        raise DraftError(f"{path}: 通常戦闘の対戦入力として成立しない: {reasons}") from error
    validate_battle_match(match, str(path))
    return LoadedBattleMatch(match=match, sources=[InputSource(role="DRAFT", path=str(path))])


class ResolvedBattleInput(ResolvedInput):
    """解決済みの通常戦闘入力。手持ちデータ適用後の両編成と規定ターン数を持つ。"""

    format: Literal["BATTLE"] = "BATTLE"
    match: BattleMatch

    def to_request(self) -> dict[str, Any]:
        return build_battle_request(self.match)

    def participant_slots(self) -> list[ParticipantSlot]:
        return battle_participant_slots(self.match)


def resolve_battle_input(
    loaded: LoadedBattleMatch,
    *,
    player_data_path: Path | None = None,
    player_data_sides: Collection[Side] = ("ALLY",),
    catalog: Catalog | None = None,
) -> ResolvedBattleInput:
    """読み込んだ対戦入力へ手持ちデータを当て、参照を検証して解決済み入力にする。

    手持ちデータは自分の育成状態なので、既定では味方にだけ当てる。両陣営を同じ育成
    状態で比べる（自分の手持ちどうしの対戦を想定する）ときは `player_data_sides` に
    `("ALLY", "ENEMY")` を渡す。どちらの陣営でも、編成に明示した値が優先する。

    `catalog` を渡すと参照（未知ID・編成プール）を事前検証し、問題があればすべて
    まとめて `InputValidationError` で落とす。
    """
    match = loaded.match
    sources = list(loaded.sources)
    warnings: list[str] = []
    if player_data_path is not None:
        player_data = load_player_data_input(player_data_path)
        updates: dict[str, FormationSpec] = {}
        for side in player_data_sides:
            field = _SIDE_FIELDS[side]
            applied, side_warnings = apply_player_data_at(
                match.formation(side), player_data.data, field
            )
            updates[_attribute_of(side)] = applied
            warnings.extend(side_warnings)
            sources.append(player_data.source.model_copy(update={"applies_to": field}))
        match = match.model_copy(update=updates)
    if catalog is not None:
        raise_if_invalid(validate_against_catalog(match, catalog))
    return revalidated(
        ResolvedBattleInput(
            match=match,
            provenance=InputProvenance(
                sources=sources,
                catalogRevision=None if catalog is None else catalog.catalog_revision,
                warnings=warnings,
            ),
        )
    )


def _attribute_of(side: Side) -> str:
    return "ally_formation" if side == "ALLY" else "enemy_formation"


def dump_resolved_battle_input(resolved: ResolvedBattleInput) -> str:
    return dump_resolved_input(resolved)


def load_resolved_battle_input(path: Path) -> ResolvedBattleInput:
    resolved = load_resolved_input(
        ResolvedBattleInput, path.read_text(encoding="utf-8"), where=str(path)
    )
    # 保存後に手で直された場合も、読み込みと同じ受理条件を通す。
    validate_battle_match(resolved.match, f"{path}: match")
    return resolved
