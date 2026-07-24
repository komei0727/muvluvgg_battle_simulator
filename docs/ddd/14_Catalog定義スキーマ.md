# Catalog 定義スキーマ

## 目的

本書は、[`02_仕様確認事項.md`](./02_仕様確認事項.md) の決定事項と、`raw/units/`・`raw/memories/` の実データ調査結果を踏まえ、Catalog v2 の JSON 契約を定義する。

前提文書: [`05_ドメインモデル.md`](./05_ドメインモデル.md)・[`07_戦闘ルール詳細.md`](./07_戦闘ルール詳細.md)・[`08_ドメインイベント.md`](./08_ドメインイベント.md)・[`11_インフラストラクチャ設計.md`](./11_インフラストラクチャ設計.md)

## 設計方針

### 基本方針

Catalog v2 は、Unit Skill と Memory の効果を同じ基盤で表現する。

効果は次の構成要素に分解する。

| 要素                      | 役割                                            |
| ------------------------- | ----------------------------------------------- |
| `TriggerDefinition`       | いつ発動候補になるか                            |
| `ConditionDefinition`     | どの状態なら実行するか                          |
| `TargetBindingDefinition` | 誰を対象として束縛するか                        |
| `EffectStepDefinition`    | どの順番で何を解決するか                        |
| `EffectActionDefinition`  | HP、リソース、状態、マーカーなどへ何をするか    |
| `FormulaDefinition`       | 値をどの戦闘状態から計算するか                  |
| `DurationDefinition`      | いつまで有効か、何で消費・失効するか            |
| `Capability`              | 表現済みだが未実装の機能を preflight で隔離する |

任意コード、文字列式、eval 相当の拡張は許可しない。条件、式、対象選択は列挙値と構造化フィールドだけで表す。

### v1 からの主な変更

| 領域            | v1                                                                                    | v2                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | `affinityBonus`, `criticalDamageBonus`, `extraGaugeMaximum`, `sourceReference` を必須 | `affinityBonus` と `criticalDamageBonus` は既定値で生成し、`extraGaugeMaximum` はEXスキル `cost.amount` から生成する。`sourceReference` は production Catalog から削除 |
| Skill targeting | Skill 全体に1つの `targeting`                                                         | `effectSequence.targetBindings` で複数対象束縛を定義                                                                                                                   |
| Skill effect    | `effects.json` の `kind` 列挙                                                         | `EffectStep` と `EffectAction` の構成で表現                                                                                                                            |
| 条件分岐        | AS発動条件とPS predicate中心                                                          | Step / Action 単位の `condition` と `BRANCH` step                                                                                                                      |
| 確率            | 会心・暗闇・回避中心                                                                  | `RANDOM_BRANCH` step                                                                                                                                                   |
| Memory          | 静的 `modifiers`                                                                      | `triggeredEffects` に一本化（`modifiers` 省略記法は廃止）                                                                                                              |
| Capability      | 保留仕様のみ                                                                          | `CAP_*` による段階導入機能も管理                                                                                                                                       |

---

## Catalog ファイル構成

```text
apps/api/catalog/
  manifest.json
  units.json
  skills.json
  effects.json
  memories.json
  capabilities.json
```

`effects.json` は v1 の `SkillEffectDefinition` ではなく、再利用可能な `EffectActionDefinition` を格納する。Skill / Memory の解決順、対象、条件、分岐はそれぞれの `effectSequence` が持つ。

### manifest.json

```json
{
  "schemaVersion": 2,
  "catalogRevision": "2026-07-11.1",
  "files": {
    "units.json": "sha256:...",
    "skills.json": "sha256:...",
    "effects.json": "sha256:...",
    "memories.json": "sha256:...",
    "capabilities.json": "sha256:..."
  }
}
```

| フィールド        | 型      | 制約                                |
| ----------------- | ------- | ----------------------------------- |
| `schemaVersion`   | integer | v2 は `2` 固定                      |
| `catalogRevision` | string  | 不透明な文字列                      |
| `files`           | object  | 上記5ファイルの sha256 を必須とする |

---

## authoring source（`catalog-src/`）と生成フロー

`catalog/` は runtime loader（`loadCatalogFromDirectory()`）が読む生成物であり、手編集の対象ではない（Issue #50）。人間が編集・レビューするのは `apps/api/catalog-src/` で、ユニット・メモリ単位に分割されている。

```text
apps/api/catalog-src/
  capabilities.json          # 共有・フラット。catalog/capabilities.json と同一形式
  units/
    <unitDefinitionId>/      # 例: UNIT_EVIE_ECO。バージョン単位のID。キャラクター単位ではない
      unit.json               # UnitDefinition 1件
      skills.json              # そのユニットのSkillDefinition配列
      effects.json              # そのユニットのEffectActionDefinition配列
  memories/
    <memoryDefinitionId>/    # 例: MEM_001。memories/ ディレクトリ自体が無い場合は0件として扱う
      memory.json              # MemoryDefinition 1件
      effects.json              # そのMemoryのEffectActionDefinition配列
```

### ディレクトリ粒度: バージョン単位（キャラクター単位ではない）

同一キャラクターでも衣装違い・イベント違いなどで複数バージョンのユニットが存在する（例: `raw/units/` の「ユリア・バーンズ」「生駒葵」「劉翠蘭」等は各2バージョン以上）。`unitDefinitionId`（例: `UNIT_EVIE_ECO`、キョンシーハッカー衣装は`UNIT_EVIE_KYONSHI`）はバージョン単位で一意なIDであり、`characterId`（例: `CHAR_EVIE_RENALT`）はキャラクター単位でユニット間に重複しうる。Unit名は `UNIT_<キャラクター名>_<衣装・バージョンを表す語>` の形式へ統一する（`UNIT_EVIE` のようなキャラクター名のみのIDは使わない）。`catalog-src/units/` のディレクトリ名は必ず `unitDefinitionId` を用いる。`characterId` や `characterName` でディレクトリを作ると、同一キャラクターの複数バージョンが衝突する。

`memories/` も同様に `memoryDefinitionId` 単位でディレクトリを作る。

### 生成コマンド

`catalog-src/` から `catalog/` の5ファイルと `manifest.json` を決定的に生成する（`apps/api/`配下で相対path解決するため、`apps/api/`で実行するか`pnpm --filter api run ...`を使う）。

```bash
pnpm --filter api run generate-catalog catalog-src catalog <catalogRevision>
```

- 各 `catalog-src/units/*/{unit.json,skills.json,effects.json}` と `catalog-src/memories/*/{memory.json,effects.json}`、`catalog-src/capabilities.json` を読み込み、ディレクトリ名昇順でユニット/メモリを並べて集約する。
- ユニットディレクトリ名が `unit.json` の `unitDefinitionId` と一致しない場合（メモリも同様）は生成せずエラーにする。
- 出力はリポジトリの Prettier 設定（`.prettierrc`）で整形され、`pnpm run format-check` をそのまま通過する。
- `manifest.json` の各ファイルhashは生成した内容から自動算出される。`catalogRevision` は明示指定必須（暗黙の日付生成はしない）。

同じ入力（`catalog-src/` の内容と `catalogRevision`）から再生成しても出力は毎回バイト単位で同一になる（決定的）。

### 検証コマンド

`catalog/` が `catalog-src/` から生成した内容と一致しているか（drift していないか）を確認する。

```bash
pnpm --filter api run check-catalog-src catalog-src catalog
```

`catalog/manifest.json` に記録済みの `catalogRevision` を使って再生成した結果と、実際の `catalog/*.json` を比較する。`catalog/` を直接手編集した場合や、`catalog-src/` を編集した後に生成コマンドを実行し忘れた場合に差分ファイル名を報告して失敗する。CIやコミット前チェックに組み込む想定。

生成後は必ず `pnpm --filter api run validate-catalog catalog` で Shape/Resolve/Semantic 検証も行う。

### #47（残Unit/Memory追加）での編集手順

1. `catalog-src/units/<新しいunitDefinitionId>/`（または `catalog-src/memories/<新しいmemoryDefinitionId>/`）を追加し、`raw/units/` や `raw/memories/` から変換した内容を書く。
2. `pnpm --filter api run generate-catalog catalog-src catalog <新しいcatalogRevision>` で `catalog/` を再生成する。
3. `pnpm --filter api run validate-catalog catalog` と `pnpm --filter api run check-catalog-src catalog-src catalog` が成功することを確認する。
4. 追加・変更したユニット/メモリ単位でレビューを依頼する（`catalog-src/` 側の差分がレビュー対象になる）。

`raw/units/`・`raw/memories/` 全件の変換状況（済み/未変換/保留）と、未変換分のM2向け分類は [`15_Unit_Memory変換台帳.md`](./15_Unit_Memory変換台帳.md) で追跡する。新しいUnit/Memoryを変換した際は台帳の該当行も更新する。

---

## ID体系

| 種別           | プレフィックス  | 例                               |
| -------------- | --------------- | -------------------------------- |
| Unit           | `UNIT_`         | `UNIT_001`                       |
| Skill          | `SKL_`          | `SKL_001_AS1`                    |
| EffectAction   | `ACT_`          | `ACT_001_DAMAGE`                 |
| Memory         | `MEM_`          | `MEM_001`                        |
| Target binding | `TGT_`          | `TGT_PRIMARY`                    |
| Marker         | `MARKER_`       | `MARKER_CURSE`                   |
| Capability     | `Q-*` / `CAP_*` | `CAP_HEAL`, `CAP_REFLECT_DAMAGE` |

ID は ASCII 英数字、ハイフン、アンダースコアのみ許可する。Catalog 全体で同種 ID は一意でなければならない。

---

## UnitDefinition

### YAML 全体像

```yaml
unitDefinitionId: UNIT_001
attribute: COMICAL
unitType: AGILE
role: CONTROL
positionAptitudes:
  - FRONT
  - BACK
baseStats:
  maximumHp: 28375
  attack: 23221
  defense: 11781
  criticalRate: 0.25
  criticalDamageBonus: 0.5
  affinityBonus: 0.25
  actionSpeed: 780
  maximumAp: 4
  maximumPp: 4
extraGaugeMaximum: 7
activeSkillDefinitionIds:
  - SKL_001_AS1
  - SKL_001_AS2
passiveSkillDefinitionIds:
  - SKL_001_PS1
  - SKL_001_PS2
extraSkillDefinitionId: SKL_001_EX
requiredCapabilities: []
metadata:
  displayName: "【純真無垢なるジーニアス】リディア・エルドリッジ"
  characterName: "リディア・エルドリッジ"
  characterId: CHAR_LYDIA_ELDRIDGE
  affiliations: []
  tags: []
```

### フィールド詳細

| フィールド                      | 型       | 必須 | 制約                                                                 |
| ------------------------------- | -------- | ---- | -------------------------------------------------------------------- |
| `unitDefinitionId`              | string   | ✓    | 一意                                                                 |
| `attribute`                     | enum     | ✓    | `AGGRESSIVE` / `SHY` / `CUTE` / `SMART` / `COMICAL` / `CLEVER`       |
| `unitType`                      | enum     | ✓    | `PHYSICAL` / `ENERGY` / `AGILE`                                      |
| `role`                          | enum     | ✓    | `PHYSICAL_ATTACKER` / `EN_ATTACKER` / `TANK` / `SUPPORT` / `CONTROL` |
| `positionAptitudes`             | enum[]   | ✓    | `FRONT` / `BACK` の1件以上                                           |
| `baseStats`                     | object   | ✓    | 下表                                                                 |
| `baseStats.maximumHp`           | integer  | ✓    | >= 1                                                                 |
| `baseStats.attack`              | integer  | ✓    | >= 0                                                                 |
| `baseStats.defense`             | integer  | ✓    | >= 0                                                                 |
| `baseStats.criticalRate`        | number   | ✓    | raw の%を割合へ変換                                                  |
| `baseStats.criticalDamageBonus` | number   | ✓    | Catalog作成時は既定値 `0.5`。Unitごとに上書き可                      |
| `baseStats.affinityBonus`       | number   | ✓    | Catalog作成時は既定値 `0.25`。Unitごとに上書き可                     |
| `baseStats.actionSpeed`         | integer  | ✓    | >= 0                                                                 |
| `baseStats.maximumAp`           | integer  | ✓    | >= 1                                                                 |
| `baseStats.maximumPp`           | integer  | ✓    | >= 1                                                                 |
| `extraGaugeMaximum`             | integer  | ✓    | >= 1。Catalog作成時はEXスキル `cost.amount` と同値で生成             |
| `activeSkillDefinitionIds`      | string[] | ✓    | AS選択優先順                                                         |
| `passiveSkillDefinitionIds`     | string[] | ✓    | 0件可。PSタイブレーカー順                                            |
| `extraSkillDefinitionId`        | string   | ✓    | EXスキル1件                                                          |
| `requiredCapabilities`          | string[] | ✓    | 空配列可                                                             |
| `metadata`                      | object   | ✓    | 表示、所属、タグ                                                     |

### v2でUnitに保持する/削除するフィールド

| v1フィールド                    | v2の扱い                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `baseStats.affinityBonus`       | Unitフィールドとして保持。Catalog作成時は既定値 `0.25` で生成し、Unitごとに上書き可能                      |
| `baseStats.criticalDamageBonus` | Unitフィールドとして保持。Catalog作成時は既定値 `0.5` で生成し、Unitごとに上書き可能                       |
| `extraGaugeMaximum`             | Unitフィールドとして保持。Catalog作成時はEXスキル `cost.amount` と同値で生成し、参照整合性で一致を検証する |
| `metadata.sourceReference`      | production Catalog から削除。authoring metadata として保持                                                 |

### metadata

| フィールド      | 型       | 必須 | 制約                         |
| --------------- | -------- | ---- | ---------------------------- |
| `displayName`   | string   | ✓    | raw の名前                   |
| `characterName` | string   | ✓    | 衣装名を除いたキャラクター名 |
| `characterId`   | string   | ✓    | 正規化ID                     |
| `affiliations`  | string[] | ✓    | 所属ID。空配列可             |
| `tags`          | string[] | ✓    | 任意タグ。空配列可           |

`affiliations` は Memory の所属フィルタで使用する。所属不明の場合は空配列にし、所属フィルタを必要とする Memory の Catalog 化時に補完する。`affiliationId`（`AFF_*`）の確定済み一覧・採番方針・Unit metadata 更新方針は [`18_Affiliation台帳.md`](./18_Affiliation台帳.md) を参照。表示名の字面一致のみでは補完しない。

---

## SkillDefinition

### YAML 全体像

