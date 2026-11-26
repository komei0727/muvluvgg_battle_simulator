"""保存結果のエクスポート。SQLiteが正本で、ここで書くファイルは何度でも再生成できる派生物。

    <out>/
      trials.jsonl   # 完了した試行1件につき1行。APIの観測値をそのまま（形式固有の詳細を含む）
      trials.csv     # 同じ試行の主要項目だけの表
      summary.json   # ケース別の記述統計と、その対象・計算条件・ファイルの説明
      cases.json     # ケースごとの対戦条件（送信内容・解決済み入力）と完了/未完了の試行番号

すべてのファイルは `exportFormatVersion`（CSVは `summary.json` の `files`）で版を持つ。
同じDBからは同じバイト列になる（生成時刻を書かない）。未完了の試行は `trials.*` に行を
作らず、件数と番号を `summary.json` / `cases.json` で示す。
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .analyzer import FormatAnalyzer
from .snapshot import EvaluationSnapshot
from .summary import summarize_evaluation

EXPORT_FORMAT_VERSION = 1

TRIALS_JSONL = "trials.jsonl"
TRIALS_CSV = "trials.csv"
SUMMARY_JSON = "summary.json"
CASES_JSON = "cases.json"

# CSVの共通列（形式固有の列はこの後ろに `FormatAnalyzer.csv_columns` の順で並ぶ）。
COMMON_CSV_COLUMNS: tuple[tuple[str, str], ...] = (
    ("evaluation_id", "評価実行ID"),
    ("case_id", "ケースID"),
    ("run_index", "試行番号"),
    ("match_fingerprint", "送信した対戦条件のハッシュ（cases.json と対応）"),
    ("trial_key", "試行の識別ハッシュ（対戦条件・seed・試行番号）"),
    ("seed", "seed"),
    ("catalog_revision", "Catalogの版"),
    ("engine_revision", "戦闘エンジンの版"),
    ("seed_derivation_version", "乱数導出の版"),
    ("completion_reason", "終了理由"),
    ("completed_turn", "完了ターン"),
)


@dataclass(frozen=True)
class ExportResult:
    directory: Path
    files: dict[str, Path]
    trials: int


def export_evaluation(
    snapshot: EvaluationSnapshot, analyzer: FormatAnalyzer, out_dir: Path
) -> ExportResult:
    summary = summarize_evaluation(snapshot, analyzer)
    out_dir.mkdir(parents=True, exist_ok=True)
    contents = {
        TRIALS_JSONL: _trials_jsonl(snapshot),
        TRIALS_CSV: _trials_csv(snapshot, analyzer),
        SUMMARY_JSON: _json(
            {
                "exportFormatVersion": EXPORT_FORMAT_VERSION,
                "source": _source(snapshot),
                "files": _file_descriptions(analyzer),
                "summary": summary,
            }
        ),
        CASES_JSON: _json(
            {
                "exportFormatVersion": EXPORT_FORMAT_VERSION,
                "source": _source(snapshot),
                "cases": [
                    {
                        "caseId": case.case_id,
                        "matchFingerprint": case.match_fingerprint,
                        "matchRequest": case.match_request,
                        "input": case.input_snapshot,
                        "runIndices": list(case.run_indices),
                        "completedRunIndices": [
                            r.run_index for r in snapshot.results_of(case.case_id)
                        ],
                        "pendingRunIndices": snapshot.pending_run_indices(case),
                    }
                    for case in snapshot.plan.cases
                ],
            }
        ),
    }
    files: dict[str, Path] = {}
    for name, text in contents.items():
        path = out_dir / name
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(text, encoding="utf-8", newline="")
        temporary.replace(path)
        files[name] = path
    return ExportResult(out_dir, files, len(snapshot.results))


def _source(snapshot: EvaluationSnapshot) -> dict[str, Any]:
    environment = snapshot.environment
    return {
        "evaluationId": snapshot.plan.evaluation_id,
        "format": snapshot.plan.contract.format,
        "contractId": snapshot.plan.contract.contract_id,
        "storageFormatVersion": snapshot.storage_format_version,
        "seed": snapshot.plan.seed,
        "environment": None
        if environment is None
        else {
            "catalogRevision": environment.catalog_revision,
            "engineRevision": environment.engine_revision,
            "seedDerivationVersion": environment.seed_derivation_version,
        },
    }


def _trials_jsonl(snapshot: EvaluationSnapshot) -> str:
    environment = snapshot.environment
    lines = []
    for result in snapshot.results:
        record = {
            "exportFormatVersion": EXPORT_FORMAT_VERSION,
            "evaluationId": snapshot.plan.evaluation_id,
            "format": snapshot.plan.contract.format,
            "contractId": snapshot.plan.contract.contract_id,
            "caseId": result.case_id,
            "runIndex": result.run_index,
            "matchFingerprint": snapshot.case(result.case_id).match_fingerprint,
            "trialKey": snapshot.trial_key_of(result),
            "seed": snapshot.plan.seed,
            "catalogRevision": environment.catalog_revision if environment else None,
            "engineRevision": environment.engine_revision if environment else None,
            "seedDerivationVersion": environment.seed_derivation_version if environment else None,
            "observation": result.observation,
        }
        lines.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return "".join(lines)


def _trials_csv(snapshot: EvaluationSnapshot, analyzer: FormatAnalyzer) -> str:
    environment = snapshot.environment
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        [name for name, _ in COMMON_CSV_COLUMNS] + [c.name for c in analyzer.csv_columns]
    )
    for result in snapshot.results:
        observation = result.observation
        common = [
            snapshot.plan.evaluation_id,
            result.case_id,
            result.run_index,
            snapshot.case(result.case_id).match_fingerprint,
            snapshot.trial_key_of(result),
            snapshot.plan.seed,
            environment.catalog_revision if environment else None,
            environment.engine_revision if environment else None,
            environment.seed_derivation_version if environment else None,
            observation.get("completionReason"),
            observation.get("completedTurn"),
        ]
        specific = [column.value(observation) for column in analyzer.csv_columns]
        writer.writerow(["" if value is None else value for value in common + specific])
    return buffer.getvalue()


def _file_descriptions(analyzer: FormatAnalyzer) -> dict[str, Any]:
    return {
        TRIALS_JSONL: {
            "description": "完了した試行1件につき1行。observation はAPIの試行オブジェクトそのもの",
            "keys": [
                "exportFormatVersion",
                "evaluationId",
                "format",
                "contractId",
                "caseId",
                "runIndex",
                "matchFingerprint",
                "trialKey",
                "seed",
                "catalogRevision",
                "engineRevision",
                "seedDerivationVersion",
                "observation",
            ],
        },
        TRIALS_CSV: {
            "description": "trials.jsonl と同じ行の主要項目。値が無いものは空欄（0にしない）",
            "exportFormatVersion": EXPORT_FORMAT_VERSION,
            "columns": [{"name": n, "description": d} for n, d in COMMON_CSV_COLUMNS]
            + [{"name": c.name, "description": c.description} for c in analyzer.csv_columns],
        },
        CASES_JSON: {
            "description": (
                "ケースごとの対戦条件（送信内容 matchRequest・解決済み入力 input）と試行番号"
            ),
        },
    }


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"
