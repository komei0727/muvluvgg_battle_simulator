"""探索のディレクトリの作成・オープン。

    <searches-dir>/<search-id>/
      search.sqlite3          # 探索問題・履歴・チェックポイントの正本
      evaluations/            # ラウンドごとの評価実行（段階2の保存形式そのもの）

作成時に探索問題を検証し（共通の制約・形式別の固定条件・起点編成・任意でCatalog）、成立しない
探索問題は保存しない。
"""

from __future__ import annotations

from pathlib import Path

from ..evaluation.plan import new_evaluation_id
from ..inputs.catalog import Catalog
from ..search.adapter import FormatSearchAdapter
from ..search.candidate import Origin, candidate_id
from ..search.constraints import problem_problems
from ..search.problem import SearchProblem, SearchProblemError
from .search_store import DB_FILE, SqliteSearchStore


def create_search(
    searches_dir: Path,
    problem: SearchProblem,
    adapter: FormatSearchAdapter,
    *,
    search_id: str | None = None,
    catalog: Catalog | None = None,
) -> tuple[Path, SqliteSearchStore]:
    problems = problem_problems(problem, adapter)
    if catalog is not None and not problems:
        problems.extend(f"catalog: {p}" for p in adapter.catalog_problems(problem, catalog))
    if problems:
        raise SearchProblemError(problems)
    identifier = search_id or new_evaluation_id()
    directory = searches_dir / identifier
    if directory.exists():
        raise FileExistsError(f"{directory}: 同じIDの探索が既にある")
    starts = [(candidate_id(start), start, Origin(kind="START")) for start in problem.starts]
    store = SqliteSearchStore.create(directory / DB_FILE, identifier, problem, starts)
    return directory, store


def open_search(directory: Path) -> SqliteSearchStore:
    return SqliteSearchStore.open(directory / DB_FILE)