```yaml
skillDefinitionId: SKL_001_AS1
skillType: AS
cost:
  resource: AP
  amount: 1
activationCondition:
  kind: TRUE
triggers: []
resolution:
  kind: IMMEDIATE
  targetBindings:
    - targetBindingId: TGT_PRIMARY
      selector:
        kind: SELECT
        side: ENEMY
        count: 1
        order:
          - NEAREST
          - FRONT_ROW
          - LEFT_TO_RIGHT
  steps:
    - kind: ACTION
      target:
        kind: BINDING
        targetBindingId: TGT_PRIMARY
      actions:
        - effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_7020
cooldown:
  unit: ACTION
  count: 1
traits:
  priorityAttack: false
  simultaneousActivationLimited: false
  exclusiveActivationGroupId: null
  accuracy:
    guaranteedHit: false
  piercing:
    defenseIgnoreRate: 0
    shieldIgnoreRate: 0
    damageReductionIgnoreRate: 0
requiredCapabilities: []
metadata:
  displayName: "ジャマしちゃ、めっ……だよ？"
  tags: []
```

### フィールド詳細

| フィールド             | 型                        | 必須 | 制約                            |
| ---------------------- | ------------------------- | ---- | ------------------------------- |
| `skillDefinitionId`    | string                    | ✓    | 一意                            |
| `skillType`            | enum                      | ✓    | `AS` / `PS` / `EX`              |
| `cost`                 | object                    | ✓    | AS=`AP`, PS=`PP`, EX=`EX_GAUGE` |
| `activationCondition`  | ConditionDefinition       | ✓    | Skill使用可否。通常は `TRUE`    |
| `triggers`             | TriggerDefinition[]       | ✓    | PSは1件以上。AS/EXは空配列      |
| `resolution`           | SkillResolutionDefinition | ✓    | 下記                            |
| `cooldown`             | object                    | ✓    | `unit`, `count`                 |
| `traits`               | object                    | ✓    | 先制、同時発動制限、命中、貫通  |
| `requiredCapabilities` | string[]                  | ✓    | 空配列可                        |
| `metadata`             | object                    | ✓    | `displayName`, `tags`           |

### traits

| フィールド                           | 型          | 必須 | 制約                                                            |
| ------------------------------------ | ----------- | ---- | --------------------------------------------------------------- |
| `priorityAttack`                     | boolean     | ✓    | 先制攻撃なら true                                               |
| `simultaneousActivationLimited`      | boolean     | ✓    | 同一イベントで候補になった同時発動制限PSのうち1件だけを発動する |
| `exclusiveActivationGroupId`         | string/null | ✓    | 同タイミング排他グループ。null なら排他グループなし             |
| `accuracy.guaranteedHit`             | boolean     | ✓    | 必中なら true                                                   |
| `piercing.defenseIgnoreRate`         | number      | ✓    | 防御力無視率。0〜1                                              |
| `piercing.shieldIgnoreRate`          | number      | ✓    | シールド無視率。0〜1                                            |
| `piercing.damageReductionIgnoreRate` | number      | ✓    | ダメージ軽減無視率。0〜1                                        |

`exclusiveActivationGroupId` が同一の PS が同じ event / root action で同時に候補になった場合、同一グループ内で発動できるのは1件だけとする。選択順は `R-PS-02` と `R-PS-03` に従い、選ばれなかった候補は同じ event では再候補化しない。

### cost

| フィールド | 型      | 制約                                                                                                                                                        |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource` | enum    | `AP` / `PP` / `EX_GAUGE`                                                                                                                                    |
| `amount`   | integer | >= 1（コスト0のAS・PS・EXは存在しない）。EXの場合、Unit の `extraGaugeMaximum` と一致しなければならない（`extraGaugeMaximum` 自体も >= 1 のため矛盾しない） |

### traits.piercing

```yaml
piercing:
  defenseIgnoreRate: 0.5
  shieldIgnoreRate: 0.5
  damageReductionIgnoreRate: 0
```

| フィールド                  | 型     | 制約 |
| --------------------------- | ------ | ---- |
| `defenseIgnoreRate`         | number | 0〜1 |
| `shieldIgnoreRate`          | number | 0〜1 |
| `damageReductionIgnoreRate` | number | 0〜1 |

v1 の `defensePiercing: true` は v2 では `defenseIgnoreRate: 0`, `shieldIgnoreRate: 1`, `damageReductionIgnoreRate: 1` など、確定ルールに応じた明示値へ移行する。raw の「防御力とシールドを50%無視」は `defenseIgnoreRate: 0.5`, `shieldIgnoreRate: 0.5` とする。

---

## SkillResolutionDefinition

### YAML 全体像

```yaml
resolution:
  kind: IMMEDIATE
  targetBindings:
    - targetBindingId: TGT_MAIN
      selector:
        kind: SELECT
        side: ENEMY
        count: 1
        order:
          - LOWEST_HP_RATIO
          - FRONT_ROW
          - LEFT_TO_RIGHT
  steps:
    - kind: ACTION
      target:
        kind: BINDING
        targetBindingId: TGT_MAIN
      actions:
        - effectActionDefinitionId: ACT_DAMAGE_EN_18020
    - kind: BRANCH
      condition:
        kind: TARGET_STATE
        target:
          kind: BINDING
          targetBindingId: TGT_MAIN
        field: IS_ALIVE
        op: EQ
        value: true
      thenSteps:
        - kind: ACTION
          target:
            kind: BINDING
            targetBindingId: TGT_MAIN
          actions:
            - effectActionDefinitionId: ACT_DAMAGE_EN_4740
      elseSteps: []
```

### フィールド詳細

| フィールド       | 型                        | 必須 | 制約                      |
| ---------------- | ------------------------- | ---- | ------------------------- |
| `kind`           | enum                      | ✓    | `IMMEDIATE` / `CHARGE`    |
| `targetBindings` | TargetBindingDefinition[] | ✓    | 0件可。定義順で束縛する   |
| `steps`          | EffectStepDefinition[]    | ✓    | 1件以上                   |
| `chargeRelease`  | object                    | —    | `kind: CHARGE` の場合必須 |

### CHARGE

```yaml
resolution:
  kind: CHARGE
  targetBindings: []
  steps:
    - kind: ACTION
      target:
        kind: SELF
      actions:
        - effectActionDefinitionId: ACT_MARKER_CHARGING
  chargeRelease:
    targetBindings:
      - targetBindingId: TGT_ALL_ENEMIES
        selector:
          kind: SELECT
          side: ENEMY
          count: ALL
          order:
            - DEFAULT
    steps:
      - kind: ACTION
        target:
          kind: BINDING
          targetBindingId: TGT_ALL_ENEMIES
        actions:
          - effectActionDefinitionId: ACT_DAMAGE_EN_21200
```

`CHARGE` 中の「回避と自身のパッシブスキルが使用できない」は、チャージ状態の共通ルール、または `requiredCapabilities: ["CAP_CHARGE_RESTRICTION"]` を持つ拡張ルールとして扱う。

---

## TargetBindingDefinition / TargetSelectorDefinition

### TargetBindingDefinition

```yaml
targetBindingId: TGT_PRIMARY
selector:
  kind: SELECT
  side: ENEMY
  count: 1
  filters: []
  order:
    - NEAREST
    - FRONT_ROW
    - LEFT_TO_RIGHT
  fallback: null
```

| フィールド        | 型                       | 必須 | 制約                                |
| ----------------- | ------------------------ | ---- | ----------------------------------- |
| `targetBindingId` | string                   | ✓    | Skill / Memory の sequence 内で一意 |
| `selector`        | TargetSelectorDefinition | ✓    | 下記                                |

### TargetSelectorDefinition

| フィールド        | 型                       | 必須     | 制約                                                                        |
| ----------------- | ------------------------ | -------- | --------------------------------------------------------------------------- |
| `kind`            | enum                     | ✓        | `SELECT` / `SELF` / `TRIGGER_SOURCE` / `TRIGGER_TARGET` / `BINDING_DERIVED` |
| `side`            | enum                     | 条件付き | `ALLY` / `ENEMY` / `ALL`                                                    |
| `count`           | integer / `ALL`          | 条件付き | `SELECT` の場合必須                                                         |
| `filters`         | TargetFilterDefinition[] | —        | 省略時空配列                                                                |
| `order`           | enum[]                   | —        | 省略時 `DEFAULT`                                                            |
| `area`            | AreaDefinition           | —        | 範囲指定                                                                    |
| `base`            | TargetReference          | 条件付き | `BINDING_DERIVED` の場合必須                                                |
| `fallback`        | TargetSelectorDefinition | —        | 候補0件時に評価                                                             |
| `includeDefeated` | boolean                  | —        | 省略時 false                                                                |

### order 候補

| 値                       | 意味                   |
| ------------------------ | ---------------------- |
| `DEFAULT`                | 距離昇順、前列、左列   |
| `NEAREST`                | 距離昇順               |
| `FARTHEST`               | 距離降順               |
| `LOWEST_HP_RATIO`        | HP割合が低い順         |
| `HIGHEST_HP_RATIO`       | HP割合が高い順         |
| `HIGHEST_ATTACK`         | 攻撃力が高い順         |
| `LOWEST_MAX_HP`          | 最大HPが低い順         |
| `HIGHEST_EX_GAUGE_RATIO` | EXゲージ充填率が高い順 |
| `FRONT_ROW`              | 前列優先               |
| `BACK_ROW`               | 後列優先               |
| `LEFT_TO_RIGHT`          | 絶対左から右           |

### TargetFilterDefinition

```yaml
filters:
  - kind: POSITION_ROW
    row: FRONT
  - kind: UNIT_TYPE
    unitType: PHYSICAL
```

| kind              | 追加フィールド  | 意味                        |
| ----------------- | --------------- | --------------------------- |
| `POSITION_ROW`    | `row`           | `FRONT` / `BACK`            |
| `POSITION_COLUMN` | `column`        | `LEFT` / `CENTER` / `RIGHT` |
| `POSITION_SLOT`   | `row`, `column` | 具体位置                    |
| `UNIT_TYPE`       | `unitType`      | UnitType一致                |
| `ROLE`            | `role`          | Role一致                    |
| `ATTRIBUTE`       | `attribute`     | Attribute一致               |
| `AFFILIATION`     | `affiliationId` | 所属一致                    |
| `CHARACTER`       | `characterId`   | キャラクター一致            |
| `HAS_MARKER`      | `markerId`      | Marker所持                  |
| `HP_RATIO`        | `op`, `value`   | HP割合比較                  |
| `AND`             | `conditions[]`  | 全条件                      |
| `OR`              | `conditions[]`  | いずれか                    |
| `NOT`             | `condition`     | 否定                        |

### AreaDefinition

```yaml
area:
  kind: SAME_ROW_AS_BASE
  includeBase: true
```

| kind                     | 意味              |
| ------------------------ | ----------------- |
| `SINGLE`                 | 対象そのもの      |
| `ALL`                    | 候補全体          |
| `ROW`                    | 指定行            |
| `COLUMN`                 | 指定列            |
| `SAME_ROW_AS_BASE`       | base と同じ横一列 |
| `SAME_COLUMN_AS_BASE`    | base と同じ縦一列 |
| `ADJACENT_ORTHOGONAL`    | 上下左右          |
| `DIRECTLY_AHEAD_OF_BASE` | base の前方1マス  |
| `BEHIND_BASE`            | base の背後1マス  |

### 位置指定の authoring 規約

- `LEFT` / `CENTER` / `RIGHT` は Q-TGT-06 の共通座標に基づく俯瞰時の絶対列とする。味方・敵の向きで左右を反転しない。
- 「右列」「左列」は `POSITION_COLUMN` または `AreaDefinition.kind=COLUMN` で表す。
- 「前列」「後列」は対象側陣営の前後列を `POSITION_ROW` で表す。
- 「対象に隣接する敵」は base target から `BINDING_DERIVED` + `ADJACENT_ORTHOGONAL` で表す。
- 「敵前後列」のように最近対象を基準に前後2マスを含める表現は、最近対象を base binding とし、`BINDING_DERIVED` + `SAME_COLUMN_AS_BASE` + `includeBase: true` で表す。

### 例: 範囲が空なら最も近い敵単体へフォールバック

```yaml
selector:
  kind: SELECT
  side: ENEMY
  count: ALL
  filters:
    - kind: POSITION_COLUMN
      column: RIGHT
  fallback:
    kind: SELECT
    side: ENEMY
    count: 1
    order:
      - NEAREST
      - FRONT_ROW
      - LEFT_TO_RIGHT
```

---

## EffectStepDefinition

### 種別

| kind            | 役割                                        |
| --------------- | ------------------------------------------- |
| `ACTION`        | 対象へ1つ以上の EffectAction を順に適用する |
| `BRANCH`        | 条件によって then / else の steps を選ぶ    |
| `RANDOM_BRANCH` | 確率で steps を選ぶ                         |
| `REPEAT`        | 同じ steps を指定回数繰り返す               |

### ACTION

ACTION は `stepCondition`（step 全体を一度だけ評価する gate）と `targetCondition`（`target` が解決した対象ごとに個別評価する filter）という、独立した 2 つの condition スコープを持つ（CAP_EFFECT_STEP_CONDITION_SCOPE、RES-004-CONDITION-SCOPE、Issue #230）。単一の `condition` フィールドは廃止した（互換シムなし、破壊的な一括移行）。

```yaml
kind: ACTION
stepCondition:
  kind: TRUE
targetCondition:
  kind: TRUE
target:
  kind: BINDING
  targetBindingId: TGT_PRIMARY
actions:
  - effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_15600
  - effectActionDefinitionId: ACT_APPLY_STUN_ACTION_2
```

| フィールド        | 型                  | 必須 | 制約                                                                                                                                                                                                                  |
| ----------------- | ------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stepCondition`   | ConditionDefinition | —    | 省略時 `TRUE`。`TARGET_STATE`/`TARGET_HAS_MARKER` は許可しない（`targetCondition`専用スコープ）                                                                                                                       |
| `targetCondition` | ConditionDefinition | —    | 省略時 `TRUE`。`TRUE`/`AND`/`OR`/`NOT`/`TARGET_STATE`/`TARGET_HAS_MARKER` のみ許可し、含まれる`TARGET_STATE`/`TARGET_HAS_MARKER`はすべてこの ACTION 自身の `target` と同じ `TargetReference` を参照しなければならない |
| `target`          | TargetReference     | ✓    | 対象参照                                                                                                                                                                                                              |
| `actions`         | object[]            | ✓    | 1件以上。定義順に解決                                                                                                                                                                                                 |

`stepCondition` がfalseの場合、step全体をスキップする（`EffectStepSkipped`、直前結果を記録しない）。`stepCondition`がtrueの場合、`target`が解決した対象ごとに`targetCondition`を評価し、falseの対象だけを`actions`の適用から除外する（全対象falseなら対象0件のACTIONとして扱い、`SKIPPED`の直前結果を記録する、R-SKL-08）。この2フィールドはスキーマ上独立しているため、`stepCondition`の`TARGET_SET_COUNT`と`targetCondition`のTARGET_STATE/TARGET_HAS_MARKERを同じACTIONで自由に併用できる（詳細はR-SKL-06、`TARGET_SET_COUNT`節）。

