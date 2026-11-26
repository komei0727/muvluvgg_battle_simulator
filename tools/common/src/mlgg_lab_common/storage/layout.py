"""評価実行のディレクトリ。

    <evaluations-dir>/<evaluation-id>/
      manifest.json         # 実行概要（確認用）
      evaluation.sqlite3    # 計画・入力・要求履歴・結果の正本

`manifest.json` は人が中身を確かめるための写しで、再開には使わない。消えても・古くても
再開はDBだけで成立する（状態を二重に持たない）。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..evaluation.models import EvaluationPlan
from .migrations import STORAGE_FORMAT_VERSION
from .sqlite import SqliteEvaluationRepository

DB_FILE = "evaluation.sqlite3"
MANIFEST_FILE = "manifest.json"
MANIFEST_VERSION = 1


def create_evaluation(
    evaluations_dir: Path, plan: EvaluationPlan
) -> tuple[Path, SqliteEvaluationRepository]:
    directory = evaluations_dir / plan.evaluation_id
    if directory.exists():
        raise FileExistsError(f"{directory}: 同じIDの評価実行が既にある")
    directory.mkdir(parents=True)
    repository = SqliteEvaluationRepository.create(directory / DB_FILE, plan)
    write_manifest(directory, repository)
    return directory, repository


def open_evaluation(directory: Path) -> SqliteEvaluationRepository:
    return SqliteEvaluationRepository.open(directory / DB_FILE)


def write_manifest(directory: Path, repository: SqliteEvaluationRepository) -> Path:
    plan = repository.load_plan()
    counters = repository.counters()
    environment = repository.environment()
    sessions = repository.sessions()
    last = sessions[-1] if sessions else None
    manifest: dict[str, Any] = {
        "manifestVersion": MANIFEST_VERSION,
        "note": f"概要の写し。再開に使う状態の正本は {DB_FILE}",
        "evaluationId": plan.evaluation_id,
        "format": plan.contract.format,
        "contractId": plan.contract.contract_id,
        "storageFormatVersion": STORAGE_FORMAT_VERSION,
        "seed": plan.seed,
        "createdAt": plan.created_at,
        "updatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "caseIds": [case.case_id for case in plan.cases],
        "budget": {"maxSubmittedRuns": plan.budget.max_submitted_runs},
        "counters": {
            "plannedRuns": counters.planned_runs,
            "submittedRuns": counters.submitted_runs,
            "completedTrials": counters.completed_trials,
        },
        "environment": None
        if environment is None
        else {
            "catalogRevision": environment.catalog_revision,
            "engineRevision": environment.engine_revision,
            "seedDerivationVersion": environment.seed_derivation_version,
        },
        "lastSession": None
        if last is None
        else {
            "stopReason": last.stop_reason,
            "detail": last.detail,
            "finishedAt": last.finished_at,
        },
    }
    path = directory / MANIFEST_FILE
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)
    return path
