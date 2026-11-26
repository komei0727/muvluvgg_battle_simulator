"""保存済みの評価実行の確認・記述統計・エクスポート。

    evaluation.sqlite3（正本） → 読み出し（`snapshot`） → 進捗（`status`）
                                                        → ケース別の記述統計（`summary`）
                                                        → JSONL / CSV / JSON（`export`）

どれもDBを読むだけで、評価APIへ接続しない・新しい試行を発生させない。形式ごとの集計は
各ラボの `FormatAnalyzer`（`analyzer`）が持ち、ここは形式に依らない部分だけを持つ。
目的関数・順位づけ・採否・追加試行の判断は持たない。
"""

from .analyzer import CsvColumn, FormatAnalyzer
from .export import EXPORT_FORMAT_VERSION, ExportResult, export_evaluation
from .snapshot import EvaluationSnapshot, load_snapshot, read_evaluation, resolve_evaluation_dir
from .status import evaluation_status
from .summary import SUMMARY_FORMAT_VERSION, summarize_evaluation

__all__ = [
    "EXPORT_FORMAT_VERSION",
    "SUMMARY_FORMAT_VERSION",
    "CsvColumn",
    "EvaluationSnapshot",
    "ExportResult",
    "FormatAnalyzer",
    "evaluation_status",
    "export_evaluation",
    "load_snapshot",
    "read_evaluation",
    "resolve_evaluation_dir",
    "summarize_evaluation",
]