`actions[]` は `effectActionDefinitionId` 参照を基本とする。Catalog authoring 中だけ `inlineAction` を許可してもよいが、production Catalog では参照形式に統一する。

### BRANCH

```yaml
kind: BRANCH
condition:
  kind: TARGET_STATE
  target:
    kind: BINDING
    targetBindingId: TGT_PRIMARY
  field: HP_RATIO
  op: LTE
  value: 0.3
thenSteps: []
elseSteps: []
```

BRANCH には `target` が無く対象別スコープがもとから存在しないため、単一の `condition` フィールドのまま変更していない（Issue #230でACTIONにだけ`stepCondition`/`targetCondition`への分離を導入した。BRANCHの`condition`は常にR-SKL-06の`stepCondition`と同じstep-wideスコープ）。

`condition`に`TARGET_STATE`/`TARGET_HAS_MARKER`を含める場合（PRレビュー[P1]、Issue #230）、参照する`TargetReference`は高々1体にしか解決できないもの（`SELF`/`TRIGGER_SOURCE`、または`selector.kind: SELECT`かつ`count: 1`の`BINDING`）に限る — BRANCHは対象ごとの評価コンテキストを持たないため、複数体に解決されうる参照（`TRIGGER_TARGET`、`count`が`1`以外または`"ALL"`の`BINDING`、`BINDING_DERIVED`、`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`）はCatalogロード時点で拒否する（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`）。対象ごとに絞り込みたい場合はACTIONの`targetCondition`を使う。

### RANDOM_BRANCH

```yaml
kind: RANDOM_BRANCH
mode: WEIGHTED_ONE
branches:
  - weight: 10
    label: DAIKICHI
    steps: []
  - weight: 20
    label: CHUKICHI
    steps: []
  - weight: 30
    label: SHOKICHI
    steps: []
  - weight: 40
    label: SUEKICHI
    steps: []
```

| mode           | 意味                                     |
| -------------- | ---------------------------------------- |
| `WEIGHTED_ONE` | weight に応じて1分岐だけ選ぶ             |
| `INDEPENDENT`  | branch ごとに probability で独立判定する |

乱数消費順は branches の定義順とする。

### REPEAT

```yaml
kind: REPEAT
count: 5
steps:
  - kind: ACTION
    target:
      kind: BINDING
      targetBindingId: TGT_PRIMARY
    actions:
      - effectActionDefinitionId: ACT_DAMAGE_EN_2340
```

複数ヒット攻撃は `REPEAT` または `DAMAGE.hitCount` のどちらでも表せるが、ヒットごとに異なる追加効果を挟む場合は `REPEAT` を使う。

---

## TargetReference

```yaml
target:
  kind: BINDING
  targetBindingId: TGT_PRIMARY
```

| kind                   | 追加フィールド    | 意味                                    |
| ---------------------- | ----------------- | --------------------------------------- |
| `BINDING`              | `targetBindingId` | targetBindings で束縛した対象           |
| `SELF`                 | なし              | 使用者/発動者                           |
| `TRIGGER_SOURCE`       | なし              | trigger event の source                 |
| `TRIGGER_TARGET`       | なし              | trigger event の target                 |
| `LAST_ACTION_TARGETS`  | なし              | 直前 action の対象                      |
| `LAST_DAMAGED_TARGETS` | なし              | 直前にHP/シールドへダメージを受けた対象 |

---

## EffectActionDefinition

### YAML 全体像

```yaml
effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_15600
kind: DAMAGE
payload:
  damageType: PHYSICAL
  formula:
    kind: SKILL_POWER
    power: 1.56
  hitCount: 1
  link:
    enabled: false
requiredCapabilities: []
metadata:
  tags: []
```

### 共通フィールド

| フィールド                 | 型       | 必須 | 制約             |
| -------------------------- | -------- | ---- | ---------------- |
| `effectActionDefinitionId` | string   | ✓    | 一意             |
| `kind`                     | enum     | ✓    | 下表             |
| `payload`                  | object   | ✓    | kindごとに異なる |
| `requiredCapabilities`     | string[] | ✓    | 空配列可         |
| `metadata`                 | object   | ✓    | `tags`           |

### kind 一覧

| kind                       | 概要                                   | 主なCapability                 |
| -------------------------- | -------------------------------------- | ------------------------------ |
| `DAMAGE`                   | HP/シールドへダメージ                  | なし / `CAP_PARTIAL_PIERCING`  |
| `HEAL`                     | 即時回復                               | `CAP_HEAL`                     |
| `APPLY_CONTINUOUS_HEAL`    | 行動/ターン時の継続回復                | `CAP_CONTINUOUS_HEAL`          |
| `APPLY_CONTINUOUS_DAMAGE`  | 行動/ターン時の継続ダメージ（DoT）     | `CAP_CONTINUOUS_DAMAGE`        |
| `APPLY_STAT_MOD`           | HP/攻撃力/防御力/会心率/速度などの補正 | `CAP_STAT_MOD`                 |
| `APPLY_DAMAGE_MOD`         | 与ダメージ/被ダメージ補正              | `CAP_DAMAGE_MOD`               |
| `APPLY_HEALING_MOD`        | 回復量増減                             | `CAP_HEAL`                     |
| `MODIFY_RESOURCE`          | AP/PP/EXゲージ増減                     | `CAP_RESOURCE_MUTATION`        |
| `MODIFY_RESOURCE_CAPACITY` | 最大APなど上限変更                     | `CAP_RESOURCE_CAPACITY_MOD`    |
| `APPLY_STATUS`             | 気絶、凍結、暗闇など                   | 状態により異なる               |
| `APPLY_SHIELD`             | シールド付与                           | `CAP_SHIELD`                   |
| `REMOVE_EFFECTS`           | 効果解除                               | `CAP_REMOVE_EFFECTS`           |
| `EFFECT_IMMUNITY`          | 効果付与拒否                           | なし / `CAP_SPECIFIC_IMMUNITY` |
| `APPLY_MARKER`             | 固有マーカー付与                       | `CAP_MARKER`                   |
| `REMOVE_MARKER`            | 固有マーカー解除                       | `CAP_MARKER`                   |
| `APPLY_DEATH_SURVIVAL`     | 致死耐え                               | `CAP_DEATH_SURVIVAL`           |
| `APPLY_TARGET_REDIRECT`    | 攻撃引き寄せ                           | `CAP_TARGET_REDIRECT`          |
| `APPLY_COVER`              | 肩代わり                               | `CAP_COVER_DAMAGE`             |
| `APPLY_REFLECT`            | 反射                                   | `CAP_REFLECT_DAMAGE`           |
| `APPLY_DAMAGE_LINK`        | 継続リンク状態                         | `CAP_DAMAGE_LINK_STATE`        |
| `APPLY_SUBUNIT`            | サブユニット                           | なし                           |
| `COOLDOWN_MANIPULATION`    | 他スキルのクールタイム短縮・リセット   | `CAP_COOLDOWN_MANIPULATION`    |

---

## EffectAction payload

### DAMAGE

```yaml
kind: DAMAGE
payload:
  damageType: PHYSICAL
  formula:
    kind: SKILL_POWER
    power: 1.56
  hitCount: 1
  critical:
    mode: NORMAL
  accuracy:
    mode: NORMAL
  piercing:
    defenseIgnoreRate: 0
    shieldIgnoreRate: 0
    damageReductionIgnoreRate: 0
  damageModifiers: []
  link:
    enabled: false
```

| フィールド        | 型                  | 必須 | 制約                                           |
| ----------------- | ------------------- | ---- | ---------------------------------------------- |
| `damageType`      | enum                | ✓    | `PHYSICAL` / `EN`                              |
| `formula`         | FormulaDefinition   | ✓    | 多くは `SKILL_POWER`                           |
| `hitCount`        | integer             | —    | 省略時1                                        |
| `critical.mode`   | enum                | —    | `NORMAL` / `GUARANTEED` / `PREVENTED`          |
| `accuracy.mode`   | enum                | —    | `NORMAL` / `GUARANTEED`                        |
| `piercing`        | object              | —    | 省略時0                                        |
| `damageModifiers` | FormulaDefinition[] | —    | このDAMAGEだけへ適用する追加倍率。省略時空配列 |
| `link.enabled`    | boolean             | —    | 即時リンクダメージ                             |

### HEAL

```yaml
kind: HEAL
payload:
  formula:
    kind: MAX_HP_RATIO
    source:
      kind: TARGET
    ratio: 0.45
  overheal: DISCARD
```

| フィールド | 型                | 必須 | 制約                 |
| ---------- | ----------------- | ---- | -------------------- |
| `formula`  | FormulaDefinition | ✓    | 回復量               |
| `overheal` | enum              | —    | `DISCARD` 固定で開始 |

### APPLY_CONTINUOUS_HEAL

```yaml
kind: APPLY_CONTINUOUS_HEAL
payload:
  formula:
    kind: MAX_HP_RATIO
    source:
      kind: TARGET
    ratio: 0.1
  timing:
    eventType: ActionStarted
    targetSelector: EFFECT_OWNER
  duration:
    timeLimit:
      unit: ACTION
      count: 2
    dispellable: true
```

### APPLY_CONTINUOUS_DAMAGE

Issue #44 G-02。`APPLY_CONTINUOUS_HEAL` の DAMAGE 方向の対になる kind。継続ダメージ（DoT、炎上など）を表す。

```yaml
kind: APPLY_CONTINUOUS_DAMAGE
payload:
  damageType: PHYSICAL
  formula:
    kind: STAT_RATIO
    source:
      kind: SKILL_SOURCE
    stat: ATTACK
    ratio: 0.3
  timing:
    eventType: ActionStarted
    targetSelector: EFFECT_OWNER
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
```

| フィールド   | 型                 | 必須 | 制約                                                                                               |
| ------------ | ------------------ | ---- | -------------------------------------------------------------------------------------------------- |
| `damageType` | enum               | ✓    | `PHYSICAL` / `EN`                                                                                  |
| `formula`    | FormulaDefinition  | ✓    | 行動時に発生させるダメージ量                                                                       |
| `timing`     | object             | ✓    | `APPLY_CONTINUOUS_HEAL` と同じ形式                                                                 |
| `duration`   | DurationDefinition | ✓    | ダメージそのものの `hitCount` / `link` は持たず、`DAMAGE` の subset として通常ダメージ処理に載せる |

### APPLY_STAT_MOD

```yaml
kind: APPLY_STAT_MOD
payload:
  stat: ATTACK
  valueType: RATIO
  formula:
    kind: CONSTANT
    value: 0.2
  stacking:
    mode: STACKABLE
  duration:
    timeLimit:
      unit: ACTION
      count: 2
```

`stat` 候補:

- `MAXIMUM_HP`
- `ATTACK`
- `DEFENSE`
- `CRITICAL_RATE`
- `CRITICAL_DAMAGE_BONUS`
- `AFFINITY_BONUS`
- `ACTION_SPEED`

`AFFINITY_BONUS` と `CRITICAL_DAMAGE_BONUS` は Unit の `baseStats` に保持する。Catalog作成時の初期値はそれぞれ `0.25` と `0.5` だが、Unitごとの上書きと `APPLY_STAT_MOD` による一時補正の対象にできる。

### APPLY_DAMAGE_MOD

```yaml
kind: APPLY_DAMAGE_MOD
payload:
  direction: OUTGOING
  damageType: PHYSICAL
  formula:
    kind: CONSTANT
    value: 0.03
  stacking:
    mode: STACKABLE
  duration:
    timeLimit:
      unit: BATTLE
      count: 1
```

| フィールド    | 型                    | 制約                         |
| ------------- | --------------------- | ---------------------------- |
| `direction`   | enum                  | `OUTGOING` / `INCOMING`      |
| `damageType`  | enum/null             | `PHYSICAL` / `EN` / null     |
| `formula`     | FormulaDefinition     | 符号付き。増加は正、減少は負 |
| `consumption` | ConsumptionDefinition | 次の攻撃など                 |

### APPLY_HEALING_MOD

Issue #44 G-01。`APPLY_DAMAGE_MOD` の回復量版。`damageType` を持たない点のみ異なる（回復は種別を持たない）。

```yaml
kind: APPLY_HEALING_MOD
payload:
  direction: INCOMING
  formula:
    kind: CONSTANT
    value: -0.2
  stacking:
    mode: STACKABLE
  duration:
    timeLimit:
      unit: ACTION
      count: 1
      owner: EFFECT_SOURCE
    dispellable: true
```

| フィールド  | 型                 | 制約                                                           |
| ----------- | ------------------ | -------------------------------------------------------------- |
| `direction` | enum               | `OUTGOING`（自身が与える回復）/ `INCOMING`（自身が受ける回復） |
| `formula`   | FormulaDefinition  | 符号付き。増加は正、減少は負                                   |
| `stacking`  | object             | `APPLY_DAMAGE_MOD` と同じく `STACKABLE` のみ                   |
| `duration`  | DurationDefinition | —                                                              |

### MODIFY_RESOURCE

```yaml
kind: MODIFY_RESOURCE
payload:
  resource: PP
  operation: ADD
  formula:
    kind: CONSTANT
    value: -2
  bounds:
    min: 0
    max: CURRENT_MAX
```

| operation    | 意味                     |
| ------------ | ------------------------ |
| `ADD`        | 現在値へ加算。減算は負値 |
| `SET`        | 指定値にする             |
| `SET_TO_MAX` | 最大値にする             |
| `DISTRIBUTE` | 対象間で分配             |

### MODIFY_RESOURCE_CAPACITY

Issue #44 G-09。`MODIFY_RESOURCE` は現在値の一回限りの加減算だが、`MODIFY_RESOURCE_CAPACITY` は最大値そのものを変更し、`duration` を持つ。

```yaml
kind: MODIFY_RESOURCE_CAPACITY
payload:
  resource: AP
  operation: ADD
  formula:
    kind: CONSTANT
    value: 1
  duration:
    timeLimit:
      unit: BATTLE
      count: 1
    dispellable: false
```

| フィールド  | 型                 | 制約                                                                                 |
| ----------- | ------------------ | ------------------------------------------------------------------------------------ |
| `resource`  | enum               | `AP` / `PP` / `EX_GAUGE`                                                             |
| `operation` | enum               | `ADD` / `SET`。`SET_TO_MAX` と `DISTRIBUTE` は上限変更に意味を持たないため許可しない |
| `formula`   | FormulaDefinition  | 変更量                                                                               |
| `duration`  | DurationDefinition | 恒久的な上限変更は `timeLimit.unit: BATTLE, count: 1, dispellable: false` で表す     |

### APPLY_STATUS

```yaml
kind: APPLY_STATUS
payload:
  status: STUN
  duration:
    timeLimit:
      unit: ACTION
      count: 2
    dispellable: true
```

`status` 候補:

