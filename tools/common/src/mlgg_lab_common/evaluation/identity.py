"""対戦条件・試行・観測値の識別。

試行の同一性は「形式・送信する対戦条件・seed・試行番号」と実行環境の識別情報で決まる。
ケースID・要求番号・分割位置は識別に混ぜない——混ぜると、分割の仕方やケースの並べ方を
変えただけで同じ試行が別物に見える（APIの乱数列も `(seed, runIndex)` だけで決まる）。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any


def canonical_json(value: Any) -> str:
    """キー順・空白に依らない表現。ハッシュと意味上の一致判定に使う。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def match_fingerprint(evaluation_format: str, match_request: Mapping[str, Any]) -> str:
    """送信する対戦条件の識別子。メモリー順・配置・編成順は意味を持つので並べ替えない。"""
    return _digest({"format": evaluation_format, "matchRequest": match_request})


def trial_key(match_fingerprint_value: str, seed: str, run_index: int) -> str:
    return _digest({"match": match_fingerprint_value, "seed": seed, "runIndex": run_index})


def observation_digest(observation: Mapping[str, Any]) -> str:
    """観測値（APIが返した試行オブジェクト）の意味上の同一性。

    試行オブジェクトは時刻・所要時間・通信IDを持たない。それらは要求の履歴（`attempts`）に
    別に残し、ここでは比べない。
    """
    return _digest(observation)
