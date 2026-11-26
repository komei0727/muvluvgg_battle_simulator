"""既存の入力データを `tools/data/inputs/` へ写す移行。

    tools/data/inputs/
      drafts/        # UIから取り出した編成JSON（`mlgg:last-draft*` の中身）
      formations/    # import-draft で変換した編成YAML（編成ライブラリ）
      player-data/   # UIから取り出した育成JSON（`mlgg:player-data` の中身）

移行元は各ラボの従来の置き場所（`<lab>/local_storage/**/*.json` と
`exercise-lab/configs/formations/*.yaml`）。JSONはファイル名ではなく中身で育成JSONか
ドラフトかを見分ける。

- 既定は何も書かない（`--apply` を付けたときだけ写す）。
- 元ファイルは消さない。従来の置き場所も入力パスとしてそのまま使える。
- 写し先に同名のファイルがあれば、同じ内容なら何もせず、違う内容なら上書きせず衝突として報告する。
- 写した後、移行前後のファイルを同じ読み込み手順で解決し、意味が一致することを確かめる。

    uv run python -m mlgg_lab_common.inputs.migration            # 計画だけ表示
    uv run python -m mlgg_lab_common.inputs.migration --apply    # 写して検証する
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from ..models.formation import ConfigError
from .draft import DraftError, load_stored_object
from .library import load_formation_library_entry
from .player_data import PlayerDataError, load_player_data

Kind = Literal["PLAYER_DATA", "DRAFT", "FORMATION", "UNRECOGNIZED"]
Status = Literal["COPY", "COPIED", "ALREADY_PRESENT", "CONFLICT", "SKIP"]

LABS = ("exercise-lab", "battle-lab", "total-war-lab")
DATA_INPUTS = Path("data") / "inputs"
_DIRECTORY: dict[str, str] = {
    "PLAYER_DATA": "player-data",
    "DRAFT": "drafts",
    "FORMATION": "formations",
}


@dataclass(frozen=True)
class MigrationItem:
    kind: Kind
    source: Path
    destination: Path | None
    status: Status
    reason: str | None = None


def plan_migration(tools_root: Path) -> list[MigrationItem]:
    """移行の計画を作る。ファイルは書かない。"""
    inputs = tools_root / DATA_INPUTS
    items: list[MigrationItem] = []
    claimed: dict[Path, Path] = {}
    for source in _legacy_files(tools_root):
        kind = _classify(source)
        if kind == "UNRECOGNIZED":
            items.append(
                MigrationItem(
                    kind, source, None, "SKIP", "育成JSON・ドラフト・編成YAMLのいずれでもない"
                )
            )
            continue
        destination = inputs / _DIRECTORY[kind] / source.name
        status, reason = _status(source, destination, claimed.get(destination))
        claimed.setdefault(destination, source)
        items.append(MigrationItem(kind, source, destination, status, reason))
    return items


def _legacy_files(tools_root: Path) -> list[Path]:
    found: list[Path] = []
    for lab in LABS:
        found.extend(sorted((tools_root / lab / "local_storage").rglob("*.json")))
    found.extend(sorted((tools_root / "exercise-lab" / "configs" / "formations").glob("*.yaml")))
    return found


def _classify(path: Path) -> Kind:
    if path.suffix == ".yaml":
        return "FORMATION"
    try:
        load_player_data(path)
        return "PLAYER_DATA"
    except PlayerDataError:
        pass
    try:
        stored = load_stored_object(path)
    except DraftError:
        return "UNRECOGNIZED"
    # 通常戦闘・演習は `draft`、総力戦は `formations` に本体を持つ。
    return "DRAFT" if "draft" in stored or "formations" in stored else "UNRECOGNIZED"


def _status(source: Path, destination: Path, claimed_by: Path | None) -> tuple[Status, str | None]:
    if claimed_by is not None:
        if claimed_by.read_bytes() == source.read_bytes():
            return "ALREADY_PRESENT", f"{claimed_by} と同じ内容"
        return "CONFLICT", f"{claimed_by} が同じ写し先を使う（内容が違う）"
    if not destination.exists():
        return "COPY", None
    if destination.read_bytes() == source.read_bytes():
        return "ALREADY_PRESENT", None
    return "CONFLICT", "写し先に内容の違う同名ファイルがある（上書きしない）"


def apply_migration(items: Sequence[MigrationItem]) -> list[MigrationItem]:
    applied: list[MigrationItem] = []
    for item in items:
        if item.status != "COPY" or item.destination is None:
            applied.append(item)
            continue
        item.destination.parent.mkdir(parents=True, exist_ok=True)
        if item.destination.exists():
            # 計画の後に別の手段で置かれた。上書きしない。
            applied.append(
                replace(item, status="CONFLICT", reason="写す直前に同名ファイルが現れた")
            )
            continue
        shutil.copy2(item.source, item.destination)
        applied.append(replace(item, status="COPIED"))
    return applied


def verify_migration(items: Sequence[MigrationItem]) -> list[str]:
    """写した（または既にあった）ファイルが、元と同じ意味に解決されるかを見る。"""
    problems: list[str] = []
    for item in items:
        if item.status not in ("COPIED", "ALREADY_PRESENT") or item.destination is None:
            continue
        try:
            same = _resolve(item.kind, item.source) == _resolve(item.kind, item.destination)
        except (ConfigError, DraftError, PlayerDataError) as error:
            problems.append(f"{item.destination}: 読み込めない: {error}")
            continue
        if not same:
            problems.append(f"{item.destination}: {item.source} と解決結果が一致しない")
    return problems


def _resolve(kind: Kind, path: Path) -> object:
    if kind == "PLAYER_DATA":
        return load_player_data(path)
    if kind == "FORMATION":
        return load_formation_library_entry(path.parent, path.stem)
    return load_stored_object(path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="既存の入力データを data/inputs へ写す")
    parser.add_argument(
        "--tools-root",
        type=Path,
        default=Path(__file__).resolve().parents[4],
        help="tools/ ディレクトリ（既定はこのパッケージの位置から求める）",
    )
    parser.add_argument("--apply", action="store_true", help="実際に写して検証する")
    args = parser.parse_args(argv)
    items = plan_migration(args.tools_root)
    if args.apply:
        items = apply_migration(items)
    root = args.tools_root.resolve()
    for item in items:
        destination = "-" if item.destination is None else _relative(item.destination, root)
        note = f"  ({item.reason})" if item.reason else ""
        print(
            f"{item.status:16} {item.kind:12} {_relative(item.source, root)} -> {destination}{note}"
        )
    if not args.apply:
        print("\n計画だけを表示した。写すには --apply を付ける。")
        return 0
    problems = verify_migration(items)
    for problem in problems:
        print(f"MISMATCH {problem}", file=sys.stderr)
    conflicts = [item for item in items if item.status == "CONFLICT"]
    print(
        json.dumps(
            {
                "copied": sum(item.status == "COPIED" for item in items),
                "alreadyPresent": sum(item.status == "ALREADY_PRESENT" for item in items),
                "conflicts": len(conflicts),
                "mismatches": len(problems),
            },
            ensure_ascii=False,
        )
    )
    return 1 if problems or conflicts else 0


def _relative(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root))
    except ValueError:
        return str(path)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