- `STUN`
- `FREEZE`
- `BLIND`
- `STEALTH`
- `EVASION`
- `DAMAGE_IMMUNITY`
- `CRITICAL_GUARANTEE`
- `CRITICAL_PREVENTION`
- `GUARANTEED_HIT`
- `HIT_EVASION`

凍結のダメージ解除倍率は status payload に保持する。スキルに具体の倍率が記載されていない場合は `damageAmplificationOnBreak: 0.5` を既定値として生成する。

```yaml
kind: APPLY_STATUS
payload:
  status: FREEZE
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
  damageAmplificationOnBreak: 0.5
```

回避は `APPLY_STATUS` の `EVASION` / `HIT_EVASION` として表す。ヒット数制限、確率、対象攻撃種別は status payload に保持する。

```yaml
kind: APPLY_STATUS
payload:
  status: EVASION
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    consumption:
      kind: INCOMING_HIT
      maxCount: 1
    dispellable: true
  probability: 1.0
  appliesTo:
    incomingActionKinds:
      - DAMAGE
```

Issue #44 G-06。`DAMAGE_IMMUNITY` は既定では受けたダメージ量にかかわらず無効化するが、`damageThreshold` を指定すると、無効化するかどうかを入射ダメージ量の比較で切り替えられる。`op` は `ConditionDefinition.op`（`14_Catalog定義スキーマ.md` の [`op`](#op) 一覧）と同じ列挙を使う。`formula` の評価対象は被弾ユニット自身（`source: TARGET` がバリア保持者を指す）。

```yaml
kind: APPLY_STATUS
payload:
  status: DAMAGE_IMMUNITY
  duration:
    timeLimit:
      unit: ACTION
      count: 2
    consumption:
      kind: INCOMING_HIT
      maxCount: 2
    dispellable: true
  damageThreshold:
    op: GT
    formula:
      kind: CURRENT_HP_RATIO
      source:
        kind: TARGET
      ratio: 0.35
```

上記は「現在HPの35%を超える攻撃のみ2ヒットまで無効化する」（現在HPの35%以下の攻撃は素通しする、大技専用の壁）を表す。

| フィールド                | 型                | 制約                                      |
| ------------------------- | ----------------- | ----------------------------------------- |
| `damageThreshold.op`      | enum              | `ConditionDefinition.op` と同じ比較演算子 |
| `damageThreshold.formula` | FormulaDefinition | 入射ダメージ量と比較するしきい値          |

### EFFECT_IMMUNITY

```yaml
kind: EFFECT_IMMUNITY
payload:
  categories:
    - DEBUFF
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
  maxBlocks: null
```

| フィールド                  | 型                 | 制約                                                              |
| --------------------------- | ------------------ | ----------------------------------------------------------------- |
| `categories`                | enum[]             | `DEBUFF` / `STATUS` / `MARKER` / `DAMAGE_MOD` / `SPECIFIC_EFFECT` |
| `effectActionDefinitionIds` | string[]           | `SPECIFIC_EFFECT` の場合に対象IDを指定                            |
| `duration`                  | DurationDefinition | 省略時は即時効果として不正                                        |
| `maxBlocks`                 | integer/null       | null = 期間中は上限なし                                           |

`EFFECT_IMMUNITY` により付与を拒否した場合は `EffectApplicationRejected` を発行する。

### REMOVE_EFFECTS

Issue #44 G-04。`EFFECT_IMMUNITY` が将来の付与を一定期間ブロックするのに対し、`REMOVE_EFFECTS` は即時効果として、対象がその時点で保持している効果を解除する。「どの種類の効果を対象にするか」は同じ分類軸のため `categories` 列挙を `EFFECT_IMMUNITY` と共有する。

```yaml
kind: REMOVE_EFFECTS
payload:
  categories:
    - DEBUFF
```

| フィールド                  | 型       | 制約                                                                       |
| --------------------------- | -------- | -------------------------------------------------------------------------- |
| `categories`                | enum[]   | `DEBUFF` / `STATUS` / `MARKER` / `DAMAGE_MOD` / `SPECIFIC_EFFECT`。1件以上 |
| `effectActionDefinitionIds` | string[] | `SPECIFIC_EFFECT` の場合に対象IDを指定                                     |

`duration` を持たない即時効果である点が `EFFECT_IMMUNITY` との違い。`Marker` の解除は既存の `REMOVE_MARKER`（`markerId` 指定）を使う。

`REMOVE_EFFECTS` を使う `EffectActionDefinition` は `requiredCapabilities` に `CAP_REMOVE_EFFECTS` を含めること。Battle Engineが未実装のkindは、Capabilityで隔離しないと preflight（`SimulationPreflightValidator`、`09_アプリケーション設計.md`）を素通りしてしまう。

### APPLY_DEATH_SURVIVAL

```yaml
kind: APPLY_DEATH_SURVIVAL
payload:
  trigger:
    lethalDamageOnly: true
  survivalHp:
    kind: CONSTANT
    value: 1
  healAfterSurvival:
    kind: MAX_HP_RATIO
    source: TARGET
    ratio: 0.65
  duration:
    timeLimit:
      unit: BATTLE
      count: 1
    consumption:
      kind: LETHAL_DAMAGE
      maxCount: 1
    dispellable: true
```

| フィールド                 | 型                     | 制約                                           |
| -------------------------- | ---------------------- | ---------------------------------------------- |
| `trigger.lethalDamageOnly` | boolean                | 致死ダメージ時だけ消費する場合 true            |
| `survivalHp`               | FormulaDefinition      | 耐えた直後の最低HP。HP1耐えは `CONSTANT=1`     |
| `healAfterSurvival`        | FormulaDefinition/null | 耐えた後に回復する場合のみ指定                 |
| `duration`                 | DurationDefinition     | 通常は `consumption.kind=LETHAL_DAMAGE` を持つ |

### APPLY_TARGET_REDIRECT

```yaml
kind: APPLY_TARGET_REDIRECT
payload:
  redirectTo:
    kind: SELF
  appliesTo:
    actionKinds:
      - DAMAGE
  duration:
    timeLimit:
      unit: ACTION
      count: 1
      owner: BATTLE
    dispellable: true
```

| フィールド              | 型                 | 制約                                                      |
| ----------------------- | ------------------ | --------------------------------------------------------- |
| `redirectTo`            | TargetReference    | 攻撃を引き寄せる対象。多くは `SELF`                       |
| `appliesTo.actionKinds` | enum[]             | `DAMAGE` / `DEBUFF` / `ANY`                               |
| `duration`              | DurationDefinition | 行動終了までなら `owner=BATTLE`, `unit=ACTION`, `count=1` |

### APPLY_COVER

```yaml
kind: APPLY_COVER
payload:
  coverer:
    kind: SELF
  damageShareRate: 1.0
  guardRate: 0.5
  appliesTo:
    actionKinds:
      - DAMAGE
  duration:
    timeLimit:
      unit: ACTION
      count: 1
      owner: BATTLE
    dispellable: true
```

| フィールド              | 型                 | 制約                                                      |
| ----------------------- | ------------------ | --------------------------------------------------------- |
| `coverer`               | TargetReference    | 肩代わりする対象                                          |
| `damageShareRate`       | number             | 肩代わりするダメージ割合。全肩代わりは `1.0`              |
| `guardRate`             | number             | 肩代わり時に軽減する割合。50%ガードは `0.5`               |
| `appliesTo.actionKinds` | enum[]             | `DAMAGE` / `ANY`                                          |
| `duration`              | DurationDefinition | 行動終了までなら `owner=BATTLE`, `unit=ACTION`, `count=1` |

`APPLY_TARGET_REDIRECT` と `APPLY_COVER` を同じ行動で付与する場合、redirect 後の攻撃対象に対して cover を評価する。

### APPLY_REFLECT

```yaml
kind: APPLY_REFLECT
payload:
  reflectTo:
    kind: TRIGGER_SOURCE
  formula:
    kind: DAMAGE_RECEIVED_RATIO
    sourceResult: LAST_DAMAGE_RECEIVED
    ratio: 0.5
  timing: AFTER_DAMAGE_APPLIED
  allowRecursiveReflect: false
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
```

| フィールド              | 型                 | 制約                                      |
| ----------------------- | ------------------ | ----------------------------------------- |
| `reflectTo`             | TargetReference    | 反撃・反射先。攻撃者なら `TRIGGER_SOURCE` |
| `formula`               | FormulaDefinition  | 反射ダメージ量                            |
| `timing`                | enum               | `AFTER_DAMAGE_APPLIED`                    |
| `allowRecursiveReflect` | boolean            | 通常 false                                |
| `duration`              | DurationDefinition | 省略時は即時反撃として扱わず不正          |

### APPLY_SHIELD

Issue #44 G-08。HPとは別枠のダメージ吸収プールを付与する。

```yaml
kind: APPLY_SHIELD
payload:
  formula:
    kind: STAT_RATIO
    source:
      kind: SKILL_SOURCE
    stat: ATTACK
    ratio: 0.45
  duration:
    timeLimit:
      unit: ACTION
      count: 2
      owner: EFFECT_TARGET
    dispellable: true
```

| フィールド | 型                 | 制約                                                             |
| ---------- | ------------------ | ---------------------------------------------------------------- |
| `formula`  | FormulaDefinition  | シールド量                                                       |
| `duration` | DurationDefinition | シールドの残量が尽きる前でも失効しうる（`timeLimit` 経過で消滅） |

`APPLY_SHIELD` を使う `EffectActionDefinition` は `requiredCapabilities` に `CAP_SHIELD` を含めること。理由は `REMOVE_EFFECTS` と同じ（Battle Engine未実装のkindをpreflightで隔離するため）。

### APPLY_SUBUNIT

```yaml
kind: APPLY_SUBUNIT
payload:
  durability:
    formula:
      kind: STAT_RATIO
      source: SKILL_SOURCE
      stat: ATTACK
      ratio: 1.0
  additionalDamage:
    formula:
      kind: SUBUNIT_ADDITIONAL_DAMAGE
      ownerAttack: CURRENT_ATTACK
      providerAttack: SOURCE_SNAPSHOT_ATTACK
      skillMultiplier: 0.5
      targetDefense: TARGET_CURRENT_DEFENSE
```

`SUBUNIT_ADDITIONAL_DAMAGE` は `サブユニット所持者の攻撃力 + 付与者の攻撃力 × スキル倍率 - 対象の防御力` を表す。最終ダメージの丸めと最低1ダメージは通常のダメージ規則に従う。

### APPLY_MARKER

```yaml
kind: APPLY_MARKER
payload:
  markerId: MARKER_CURSE
  stack:
    policy: ADD
    max: 4
  duration:
    timeLimit:
      unit: BATTLE
      count: 1
    dispellable: false
```

| フィールド     | 型           | 制約                                            |
| -------------- | ------------ | ----------------------------------------------- |
| `markerId`     | string       | `MARKER_` prefix                                |
| `stack.policy` | enum         | `ADD` / `KEEP_EXISTING` / `REFRESH` / `REPLACE` |
| `stack.max`    | integer/null | null = 上限なし                                 |

### COOLDOWN_MANIPULATION

Issue #129。他スキルのクールタイムを短縮・リセットする。`RESET` は対象スキルの残数を0にし、`REDUCE` は `amount` だけ減らす（0未満にはならない）。対象がREADY（未登録、または残数が既に0）の場合は残数不変のためno-opとし、`CooldownReduced`/`CooldownCompleted` を発行しない。設定scope（`R-SKL-04`「設定した行動・ターンでは減らさない」）の対象外の明示操作であり、対象スキルが今回の行動・ターンで設定されていても適用する。

```yaml
kind: COOLDOWN_MANIPULATION
payload:
  targetSkillDefinitionId: SKL_SAYA_BUNNY_AS1
  operation: RESET
```

```yaml
kind: COOLDOWN_MANIPULATION
payload:
  targetSkillDefinitionId: SKL_MERU_FLATSPIN_PS1
  operation: REDUCE
  amount: 1
```

| フィールド                | 型     | 必須     | 制約                                 |
| ------------------------- | ------ | -------- | ------------------------------------ |
| `targetSkillDefinitionId` | string | ✓        | `SKL_` prefix                        |
| `operation`               | enum   | ✓        | `RESET` / `REDUCE`                   |
| `amount`                  | number | 条件付き | `operation: REDUCE` の場合必須、>= 1 |

`targetSkillDefinitionId` の存在は Catalog 検証で拒否する（未定義のSkill IDへの参照）。加えて、対象スキルは操作元の`EffectAction`を保有するUnitと同じUnitが所有するスキルでなければならず、所有者が一致しない参照もCatalog検証で拒否する。`COOLDOWN_MANIPULATION` を使う `EffectActionDefinition` は `requiredCapabilities` に `CAP_COOLDOWN_MANIPULATION` を含めること。

---

## FormulaDefinition

### 基本構造

```yaml
formula:
  kind: CONSTANT
  value: 0.2
```

Formula は数値を返す。戻り値が整数リソースやHPへ適用される場合は、適用側のルールで整数化する。

### kind 一覧

| kind                        | 追加フィールド                                                      | 意味                                                     |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| `CONSTANT`                  | `value`                                                             | 固定値                                                   |
| `SKILL_POWER`               | `power`                                                             | 攻撃力を基礎にしたスキル威力倍率                         |
| `SUBUNIT_ADDITIONAL_DAMAGE` | `ownerAttack`, `providerAttack`, `skillMultiplier`, `targetDefense` | サブユニット追加ダメージ                                 |
| `STAT_RATIO`                | `source`, `stat`, `ratio`                                           | 指定対象のstat×ratio                                     |
| `MAX_HP_RATIO`              | `source`, `ratio`                                                   | 最大HP×ratio                                             |
| `CURRENT_HP_RATIO`          | `source`, `ratio`                                                   | 現在HP×ratio                                             |
| `MISSING_HP_RATIO`          | `source`, `ratio`                                                   | 不足HP×ratio                                             |
| `LOST_HP_RATIO`             | `source`, `ratio`                                                   | 失ったHP×ratio                                           |
| `DAMAGE_DEALT_RATIO`        | `sourceResult`, `ratio`                                             | 与えたダメージ×ratio（`sourceResult` で直前/合計を選択） |
| `DAMAGE_RECEIVED_RATIO`     | `sourceResult`, `ratio`                                             | 受けたダメージ×ratio（`sourceResult` で直前/合計を選択） |
| `MARKER_COUNT_SCALE`        | `target`, `markerId`, `perStack`, `max`                             | marker数×perStack                                        |
| `ALIVE_UNIT_COUNT_SCALE`    | `side`, `perUnit`, `max`                                            | 生存数×perUnit                                           |
| `HP_RATIO_SCALE`            | `target`, `min`, `max`, `direction`                                 | HP割合でmin〜maxを線形補間                               |
| `SUM`                       | `formulas[]`                                                        | 合計                                                     |
| `MIN`                       | `formulas[]`                                                        | 最小                                                     |
| `MAX`                       | `formulas[]`                                                        | 最大                                                     |
| `CLAMP`                     | `formula`, `min`, `max`                                             | 範囲制限                                                 |

