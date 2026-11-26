"""評価実行の保存。評価実行ごとに1つのSQLiteを作り、再開状態の正本とする。

- `repository`: 保存・検索のインターフェースと、保存時に検出する不整合
- `sqlite`: SQLite実装
- `migrations`: DB保存形式のバージョンと移行
- `layout`: 評価実行のディレクトリ（`<evaluation-id>/manifest.json` と DB）
"""
