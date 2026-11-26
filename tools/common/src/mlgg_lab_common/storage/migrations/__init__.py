"""DB保存形式のバージョン管理。

保存形式のバージョンは SQLite の `PRAGMA user_version` に持ち、このファイルの
`MIGRATIONS` が「そのバージョンへ上げる手順」を順に並べる。

- 新しいDBは最新の形式で作る。
- 古い形式のDBは開くときに順に移行する（1つの移行は1トランザクション）。
- 知らない新しい形式（このツールより後の版が作ったDB）は読まずに止める。黙って読むと、
  知らない列・意味の変わった列を取り違えたまま再開してしまう。
- このツールのDBかどうかは `PRAGMA application_id` で見分け、別のSQLiteファイルは開かない。

形式を変えるときは `vNNNN_*.py` を足して `MIGRATIONS` の末尾へ加える。既存の移行は書き換えない。
"""

from __future__ import annotations

from . import v0001_initial

# "MLGE"（MuvLuv GG Evaluation）。
APPLICATION_ID = 0x4D4C4745

MIGRATIONS: tuple[str, ...] = (v0001_initial.SQL,)
STORAGE_FORMAT_VERSION = len(MIGRATIONS)