### source

| kind             | 意味                  |
| ---------------- | --------------------- |
| `SKILL_SOURCE`   | Skill使用者           |
| `TARGET`         | 現在action対象        |
| `TRIGGER_SOURCE` | trigger source        |
| `TRIGGER_TARGET` | trigger target        |
| `BINDING`        | targetBindingIdで指定 |

### sourceResult（`DAMAGE_DEALT_RATIO` / `DAMAGE_RECEIVED_RATIO`）

| 値                     | 意味                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `LAST_DAMAGE_DEALT`    | 直前に発生した `DAMAGE` 結果1件のみ                                                   |
| `LAST_DAMAGE_RECEIVED` | 直前に受けた `DAMAGE` 結果1件のみ                                                     |
| `SUM_DAMAGE_DEALT`     | 同一 `EffectSequence` 実行中にこれまで発生した `DAMAGE` 結果の合計（G-10、Issue #44） |
| `SUM_DAMAGE_RECEIVED`  | 同一 `EffectSequence` 実行中にこれまで受けた `DAMAGE` 結果の合計                      |

例: フルート EX「＃ぽよ・オア・トリート」の「与えたダメージの60%分自身のHPを回復する」は、列攻撃と条件付き追撃の合計与ダメージを参照する必要があるため `SUM_DAMAGE_DEALT` を使う。

```yaml
kind: DAMAGE_DEALT_RATIO
sourceResult: SUM_DAMAGE_DEALT
ratio: 0.6
```

### 例: 対象の現在HP90%、攻撃力150%上限

```yaml
formula:
  kind: MIN
  formulas:
    - kind: CURRENT_HP_RATIO
      source:
        kind: TARGET
      ratio: 0.9
    - kind: STAT_RATIO
      source:
        kind: SKILL_SOURCE
      stat: ATTACK
      ratio: 1.5
```

---

## ConditionDefinition

### 基本構造

```yaml
condition:
  kind: AND
  conditions:
    - kind: TARGET_STATE
      target:
        kind: BINDING
        targetBindingId: TGT_PRIMARY
      field: HP_RATIO
      op: LTE
      value: 0.3
    - kind: TARGET_HAS_MARKER
      target:
        kind: BINDING
        targetBindingId: TGT_PRIMARY
      markerId: MARKER_CURSE
```

### kind 一覧

| kind                | 追加フィールド                         | 意味                                                                                               |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TRUE`              | なし                                   | 常に成立                                                                                           |
| `AND`               | `conditions[]`                         | 全条件                                                                                             |
| `OR`                | `conditions[]`                         | いずれか                                                                                           |
| `NOT`               | `condition`                            | 否定                                                                                               |
| `TARGET_STATE`      | `target`, `field`, `op`, `value`       | 対象状態比較                                                                                       |
| `TARGET_HAS_MARKER` | `target`, `markerId`, `countCondition` | Marker所持                                                                                         |
| `EVENT_PAYLOAD`     | `field`, `op`, `value`                 | trigger payload比較                                                                                |
| `LAST_RESULT`       | `field`, `op`, `value`                 | 直前結果比較                                                                                       |
| `RUNTIME_COUNTER`   | `counter`, `op`, `value`, `modulo`     | SkillRuntime等のcounter比較                                                                        |
| `TURN_NUMBER`       | `op`, `value`, `modulo`                | ターン番号条件                                                                                     |
| `ALIVE_UNIT_COUNT`  | `side`, `excludeSelf`, `op`, `value`   | 生存ユニット数の直接比較（G-03、Issue #44）                                                        |
| `POSITION_RELATION` | `target`, `relation`                   | PS所有者から見た対象のFormation位置関係（M6、`TRIGGER_POSITION_RELATION`、Issue #144）             |
| `RESOLUTION_PHASE`  | `phase`, `negate`                      | 現在のroot/ancestorイベントが属するBattle/Turn phase（M6、`TRIGGER_EXCLUSION_TIMING`、Issue #144） |
| `TARGET_SET_COUNT`  | `target`, `op`, `value`                | 対象集合（`TargetReference`が解決する集合）の生存数しきい値判定（RES-004集合条件、Issue #227）     |

`RUNTIME_COUNTER`の`modulo`は`TURN_NUMBER`と同じ意味を持つ。省略時は`op`/`value`のみで判定する（従来どおり）。指定時は「更新後の`value`を`modulo`で割った余りが0」を追加条件とし、N回ごとの発動を表す（`RUNTIME_COUNTER_MODULO`、Issue #143）。

### counterUpdates（RuntimeCounterの更新契機、Issue #143）

`RUNTIME_COUNTER` Conditionが参照するcounterは、`SkillDefinition.counterUpdates`（`RuntimeCounterUpdateDefinition[]`、省略時`[]`）が更新契機を宣言する。TriggerDefinition/activationConditionが参照するcounterは、必ずいずれかの`counterUpdates[].counter`と一致しなければならない。`SKILL_RUNTIME`更新とproductionテストを持つ定義は`CAP_SKILL_RUNTIME_COUNTER`を宣言する。Issue #166で従来の`<skillId>_ACTIVATIONS`/`<skillId>_CUMULATIVE_DAMAGE_RATIO`も明示的な更新定義へ移行した。`AppliedEffect`スコープの`counterUpdates`は`SkillDefinition`ではなく`DurationDefinition`が宣言する（下記「counterUpdates（AppliedEffectスコープ、EFF-005）」参照）。`CAP_EFFECT_RUNTIME_COUNTER`として別に追跡する。

```yaml
counterUpdates:
  - kind: INCREMENT
    counter: SKL_EXAMPLE_PS1_TRIGGER_COUNT
    scope: SKILL_RUNTIME
    trigger:
      eventType: SkillUseCompleted
      category: FACT
      sourceSelector: SELF
      targetSelector: ANY
      condition: { kind: EVENT_PAYLOAD, field: skillType, op: EQ, value: AS }
    amount: 1
  - kind: CUMULATIVE_DAMAGE_THRESHOLD
    counter: SKL_EXAMPLE_PS2_THRESHOLD_COUNT
    scope: SKILL_RUNTIME
    trigger:
      eventType: DamageApplied
      category: FACT
      sourceSelector: ENEMY
      targetSelector: SELF
    maxHpRatio: 0.4
```

| kind                          | 追加フィールド           | 意味                                                                                                                                                                       |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INCREMENT`                   | `amount`（整数、1以上）  | `trigger`が成立するたびにcounterへ`amount`を加算する（`RUNTIME_COUNTER_MODULO`）。                                                                                         |
| `CUMULATIVE_DAMAGE_THRESHOLD` | `maxHpRatio`（`(0, 1]`） | `trigger`成立時の被ダメージ量を対象の最大HP×`maxHpRatio`単位で加算し、超えた閾値の回数だけcounterを進める。端数は次回へ繰り越す（`CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`）。 |

`trigger`は`TriggerDefinition`と同じ形（`eventType`/`category`/`sourceSelector`/`targetSelector`/`condition`）で、対象の更新契機を独立に判定する。`scope`は`RuntimeCounter`の所有スコープ（`BATTLE`／`BATTLE_UNIT`／`SKILL_RUNTIME`／`APPLIED_EFFECT`／`EFFECT_SEQUENCE`、`05_ドメインモデル.md`「RuntimeCounter」参照）で、`SkillDefinition.counterUpdates`は`SKILL_RUNTIME`だけを受理する。`BATTLE`／`BATTLE_UNIT`はCatalogロード時点（`createRuntimeCounterUpdateDefinition`）で明示的に拒否する（レビュー再レビュー[P2]、Issue #143: 当初「Catalogとして受理するが評価器が実行時に拒否する」契約だったが、未対応スコープを実行前に検出できるよう変更した）。利用するproduction定義が現れるまではFeature Complete必須対象に含めず、必要な定義を追加する際にそのproduction経路と同じTaskで実装・検証する。

`resetScope`（省略可、`"RESOLUTION_SCOPE"`のみ）を宣言すると、そのcounterは「1解決スコープ（1行動、またはターン開始・終了など行動外のトップレベルイベント）の終了時に破棄される」（`R-EFF-11`）。省略時（既定）はBattle単位、つまり戦闘終了までcounterを保持する。スコープ終了時の破棄・`RuntimeCounterReset`発行・候補解決は呼び出し側（`PassiveActivationRuntime.finalizeResolutionScope`）が、そのスコープの最後の`onFactEvent`呼び出し後に必ず1回実行する。`RuntimeCounterReset`自身の候補解決が同じcounterを再生成した場合は、対象が残らなくなるまで「破棄→発行→候補解決」を繰り返すが、この反復はPS発動済みGuard（R-PS-07）を経由しないため、実装は反復回数へ決定的な上限を設けて超過時にエラーを送出する（`counterUpdates`が自身の`RuntimeCounterReset`を再生契機にする誤ったCatalog定義を検出するため）。

```yaml
counterUpdates:
  - kind: INCREMENT
    counter: SKL_EXAMPLE_PS3_PER_ACTION_COUNT
    scope: SKILL_RUNTIME
    trigger:
      eventType: SkillUseCompleted
      category: FACT
      sourceSelector: SELF
      targetSelector: ANY
    amount: 1
    resetScope: RESOLUTION_SCOPE
```

公開値（`value`）が変わらない更新（例: 累計ダメージ閾値未到達のヒット）でも、内部端数（`carry`）が変化していれば`RuntimeCounterChanged`を発行する（レビュー再レビュー[P2]: `value`不変・`carry`不変（トリガー自体が不成立、または加算量0）の場合だけ何も発行しない）。可変状態の変化を必ずイベント列から追跡できるようにするため。

`INCREMENT`によるカウントは、`RUNTIME_COUNTER` Conditionを対象イベント自身（`counterUpdates[].trigger`と同じ`eventType`）へ直接付与し、`modulo`で周期を絞り込む。一方`CUMULATIVE_DAMAGE_THRESHOLD`は、`counterUpdates[].trigger`（`DamageApplied`など）ごとに閾値を超えたとは限らないため、`RUNTIME_COUNTER`をそのまま使うと閾値を超えていない被ダメージでも「前回超えた時のvalueがまだ条件を満たす」まま誤って再発火しうる。そのため`CUMULATIVE_DAMAGE_THRESHOLD`を消費するPSは、`counterUpdates[].trigger`ではなく`RuntimeCounterChanged`をtriggerのeventTypeとする。

ただし`RuntimeCounterChanged`は上記のとおりcarryのみの変化でも発行されるため（`valueChanged: false`）、`EVENT_PAYLOAD`で`counter`フィールドを自身のcounter IDと比較するだけでは閾値未到達の被弾ごとに誤発動する（レビュー再々レビュー[P1]、Issue #143）。`counter`の一致に加えて`valueChanged`が`true`であることも`AND`で要求し、実際に閾値を跨いだ（`before !== after`）更新だけに絞り込む。

```yaml
triggers:
  - eventType: RuntimeCounterChanged
    category: FACT
    sourceSelector: SELF
    targetSelector: ANY
    condition:
      kind: AND
      conditions:
        - { kind: EVENT_PAYLOAD, field: counter, op: EQ, value: SKL_EXAMPLE_PS2_THRESHOLD_COUNT }
        - { kind: EVENT_PAYLOAD, field: valueChanged, op: EQ, value: true }
```

`POSITION_RELATION`の`relation`は少なくとも「目の前」（`IN_FRONT_OF`）を候補とする。`target`は`TargetReference`（`SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`、trigger文脈では`BINDING`等のEffectSequence専用kindは非対応）で、`ALLY`/`ENEMY`の`sourceSelector`/`targetSelector`と組み合わせられる。`RESOLUTION_PHASE`の`phase`は`BATTLE_START`/`TURN_START`/`TURN_END`を候補とし、`negate: true`で「これらのphase中は不成立」（除外条件）を表す。両kindとも、`condition`フィールド（`ConditionDefinition`）から他のkindと`AND`/`OR`/`NOT`で組み合わせられる（Issue #144）。

`POSITION_RELATION`は、`target`が解決する対象が複数ある場合（`TRIGGER_TARGET`が複数ユニットを指す等）はいずれか1体が`relation`を満たせば成立とし（`sourceSelector`/`targetSelector`の「いずれか1件」判定と同じ方針）、対象が不在（`target`が解決先を持たない）または戦闘不能の場合は不成立として扱う。`RESOLUTION_PHASE`は、呼び出し側が現在の解決スコープのphaseを渡さない場合（行動中など通常の解決スコープ）を「いずれの`phase`とも一致しない」の既定値として扱うため、`negate: false`の条件はcontext省略時に常に不成立、`negate: true`の条件は常に成立する。両kindとも、`TriggerDefinition.condition`／`SkillDefinition.activationCondition`の評価器（`PassiveTriggerMatcher`、`battle/triggering`）が対応し、`EffectSequence`側の`ConditionEvaluator`（M7）は未対応のまま。

`ALIVE_UNIT_COUNT` は `FormulaDefinition.ALIVE_UNIT_COUNT_SCALE` が倍率計算専用（発動可否のゲーティングに使えない）だったことを受けて追加した。`excludeSelf: true` で自身を母数から除外できる（例: 「自身以外の味方が0体なら不発」は `side: ALLY, excludeSelf: true, op: GT, value: 0` を `activationCondition` に設定する）。

```yaml
kind: ALIVE_UNIT_COUNT
side: ALLY
excludeSelf: true
op: GT
value: 0
```

`TARGET_SET_COUNT`（RES-004集合条件、Issue #227）は、`ALIVE_UNIT_COUNT`が陣営(side)単位の生存数比較しかできない制約を、Area/TargetFilterで絞り込んだ後の対象集合へ拡張する。`target`（`TargetReference`）が解決する集合（`TargetBinding`の`selector`が`filters`/`area`で絞り込んだ後の集合を含む）から、生存している（戦闘不能でない）要素数だけを数え、`op`/`value`で比較する。`EXISTS`（1体以上存在する）は`op: GTE, value: 1`、`NONE`（1体も存在しない）は`op: LT, value: 1`で表し、他の`op`/`value`の組み合わせで任意のしきい値比較（COUNT）も表現できる。評価は条件評価時点の最新Battle stateを反映する（`resolvedBindings`が保持するスナップショットではなく、都度最新の対象を引き直す）。

```yaml
# 例: SKL_LYDIA_GENIUS_AS1「対象範囲（敵右列・左列）に敵が存在しない場合は発動しない」の
# 近似解消方針（EffectStep条件としての表現。AS/EXのactivationConditionとしての利用は
# CAP_ACTION_ACTIVATION_CONDITION、Issue #180/M7-003へ引き渡す）。
kind: TARGET_SET_COUNT
target:
  kind: BINDING
  targetBindingId: TGT_COLUMNS
op: GTE
value: 1
```

