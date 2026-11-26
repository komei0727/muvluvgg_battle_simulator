"""対戦入力ファイルの中の「編成1件」の書き方。

各ラボの対戦入力ファイル（通常戦闘・総力戦）は、編成を次のどちらでも書ける。

- インライン: `FormationSpec` と同じ形（`units` / `memoryDefinitionIds` / `academyLevels`）
- 編成ライブラリの参照: `{ library: <id> }`（`configs/formations/<id>.yaml`）

参照は解決時に中身へ展開し、解決済み入力には中身だけを残す。参照先のパスは
由来情報（`InputSource`）として別に持つ——ファイルは後から書き換わり得るので、
パスを対戦条件の代わりにしない。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from ..models.formation import ConfigError, FormationSpec, validate_formation
from ..models.resolved import InputSource
from .library import formation_path, load_formation_library_entry

LIBRARY_REFERENCE_KEY = "library"


@dataclass(frozen=True)
class LoadedFormation:
    formation: FormationSpec
    # 編成ライブラリから展開したときだけ持つ。
    source: InputSource | None


def load_formation_entry(
    raw: object, where: str, *, formations_dir: Path | None
) -> LoadedFormation:
    """編成1件を読み、R-FRM-02等の共通の受理条件まで検証する。

    `where` は入力内の位置（例: `ally.formations[1]`）で、エラー文と由来情報に使う。
    """
    if isinstance(raw, dict) and LIBRARY_REFERENCE_KEY in raw:
        return _load_library_reference(raw, where, formations_dir)
    try:
        formation = FormationSpec.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{where}: {error}") from error
    validate_formation(formation, where)
    return LoadedFormation(formation=formation, source=None)


def _load_library_reference(
    raw: dict[str, object], where: str, formations_dir: Path | None
) -> LoadedFormation:
    extra = sorted(set(raw) - {LIBRARY_REFERENCE_KEY})
    if extra:
        # 参照と中身の書き足しを混ぜると、どちらの値で評価したのか読めなくなる。
        # 育成値は手持ちデータから入れる。
        raise ConfigError(
            f"{where}: 編成ライブラリの参照（{LIBRARY_REFERENCE_KEY}）には他の項目を"
            f"並べられない: {', '.join(extra)}"
        )
    formation_id = raw[LIBRARY_REFERENCE_KEY]
    if not isinstance(formation_id, str) or not formation_id:
        raise ConfigError(f"{where}: {LIBRARY_REFERENCE_KEY} は編成IDの文字列でなければならない")
    if formations_dir is None:
        raise ConfigError(
            f"{where}: 編成ライブラリ '{formation_id}' を参照しているが、"
            "編成ライブラリのディレクトリが指定されていない"
        )
    entry = load_formation_library_entry(formations_dir, formation_id)
    formation = entry.to_formation()
    validate_formation(formation, f"{where}（{LIBRARY_REFERENCE_KEY}: {formation_id}）")
    return LoadedFormation(
        formation=formation,
        source=InputSource(
            role="FORMATION_LIBRARY",
            path=str(formation_path(formations_dir, formation_id)),
            appliesTo=where,
        ),
    )
