"""総力戦（`TOTAL_WAR`）の対戦入力。

対戦条件は「両陣営の編成列（出撃順）」で、`TotalWarRequest`／
`TotalWarEvaluationCaseRequest` の対戦条件部分と同じ形を持つ。規定ターン数は15で固定
（R-TWR-01 #5）なので持たない。編成そのものは `mlgg_lab_common` の陣営に依らない
モデルを使い、ここは総力戦に固有の条件だけを持つ。

- 各陣営1～3編成。両陣営の編成数は違ってよい（R-TWR-01 #1）。
- 各編成にはR-FRM-01／02／04をそのまま適用する。配置の重複は編成ごとに判定し、
  別の編成どうしは同じ配置位置を使ってよい（#2）。
- 1編成内で同じ `unitDefinitionId`・同じメモリーIDを指定できない（#3／#4）。
  **別の編成への再登場は許可する。** 再登場の基礎値補正（R-TWR-02）はAPIが自動で
  掛けるので、入力では表さない。
- 編成プールは両陣営とも `PLAYABLE`（#6）。
- 編成の順序は出撃順であり、並べ替えない。参加枠は `(side, formationNumber, unitIndex)`
  で区別する（再登場ユニットは定義IDだけでは区別できない）。

ここの検証は事前検証であり、最終的な受理判定はAPIが行う。

入力は次のいずれかから作る。

- 対戦入力ファイル（YAML）: キーはAPIと同じ `allyFormations` / `enemyFormations`。
  各要素はインラインか編成ライブラリの参照（`{ library: <id> }`）で書く。
- UIの総力戦ドラフト（localStorage `mlgg:last-draft:total-war`）: 3組のうち各陣営の
  編成数ぶんを先頭から使う。強化入力は読まない（育成状態の正本は手持ちデータ）。
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Collection
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, ValidationError

from mlgg_lab_common.inputs.catalog import PLAYABLE, Catalog, formation_reference_errors
from mlgg_lab_common.inputs.draft import (
    DraftError,
    StoredSlot,
    formation_of,
    load_stored_object,
    parse_draft_body,
)
from mlgg_lab_common.inputs.resolution import (
    InputValidationError,
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
    validate_formation,
)

TOTAL_WAR_DRAFT_STORAGE_KEY = "mlgg:last-draft:total-war"
# R-TWR-01 #1
MAX_FORMATIONS = 3
# 総力戦の編成プール: 両陣営とも `PLAYABLE`。
TOTAL_WAR_POOL_RULE = "R-TEX-11 #3・R-TWR-01 #6"
# UIのドラフトは編成数によらず常に3組を持つ。
DRAFT_FORMATION_SETS = 3

_SIDE_FIELDS: dict[Side, str] = {"ALLY": "allyFormations", "ENEMY": "enemyFormations"}


class TotalWarMatch(Spec):
    ally_formations: list[FormationSpec] = Field(
        alias="allyFormations", min_length=1, max_length=MAX_FORMATIONS
    )
    enemy_formations: list[FormationSpec] = Field(
        alias="enemyFormations", min_length=1, max_length=MAX_FORMATIONS
    )

    def formations(self, side: Side) -> list[FormationSpec]:
        return self.ally_formations if side == "ALLY" else self.enemy_formations


def total_war_errors(match: TotalWarMatch) -> list[str]:
    """1編成内の重複（R-TWR-01 #3／#4）をすべて返す。編成をまたぐ重複は再登場として許可する。

    パスはAPIのviolationと同じく編成・枠の添字を含める（例:
    `allyFormations[1].units[3].unitDefinitionId`）。
    """
    errors: list[str] = []
    for side, field in _SIDE_FIELDS.items():
        for index, formation in enumerate(match.formations(side)):
            where = f"{field}[{index}]"
            errors.extend(
                f"{where}.units[{position}].unitDefinitionId: 編成内で {unit_id} が重複している"
                "（R-TWR-01 #3。別の編成への再登場は可）"
                for position, unit_id in _repeated(
                    [unit.unit_definition_id for unit in formation.units]
                )
            )
            errors.extend(
                f"{where}.memoryDefinitionIds[{position}]: 編成内で {memory_id} が重複している"
                "（R-TWR-01 #4。別の編成への再登場は可）"
                for position, memory_id in _repeated(formation.memory_definition_ids)
            )
    return errors


def _repeated(values: list[str]) -> list[tuple[int, str]]:
    """2回目以降に現れた値の添字。1回目は正当な指定なので指さない。"""
    seen: Counter[str] = Counter()
    repeated: list[tuple[int, str]] = []
    for index, value in enumerate(values):
        if seen[value]:
            repeated.append((index, value))
        seen[value] += 1
    return repeated


def validate_total_war_match(match: TotalWarMatch, where: str) -> None:
    """pydanticの宣言で表せない受理条件。違反はまとめて `InputValidationError` で返す。"""
    for side, field in _SIDE_FIELDS.items():
        for index, formation in enumerate(match.formations(side)):
            validate_formation(formation, f"{where}: {field}[{index}]")
    errors = total_war_errors(match)
    if errors:
        raise InputValidationError([f"{where}: {error}" for error in errors])


def build_total_war_request(match: TotalWarMatch) -> dict[str, Any]:
    """`TotalWarRequest` の対戦条件部分（`options` を除く）。編成は出撃順のまま送る。

    大量試行API（`TotalWarEvaluationCaseRequest`）は、これに `caseId` と `runIndices` を
    足した形になる。
    """
    return {
        "allyFormations": [build_formation_request(f) for f in match.ally_formations],
        "enemyFormations": [build_formation_request(f) for f in match.enemy_formations],
    }


def total_war_participant_slots(match: TotalWarMatch) -> list[ParticipantSlot]:
    return participant_slots("ALLY", match.ally_formations, numbered=True) + participant_slots(
        "ENEMY", match.enemy_formations, numbered=True
    )


def validate_against_catalog(match: TotalWarMatch, catalog: Catalog) -> list[str]:
    """全編成の参照をCatalogと突き合わせ、見つかった問題をすべて返す。"""
    errors: list[str] = []
    for side, field in _SIDE_FIELDS.items():
        for index, formation in enumerate(match.formations(side)):
            errors.extend(
                formation_reference_errors(
                    formation,
                    f"{field}[{index}]",
                    catalog,
                    required_category=PLAYABLE,
                    rule=TOTAL_WAR_POOL_RULE,
                )
            )
    return errors


class LoadedTotalWarMatch(Spec):
    match: TotalWarMatch
    sources: list[InputSource]


_MATCH_FILE_KEYS = frozenset(_SIDE_FIELDS.values())


def load_total_war_match_file(
    path: Path, *, formations_dir: Path | None = None
) -> LoadedTotalWarMatch:
    """対戦入力ファイル（YAML）を読む。編成ライブラリの参照は `formations_dir` から展開する。"""
    raw = load_yaml_mapping(path)
    unknown = sorted(set(raw) - _MATCH_FILE_KEYS)
    if unknown:
        # `turnLimit` もここで落ちる。総力戦の規定ターン数は固定で指定できない。
        raise ConfigError(f"{path}: 未知のキーがある: {', '.join(unknown)}")
    sources = [InputSource(role="MATCH_FILE", path=str(path))]
    sides: dict[str, list[FormationSpec]] = {}
    for field in _SIDE_FIELDS.values():
        entries = raw.get(field)
        if not isinstance(entries, list):
            raise ConfigError(f"{path}: {field} は編成の配列（出撃順）でなければならない")
        formations: list[FormationSpec] = []
        for index, entry in enumerate(entries):
            where = f"{field}[{index}]"
            loaded = load_formation_entry(entry, f"{path}: {where}", formations_dir=formations_dir)
            formations.append(loaded.formation)
            if loaded.source is not None:
                sources.append(loaded.source.model_copy(update={"applies_to": where}))
        sides[field] = formations
    match = _match_of(sides, str(path))
    validate_total_war_match(match, str(path))
    return LoadedTotalWarMatch(match=match, sources=sources)


def load_total_war_draft(path: Path) -> LoadedTotalWarMatch:
    """UIの総力戦ドラフト（`mlgg:last-draft:total-war`）を読む。"""
    stored = load_stored_object(path)
    sets = stored.get("formations")
    if not isinstance(sets, list) or len(sets) != DRAFT_FORMATION_SETS:
        raise DraftError(
            f"{path}: `formations` が{DRAFT_FORMATION_SETS}組の配列ではない"
            f"（{TOTAL_WAR_DRAFT_STORAGE_KEY} の中身を渡す）"
        )
    counts = stored.get("formationCounts")
    if not isinstance(counts, dict):
        raise DraftError(f"{path}: `formationCounts` が無い")
    bodies = []
    for index, body in enumerate(sets):
        if not isinstance(body, dict):
            raise DraftError(f"{path}: formations[{index}] がオブジェクトではない")
        bodies.append(parse_draft_body(body, where=f"{path}: formations[{index}]"))
    sides: dict[str, list[FormationSpec]] = {}
    for side, field in _SIDE_FIELDS.items():
        count = _formation_count(counts.get(side.lower()), field, path)
        formations: list[FormationSpec] = []
        for index in range(count):
            body = bodies[index]
            slots, memories = (
                (body.ally_slots, body.ally_memory_definition_ids)
                if side == "ALLY"
                else (body.enemy_slots, body.enemy_memory_definition_ids)
            )
            formations.append(_draft_formation(slots, memories, f"{path}: {field}[{index}]"))
        sides[field] = formations
    match = _match_of(sides, str(path))
    validate_total_war_match(match, str(path))
    return LoadedTotalWarMatch(match=match, sources=[InputSource(role="DRAFT", path=str(path))])


def _formation_count(value: object, field: str, path: Path) -> int:
    # `bool` は `int` の派生なので先に除く。
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_FORMATIONS:
        raise DraftError(
            f"{path}: {field} の編成数が1～{MAX_FORMATIONS}の整数ではない（{value!r}）"
        )
    return value


def _draft_formation(
    slots: tuple[StoredSlot, ...], memories: tuple[str, ...], where: str
) -> FormationSpec:
    if not slots:
        raise DraftError(f"{where}: ユニットが0体の編成は出撃できない（R-FRM-01）")
    try:
        return formation_of(slots, memories)
    except ValidationError as error:
        reasons = "; ".join(detail["msg"] for detail in error.errors())
        raise DraftError(f"{where}: 編成として成立しない: {reasons}") from error


def _match_of(sides: dict[str, list[FormationSpec]], where: str) -> TotalWarMatch:
    try:
        return TotalWarMatch.model_validate(sides)
    except ValidationError as error:
        raise ConfigError(f"{where}: {error}") from error


class ResolvedTotalWarInput(ResolvedInput):
    """解決済みの総力戦入力。手持ちデータ適用後の編成列を出撃順のまま持つ。"""

    format: Literal["TOTAL_WAR"] = "TOTAL_WAR"
    match: TotalWarMatch

    def to_request(self) -> dict[str, Any]:
        return build_total_war_request(self.match)

    def participant_slots(self) -> list[ParticipantSlot]:
        return total_war_participant_slots(self.match)


def resolve_total_war_input(
    loaded: LoadedTotalWarMatch,
    *,
    player_data_path: Path | None = None,
    player_data_sides: Collection[Side] = ("ALLY",),
    catalog: Catalog | None = None,
) -> ResolvedTotalWarInput:
    """読み込んだ対戦入力へ手持ちデータを当て、参照を検証して解決済み入力にする。

    手持ちデータは陣営の全編成へ、編成ごとに当てる（再登場ユニットにはどの編成でも
    同じ手持ちの値が入る。基礎値補正はAPIが掛ける）。既定では味方にだけ当てる。
    """
    match = loaded.match
    sources = list(loaded.sources)
    warnings: list[str] = []
    if player_data_path is not None:
        player_data = load_player_data_input(player_data_path)
        updates: dict[str, list[FormationSpec]] = {}
        for side in player_data_sides:
            field = _SIDE_FIELDS[side]
            applied_formations: list[FormationSpec] = []
            for index, formation in enumerate(match.formations(side)):
                applied, formation_warnings = apply_player_data_at(
                    formation, player_data.data, f"{field}[{index}]"
                )
                applied_formations.append(applied)
                warnings.extend(formation_warnings)
            updates["ally_formations" if side == "ALLY" else "enemy_formations"] = (
                applied_formations
            )
            sources.append(player_data.source.model_copy(update={"applies_to": field}))
        match = match.model_copy(update=updates)
    if catalog is not None:
        raise_if_invalid(validate_against_catalog(match, catalog))
    return ResolvedTotalWarInput(
        match=match,
        provenance=InputProvenance(
            sources=sources,
            catalogRevision=None if catalog is None else catalog.catalog_revision,
            warnings=warnings,
        ),
    )


def dump_resolved_total_war_input(resolved: ResolvedTotalWarInput) -> str:
    return dump_resolved_input(resolved)


def load_resolved_total_war_input(path: Path) -> ResolvedTotalWarInput:
    resolved = load_resolved_input(
        ResolvedTotalWarInput, path.read_text(encoding="utf-8"), where=str(path)
    )
    # 保存後に手で直された場合も、読み込みと同じ受理条件を通す。
    validate_total_war_match(resolved.match, f"{path}: match")
    return resolved