`BRANCH`の`condition`、またはACTIONの`stepCondition`（`CAP_EFFECT_STEP_SET_CONDITION`）でだけ評価できる（Issue #230でACTIONの`condition`は`stepCondition`/`targetCondition`へ分離済み。`targetCondition`には含められない）。AS/EXの`activationCondition`（`CAP_ACTION_ACTIVATION_CONDITION`）やPSの`activationCondition`／`TriggerDefinition.condition`（`CAP_PASSIVE_ACTIVATION_CONDITION`）からの利用は、対象集合を解決するための`resolvedBindings`／`TargetBinding`評価の文脈が異なるため、この完了境界には含めない（Issue #227、#180（M7-003）へ引き渡す）。

`BRANCH`は`target`を持たず単一の`condition`が常にstep-wideスコープのままのため、今も`TARGET_STATE`/`TARGET_HAS_MARKER`（対象ごとに真偽が変わる対象別条件）と`TARGET_SET_COUNT`（step全体で1回だけ評価する集合条件）を`AND`/`OR`/`NOT`で同時に含められない（PRレビュー[P2]再々々指摘・再々々々指摘）。両者は単一のbooleanへ還元する意味論が異なり（前者は「対象ごとの適用可否フィルタ」、後者は「step自体のskip判定」）、混在させると量化の位置に依存して結果が変わってしまう。`TARGET_STATE`/`TARGET_HAS_MARKER`が参照する`TargetReference`が`step.target`と一致するかどうかは問わない — `TARGET_SET_COUNT`単独の評価経路は対象ごとの文脈を持たないため、参照先を問わず例外になる。Catalog検証（`catalog-integrity.ts`の`MIXED_STEP_TARGET_SET_CONDITION`）がロード時点で明示的に拒否する。

ACTIONは`stepCondition`（TARGET_SET_COUNTを許可）と`targetCondition`（TARGET_STATE/TARGET_HAS_MARKERを許可）という独立したスキーマフィールドへ分離済み（Issue #230、CAP_EFFECT_STEP_CONDITION_SCOPE）のため、この2種の混在は型・Catalogスキーマの両方で最初から構築不可能になり、`MIXED_STEP_TARGET_SET_CONDITION`の対象から外れた — 同じACTION stepでstep-wide gate（TARGET_SET_COUNT）とper-target filter（TARGET_STATE/TARGET_HAS_MARKER）を自由に併用できる。

### counterUpdates（AppliedEffectスコープ、EFF-005）

`DurationDefinition`は`counterUpdates`（`RuntimeCounterUpdateDefinition[]`、省略可・省略時は宣言なし扱い）を持てる（EFF-005、Issue #162）。`SkillDefinition.counterUpdates`と同じ構文（`kind`/`counter`/`trigger`/`amount`または`maxHpRatio`/`resetScope`）だが、`scope`は常に`APPLIED_EFFECT`でなければならない（他スコープはこの位置では意味を持たないため拒否する）。宣言したcounterは、同じ`DurationDefinition`の`expiration.conditions`（R-EFF-08）から`RUNTIME_COUNTER` Conditionで参照できる — 参照は宣言必須（`SkillDefinition`と同じ「未宣言counterの参照を拒否する」規則）。

```yaml
duration:
  dispellable: true
  linkedEffectGroupId: null
  counterUpdates:
    - kind: INCREMENT
      counter: ACT_EXAMPLE_HIT_COUNT
      scope: APPLIED_EFFECT
      trigger:
        eventType: DamageApplied
        category: FACT
        sourceSelector: ENEMY
        targetSelector: SELF
      amount: 1
  expiration:
    conditions:
      - { kind: RUNTIME_COUNTER, counter: ACT_EXAMPLE_HIT_COUNT, op: GTE, value: 3 }
```

`counterUpdates`を持つduration保持`EffectActionDefinition`（`APPLY_MARKER`を除く）は`requiredCapabilities`へ`CAP_EFFECT_RUNTIME_COUNTER`を宣言しなければならない。`APPLY_MARKER.duration.counterUpdates`はCatalogロード時点で明示的に拒否する（`UNSUPPORTED_MARKER_DURATION`）— `MarkerState`も同じ`DurationDefinition`/`EffectDurationState`を再利用するためschema上は設定できてしまうが、Marker自身のconsumption/expiration機構が別途未実装のため、宣言してもMarkerが失効しないまま静かに無視される事態を防ぐ。`resetScope`（`RESOLUTION_SCOPE`）はこの位置では意味を持たない（`AppliedEffect`スコープのcounterは効果インスタンス自身の失効がリセットを兼ねるため、`RuntimeCounterReset`を発行しない）。利用するproduction定義は現状存在しないため、`CAP_EFFECT_RUNTIME_COUNTER`は明示的Scenarioで検証済みだが`runtimeStatus: PLANNED`のまま — `runtimeStatus: IMPLEMENTED`は`productionDefinitionIds`が非空であることを要求する（`capability-definition.ts`）。

### counterUpdates（EffectSequenceスコープ、EFF-006）

`EffectSequence`は`counterUpdates`（`RuntimeCounterUpdateDefinition[]`、省略可・省略時は宣言なし扱い）を持てる（EFF-006、Issue #212）。`SkillDefinition.counterUpdates`と同じ構文だが、`scope`は常に`EFFECT_SEQUENCE`でなければならない。実行時識別子には既存の`SkillUseId`（1回の解決を一意に識別する）を再利用し、`BattleUnit.effectSequenceCounters`（`SkillUseId`→`RuntimeCounter`）が保持先となる。宣言位置は`SkillDefinition.resolution`（`kind: IMMEDIATE`）または`chargeRelease`（`kind: CHARGE`）のいずれかで、`EffectSequence`自身が解決されるたびに空のcounterから始まり、その解決が完了した時点（正常終了・中断のいずれでも）で必ず破棄・`RuntimeCounterReset`を発行する — `resetScope`はこの位置では宣言できない（`EffectSequence`は解決単位を超えて状態を持てないため、選択の余地がない）。

```yaml
resolution:
  kind: CHARGE
  targetBindings: []
  steps:
    - kind: ACTION
      target: { kind: SELF }
      actions:
        - effectActionDefinitionId: ACT_MARKER_CHARGING
  chargeRelease:
    targetBindings:
      - targetBindingId: TGT_ALL_ENEMIES
        selector: { kind: SELECT, side: ENEMY, count: ALL, order: [DEFAULT] }
    steps:
      - kind: ACTION
        target: { kind: BINDING, targetBindingId: TGT_ALL_ENEMIES }
        actions:
          - effectActionDefinitionId: ACT_DAMAGE_EN_4740
    counterUpdates:
      - kind: INCREMENT
        counter: ACT_EXAMPLE_HIT_COUNT
        scope: EFFECT_SEQUENCE
        trigger:
          eventType: EffectActionCompleted
          category: FACT
          sourceSelector: SELF
          targetSelector: ANY
        amount: 1
```

`counterUpdates`を宣言する`EffectSequence`を持つ`SkillDefinition`は`requiredCapabilities`へ`CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER`を宣言しなければならない。**CHARGEスキルの開始側（トップレベルの`steps`/`targetBindings`）に宣言することはできない**（`resolveChargeStart`が一度もこのEffectSequenceを解決しないため、宣言しても更新もResetも一切発生しない — Catalogロード時点で明示的に拒否する、PR #213レビュー[P1]）。`chargeRelease`側（`resolveChargeRelease`が実際に解決する）にだけ宣言できる。利用するproduction定義は現状存在しないため、`CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER`は明示的Scenarioで検証済みだが`runtimeStatus: PLANNED`のまま。

### TARGET_STATE field

| field               | 型      |
| ------------------- | ------- |
| `IS_ALIVE`          | boolean |
| `HP_RATIO`          | number  |
| `ATTRIBUTE`         | enum    |
| `UNIT_TYPE`         | enum    |
| `ROLE`              | enum    |
| `POSITION_ROW`      | enum    |
| `POSITION_COLUMN`   | enum    |
| `HAS_STATUS`        | enum    |
| `RESOURCE_AP`       | integer |
| `RESOURCE_PP`       | integer |
| `RESOURCE_EX_GAUGE` | integer |

### op

`GT` / `GTE` / `LT` / `LTE` / `EQ` / `NEQ` / `IN` / `CONTAINS`

---

## DurationDefinition

### 基本構造

```yaml
duration:
  timeLimit:
    unit: ACTION
    count: 2
    owner: EFFECT_TARGET
  consumption:
    kind: NEXT_INCOMING_ATTACK
    maxCount: 1
  expiration:
    conditions: []
  dispellable: true
  linkedEffectGroupId: null
  linkedEffectGroupRole: null
```

| フィールド              | 型          | 必須 | 制約                                                                                                              |
| ----------------------- | ----------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `timeLimit`             | object      | —    | 省略時は即時効果                                                                                                  |
| `consumption`           | object      | —    | 消費型効果                                                                                                        |
| `expiration`            | object      | —    | 特殊失効                                                                                                          |
| `dispellable`           | boolean     | —    | 省略時 true                                                                                                       |
| `linkedEffectGroupId`   | string/null | —    | 親子連動                                                                                                          |
| `linkedEffectGroupRole` | enum        | —    | `PARENT` / `CHILD`。`linkedEffectGroupId`必須。省略時は理由を問わずグループ全体へ対称にカスケードするレガシー扱い |

`linkedEffectGroupRole`（R-EFF-09）: `linkedEffectGroupId`が同じ`AppliedEffect`間のカスケード方向を明示する。`PARENT`が失効すると理由を問わず同グループ全体（他の`PARENT`・`CHILD`）へカスケードするが、`CHILD`が単独で失効してもカスケードしない（「子効果だけが消費条件で失効した場合、親効果は維持する」）。どちらのメンバーも`linkedEffectGroupRole`を持たないグループは従来どおり対称にカスケードする。

### timeLimit.unit

| unit        | 意味             |
| ----------- | ---------------- |
| `ACTION`    | owner の行動回数 |
| `TURN`      | ターン終了回数   |
| `BATTLE`    | 戦闘終了まで     |
| `HIT`       | ヒット数         |
| `SKILL_USE` | スキル使用回数   |

### timeLimit.owner

| owner           | 意味       |
| --------------- | ---------- |
| `EFFECT_TARGET` | 効果対象   |
| `EFFECT_SOURCE` | 効果付与者 |
| `BATTLE`        | 戦闘全体   |

### consumption.kind

| kind                   | 意味                     |
| ---------------------- | ------------------------ |
| `NEXT_OUTGOING_ATTACK` | 次に行う攻撃             |
| `NEXT_INCOMING_ATTACK` | 次に受ける攻撃           |
| `INCOMING_HIT`         | 被ヒットごと             |
| `OUTGOING_HIT`         | 与ヒットごと             |
| `STATUS_BLOCKED`       | 状態異常を無効化したとき |
| `LETHAL_DAMAGE`        | 致死ダメージを受けたとき |

`consumption.maxCount` は消費条件の成立回数上限を表す。上限に到達した効果は、該当する EffectAction の解決後に失効する。

---

## TriggerDefinition

### 基本構造

```yaml
trigger:
  eventType: TurnStarted
  category: FACT
  sourceSelector: ANY
  targetSelector: ANY
  condition:
    kind: TRUE
```

### eventType 候補

v2では v1 のイベントに加えて、raw のPS条件を表現するため次を追加候補とする。

| eventType               | 用途                       |
| ----------------------- | -------------------------- |
| `BattleStarted`         | Memoryの戦闘開始時効果     |
| `TurnStarted`           | ターン開始PS/Memory        |
| `TurnCompleting`        | ターン終了PS               |
| `SkillUseStarting`      | スキル使用前               |
| `SkillUseCompleted`     | スキル使用後               |
| `UnitBeingAttacked`     | 攻撃対象決定後、ダメージ前 |
| `DamageWillBeApplied`   | ダメージ適用直前           |
| `DamageApplied`         | ダメージ適用後             |
| `EffectApplied`         | 効果インスタンス追加後     |
| `HealApplied`           | 回復後                     |
| `CriticalHitConfirmed`  | 会心確定後                 |
| `ResourceChanged`       | AP/PP/EX変更後             |
| `MarkerApplied`         | Marker付与後               |
| `MarkerCountChanged`    | Marker数変更後             |
| `ChargeStarted`         | チャージ開始後             |
| `PassiveEffectReceived` | 他味方からPS効果を受けた後 |
| `UnitDefeated`          | 戦闘不能後                 |

Memory の `BattleStarted` trigger は、編成内 Memory の API 指定順、同一 Memory 内の `triggeredEffects` 定義順で解決する。

---

## MemoryDefinition

### YAML 全体像

```yaml
memoryDefinitionId: MEM_001
triggeredEffects:
  - trigger:
      eventType: BattleStarted
      category: FACT
      condition:
        kind: TRUE
    effectSequence:
      targetBindings:
        - targetBindingId: TGT_ALL_ALLIES
          selector:
            kind: SELECT
            side: ALLY
            count: ALL
      steps:
        - kind: ACTION
          target:
            kind: BINDING
            targetBindingId: TGT_ALL_ALLIES
          actions:
            - effectActionDefinitionId: ACT_MEMORY_ATTACK_FIXED_250
requiredCapabilities:
  - CAP_MEMORY_TRIGGERED_EFFECT
metadata:
  displayName: "Colorful Bouquet"
  tags: []
```

### フィールド詳細

| フィールド             | 型       | 必須 | 制約                  |
| ---------------------- | -------- | ---- | --------------------- |
| `memoryDefinitionId`   | string   | ✓    | 一意                  |
| `triggeredEffects`     | object[] | ✓    | 1件以上。v2唯一の表現 |
| `requiredCapabilities` | string[] | ✓    | 空配列可              |
| `metadata`             | object   | ✓    | displayName / tags    |

単純な「戦闘開始時に味方へ stat 補正」も、`APPLY_STAT_MOD` を持つ `triggeredEffects` として表現する（`eventType: BattleStarted`、`side: ALLY` の `selector`、`duration.timeLimit: { unit: BATTLE, count: 1 }`）。`modifiers` 省略記法は廃止した。

`triggeredEffects` を持つ Memory は `requiredCapabilities` に `CAP_MEMORY_TRIGGERED_EFFECT` を含めること。Memory発動エンジン（M7、`BattleStarted` での `triggeredEffects` 解決、`R-MEM-01`〜`04`）が未実装の間、Capabilityで隔離しないと `SimulationPreflightValidator` を素通りし、戦闘は開始できるがMemory効果だけが黙って未適用になる（`REMOVE_EFFECTS`/`APPLY_SHIELD`と同じ理由）。

---

## CapabilityDefinition

### capabilities.json

```json
[
  {
    "capabilityId": "CAP_HEAL",
    "schemaStatus": "SUPPORTED",
    "runtimeStatus": "PLANNED",
    "implementationTaskId": "M7-005",
    "description": "即時回復EffectAction",
    "verification": {
      "productionDefinitionIds": [],
      "testCaseIds": []
    }
  }
]
```

