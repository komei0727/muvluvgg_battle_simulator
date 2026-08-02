# Specification routing

Treat repository documents as the source of truth. Search identifiers with `rg -n '<ID>' docs/ddd` before reading the surrounding section.

| Concern                                     | Primary source                              |
| ------------------------------------------- | ------------------------------------------- |
| Vocabulary                                  | `docs/ddd/01_ユビキタス言語.md`             |
| Decisions and pending questions (`Q-*`)     | `docs/ddd/02_仕様確認事項.md`               |
| Use cases                                   | `docs/ddd/03_ユースケース.md`               |
| Context and dependency boundaries           | `docs/ddd/04_境界づけられたコンテキスト.md` |
| Aggregates, entities, values, policies      | `docs/ddd/05_ドメインモデル.md`             |
| Battle, turn, round, and action transitions | `docs/ddd/06_戦闘状態遷移.md`               |
| Domain rules (`R-*`)                        | `docs/ddd/07_戦闘ルール詳細.md`             |
| Events, causality, and state deltas         | `docs/ddd/08_ドメインイベント.md`           |
| Commands, use cases, ports, and errors      | `docs/ddd/09_アプリケーション設計.md`       |
| HTTP DTOs, schemas, and status mapping      | `docs/ddd/10_API設計.md`                    |
| Catalog, workers, runtime, and operations   | `docs/ddd/11_インフラストラクチャ設計.md`   |
| Test levels, IDs, determinism, and gates    | `docs/ddd/12_テスト戦略.md`                 |
| Milestones, dependencies, and completion    | `docs/ddd/13_実装計画.md`                   |

Also inspect `docs/ddd/戦闘システム.md` when a rule depends on the source gameplay description, and `docs/templates/` when changing Catalog definitions.

Resolve conflicts in this order: explicit decided `Q-*` item, detailed `R-*` rule, domain/event/application/API design, implementation plan. Stop and surface a conflict instead of choosing silently.