| フィールド                             | 型       | 必須 | 制約                                               |
| -------------------------------------- | -------- | ---- | -------------------------------------------------- |
| `capabilityId`                         | string   | ✓    | `Q-*` または `CAP_*`                               |
| `schemaStatus`                         | enum     | ✓    | `SUPPORTED` / `PLANNED` / `BLOCKED`                |
| `runtimeStatus`                        | enum     | ✓    | `IMPLEMENTED` / `PLANNED` / `BLOCKED`              |
| `implementationTaskId`                 | string   | ✓    | 実行可能化を完了責任として持つ単一Task ID          |
| `description`                          | string   | ✓    | 近似なしで完了判定できる機能境界                   |
| `verification.productionDefinitionIds` | string[] | ✓    | 本番検証対象のUnit / Skill / EffectAction / Memory |
| `verification.testCaseIds`             | string[] | ✓    | 本番経路を検証するテストID                         |

`schemaStatus` はCatalogが近似なしで表現できるか、`runtimeStatus` はBattle Engineが実ライフサイクルで実行できるかを表す。production定義の`requiredCapabilities`は`schemaStatus == SUPPORTED`だけを参照できる。`SimulationPreflightValidator`は編成から推移的に集めたCapabilityの`runtimeStatus != IMPLEMENTED`を`UNSUPPORTED_RULE`としてBattle生成前に拒否する。

`runtimeStatus`を`IMPLEMENTED`へ変更するには、`productionDefinitionIds`と`testCaseIds`をそれぞれ1件以上記録する。Catalog整合性検証は各production definition IDの存在と、その定義自身が同じCapabilityを`requiredCapabilities`へ宣言していることを検査する。repository traceability testはTypeScript ASTから、Vitestからnamed importした`it`/`test`（aliasを含む）がトップレベルまたは実行対象の`describe`/`suite` callbackへ無条件に登録するタイトルを読み取り、各test case IDが一意なテスト定義として実在することを検査する。証跡用test/suiteはinline callbackを必須とし、optionsはspreadや動的computed keyを含まないobject literalかつ`skip`/`todo`が未指定または明示的な`false`の場合だけ受理する。parameterized test/suiteはSpreadElementを含まず、静的に1件以上のcaseを持つ配列リテラルだけを受理する。コメント、任意の文字列、同一ファイル内を含む重複テスト定義、ローカル同名関数、空・spread・動的なparameterized test/suite、callback欠落、optionsまたはmodifierによるskip/todo、条件式/未呼出関数配下の非実行テストは証跡として受理しない。Schema/Mapperや単体関数だけの完成、fixtureだけのテストでは`IMPLEMENTED`にしない。

`implementationTaskId`は一つだけ持たせる。複数Taskの完了を待つ広域Capabilityを作らず、各Taskがproduction定義と統合テストを提示できる機能単位へ分割する。

### Issue #166での分割

| 旧Capability                   | 現Capability                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `CAP_ADVANCED_TARGETING`       | `CAP_TARGET_FILTER_ORDER`、`CAP_TARGET_DERIVED_AREA`、`CAP_TARGET_BINDING_FALLBACK` |
| `CAP_ADVANCED_PASSIVE_TRIGGER` | `CAP_TRIGGER_CONTEXT`（その他の条件・効果はそれぞれの既存Capability）               |
| `CAP_RUNTIME_COUNTER`          | 実装済み`CAP_SKILL_RUNTIME_COUNTER`、未実装`CAP_EFFECT_RUNTIME_COUNTER`             |
| `CAP_EFFECT_CONDITION`         | `CAP_EFFECT_STEP_CONDITION`                                                         |
| `CAP_RESOLUTION_BRANCH`        | `CAP_RESOLUTION_BRANCH_REPEAT`                                                      |
| `CAP_RESOURCE_MOD`             | `CAP_RESOURCE_MUTATION`                                                             |
| `CAP_DERIVED_TARGETS`          | `CAP_TARGET_DERIVED_AREA`                                                           |
| `CAP_TARGET_FALLBACK`          | `CAP_TARGET_BINDING_FALLBACK`                                                       |

旧IDは互換aliasとして残さない。`catalog-src/`内の参照と生成済み`catalog/`を同じrevisionで一括移行する。API v1はCapability定義本体を公開せず、選択不可理由のCapability IDだけを返すため、レスポンスSchemaの変更はない。

RES-004（Issue #171、PRレビュー[P2]）では、`CAP_EFFECT_STEP_CONDITION`の完了境界を「EffectStepの対象別条件（自身のtargetを参照するTARGET_STATE/TARGET_HAS_MARKERの個別評価）と、既存productionが使う非TRUE条件（`LAST_RESULT`等）」に絞り、`IMPLEMENTED`はこの境界だけで判断する。「集合条件」（対象集合のしきい値判定、`SET_THRESHOLD_ACTIVATION_CONDITION`）は、当時`schemaStatus: SUPPORTED`にできる具体的な`ConditionKind`設計がまだ無かったため、このCapabilityの完了境界に含めなかった。

RES-004後続（Issue #227）で、`ConditionDefinition.kind: TARGET_SET_COUNT`として集合条件のschemaを設計し、`CAP_EFFECT_STEP_SET_CONDITION`を新規Capabilityとして追加した（Issue #166のような改名ではなく、未着手スコープの新規追加）。schema・`EffectStep`条件評価器（`ACTION`/`BRANCH`）への配線・Catalog検証は実装済みだが、利用するproduction定義（`SKL_LYDIA_GENIUS_AS1`/`SKL_ELENA_MOODMAKER_AS1`はいずれもAS/EXの`activationCondition`としての利用であり、`CAP_ACTION_ACTIVATION_CONDITION`（#180、M7-003）のスコープ）が現状存在しないため、`runtimeStatus`は`PLANNED`のままとする。

実行時構造から必要Capabilityを一意に導出し、Skill/Memory自身の`requiredCapabilities`へ宣言する。非空`filters`または`["DEFAULT"]`以外の`order`は`CAP_TARGET_FILTER_ORDER`、`BINDING_DERIVED`または`area`は`CAP_TARGET_DERIVED_AREA`、`fallback`は`CAP_TARGET_BINDING_FALLBACK`を必須とする。TargetSelectorのkind/baseまたはEffectStep targetが`TRIGGER_SOURCE`/`TRIGGER_TARGET`なら`CAP_TRIGGER_CONTEXT`、EffectStep targetが`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`なら`CAP_RESOLUTION_BRANCH_REPEAT`を必須とする。`RANDOM_BRANCH`は`CAP_RANDOM_BRANCH`、Memoryの`triggeredEffects`は`CAP_MEMORY_TRIGGERED_EFFECT`を必須とする。Skillの`activationCondition`が`TRUE`以外なら、AS/EXは`CAP_ACTION_ACTIVATION_CONDITION`、PSは`CAP_PASSIVE_ACTIVATION_CONDITION`を必須とする。前者はR-ACT-01/02の行動選択、後者はPS候補判定・発動直前再確認という別ライフサイクルを完了境界とする。Catalog整合性検証はEffectStepの分岐・反復とselectorのfallbackを再帰走査し、宣言漏れを拒否する。

### 現Capability registry

正本は`catalog-src/capabilities.json`とし、下表は担当境界を示す。

| Capability                         | 完了責任Task | 実行可能化の境界                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAP_ACTION_ACTIVATION_CONDITION`  | `M7-003`     | AS / EXのactivationConditionを行動選択で評価する                                                                                                                                                                                                                                           |
| `CAP_PASSIVE_ACTIVATION_CONDITION` | `RES-004`    | PSのactivationConditionを候補判定・直前再確認で評価する                                                                                                                                                                                                                                    |
| `CAP_CHARGE_RESTRICTION`           | `M7-003`     | チャージ中の回避/PS制限                                                                                                                                                                                                                                                                    |
| `CAP_COMPLEX_EXPIRATION`           | `EFF-003`    | ACTION/TURN期間・消費・特殊失効・親子連動                                                                                                                                                                                                                                                  |
| `CAP_CONTINUOUS_DAMAGE`            | `DMG-008`    | 継続ダメージ(DoT)                                                                                                                                                                                                                                                                          |
| `CAP_CONTINUOUS_HEAL`              | `M7-005`     | 継続回復                                                                                                                                                                                                                                                                                   |
| `CAP_COOLDOWN_MANIPULATION`        | `M6-CD-001`  | 他スキルのクールタイム短縮・リセット                                                                                                                                                                                                                                                       |
| `CAP_COVER_DAMAGE`                 | `DMG-006`    | 肩代わり                                                                                                                                                                                                                                                                                   |
| `CAP_CRITICAL_CONTROL`             | `DMG-003`    | 会心保証・会心不可                                                                                                                                                                                                                                                                         |
| `CAP_DAMAGE_MOD`                   | `DMG-002`    | 与ダメージ・被ダメージ補正                                                                                                                                                                                                                                                                 |
| `CAP_DEATH_SURVIVAL`               | `DMG-006`    | 致死耐え                                                                                                                                                                                                                                                                                   |
| `CAP_EFFECT_RUNTIME_COUNTER`       | `EFF-005`    | AppliedEffectスコープのRuntimeCounter（実装済み、production定義が現れるまで`runtimeStatus: PLANNED`）                                                                                                                                                                                      |
| `CAP_EFFECT_STEP_CONDITION`        | `RES-004`    | EffectStepの対象別条件（ACTIONの`targetCondition`、またはBRANCHの`condition`が自身のtargetを参照するTARGET_STATE/TARGET_HAS_MARKERを対象ごとに個別評価。Issue #230でACTIONは専用フィールドへ分離）。集合条件は`CAP_EFFECT_STEP_SET_CONDITION`が別途担う                                    |
| `CAP_EFFECT_STEP_SET_CONDITION`    | `RES-004`    | BRANCHの`condition`、またはACTIONの`stepCondition`（Issue #230でACTIONの`condition`から分離）でTARGET_SET_COUNTを評価する（実装済み、production定義が現れるまで`runtimeStatus: PLANNED`）。AS/EXのactivationConditionでの利用は`CAP_ACTION_ACTIVATION_CONDITION`（#180、M7-003）が別途担う |
| `CAP_FORMULA`                      | `RES-001`    | 動的値計算                                                                                                                                                                                                                                                                                 |
| `CAP_HEAL`                         | `M7-005`     | 即時回復EffectAction                                                                                                                                                                                                                                                                       |
| `CAP_HIT_COUNT_EVASION`            | `M7-004`     | Nヒット回避                                                                                                                                                                                                                                                                                |
| `CAP_MARKER`                       | `EFF-004`    | 固有マーカー                                                                                                                                                                                                                                                                               |
| `CAP_MARKER_STACK_FORMULA`         | `EFF-004`    | Marker数を参照するFormula                                                                                                                                                                                                                                                                  |
| `CAP_MEMORY_TRIGGERED_EFFECT`      | `M7-006`     | MemoryのTriggeredEffect発動engine                                                                                                                                                                                                                                                          |
| `CAP_PARTIAL_PIERCING`             | `DMG-003`    | 部分防御/シールド無視                                                                                                                                                                                                                                                                      |
| `CAP_RANDOM_BRANCH`                | `RES-003`    | 確率分岐                                                                                                                                                                                                                                                                                   |
| `CAP_REMOVE_EFFECTS`               | `M7-001`     | 効果解除                                                                                                                                                                                                                                                                                   |
| `CAP_RESOLUTION_BRANCH_REPEAT`     | `RES-003`    | BRANCH / REPEATと直前結果                                                                                                                                                                                                                                                                  |
| `CAP_RESOURCE_CAPACITY_MOD`        | `M7-002`     | 最大APなどの上限変更                                                                                                                                                                                                                                                                       |
| `CAP_RESOURCE_MUTATION`            | `M7-002`     | AP / PP / EX 操作                                                                                                                                                                                                                                                                          |
| `CAP_SHIELD`                       | `DMG-004`    | シールド付与                                                                                                                                                                                                                                                                               |
| `CAP_SKILL_RUNTIME_COUNTER`        | `M6-RC-001`  | SkillRuntimeスコープの発動回数・累計条件                                                                                                                                                                                                                                                   |
| `CAP_SPECIFIC_IMMUNITY`            | `M7-001`     | 個別状態異常無効                                                                                                                                                                                                                                                                           |
| `CAP_TARGET_BINDING_FALLBACK`      | `TGT-003`    | TargetBinding固定・参照時の戦闘不能skip・fallback判定                                                                                                                                                                                                                                      |
| `CAP_TARGET_DERIVED_AREA`          | `TGT-001`    | area・距離・隣接・列による派生対象                                                                                                                                                                                                                                                         |
| `CAP_TARGET_FILTER_ORDER`          | `TGT-002`    | Target filter・order・除外選択                                                                                                                                                                                                                                                             |
| `CAP_TARGET_REDIRECT`              | `DMG-006`    | 挑発・攻撃引き寄せ                                                                                                                                                                                                                                                                         |
| `CAP_TRIGGER_CONTEXT`              | `RES-005`    | TRIGGER_SOURCE / TRIGGER_TARGETと基本Damage事実イベント                                                                                                                                                                                                                                    |

現時点で保留仕様として隔離する `Q-*` Capability はない。

---

## raw からの変換例

### 例1: 単体攻撃 + 気絶

raw:

```text
敵単体に威力301.2で攻撃し、対象に2行動分の気絶を付与する。
```

v2:

```yaml
targetBindings:
  - targetBindingId: TGT_PRIMARY
    selector:
      kind: SELECT
      side: ENEMY
      count: 1
      order:
        - DEFAULT
steps:
  - kind: ACTION
    target:
      kind: BINDING
      targetBindingId: TGT_PRIMARY
    actions:
      - effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_30120
      - effectActionDefinitionId: ACT_STUN_ACTION_2
```

### 例2: 対象が生存していた場合に追加攻撃

raw:

```text
敵単体に威力20で2ヒット攻撃する。攻撃後に対象が生存していた場合、さらに威力53でもう一度攻撃を行う。
```

v2:

```yaml
steps:
  - kind: ACTION
    target:
      kind: BINDING
      targetBindingId: TGT_PRIMARY
    actions:
      - effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_2000_HIT2
  - kind: BRANCH
    condition:
      kind: TARGET_STATE
      target:
        kind: BINDING
        targetBindingId: TGT_PRIMARY
      field: IS_ALIVE
      op: EQ
      value: true
    thenSteps:
      - kind: ACTION
        target:
          kind: BINDING
          targetBindingId: TGT_PRIMARY
        actions:
          - effectActionDefinitionId: ACT_DAMAGE_PHYSICAL_5300
    elseSteps: []
```

### 例3: Memory の敵前衛被ダメージ増加

raw:

```text
戦闘開始時に発動。敵前衛の受けるダメージを7.5%上昇させる
```

v2:

```yaml
triggeredEffects:
  - trigger:
      eventType: BattleStarted
      category: FACT
      condition:
        kind: TRUE
    effectSequence:
      targetBindings:
        - targetBindingId: TGT_ENEMY_FRONT
          selector:
            kind: SELECT
            side: ENEMY
            count: ALL
            filters:
              - kind: POSITION_ROW
                row: FRONT
      steps:
        - kind: ACTION
          target:
            kind: BINDING
            targetBindingId: TGT_ENEMY_FRONT
          actions:
            - effectActionDefinitionId: ACT_INCOMING_DAMAGE_UP_075
requiredCapabilities:
  - CAP_MEMORY_TRIGGERED_EFFECT
  - CAP_DAMAGE_MOD
```

### 例4: 固有マーカー数に応じたダメージ増加

raw:

```text
この攻撃によるダメージは、対象に付与されている「警棒」1つにつき15%増加する(最大3つまで)
```

v2:

```yaml
kind: DAMAGE
payload:
  damageType: PHYSICAL
  formula:
    kind: SKILL_POWER
    power: 0.53
  damageModifiers:
    - kind: MARKER_COUNT_SCALE
      target:
        kind: TARGET
      markerId: MARKER_KEIBO
      perStack: 0.15
      max: 0.45
requiredCapabilities:
  - CAP_MARKER
  - CAP_MARKER_STACK_FORMULA
```

---

## 参照整合性規則

Catalog v2 検証器は次を確認する。

1. ID一意性。
2. Unit が参照する Skill が存在し、`skillType` が一致する。
3. Skill / Memory の `effectSequence.steps` が参照する `effectActionDefinitionId` が存在する。
4. `TargetReference.kind: BINDING` が同じ sequence 内の `targetBindings` に存在する。
5. `ConditionDefinition` と `FormulaDefinition` の参照 field が許可一覧に存在する。
6. `requiredCapabilities` が `capabilities.json` に存在する。
7. `schemaVersion` が `2` である。
8. `triggeredEffects` を1件以上持つ Memory だけを許可する。
9. AS/EX の `triggers` は空、PS の `triggers` は1件以上。
10. EX Skill の `cost.resource` は `EX_GAUGE` で、`cost.amount` が Unit の `extraGaugeMaximum` と一致する。
11. `EFFECT_IMMUNITY` / `REMOVE_EFFECTS` の `payload.effectActionDefinitionIds`（`categories` に `SPECIFIC_EFFECT` を含む場合）が参照する `EffectActionDefinition` が存在する。

---

## Authoring への影響

Unit / Memory Markdown から Catalog v2 へ変換する際は、次をテンプレートへ追加する。

- Unit metadata: `characterName`, `characterId`, `affiliations`
- Unit generated fields: `baseStats.affinityBonus = 0.25`, `baseStats.criticalDamageBonus = 0.5`, `extraGaugeMaximum = EX skill cost.amount`
- Skill: `targetBindings`, `steps`, `requiredCapabilities`
- EffectAction: `formula`, `duration`, `stacking`, `requiredCapabilities`
- Memory: `triggeredEffects`、`requiredCapabilities`（`CAP_MEMORY_TRIGGERED_EFFECT` を必ず含める）
- 判断記録: raw 文のどの句が Target / Condition / Formula / Action / Duration に対応したか

production Catalog には source text を含めない。出典と転記根拠は authoring Markdown の front matter / source block / decisions block へ保持する。

---

## 後続設計で具体化する点

本書では Catalog schema の枠を定める。以下は `05_ドメインモデル.md`、`07_戦闘ルール詳細.md`、`08_ドメインイベント.md` で具体化する。

1. DamageModifier / HealingModifier の正確な計算順。
2. `UnitBeingAttacked` / `DamageWillBeApplied` など新イベントの発行位置。
3. Cover / Reflect / DamageLink の割り込み順。
4. Marker と linkedEffectGroup の失効順。
5. RandomBranch のログ形式。
6. Memory の複数指定時の発動順。
7. Capability ごとの初期 `IMPLEMENTED` / `PLANNED` 状態。

## Issue #6実装で判明した制約

Catalog v2 DTO・Domain Definition・Mapperの実装（Issue #6）で、本書の記述だけでは一意に決まらない箇所が見つかった。次はpayload例やenum一覧が未確定であり、production Catalogの authoring 前に本書へ追記が必要。

1. `EffectActionDefinition.kind` のうち `APPLY_HEALING_MOD`、`MODIFY_RESOURCE_CAPACITY`、`APPLY_SHIELD`、`REMOVE_EFFECTS`、`APPLY_DAMAGE_LINK` の5種はpayload例が示されていなかった。Issue #44でこのうち `APPLY_HEALING_MOD`・`MODIFY_RESOURCE_CAPACITY`・`APPLY_SHIELD`・`REMOVE_EFFECTS` の4種のpayload形状を本書へ追記し、Mapperへ実装した（下記「Issue #44実装で追加した拡張」）。`APPLY_DAMAGE_LINK` はCover/Reflect/DamageLinkの割り込み順（本書「後続設計で具体化する点」#3）が未確定のため、引き続きMapperは未サポートとして拒否する。`REMOVE_MARKER` は `APPLY_MARKER` の対称形（`markerId` のみ）として実装した。
2. `FormulaDefinition` の `HP_RATIO_SCALE.direction` は値候補が本書のどこにも列挙されていない。Mapperは `HP_RATIO_SCALE` 自体を未サポートとして拒否する。
3. `APPLY_STAT_MOD.stacking.mode` / `APPLY_DAMAGE_MOD.stacking.mode` は例で `STACKABLE` しか示されていない。「重複なし」(`R-STA-03`) に対応する値が未定義のため、Mapperは `STACKABLE` のみを許可する。
4. Formulaの `source`/`target` 参照（`STAT_RATIO.source`、`MARKER_COUNT_SCALE.target` など）はHEAL/MARKER_COUNT_SCALE例では `{kind: ...}` オブジェクト形式、APPLY_SUBUNIT例 (`source: SKILL_SOURCE`) では裸のenum文字列形式と表記が揺れている。Mapperはオブジェクト形式 `{kind, targetBindingId?}` に統一した（`BINDING` 種別が追加フィールドを要するため）。
5. `TriggerDefinition.sourceSelector` / `targetSelector` の値候補は本書に一覧化されていない。実装では `08_ドメインイベント.md` と本書の例に実際に現れる値（`SELF`、`ALLY`、`ENEMY`、`ANY`、`EFFECT_OWNER`）だけを許可した。
6. `MarkerDefinition` はUnit/Skill/EffectAction/Memoryのような専用Catalogファイルを持たず、`MarkerId` 参照のみが登場する。Issue #6では `MarkerId` のformat検証のみを実装し、スタック上限や関連効果を持つ独立したMarkerカタログは未実装とした。

## Issue #44実装で追加した拡張

Issue #41（代表10ユニットのv2 Catalog変換パイロット）で、当時のMapperでは表現できずfixtureから省略した10項目（G-01〜G-10）について、設計方針を確定し、実装するもの・見送るものを区分した。

### 実装したもの（Mapper拡張済み、fixtureで実データ再変換済み）

| #    | 内容                                     | 追加したschema要素                                                              | Capability                                                                                                                                             |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G-01 | 回復量増減の被付与                       | `EffectActionDefinition.kind: APPLY_HEALING_MOD`                                | `CAP_HEAL`（既存を再利用）                                                                                                                             |
| G-02 | 継続ダメージ(DoT)                        | `EffectActionDefinition.kind: APPLY_CONTINUOUS_DAMAGE`                          | `CAP_CONTINUOUS_DAMAGE`（新規）                                                                                                                        |
| G-03 | 生存ユニット数を直接比較する条件         | `ConditionDefinition.kind: ALIVE_UNIT_COUNT`                                    | AS/EXの`activationCondition`では`CAP_ACTION_ACTIVATION_CONDITION`、PSでは`CAP_PASSIVE_ACTIVATION_CONDITION`、EffectStepでは`CAP_EFFECT_STEP_CONDITION` |
| G-04 | 効果解除                                 | `EffectActionDefinition.kind: REMOVE_EFFECTS`                                   | `CAP_REMOVE_EFFECTS`（新規）                                                                                                                           |
| G-06 | `DAMAGE_IMMUNITY`のダメージ量しきい値    | `APPLY_STATUS.payload.damageThreshold`（既存kindへのフィールド追加）            | なし（`APPLY_STATUS`の既存Capability方針を継承。`status !== DAMAGE_IMMUNITY`ではMapperが拒否する）                                                     |
| G-08 | シールド付与                             | `EffectActionDefinition.kind: APPLY_SHIELD`                                     | `CAP_SHIELD`（新規）                                                                                                                                   |
| G-09 | 最大リソース上限変更                     | `EffectActionDefinition.kind: MODIFY_RESOURCE_CAPACITY`                         | `CAP_RESOURCE_CAPACITY_MOD`（既存を再利用）                                                                                                            |
| G-10 | 同一EffectSequence内のDAMAGE結果合算参照 | `FormulaDefinition` の `sourceResult: SUM_DAMAGE_DEALT` / `SUM_DAMAGE_RECEIVED` | `CAP_FORMULA`（既存を再利用）                                                                                                                          |

いずれも `requiredCapabilities` は現時点で `PLANNED`（`capabilities.json`）のままとし、Mapper/schemaレベルでの受理と、対応するBattle Engineの実行（HP/リソース状態遷移、イベント発行）を分離している。これは既存の `CAP_HEAL` / `CAP_MARKER` などと同じ方針であり、Engine側の実装は各Task（DoTはDMG-008／Issue #189、ShieldはDMG-004／Issue #194、SubUnitへのDamage適用はDMG-005／Issue #190、効果解除・無効化・CombatStat再計算はM7-001／Issue #181）で追跡する。

### M7実装予定のもの（schema契約を確定、Mapper未実装）

| #    | 内容                                       | 追加するschema要素                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Capability                      |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| G-05 | リソース「獲得量」自体を増減させるModifier | `EffectActionDefinition.kind: APPLY_RESOURCE_GAIN_MOD`。payload: `resource`（`AP`/`PP`/`EX_GAUGE`）、`rateDelta`（符号付き倍率、例: `+0.5`＝+50%）。`duration: DurationDefinition`、`stacking`（既存`APPLY_STAT_MOD`と同じ`STACKABLE`のみ許可）を持つ。M7の`AppliedEffect`として付与し、対象の`ResourceChanged`確定前に有効な`rateDelta`を合算して基礎量へ適用する（[06\_戦闘状態遷移.md](./06_戦闘状態遷移.md)「`RESOURCE_CONSUMING`：リソース消費」、[07\_戦闘ルール詳細.md](./07_戦闘ルール詳細.md)の`R-ACT-04`参照）。 | `CAP_RESOURCE_GAIN_MOD`（新規） |

`MODIFY_RESOURCE` は一回限りの加減算のままとし、`APPLY_RESOURCE_GAIN_MOD` とは別kindとして扱う（「Duration付与時に確定した符号付き量を加算する」既存の`APPLY_DAMAGE_MOD`/`APPLY_HEALING_MOD`と同じモデルへ揃え、将来の獲得イベントへ事後的にフックする新モデルは導入しない）。フィールド名・丸め規則・複数Modifier合成順の最終確定と、Mapper/Domain実装はM7-002（Issue #185）で行う。`requiredCapabilities` はMapper実装まで`PLANNED`のままとする。

### 見送ったもの（設計課題を明記し、実装を見送り）

| #    | 内容                                    | 見送り理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-07 | `APPLY_DAMAGE_MOD` の動的な相対比較条件 | 「対象HP割合が自身より低い敵にのみ与ダメージ+10%」は、`APPLY_DAMAGE_MOD` が付与時（skill使用時）に1回だけ評価される現行モデルに対し、以後発生する個々の`DAMAGE`解決のたびに、その時点の対象で条件を再評価する必要がある。単に `condition: ConditionDefinition` フィールドを追加するだけでは、条件内の `TargetReference` が「このDamageModifierが今まさに適用されようとしている対象」を指す手段（既存の `TargetReference` kindはBINDING/SELF/TRIGGER_SOURCE/TRIGGER_TARGET/LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETSのみで、この用途を持たない）がなく、新しいTargetReference kindとDamage pipeline側の評価フックの両方の設計を要する。防御貫通はDMG-001（Issue #195）、複数hitはDMG-002（Issue #192）でDamage pipelineを完成させ、per-hit評価の設計が固まってから着手する。 |

G-05（カリナPS2 包囲かんりょ～）該当箇所はM7-002（Issue #185）でschema契約どおりに実装する。G-07（コトハPS2 起死回生）該当箇所は、Issue #41時点のfixtureのまま近似表現（該当効果を省略）を維持する。

## Issue #46実装で見つかった追加課題

代表10ユニットのfixtureをproduction Catalog候補（`catalog/`）へ昇格するにあたり raw と再照合した際に、G-01〜G-10 とは別の新しい表現ギャップが1件見つかった。

| #    | 内容                                                                                                                                   | 影響ユニット・スキル                                                                                            | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-11 | `TargetSelectorDefinition.fallback` で対象が差し替わったとき、適用する `EffectAction` 自体（威力など）を候補経路ごとに変える手段がない | リディア EX リディアたいちょうのめいれい（右列・左列に敵がいない場合は威力113.76ではなく威力100の別攻撃にする） | **見送り**。`fallback` は対象選択のみを差し替える仕組みで、`resolution.steps[].actions[]` は選択された対象の由来（通常フィルタ経由か `fallback` 経由か）を区別しない。現状の fixture は `TGT_COLUMNS` の埋め込み `fallback`（対象が0件のとき最近の敵1体を選ぶ）で対象選択だけは表現しつつ、命中した対象には通常と同じ `ACT_LYDIA_EX_DAMAGE_COLUMN`（威力113.76）を適用する近似とする。この近似が実行されるのは `requiredCapabilities` の `CAP_TARGET_BINDING_FALLBACK` が実装され、当該スキルが `SimulationPreflightValidator` を通過してからであり、それまでは production でも到達しない。単に威力を分ける `EffectAction` を fallback 側に追加するだけでは実行されず、`fallback` 経由か否かを steps へ伝播する新しいフィールド（例: `EffectStepDefinition.target.kind: BINDING` に `viaFallback` の分岐先を持たせる）の設計を要するため、対象フォールバック機構そのものを実装する際にあわせて設計する。 |

Issue #41パイロット実施時に宣言されていた `TGT_FALLBACK` targetBinding と `ACT_LYDIA_EX_DAMAGE_FALLBACK`（威力100の専用DAMAGE）は、どの `resolution.steps` からも参照されない死んだ定義だったため、Issue #46でproduction Catalog候補へ昇格する際に削除した。上記の近似表現に置き換わる実装ができるまで、威力100の専用アクションを復活させない。
