# Catalog 定義スキーマ

## 目的

本書は、[`02_仕様確認事項.md`](./02_仕様確認事項.md) の決定事項と、`raw/units/`・`raw/memories/` の実データ調査結果を踏まえ、Catalog v3 の JSON 契約を定義する。

前提文書: [`05_ドメインモデル.md`](./05_ドメインモデル.md)・[`07_戦闘ルール詳細.md`](./07_戦闘ルール詳細.md)・[`08_ドメインイベント.md`](./08_ドメインイベント.md)・[`11_インフラストラクチャ設計.md`](./11_インフラストラクチャ設計.md)

## 設計方針

### 基本方針

Catalog v3 は、Unit Skill と Memory の効果を同じ基盤で表現する。v3 は v2 から `capabilities.json` と各定義の `requiredCapabilities` を落とした版であり（`REF-023`／Issue #352）、それ以外の契約は v2 と同じである。本書に残る「v1 → v2」の記述は、その変更の由来として引き続き有効である。

効果は次の構成要素に分解する。

| 要素                      | 役割                                         |
| ------------------------- | -------------------------------------------- |
| `TriggerDefinition`       | いつ発動候補になるか                         |
| `ConditionDefinition`     | どの状態なら実行するか                       |
| `TargetBindingDefinition` | 誰を対象として束縛するか                     |
| `EffectStepDefinition`    | どの順番で何を解決するか                     |
| `EffectActionDefinition`  | HP、リソース、状態、マーカーなどへ何をするか |
| `FormulaDefinition`       | 値をどの戦闘状態から計算するか               |
| `DurationDefinition`      | いつまで有効か、何で消費・失効するか         |

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

---

## Catalog ファイル構成

```text
apps/api/catalog/
  manifest.json
  units.json
  skills.json
  effects.json
  memories.json
```

`effects.json` は v1 の `SkillEffectDefinition` ではなく、再利用可能な `EffectActionDefinition` を格納する。Skill / Memory の解決順、対象、条件、分岐はそれぞれの `effectSequence` が持つ。

### manifest.json

```json
{
  "schemaVersion": 3,
  "catalogRevision": "2026-07-11.1",
  "files": {
    "units.json": "sha256:...",
    "skills.json": "sha256:...",
    "effects.json": "sha256:...",
    "memories.json": "sha256:..."
  }
}
```

| フィールド        | 型      | 制約                                                                                                                |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`   | integer | v3 は `3` 固定。任意フィールドの加算的追加（例: `category`／`exerciseActive`）は v3 内で許容し、version bump しない |
| `catalogRevision` | string  | 不透明な文字列                                                                                                      |
| `files`           | object  | 上記4ファイルの sha256 を必須とする                                                                                 |

---

## authoring source（`catalog-src/`）と生成フロー

`catalog/` は runtime loader（`loadCatalogFromDirectory()`）が読む生成物であり、手編集の対象ではない（Issue #50）。人間が編集・レビューするのは `apps/api/catalog-src/` で、ユニット・メモリ単位に分割されている。

```text
apps/api/catalog-src/
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

- 各 `catalog-src/units/*/{unit.json,skills.json,effects.json}` と `catalog-src/memories/*/{memory.json,effects.json}` を読み込み、ディレクトリ名昇順でユニット/メモリを並べて集約する。
- ユニットディレクトリ名が `unit.json` の `unitDefinitionId` と一致しない場合（メモリも同様）は生成せずエラーにする。
- 出力はリポジトリの Prettier 設定（`.prettierrc`）で整形され、`pnpm run format:check` をそのまま通過する。
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

| 種別           | プレフィックス | 例               |
| -------------- | -------------- | ---------------- |
| Unit           | `UNIT_`        | `UNIT_001`       |
| Skill          | `SKL_`         | `SKL_001_AS1`    |
| EffectAction   | `ACT_`         | `ACT_001_DAMAGE` |
| Memory         | `MEM_`         | `MEM_001`        |
| Target binding | `TGT_`         | `TGT_PRIMARY`    |
| Marker         | `MARKER_`      | `MARKER_CURSE`   |

ID は ASCII 英数字、ハイフン、アンダースコアのみ許可する。Catalog 全体で同種 ID は一意でなければならない。

---

## UnitDefinition

### YAML 全体像

```yaml
unitDefinitionId: UNIT_001
category: PLAYABLE # 任意。省略時 PLAYABLE。EXERCISE_ENEMY は戦術演習専用（R-TEX-11）
# exerciseActive: true — EXERCISE_ENEMY のときのみ許可かつ必須（開催中フラグ、表示専用）
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
levelGrowth:
  hp: 255
  attack: 209
  defense: 106
  actionSpeed: 2
extraGaugeMaximum: 7
activeSkillDefinitionIds:
  - SKL_001_AS1
  - SKL_001_AS2
passiveSkillDefinitionIds:
  - SKL_001_PS1
  - SKL_001_PS2
extraSkillDefinitionId: SKL_001_EX
metadata:
  displayName: "【純真無垢なるジーニアス】リディア・エルドリッジ"
  characterName: "リディア・エルドリッジ"
  characterId: CHAR_LYDIA_ELDRIDGE
  affiliations: []
  tags: []
```

### フィールド詳細

| フィールド                      | 型       | 必須 | 制約                                                                           |
| ------------------------------- | -------- | ---- | ------------------------------------------------------------------------------ |
| `unitDefinitionId`              | string   | ✓    | 一意                                                                           |
| `category`                      | enum     |      | `PLAYABLE` / `EXERCISE_ENEMY`。省略時 `PLAYABLE`（R-TEX-11 #1）                |
| `exerciseActive`                | boolean  |      | `EXERCISE_ENEMY` のときのみ許可かつ必須。表示専用の開催中フラグ（R-TEX-11 #4） |
| `attribute`                     | enum     | ✓    | `AGGRESSIVE` / `SHY` / `CUTE` / `SMART` / `COMICAL` / `CLEVER`                 |
| `unitType`                      | enum     | ✓    | `PHYSICAL` / `ENERGY` / `AGILE`                                                |
| `role`                          | enum     | ✓    | `PHYSICAL_ATTACKER` / `EN_ATTACKER` / `TANK` / `SUPPORT` / `CONTROL`           |
| `positionAptitudes`             | enum[]   | ✓    | `FRONT` / `BACK` の1件以上                                                     |
| `baseStats`                     | object   | ✓    | 下表                                                                           |
| `baseStats.maximumHp`           | integer  | ✓    | >= 1                                                                           |
| `baseStats.attack`              | integer  | ✓    | >= 0                                                                           |
| `baseStats.defense`             | integer  | ✓    | >= 0                                                                           |
| `baseStats.criticalRate`        | number   | ✓    | raw の%を割合へ変換                                                            |
| `baseStats.criticalDamageBonus` | number   | ✓    | Catalog作成時は既定値 `0.5`。Unitごとに上書き可                                |
| `baseStats.affinityBonus`       | number   | ✓    | Catalog作成時は既定値 `0.25`。Unitごとに上書き可                               |
| `baseStats.actionSpeed`         | integer  | ✓    | >= 0                                                                           |
| `baseStats.maximumAp`           | integer  | ✓    | >= 1                                                                           |
| `baseStats.maximumPp`           | integer  | ✓    | >= 1                                                                           |
| `levelGrowth`                   | object   |      | 任意。レベル1あたりの成長値（R-ENH-05）。下4行はobject内で必須                 |
| `levelGrowth.hp`                | integer  | ✓    | >= 0                                                                           |
| `levelGrowth.attack`            | integer  | ✓    | >= 0                                                                           |
| `levelGrowth.defense`           | integer  | ✓    | >= 0                                                                           |
| `levelGrowth.actionSpeed`       | integer  | ✓    | >= 0                                                                           |
| `extraGaugeMaximum`             | integer  | ✓    | >= 1。Catalog作成時はEXスキル `cost.amount` と同値で生成                       |
| `activeSkillDefinitionIds`      | string[] | ✓    | AS選択優先順                                                                   |
| `passiveSkillDefinitionIds`     | string[] | ✓    | 0件可。PSタイブレーカー順                                                      |
| `extraSkillDefinitionId`        | string   | ✓    | EXスキル1件                                                                    |
| `metadata`                      | object   | ✓    | 表示、所属、タグ                                                               |

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

### levelGrowth の仮値

成長値の実測データが存在しないため、初期投入では仮値を使用する（Q-ENH-07）。

- `hp`／`attack`／`defense`: 対応する `baseStats` の200レベル値 × 0.9% を四捨五入した整数
- `actionSpeed`: 2（実ゲームではユニットに応じて2または3）

仮値は生成スクリプトで注入せず、`catalog-src/units/<id>/unit.json` へ明示的に保持する。目視確認した実測値でこの実データを直接上書きし、更新の要否をdiffで追跡できるようにする。`levelGrowth` を持たないユニットへ現在レベル200以外を指定したAPIリクエストは、アプリケーション検証で拒否される（R-ENH-05）。

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
metadata:
  displayName: "ジャマしちゃ、めっ……だよ？"
  tags: []
```

### フィールド詳細

| フィールド            | 型                        | 必須 | 制約                            |
| --------------------- | ------------------------- | ---- | ------------------------------- |
| `skillDefinitionId`   | string                    | ✓    | 一意                            |
| `skillType`           | enum                      | ✓    | `AS` / `PS` / `EX`              |
| `cost`                | object                    | ✓    | AS=`AP`, PS=`PP`, EX=`EX_GAUGE` |
| `activationCondition` | ConditionDefinition       | ✓    | Skill使用可否。通常は `TRUE`    |
| `triggers`            | TriggerDefinition[]       | ✓    | PSは1件以上。AS/EXは空配列      |
| `resolution`          | SkillResolutionDefinition | ✓    | 下記                            |
| `cooldown`            | object                    | ✓    | `unit`, `count`                 |
| `traits`              | object                    | ✓    | 先制、同時発動制限、命中、貫通  |
| `metadata`            | object                    | ✓    | `displayName`, `tags`           |

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

| フィールド       | 型                        | 必須 | 制約                                                             |
| ---------------- | ------------------------- | ---- | ---------------------------------------------------------------- |
| `kind`           | enum                      | ✓    | `IMMEDIATE` / `CHARGE`                                           |
| `targetBindings` | TargetBindingDefinition[] | ✓    | 0件可。定義順で束縛する                                          |
| `steps`          | EffectStepDefinition[]    | ✓    | `kind: IMMEDIATE` では1件以上。`kind: CHARGE` では必ず空（下記） |
| `chargeRelease`  | object                    | —    | `kind: CHARGE` の場合必須                                        |

### CHARGE

```yaml
resolution:
  kind: CHARGE
  # 開始側は必ず空。`targetBindings` は activationCondition のスコープとしてだけ意味を持つ
  targetBindings: []
  steps: []
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

`kind: CHARGE` の開始側 EffectSequence（トップレベルの `steps` / `counterUpdates`）は**必ず空**とする。`06_戦闘状態遷移.md`「チャージ開始」#1〜6 と `R-SKL-05` はコスト消費・クールタイム設定・チャージ状態化・`ChargeStarted` 発行・PS解決・行動完了だけを規定し、効果解決の手順を持たない。`resolveChargeStart` も開始側のstepを一つも解決しないため、ここにEffectActionを宣言すると、対応するDomain Event・StateDeltaごと実行時に黙って欠落する。DTOのJSON Schema（`catalog-schema.ts` の `kind` 条件付き `maxItems: 0`）とDomainのfactory（`createResolution`）の両方がロード時点で拒否する（`M7-016`／Issue #270。`counterUpdates` も同じ理由で拒否する）。開始側の `targetBindings` だけは、AS/EX の `activationCondition` が開始側bindingへスコープされるため引き続き意味を持つ。チャージ効果は `chargeRelease` にだけ宣言する。

`CHARGE` 中の「回避と自身のパッシブスキルが使用できない」は、チャージ状態の共通ルール（`R-HIT-02`・`R-HIT-04`・`R-PS-04`）として、チャージ中の所有者に対して常に適用する。制限自体はチャージ状態の有無だけで決まる。

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
| `order`           | TargetOrderEntry[]       | —        | 省略時 `DEFAULT`。文字列（`TargetOrderKey`）とオブジェクト形式が混在できる  |
| `area`            | AreaDefinition           | —        | 範囲指定                                                                    |
| `base`            | TargetReference          | 条件付き | `BINDING_DERIVED` の場合必須                                                |
| `fallback`        | TargetSelectorDefinition | —        | 候補0件時に評価                                                             |
| `includeDefeated` | boolean                  | —        | 省略時 false                                                                |

### order 候補

`order`の各要素は、パラメータを持たない文字列（`TargetOrderKey`）か、`markerId`/`unitType`などパラメータを持つオブジェクト形式（`TargetOrderEntry`のうち`MARKER_COUNT`/`UNIT_TYPE_PRIORITY`）のいずれかで、同じ配列内に混在できる（例: `["FRONT_ROW", "NEAREST", "LEFT_TO_RIGHT"]`、`[{ kind: MARKER_COUNT, markerId: ..., direction: ASC }, "SELF_LOWEST_PRIORITY"]`）。

| 値                       | 意味                                                 |
| ------------------------ | ---------------------------------------------------- |
| `DEFAULT`                | 距離昇順、前列、左列                                 |
| `NEAREST`                | 距離昇順                                             |
| `FARTHEST`               | 距離降順                                             |
| `LOWEST_HP_RATIO`        | HP割合が低い順                                       |
| `HIGHEST_HP_RATIO`       | HP割合が高い順                                       |
| `HIGHEST_ATTACK`         | 攻撃力が高い順                                       |
| `LOWEST_MAX_HP`          | 最大HPが低い順                                       |
| `HIGHEST_MAX_HP`         | 最大HPが高い順                                       |
| `HIGHEST_EX_GAUGE_RATIO` | EXゲージ充填率が高い順                               |
| `FASTEST`                | 行動速度が高い順                                     |
| `FRONT_ROW`              | 前列優先                                             |
| `BACK_ROW`               | 後列優先                                             |
| `LEFT_TO_RIGHT`          | 絶対左から右                                         |
| `SELF_LOWEST_PRIORITY`   | 自身を末尾へ回す（hard excludeではなく自身以外優先） |

| kind（オブジェクト形式） | 追加フィールド                          | 意味                        |
| ------------------------ | --------------------------------------- | --------------------------- |
| `MARKER_COUNT`           | `markerId`, `direction`（`ASC`/`DESC`） | 指定Marker所持数の昇順/降順 |
| `UNIT_TYPE_PRIORITY`     | `unitType`                              | 指定unitTypeの対象を優先    |

### TargetFilterDefinition

```yaml
filters:
  - kind: POSITION_ROW
    row: FRONT
  - kind: UNIT_TYPE
    unitType: PHYSICAL
```

| kind                    | 追加フィールド                | 意味                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSITION_ROW`          | `row`                         | `FRONT` / `BACK`                                                                                                                                                                                                                                                            |
| `POSITION_COLUMN`       | `column`                      | `LEFT` / `CENTER` / `RIGHT`                                                                                                                                                                                                                                                 |
| `POSITION_SLOT`         | `row`, `column`               | 具体位置                                                                                                                                                                                                                                                                    |
| `UNIT_TYPE`             | `unitType`                    | UnitType一致                                                                                                                                                                                                                                                                |
| `ROLE`                  | `role`                        | Role一致                                                                                                                                                                                                                                                                    |
| `ATTRIBUTE`             | `attribute`                   | Attribute一致                                                                                                                                                                                                                                                               |
| `AFFILIATION`           | `affiliationId`               | 所属一致                                                                                                                                                                                                                                                                    |
| `CHARACTER`             | `characterId`                 | キャラクター一致                                                                                                                                                                                                                                                            |
| `HAS_MARKER`            | `markerId`, `countCondition?` | Marker所持（`countCondition`（`op`/`value`）で所持数のしきい値も指定できる）                                                                                                                                                                                                |
| `HP_RATIO`              | `op`, `value`                 | HP割合比較                                                                                                                                                                                                                                                                  |
| `EXCLUDE_RESOLVED_UNIT` | `reference`                   | `reference`（`SELF`/`BINDING`）が指す解決済みユニットを除外する                                                                                                                                                                                                             |
| `MARKER_IN_AREA`        | `area`, `markerId`            | 候補自身を基準にした`area`内に指定Markerの所持者がいるか（`area`は`ADJACENT_ORTHOGONAL`/`DIRECTLY_AHEAD_OF_BASE`/`BEHIND_BASE`/`SAME_ROW_AS_BASE`/`SAME_COLUMN_AS_BASE`の5 kindのみ許可。下記`AreaDefinition`の`SINGLE`/`ALL`/`ROW`/`COLUMN`はCatalogロード時点で拒否する） |
| `AND`                   | `conditions[]`                | 全条件                                                                                                                                                                                                                                                                      |
| `OR`                    | `conditions[]`                | いずれか                                                                                                                                                                                                                                                                    |
| `NOT`                   | `condition`                   | 否定                                                                                                                                                                                                                                                                        |

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

`target-selection-policy.ts`の`applyArea`は、この9 kindのうち`ADJACENT_ORTHOGONAL`/`DIRECTLY_AHEAD_OF_BASE`/`BEHIND_BASE`/`SAME_ROW_AS_BASE`/`SAME_COLUMN_AS_BASE`の5 kindだけを実装する（`SINGLE`/`ALL`/`ROW`/`COLUMN`は未実装で実行時に`DomainValidationError`を投げる）。`TargetFilterDefinition.MARKER_IN_AREA.area`（Issue #169/TGT-002）はこの5 kindだけをCatalogロード時点で許可し、残り4 kindを検証時点で拒否する。`TargetSelectorDefinition.area`（`base`基準の対象範囲）は同じ実行時制約を持つが、Catalogロード時点の検証はまだ実装範囲と揃っていない（production Catalogは実装済みの5 kindしか使用しておらず、現状は未検出のまま残る既存のギャップ）。

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

`condition`に`TARGET_STATE`/`TARGET_HAS_MARKER`を含める場合（Issue #230）、参照する`TargetReference`は高々1体にしか解決できないもの（`SELF`/`TRIGGER_SOURCE`、または`selector.kind: SELECT`かつ`count: 1`の`BINDING`（`fallback`を持つ場合は、再帰的に辿った先すべてが同じ条件を満たす場合だけ））に限る — BRANCHは対象ごとの評価コンテキストを持たないため、複数体に解決されうる参照（`TRIGGER_TARGET`、`count`が`1`以外または`"ALL"`の`BINDING`、`BINDING_DERIVED`、`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`）はCatalogロード時点で拒否する（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`）。対象ごとに絞り込みたい場合はACTIONの`targetCondition`を使う。

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
metadata:
  tags: []
```

### 共通フィールド

| フィールド                 | 型     | 必須 | 制約             |
| -------------------------- | ------ | ---- | ---------------- |
| `effectActionDefinitionId` | string | ✓    | 一意             |
| `kind`                     | enum   | ✓    | 下表             |
| `payload`                  | object | ✓    | kindごとに異なる |
| `metadata`                 | object | ✓    | `tags`           |

### kind 一覧

| kind                       | 概要                                     |
| -------------------------- | ---------------------------------------- |
| `DAMAGE`                   | HP/シールドへダメージ                    |
| `APPLY_PIERCING_MOD`       | 後続の自身の攻撃へ一時的に防御貫通を付与 |
| `HEAL`                     | 即時回復                                 |
| `APPLY_CONTINUOUS_HEAL`    | 行動/ターン時の継続回復                  |
| `APPLY_CONTINUOUS_DAMAGE`  | 行動/ターン時の継続ダメージ（DoT）       |
| `APPLY_STAT_MOD`           | HP/攻撃力/防御力/会心率/速度などの補正   |
| `APPLY_DAMAGE_MOD`         | 与ダメージ/被ダメージ補正                |
| `APPLY_HEALING_MOD`        | 回復量増減                               |
| `APPLY_HEALING_LINK`       | 回復リンク（回復効果の転送）             |
| `MODIFY_RESOURCE`          | AP/PP/EXゲージ増減                       |
| `MODIFY_RESOURCE_CAPACITY` | 最大APなど上限変更                       |
| `APPLY_STATUS`             | 気絶、凍結、暗闇など                     |
| `APPLY_SHIELD`             | シールド付与                             |
| `REMOVE_EFFECTS`           | 効果解除                                 |
| `EFFECT_IMMUNITY`          | 効果付与拒否                             |
| `APPLY_MARKER`             | 固有マーカー付与                         |
| `REMOVE_MARKER`            | 固有マーカー解除                         |
| `APPLY_DEATH_SURVIVAL`     | 致死耐え                                 |
| `APPLY_TARGET_REDIRECT`    | 攻撃引き寄せ                             |
| `APPLY_COVER`              | 肩代わり                                 |
| `APPLY_REFLECT`            | 反射                                     |
| `APPLY_DAMAGE_LINK`        | 継続リンク状態                           |
| `APPLY_SUBUNIT`            | サブユニット                             |
| `COOLDOWN_MANIPULATION`    | 他スキルのクールタイム短縮・リセット     |

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

| フィールド     | 型                | 必須 | 制約                                                                                                                                                     |
| -------------- | ----------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formula`      | FormulaDefinition | ✓    | 回復量。`SKILL_POWER` は `回復者の攻撃力 × power`（R-HEAL-01 #1、防御力は差し引かない）                                                                  |
| `overheal`     | enum              | —    | `DISCARD` 固定で開始                                                                                                                                     |
| `distribution` | enum              | —    | `NONE`（既定、対象ごとに評価結果の全量を回復）／`EVEN`（評価結果を総回復量とみなし、同一EffectStep内でこのEffectActionが適用される対象数で等分）。M7-005 |

`distribution: EVEN` は `MODIFY_RESOURCE.operation: DISTRIBUTE` の HEAL 版であり、「威力65分のHP回復量を均等に配分して回復する」（`SKL_LUCIE_COMPANION_AS3`）のような原文をそのまま表現するために M7-005（Issue #184）で追加した。分配数（分母）は同一EffectStep内でこのEffectAction参照が実際に適用される対象数（同じEffectActionを複数回参照した場合は参照ごとに独立した分配になる）だが、`HEAL` は R-HEAL-01 に蘇生規則が無く戦闘不能の対象を一切回復しないため、`includeDefeated` の有無にかかわらず戦闘不能者を分母から除外する（`MODIFY_RESOURCE.DISTRIBUTE` は明示指定された戦闘不能の対象へ実際に適用するため分母に残す点だけが異なる）。

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

M7-005（Issue #184、R-HEAL-03）で実装したのは `timing: {eventType: ActionStarted, targetSelector: EFFECT_OWNER}`（保持者自身の行動開始時に保持者を回復する）だけであり、production Catalogの継続回復定義はすべてこの組み合わせを使う。それ以外の組み合わせは `CAP_CONTINUOUS_HEAL` が `IMPLEMENTED` でも一度も発火しないため、Catalogロード時点で `UNSUPPORTED_CONTINUOUS_HEAL_TIMING` として拒否する（`APPLY_MARKER` の未対応 `duration` と同じ扱い）。

### APPLY_CONTINUOUS_DAMAGE

Issue #44 G-02。`APPLY_CONTINUOUS_HEAL` の DAMAGE 方向の対になる kind。継続ダメージ（DoT、炎上など）を表す。

```yaml
kind: APPLY_CONTINUOUS_DAMAGE
payload:
  continuousDamageKind: BURN
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

| フィールド             | 型                 | 必須 | 制約                                                                                               |
| ---------------------- | ------------------ | ---- | -------------------------------------------------------------------------------------------------- |
| `continuousDamageKind` | enum               | ✓    | `FIXED` / `BURN` / `POISON`                                                                        |
| `damageType`           | enum               | ✓    | `PHYSICAL` / `EN`                                                                                  |
| `formula`              | FormulaDefinition  | ✓    | 行動時に発生させるダメージ量                                                                       |
| `timing`               | object             | ✓    | `APPLY_CONTINUOUS_HEAL` と同じ形式                                                                 |
| `duration`             | DurationDefinition | ✓    | ダメージそのものの `hitCount` / `link` は持たず、`DAMAGE` の subset として通常ダメージ処理に載せる |

`continuousDamageKind`（`DMG-008`／Issue #189、`R-DOT-02`〜`R-DOT-04`）は継続ダメージの種別を表す。同じ `APPLY_CONTINUOUS_DAMAGE` でも算出式・重複規則・シールド適用可否が種別ごとに異なるため、Catalog側で判別できる必要がある。

- `FIXED`（`R-DOT-02` 固定継続ダメージ）: スナップショット攻撃力と効果定義の倍率から固定ダメージを算出し、対応するタイプありシールド→タイプなしシールド→HPの順で適用する。
- `BURN`（`R-DOT-03` 炎上）: `FIXED` と同じ固定ダメージ算出に、種別単位で最大3つまでの重複と「3つ保持時は各インスタンスのダメージをそれぞれ2倍」が加わる。上限到達時の付与は `EffectActionCompleted.resultKind: SKIPPED` になる。
- `POISON`（`R-DOT-04` 毒）: `現在HP × 効果率` を `付与時攻撃力 × 100%` で上限した割合ダメージ。再付与は既存インスタンスへ統合する（`EffectMerged`）。

省略時の既定値は置かない（必須fieldとする）— 既定値があると「炎上として書いたつもりの定義が固定継続ダメージとして黙って別規則で解決される」近似が復活するためである。`BURN` と `POISON` はシールドとサブユニットで受けない（`R-SUB-01`／`R-LNK-02`）。

`timing` は `APPLY_CONTINUOUS_HEAL` と同じく `{eventType: ActionStarted, targetSelector: EFFECT_OWNER}` だけを実装する（`R-DOT-01`「付与対象の行動開始時に発生する」）。それ以外の組み合わせは一度も発火しないため、Catalogロード時点で `UNSUPPORTED_CONTINUOUS_DAMAGE_TIMING` として拒否する。

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

| フィールド  | 型                 | 必須 | 制約                                                              |
| ----------- | ------------------ | ---- | ----------------------------------------------------------------- |
| `stat`      | enum               | ✓    | 下記の `stat` 候補                                                |
| `valueType` | enum               | ✓    | `RATIO` / `FIXED`                                                 |
| `formula`   | FormulaDefinition  | ✓    | 符号付き。増加は正、減少は負                                      |
| `stacking`  | object             | ✓    | `mode`（`STACKABLE` / `NON_STACKABLE`）と任意の `max`。詳細は下記 |
| `duration`  | DurationDefinition | ✓    | —                                                                 |

`stacking.mode`（`R-EFF-05` / `R-STA-03`、`M7-012`／Issue #266）:

- `STACKABLE`（重複あり）は保持している全インスタンスを合成する。
- `NON_STACKABLE`（重複なし）は同じ `EffectKindKey` のグループ内で最も強い1件だけを合成する。
- `NON_STACKABLE` は `APPLY_STAT_MOD` だけが宣言できる。他の `stacking` 保持kind（`APPLY_DAMAGE_MOD`・`APPLY_HEALING_MOD`・`APPLY_RESOURCE_GAIN_MOD`）は合成経路が全インスタンスの合算だけを実装しており、受理しても何も変わらない「受理されるが効かない定義」になるため、Mapperは引き続き `STACKABLE` のみを許可する。

`stacking.max`（重複上限、`APPLY_MARKER` の `stack.max` に対応、`APPLY_STAT_MOD` 専用）:

- 1以上の整数、または `null`（上限なし）。省略時は `null`。
- 対象が同じ `EffectKindKey` のインスタンスを `max` 件保持している場合、それ以上の付与を行わない（`EffectApplied` を発行せず、`EffectActionCompleted.resultKind` は `SKIPPED` になる）。
- production例は `ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`（`max: 14`）。Marker「負けん気」の `stack.max: 14` と1対1で対応する攻撃力バフである。

```yaml
stacking:
  mode: STACKABLE
  max: 14
```

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

| フィールド        | 型                        | 制約                                                                   |
| ----------------- | ------------------------- | ---------------------------------------------------------------------- |
| `direction`       | enum                      | `OUTGOING` / `INCOMING`                                                |
| `damageType`      | enum/null                 | `PHYSICAL` / `EN` / null                                               |
| `formula`         | FormulaDefinition         | 符号付き。増加は正、減少は負                                           |
| `condition`       | DamageModCondition/省略可 | ヒットごとに評価する動的条件（`DMG-002`）                              |
| `damageThreshold` | DamageThreshold/省略可    | 入射ダメージ閾値（`R-DMG-07`）。`direction: INCOMING` でだけ宣言できる |
| `consumption`     | ConsumptionDefinition     | 次の攻撃など                                                           |

#### `condition`（`DMG-002`／Issue #192）

補正が「どの攻撃に対して成立するか」を、付与時点ではなく**R-DMG-04の集計時点（ヒットごと）**に評価する条件。省略時は無条件。

参照できるユニットは、そのヒットの2体だけに限る。`EffectStep` の `ConditionDefinition` が使う `TargetReference`（`BINDING`／`TRIGGER_SOURCE` など）は、補正が付与された後の無関係なスキル解決中には原理的に解決できないため、専用の2値を使う。

| `unit` の値    | 意味                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `EFFECT_OWNER` | 補正を保持しているユニット（`INCOMING`なら防御側、`OUTGOING`なら攻撃側） |
| `OPPONENT`     | そのヒットの相手（`INCOMING`なら攻撃側、`OUTGOING`なら攻撃対象）         |

| `kind`                | フィールド                            | 意味                                                      |
| --------------------- | ------------------------------------- | --------------------------------------------------------- |
| `TRUE`                | —                                     | 常に成立                                                  |
| `AND` / `OR`          | `conditions[]`                        | 論理合成（非空）                                          |
| `NOT`                 | `condition`                           | 否定                                                      |
| `UNIT_STATE`          | `unit`, `field`, `op`, `value`        | 指定ユニットの状態比較                                    |
| `UNIT_HAS_MARKER`     | `unit`, `markerId`, `countCondition?` | 指定ユニットのMarker所持（`countCondition`省略で1つ以上） |
| `HP_RATIO_COMPARISON` | `left`, `op`, `right`                 | 2体のHP割合同士の比較                                     |

`UNIT_STATE.field` は `TARGET_STATE.field` の部分集合（`IS_ALIVE` / `HP_RATIO` / `ATTRIBUTE` / `POSITION_ROW` / `POSITION_COLUMN` / `RESOURCE_AP` / `RESOURCE_PP` / `RESOURCE_EX_GAUGE`）とする。ダメージ解決時点（`domain/battle/combat`）ではCatalogの `unitDefinitions` を引けないため、`UNIT_TYPE` / `ROLE` と、状態異常追跡を要する `HAS_STATUS` は受理しない（受理しても評価できない「効かない定義」を作らないため）。

```yaml
kind: APPLY_DAMAGE_MOD
payload:
  direction: INCOMING
  damageType: null
  formula: { kind: CONSTANT, value: -0.3 }
  condition:
    kind: UNIT_STATE
    unit: EFFECT_OWNER
    field: HP_RATIO
    op: GTE
    value: 0.65
  stacking: { mode: STACKABLE }
  duration:
    timeLimit: { unit: BATTLE, count: 1 }
```

production例:

- `SKL_KEI_JACKKNIFE_PS1`「自身のHPが最大HPの65%以上の場合にのみ被ダメージを30%減少」→ 上のYAMLそのもの
- `SKL_AOI_ELEGANT_PS2`／`SKL_OLGA_VETERAN_AS2`「Xを所持している敵から受ける攻撃の被ダメージを減少」→ `UNIT_HAS_MARKER` + `unit: OPPONENT`
- `SKL_JULIE_SNOW_PS1`「自分よりもHP割合が高い相手から攻撃された場合にのみ」→ `HP_RATIO_COMPARISON` `left: OPPONENT`, `op: GT`, `right: EFFECT_OWNER`
- `SKL_KOTOHA_REBEL_PS2`「対象のHP割合が自身より低い敵に対してのみ与ダメージが10%増加」→ `HP_RATIO_COMPARISON` `left: OPPONENT`, `op: LT`, `right: EFFECT_OWNER`

#### `damageThreshold`（`R-DMG-07`）

「現在HPのX%を**超える**ダメージのみ軽減する」のような、入射ダメージの大きさで適用可否が決まる被ダメージ補正を表す。構造・比較演算子は `APPLY_STATUS` の [`damageThreshold`](#damagethreshold) と同じで、`formula` の評価対象は補正の保持者自身（`source: TARGET` が保持者=被弾側を指す）。判定素材・合成・消費の規則は `R-DMG-07` を正本とする。

- `direction: OUTGOING` への宣言はCatalogロード時に拒否する — 判定素材の「確定した入射ダメージ」は被弾側のヒットにしか存在しない。
- この補正は `R-DMG-04` の通常合成に参加せず、`DamageCalculated` の `incomingDamageMultiplier` にも現れない（`finalDamage` が軽減後の値を持つ）。
- `duration.consumption {kind: INCOMING_HIT}` と組み合わせた場合、消費は軽減を実際に適用したヒットでだけ起きる（`R-DMG-07` #6）。

```yaml
kind: APPLY_DAMAGE_MOD
payload:
  direction: INCOMING
  damageType: null
  formula: { kind: CONSTANT, value: -0.5 }
  damageThreshold:
    op: GT
    formula: { kind: CURRENT_HP_RATIO, source: { kind: TARGET }, ratio: 0.2 }
  stacking: { mode: STACKABLE }
  duration:
    timeLimit: { unit: BATTLE, count: 1 }
    consumption: { kind: INCOMING_HIT, maxCount: 3 }
```

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

### APPLY_HEALING_LINK

`M7-005-HEAL-LINK`（Issue #229、R-HEAL-04）。保持者が得られる回復効果を、指定した割合だけ転送先へ移し替える継続効果（`AppliedEffect`）。production例は `SKL_ELENA_MOODMAKER_AS1`（私に任せて！）の「対象が得られる回復効果を100%自身に転送する」。`APPLY_DAMAGE_LINK`（`CAP_DAMAGE_LINK_STATE`、M8）とは方向（回復／被ダメージ）も配分規則（転送＝移し替え／リンク＝同量を追加発生）も異なる別kindである。

```yaml
kind: APPLY_HEALING_LINK
payload:
  transferTo:
    kind: SELF
  transferRate: 1
  duration:
    timeLimit:
      unit: ACTION
      count: 1
      owner: EFFECT_SOURCE
    dispellable: true
```

| フィールド     | 型                 | 必須 | 制約                                                                                                                   |
| -------------- | ------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `transferTo`   | TargetReference    | ✓    | 転送先。付与時点に解決して当該インスタンスへ固定する。実装済みは `SELF`（付与者自身）のみ                              |
| `transferRate` | number             | ✓    | 転送率。`0` 以上 `1` 以下。`1` が原文の「100%転送」                                                                    |
| `duration`     | DurationDefinition | ✓    | 「自身が1回行動を終えるまでの間」は `{unit: ACTION, count: 1, owner: EFFECT_SOURCE}`（R-EFF-04、既存の同一原文と同じ） |

`transferTo` はスキーマ上 `TargetReference` の全kindを取れるが、`heal-application-service.ts` が転送先として解決できるのは付与時点に確定する `SELF` だけである。`TRIGGER_SOURCE`/`TRIGGER_TARGET`/`BINDING`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS` は「付与は成功するが転送先が決まらない」silent partial implementationになるため、`APPLY_CONTINUOUS_HEAL` の未対応 `timing` と同じくCatalogロード時点で `UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET` として拒否する。

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

| フィールド | 型                 | 制約                                                                                                                                                                                                     |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource` | enum               | `AP` / `PP` / `EX_GAUGE` / `HP`。`HP`はM7-002（Issue #185、HP_DIRECT_COST）で追加し、防御力・会心などの通常ダメージ処理を経由せずHPを直接増減する                                                        |
| `bounds`   | object（optional） | `min`/`max`はCatalog作成者が任意の有限値を指定できるが、実行側は常に対象リソースの実際の可動域`0..currentMax`と交差させてから適用する（範囲外や空区間の指定でも実行時例外にはならず、静かにclampされる） |

| operation    | 意味                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADD`        | 現在値へ加算。減算は負値                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SET`        | 指定値にする                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SET_TO_MAX` | 最大値にする                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DISTRIBUTE` | 対象間で分配（M7-017／Issue #271で実装）。`formula`の評価結果は対象ごとの適用量ではなく**総量**であり、同一EffectStep内でこのEffectAction**参照**が実際に適用される対象数で等分した取り分を`ADD`と同じ規約で加算する（R-ACTN-02、端数は対象ごとに切り捨て＝R-NUM-02、余りは破棄）。同じEffectActionを1つのACTION stepから複数回参照した場合（R-SKL-06 #4）は各参照が独立に総量を分配する。`HEAL`の`distribution: EVEN`のリソース版。 |

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

| フィールド  | 型                 | 制約                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource`  | enum               | `AP` / `PP` / `EX_GAUGE` / `HP`。Mapperは`MODIFY_RESOURCE`と同じ共通`ResourceKind`（`HP`含む）を受理する。M7-002A（Issue #255）のEngine実装もこの4種すべてを対象にした — `AP`/`PP`/`EX_GAUGE`は`BattleUnit`のゲージ最大値を、`HP`は`MAXIMUM_HP`戦闘中ステータス（HPゲージの上限そのもの）を変更する |
| `operation` | enum               | `ADD` / `SET`。`SET_TO_MAX` と `DISTRIBUTE` は上限変更に意味を持たないため許可しない。有効な`SET`が複数ある場合は付与順で後のものが基準を置き換え、`ADD`はその結果へ合算する（R-ACTN-03）                                                                                                           |
| `formula`   | FormulaDefinition  | 変更量。`APPLY_STAT_MOD`と同じ評価規約で付与時点に一度だけ評価する                                                                                                                                                                                                                                  |
| `duration`  | DurationDefinition | 恒久的な上限変更は `timeLimit.unit: BATTLE, count: 1, dispellable: false` で表す                                                                                                                                                                                                                    |

### APPLY_RESOURCE_GAIN_MOD

G-05（Issue #44、実装: M7-002/Issue #185）。リソース「獲得量」自体（R-ACT-03のAP/PP消費起因のEXゲージ増加）を一定期間割合で増減させる継続効果。`APPLY_STAT_MOD`と同じ評価規約で`rateDelta`を付与時点に一度だけ評価し、結果を符号付き倍率として`AppliedEffect.magnitude`へ保持する。

```yaml
kind: APPLY_RESOURCE_GAIN_MOD
payload:
  resource: EX_GAUGE
  rateDelta:
    kind: CONSTANT
    value: -0.5
  stacking:
    mode: STACKABLE
  duration:
    dispellable: true
```

| フィールド  | 型                 | 制約                                                                                                                                                                                         |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource`  | enum               | `EX_GAUGE`固定。合成経路（`composeResourceGainRate`／`increaseExGauge`呼び出し側）がEXゲージ増加だけを対象にするため、AP/PP/HPは受理しない（獲得イベント自体が存在せず合成先を持たないため） |
| `rateDelta` | FormulaDefinition  | 符号付き倍率（例: `+0.5`＝+50%）。付与時点で一度だけ評価する                                                                                                                                 |
| `stacking`  | object             | `STACKABLE`のみ許可。保持している全インスタンスの`rateDelta`を合算する（重複なしグループの最強選択は不要）                                                                                   |
| `duration`  | DurationDefinition | —                                                                                                                                                                                            |

`MODIFY_RESOURCE`の一回限りの加減算には適用しない。合成後の倍率は下限を持たない（`-50%`のModifierを3個以上重ねると`-150%`のように`-100%`を下回りうる。R-FRM-03は同一UnitDefinitionの複数編成を許可するためproduction Catalogでも到達可能）が、`increaseExGauge`（`action-resolution-shared.ts`）は`amount * (1 + rate)`の結果を0で floor してから適用するため、既存のEXゲージを減少させることはない（獲得量が0になるだけ）。

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
- `CONFUSION`
- `DAMAGE_TO_HEAL`

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

回避は `APPLY_STATUS` の `EVASION` / `HIT_EVASION` として表す。両者は同じ「特別な回避効果」であり、判定（R-HIT-02）もヒット数の消費（R-HIT-04）も同一に扱う。確率と対象攻撃種別は status payload に、ヒット数制限は `duration.consumption`（`kind: INCOMING_HIT`、`maxCount` がヒット数）に保持する。

必中は `APPLY_STATUS` の `GUARANTEED_HIT` として表す（R-HIT-05）。保持者の攻撃を、攻撃側定義の `accuracy.mode` に関わらず必中として扱う。被効果側の絞り込み（`appliesTo`）やダメージ側のfield（`damageThreshold`/`damageAmplificationOnBreak`）は解釈しない — 指定された定義はCatalogロードではなくresolverが明示的に拒否する。

混乱・幻惑は `APPLY_STATUS` の `CONFUSION` / `DAMAGE_TO_HEAL` として表す（R-CFS-01／R-CFS-02／R-DTH-01、`DMG-009`／Issue #193）。どちらも**保持者の攻撃**に働き、数値は専用の宣言に保持する。`CONFUSION` は `confusion` を、`DAMAGE_TO_HEAL` は `damageToHeal` を必須とし、対応しない `status` へ宣言するとCatalogロード時点で拒否する（既定値でfallbackすると「混乱しているのにダメージが変わらない」近似へ黙って退行するため）。被効果側の絞り込み（`appliesTo`）・ダメージ側のfield（`damageThreshold`/`damageAmplificationOnBreak`）・1未満の `probability` はいずれも解釈しないため、指定された定義はresolverが明示的に拒否する。解除カテゴリはどちらも `DEBUFF` だけで `STATUS` は付かない — `戦闘システム.md`「3. 状態異常について」が列挙する定義済み状態異常に混乱・幻惑は含まれないためである（`CRITICAL_PREVENTION` と同じ扱い）。

```yaml
kind: APPLY_STATUS
payload:
  status: CONFUSION
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
  confusion:
    damageReductionRate: 0.3
    lowAttackBaseDamageRate: 0.1
```

| フィールド                | 型     | 制約                                                                                                                |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `damageReductionRate`     | number | `[0, 1]`。混乱倍率が `1 - damageReductionRate` になる（R-CFS-02）。raw原文「この際のダメージは30%減少する」＝ `0.3` |
| `lowAttackBaseDamageRate` | number | `[0, 1]`。攻撃力が実効防御力以下のとき基礎ダメージへ使う攻撃力の割合。raw原文「攻撃力×10%の値を使用し」＝ `0.1`     |

```yaml
kind: APPLY_STATUS
payload:
  status: DAMAGE_TO_HEAL
  duration:
    timeLimit:
      unit: ACTION
      count: 1
    dispellable: true
  damageToHeal:
    healRate: 0.7
```

| フィールド | 型     | 制約                                                                                       |
| ---------- | ------ | ------------------------------------------------------------------------------------------ |
| `healRate` | number | 0以上。本来のダメージ量に対する回復量の割合。raw原文「本来ダメージ値の70％となる」＝ `0.7` |

会心保証・会心不可は `APPLY_STATUS` の `CRITICAL_GUARANTEE` / `CRITICAL_PREVENTION` として表す（R-CRT-03）。`GUARANTEED_HIT` と同じく**保持者の攻撃**に働き、攻撃側定義の `critical.mode` に関わらずその攻撃を会心確定／会心不可として扱う（防御側が保持していても、その対象へ向かう攻撃の会心は変わらない）。両方を保持する場合は会心不可が勝つ。解除カテゴリは会心保証が `BUFF`、会心不可が `DEBUFF`（定義済みの状態異常ではないため `STATUS` は付かない）。被効果側の絞り込み（`appliesTo`）・ダメージ側のfield（`damageThreshold`/`damageAmplificationOnBreak`）・1未満の `probability` はいずれも解釈しないため、指定された定義はresolverが明示的に拒否する。

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

| フィールド                  | 型                 | 制約                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories`                | enum[]             | `BUFF` / `DEBUFF` / `STATUS` / `MARKER` / `DAMAGE_MOD` / `SHIELD` / `SUBUNIT` / `SPECIFIC_EFFECT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `effectActionDefinitionIds` | string[]           | `SPECIFIC_EFFECT` の場合に対象IDを指定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `statusKinds`               | StatusKind[]       | `categories` が `STATUS` を含む場合だけ指定可能。省略時は `STATUS` カテゴリ全体（状態異常すべて）が対象。指定した場合はその状態異常種別だけへ免疫を絞り込む（M7-001B、Issue #243、`EFFECT_IMMUNITY_STATUS_GRANULARITY`、R-EFF-03、`CAP_SPECIFIC_IMMUNITY`）。値は`StatusKind`全体ではなく`STUN`/`FREEZE`/`BLIND`（R-STS-01により実行時に`STATUS`カテゴリへ分類される状態異常だけ、`effect-action-payload.ts`の`STATUS_AILMENT_KINDS`）に限る — `STEALTH`等それ以外を指定すると実行時の`STATUS`分類に一致せず免疫が無効になるため、Catalogロード時点で拒否する。`categories` が `STATUS` を含まない場合に指定するとCatalogロード時点で拒否する |
| `duration`                  | DurationDefinition | 省略時は即時効果として不正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `maxBlocks`                 | integer/null       | null = 期間中は上限なし                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`EFFECT_IMMUNITY` により付与を拒否した場合は `EffectApplicationRejected` を発行する（`08_ドメインイベント.md`「EffectApplicationRejected payload」）。

### REMOVE_EFFECTS

Issue #44 G-04。`EFFECT_IMMUNITY` が将来の付与を一定期間ブロックするのに対し、`REMOVE_EFFECTS` は即時効果として、対象がその時点で保持している効果を解除する。「どの種類の効果を対象にするか」は同じ分類軸のため `categories` 列挙を `EFFECT_IMMUNITY` と共有する。

```yaml
kind: REMOVE_EFFECTS
payload:
  categories:
    - DEBUFF
```

| フィールド                  | 型       | 制約                                                                                                                        |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `categories`                | enum[]   | `BUFF` / `DEBUFF` / `STATUS` / `DAMAGE_MOD` / `SHIELD` / `SUBUNIT` / `SPECIFIC_EFFECT`。1件以上（`MARKER`は不可、下記参照） |
| `effectActionDefinitionIds` | string[] | `SPECIFIC_EFFECT` の場合に対象IDを指定                                                                                      |
| `maxRemovals`               | integer? | 解除件数の上限（M7-001、`REMOVE_EFFECTS_COUNT_LIMIT`）。省略時は該当カテゴリの全件を解除する。1以上                         |

`duration` を持たない即時効果である点が `EFFECT_IMMUNITY` との違い。`Marker` の解除は `REMOVE_EFFECTS` の `categories` ではなく既存の `REMOVE_MARKER`（`markerId` 指定。M7-001で `count?`（解除スタック数の上限、省略時は全スタック解除）を追加）を使う。`REMOVE_EFFECTS` は `AppliedEffect` のみを走査するため、`categories` に `MARKER` を指定すると黙って no-op になる。これを避けるため、`REMOVE_EFFECTS` の `categories` は `MARKER` をCatalogロード時点で拒否する（`MARKER` は `EFFECT_IMMUNITY` 専用）。

M7-001（Issue #181）で `BUFF`（`REMOVE_BUFF_CATEGORY`）・`SHIELD`・`SUBUNIT`（`REMOVE_EFFECTS_CATEGORY_GAP`）を `categories` へ追加した。バフ/デバフ判定は R-EFF-05「バフは正の効果量、デバフは弱化量」に従い符号付き効果量から導き、状態異常（`STATUS`）は R-STS-01 により `DEBUFF` も兼ねる（`effect-category-classifier.ts`）。解除優先順が定義されていない場合の既定は付与順の古い順とする（R-EFF-02 #3）。

`SHIELD` は DMG-004（Issue #194）が `CAP_SHIELD` を、`SUBUNIT` は DMG-005（Issue #190）が `CAP_SUBUNIT` を `IMPLEMENTED` にしたため、どちらも実行時状態を持つ（`AppliedEffect.shield` / `AppliedEffect.subUnit`）。これを受けて M7-001A（Issue #242）が `effect-action-group-resolver.ts` の実行時拒否を解除し、両カテゴリは他のカテゴリと同じ `removeEffects` 経路でインスタンスごと解除される（シールドプールもサブユニット耐久力もインスタンス集合からの導出値のため、インスタンス除去がそのまま解除になる）。`MARKER` を `categories` に含める `REMOVE_EFFECTS`（直前の段落）だけはCatalogロード時点で拒否する。`MARKER` は `REMOVE_EFFECTS` が走査する `AppliedEffect` に原理的に含まれない（`MarkerState` は別モデル）ため、どれだけ実装が進んでも黙って no-op になる恒久的な誤りだからである。

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

`DMG-006`（Issue #188、`R-INT-01` #5）で実行時へ配線した。実装するのは `trigger.lethalDamageOnly: true` だけであり（致死耐えはHPへ適用する量が確定した時点でのみ成立する）、`false` は `UNSUPPORTED_DEFENSIVE_INTERVENTION` としてCatalogロード時点で拒否する。`survivalHp`／`healAfterSurvival` は付与時点ではなく耐えた時点で評価する（`MAX_HP_RATIO` が耐えた時点の最大HPを参照するため）。

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

`DMG-006`（Issue #188、`R-INT-01` #1）で実行時へ配線した。この効果は**攻撃側**が保持し（production定義の付与対象はいずれも `TRIGGER_SOURCE`、raw原文「攻撃してくる敵単体に対して…攻撃を自身に引き寄せ」）、`redirectTo` は付与時点で解決して効果インスタンスへ焼き込む。そのため実装するのは付与時点に確定する `SELF` だけであり、他の `kind` は `UNSUPPORTED_DEFENSIVE_INTERVENTION` としてCatalogロード時点で拒否する（`APPLY_HEALING_LINK.transferTo` と同じ制限）。

`appliesTo.actionKinds` も実装するのは `["DAMAGE"]` だけである。`R-INT-01` が介入の評価点として定めるのは `DamageWillBeApplied` の後だけで、デバフ付与のライフサイクルには介入の評価点自体が無いため、`DEBUFF` を含む宣言は「`EffectApplied` としては成功するが一度も作用しない」silent no-opになる（`ANY` も同じ理由で `DAMAGE` 以外には作用しない）。同じく `UNSUPPORTED_DEFENSIVE_INTERVENTION` として拒否し、デバフ側へ配線した時点で解除する。

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

`DMG-006`（Issue #188、`R-INT-01` #2／`R-INT-02`）で実行時へ配線した。`APPLY_TARGET_REDIRECT` と同じく攻撃側が保持し、`coverer` は付与時点で解決するため実装するのは `SELF` だけ、`appliesTo.actionKinds` も同じ理由で `["DAMAGE"]` だけである。`damageShareRate` も実装するのは `1`（`R-INT-02` 第1項「防御側を肩代わり者へ変更する」）だけで、1未満は1ヒットのダメージを2体へ分割適用することになり `R-INT-02` が規定しない。どちらも外れる定義は `UNSUPPORTED_DEFENSIVE_INTERVENTION` としてCatalogロード時点で拒否する。`guardRate` は最終切り捨ての前に掛ける（`Q-DMG-01`）ため、肩代わり者が redirect 後の対象自身であっても軽減だけは成立する（`ACT_EVIE_ECO_PS1_COVER`）。

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

`DMG-006`（Issue #188、`R-INT-01` #4／`R-INT-03`）で実行時へ配線した。引き寄せ・肩代わりと違い、この効果は**防御側**（反射する側）が保持する。実装するのは `reflectTo: TRIGGER_SOURCE`（元ダメージの攻撃者）と `allowRecursiveReflect: false`（`R-INT-03` 第2項「反射からさらに反射を発生させない」）だけで、それ以外は `UNSUPPORTED_DEFENSIVE_INTERVENTION` としてCatalogロード時点で拒否する。`formula` は反射時点に評価し（production例は `DAMAGE_RECEIVED_RATIO`／`LAST_DAMAGE_RECEIVED` の75%）、`R-DMG-02` の切り捨て・最低1ダメージだけを適用する。

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

| フィールド   | 型                      | 制約                                                             |
| ------------ | ----------------------- | ---------------------------------------------------------------- |
| `formula`    | FormulaDefinition       | シールド量。R-NUM-02により付与直前に切り捨てて整数化する         |
| `duration`   | DurationDefinition      | シールドの残量が尽きる前でも失効しうる（`timeLimit` 経過で消滅） |
| `shieldType` | enum（`PHYSICAL`/`EN`） | 省略時はタイプなしシールド。DMG-004（Issue #194）で追加          |
| `decay`      | ShieldDecayDefinition   | 省略時は漸減しない。DMG-004（Issue #194）で追加                  |

#### shieldType（DMG-004、Issue #194）

R-SHD-01 のタイプ別プールを表す。`PHYSICAL`/`EN` を指定したシールドは同じダメージタイプのヒットだけを吸収し（R-SHD-02「対応しないタイプありシールドへダメージを適用しない」）、省略した場合はあらゆるダメージタイプを吸収するタイプなしシールドになる。production Catalog でタイプを明示するのは `ACT_LILY_SINGER_PS2_SHIELD`（raw原文「ENシールド」）だけである。

#### ShieldDecayDefinition（`SHIELD_DECAY_OVER_TIME`、DMG-004、Issue #194）

```yaml
decay:
  unit: ACTION
  ratio: 0.25
  owner: EFFECT_TARGET # 省略可
```

| フィールド | 型                                       | 制約                                                                       |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `unit`     | enum（`ACTION` のみ）                    | 現状 `ACTION` だけを許可する                                               |
| `ratio`    | number                                   | `0 < ratio <= 1`。**付与時最大値**に対する1行動あたりの減少割合            |
| `owner`    | enum（`DurationTimeLimit.owner` と同じ） | 省略時 `EFFECT_TARGET`。「誰の行動で減らすか」を R-EFF-04 と同じ規約で解決 |

raw原文の例は `SKL_SHIRANA_LUCKY_EX`（薄暮の宵火）「シールドは1行動に付き最大値の25%減少する」。基準はその時点の残量ではなく付与時最大値であるため等差で減り、`ratio: 0.25` なら4行動でちょうど枯渇する。減少そのものは `ShieldConsumed`（`reason: DECAY`）として記録し、0になったインスタンスは `EffectExpired`（`reason: SHIELD_DEPLETED`）で失効する — 失効経路は時間制限（`TIME_LIMIT`）と共有するため、R-EFF-09 の `linkedEffectGroupId` カスケードと CombatStat 再計算も同じ振る舞いになる。

### APPLY_DAMAGE_LINK

`DMG-007`（Issue #187、R-INT-01 #3・R-LNK-01〜03）。保持者が**受けた**ダメージと同じ量（`linkRate` の割合）を `linkTo` へ追加で発生させる継続効果（`AppliedEffect`）。`APPLY_HEALING_LINK`（回復リンク）とは方向も配分規則も異なる別kindである — 回復リンクは保持者の回復量を転送先へ**移し替える**のに対し、ダメージリンクは元ダメージをそのまま残したうえでリンク先へ**追加で発生**させる。

```yaml
kind: APPLY_DAMAGE_LINK
payload:
  linkTo:
    kind: SELF
  linkRate: 0.5
  polarity: BUFF
  duration:
    timeLimit:
      unit: ACTION
      count: 2
      owner: EFFECT_SOURCE
    dispellable: false
```

| フィールド | 型                 | 制約                                         |
| ---------- | ------------------ | -------------------------------------------- |
| `linkTo`   | TargetReference    | 実装済みは `SELF`（付与者自身）と `BINDING`  |
| `linkRate` | number             | `0`以上`1`以下。`1` が `R-LNK-02` の「同量」 |
| `polarity` | enum               | `BUFF` / `DEBUFF`。省略不可                  |
| `duration` | DurationDefinition | —                                            |

`polarity` が必須なのは、ダメージリンクが**同じkindのまま両向きに使われる**唯一の防御介入だからである。`APPLY_TARGET_REDIRECT`／`APPLY_COVER`（常に `DEBUFF`）や `APPLY_REFLECT`（常に `BUFF`）と違い、`ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK` は保持者（榊千鶴自身）の被ダメージを敵へ送るため保持者を利し、`ACT_DOROTHEA_PIONEER_PS1_LINK_TO_*` は敵2体へ付与して互いの被ダメージを増やす。`linkRate` は常に正のため `magnitude` の符号からは導けず、既定値を置くと向きを書き忘れた定義が黙って逆向きに分類され、`EFFECT_IMMUNITY` の拒否・`REMOVE_EFFECTS` の解除・`TARGET_HAS_EFFECT` の照会がすべて反対に働く（`APPLY_CONTINUOUS_DAMAGE.continuousDamageKind` と同じ「既定値を置かない」方針）。実データでは自陣・自身へ付与するリンクが `BUFF`、敵へ付与するリンクが `DEBUFF` になる。

保持者と付与者が別のユニットになるリンクでは `timeLimit.owner` に注意する。既定は `EFFECT_TARGET`（保持者自身の行動で減る）であり、`ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK` のように味方全体へ付与しつつ付与者側の効果（2枚目のシールド）と同時に消滅させたい場合は、`owner: EFFECT_SOURCE` を明示して**親と同じ時計**へ揃える必要がある。省略すると素早い味方のリンクだけが親より先に失効する。

`linkTo` は付与時点に解決して `AppliedEffect.damageLink.linkToUnitId` へ焼き込む（`APPLY_HEALING_LINK.transferTo` と同じ「付与時snapshot」規約 — ダメージ適用時点にはTargetBindingもトリガーcontextも残っていない）。したがって実装済みなのは付与時点に高々1体へ確定できる参照だけである。

- `SELF`: 付与者自身。production 例は `ACT_SUIRAN_CASINO_AS1_DAMAGE_LINK`（味方が受けたダメージの50%を劉翠蘭自身へ）
- `BINDING`: **この効果アクションを使う EffectSequence** が宣言し、高々1体へ解決する TargetBinding。production 例は `ACT_DOROTHEA_PIONEER_PS1_LINK_TO_FARTHEST`／`ACT_DOROTHEA_PIONEER_PS1_LINK_TO_NEAREST`（互いを指す35%の相互リンク）と `ACT_CHIZURU_DOMESTIC_PS1_DAMAGE_LINK`（保持者は自身、リンク先は攻撃対象）

他のkindは `UNSUPPORTED_DEFENSIVE_INTERVENTION`、宣言のない（または複数体へ解決しうる）bindingを指す `BINDING` は `DAMAGE_LINK_UNBOUNDED_BINDING` として Catalog ロード時点で拒否する。`EffectActionDefinition` は自分の使われ方を知らないため、後者の検証は Skill／Memory 側から行う（`ACTIVATION_CONDITION_UNBOUNDED_REFERENCE` と同じ扱い）。

「元効果の消滅と同時にリンクも消滅する」（`SKL_SUIRAN_CASINO_AS1` の「2枚目の消滅と同時にダメージリンクも消滅する」）は `duration.linkedEffectGroupId`／`linkedEffectGroupRole` の親子連動（R-EFF-09）で表す。

### APPLY_SUBUNIT

```yaml
kind: APPLY_SUBUNIT
payload:
  durability:
    formula:
      kind: MAX_HP_RATIO
      source: { kind: SKILL_SOURCE }
      ratio: 0.35
  additionalDamage:
    formula:
      kind: SUBUNIT_ADDITIONAL_DAMAGE
      ownerAttack: CURRENT_ATTACK
      providerAttack: SOURCE_SNAPSHOT_ATTACK
      skillMultiplier: 0.312
      targetDefense: TARGET_CURRENT_DEFENSE
    damageType: EN
    debuff:
      effectActionDefinitionId: ACT_SHIRANA_SORA_AS1_SUBUNIT_SPEED_DOWN
  duration:
    dispellable: true
    timeLimit: { unit: ACTION, count: 3 }
```

`SUBUNIT_ADDITIONAL_DAMAGE` は `サブユニット所持者の攻撃力 + 付与者の攻撃力 × スキル倍率 - 対象の防御力` を表す。最終ダメージの丸めと最低1ダメージは通常のダメージ規則に従う。付与者の攻撃力（`providerAttack: SOURCE_SNAPSHOT_ATTACK`）は付与時点のスナップショットで、`AppliedEffect.snapshot` が保持する（継続ダメージの `sourceAttack` と同じ規約）。

| フィールド                    | 型                             | 意味                                                                                                                                                                                             |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `durability.formula`          | Formula                        | 付与時の最大耐久力。R-NUM-02 で切り捨てた非負整数を最大値（`magnitude`）と初期残量の両方に置く                                                                                                   |
| `additionalDamage.formula`    | Formula                        | R-SUB-02 の追加ダメージ量。`SUBUNIT_ADDITIONAL_DAMAGE` を使う                                                                                                                                    |
| `additionalDamage.damageType` | enum（`PHYSICAL` / `EN`）      | 任意。追加ダメージ自身のダメージタイプで、R-SHD-02 のタイプありシールド選択に使う。省略時は**その追加ダメージの契機になった攻撃**（保持者が使ったDAMAGE EffectAction）のタイプを引き継ぐ         |
| `additionalDamage.debuff`     | `{ effectActionDefinitionId }` | 任意（`SUBUNIT_ADDITIONAL_DAMAGE_DEBUFF`）。追加ダメージに付随して同じ対象へ付与する `APPLY_STAT_MOD` 定義への参照。参照先が存在しない／`APPLY_STAT_MOD` でない場合はCatalogロード時点で拒否する |
| `duration`                    | `DurationDefinition`           | 必須（`SUBUNIT_DURATION`）。サブユニット自身の存続期間。`timeLimit` なしは「耐久力が尽きるまで存続する」を表す                                                                                   |

`damageType` を任意にしたのは、raw原文が明示する定義（`ACT_SHIRANA_SORA_EX_SUBUNIT`／`AS1`・`ACT_OLGA_VETERAN_PS1_SUBUNIT`／`PS2` の「ENダメージを追加する」）と、書いていない定義（`ACT_NADYA_SUCCESSOR_*` の「ダメージを追加する」）を取り違えないためである。省略は「不明」ではなく「その攻撃と同じ種類のダメージ」という確定した意味を持つ。

`duration` は他の継続効果と同じく必須にする — 省略を許すと「期間を書き忘れた定義」と「期間を持たない定義」（`ACT_OLGA_VETERAN_PS2_SUBUNIT` の「カムラッドⅠ」）が区別できなくなるためである。耐久力が0になったインスタンスは `EffectExpired`（`reason: SUBUNIT_DEPLETED`）で失効し、失効経路は時間制限（`TIME_LIMIT`）と共有するため R-EFF-09 の `linkedEffectGroupId` カスケードと CombatStat 再計算も同じ振る舞いになる（`APPLY_SHIELD` の `SHIELD_DEPLETED` と同じ）。

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

`targetSkillDefinitionId` の存在は Catalog 検証で拒否する（未定義のSkill IDへの参照）。加えて、対象スキルは操作元の`EffectAction`を保有するUnitと同じUnitが所有するスキルでなければならず、所有者が一致しない参照もCatalog検証で拒否する。

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
| `PRODUCT`                   | `formulas[]`                                                        | 総乗（`DMG-002`／Issue #192で追加）                      |
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

### HP_RATIO_SCALE（`DMG-002`／Issue #192）

参照対象のHP割合で `min`〜`max` を線形補間する。raw原文の「HPが多い/少ないほど高い効果を発揮する（上限X）」をそのまま表す。

```yaml
kind: HP_RATIO_SCALE
target: { kind: TARGET }
min: 0
max: 2
direction: LOWER_HP_IS_MAX
```

| フィールド  | 型         | 制約                                     |
| ----------- | ---------- | ---------------------------------------- |
| `target`    | source参照 | 上の「source」表と同じ（`TARGET` など）  |
| `min`       | number     | HP割合が `max` 側の反対端にあるときの値  |
| `max`       | number     | `direction` が示すHP端に到達したときの値 |
| `direction` | enum       | `LOWER_HP_IS_MAX` / `HIGHER_HP_IS_MAX`   |

```text
hpRatio = clamp(対象の現在HP / 対象の最大HP, 0, 1)
LOWER_HP_IS_MAX  → min + (max - min) × (1 - hpRatio)
HIGHER_HP_IS_MAX → min + (max - min) × hpRatio
```

`min`/`max` の大小関係は問わない（`max` は「`direction` が示すHP端の値」であって上限値ではない）。被ダメージ減少のような負の補正は `min: 0`, `max: -0.5` のように書く。他のFormulaと同じく評価結果を丸めない（R-NUM-02の整数化は適用側の責務）。

production例:

- `SKL_MERU_SIRIUS_AS2`「敵のHPが少ないほどダメージが増加する(+200%まで)」→ `DAMAGE.damageModifiers` に `target: TARGET`, `0`〜`2`, `LOWER_HP_IS_MAX`
- `SKL_MEIYA_FATED_PS2`「攻撃対象のHPが多いほど高い効果を発揮する」→ `target: TRIGGER_TARGET`, `HIGHER_HP_IS_MAX`
- `SKL_MAO_COMMITTEE_PS2`「付与時の自身のHPが多いほど…被ダメージを最大50%減少」→ `APPLY_DAMAGE_MOD.formula` に `target: SKILL_SOURCE`, `0`〜`-0.5`, `HIGHER_HP_IS_MAX`

### PRODUCT（`DMG-002`／Issue #192）

`SUM` の乗算版。`formulas[]` の評価結果を、途中で丸めずに掛け合わせる。「基礎量 × (1 + 逓減倍率)」という形（`SKL_SENKA_CHRISTMAS_AS2`「威力35で回復する。対象のHPが少ないほど回復量が増加する（50%まで）」）を1つのFormulaで表すために追加した。

```yaml
kind: PRODUCT
formulas:
  - { kind: STAT_RATIO, source: { kind: SKILL_SOURCE }, stat: ATTACK, ratio: 0.35 }
  - kind: SUM
    formulas:
      - { kind: CONSTANT, value: 1 }
      - {
          kind: HP_RATIO_SCALE,
          target: { kind: TARGET },
          min: 0,
          max: 0.5,
          direction: LOWER_HP_IS_MAX,
        }
```

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

#### `SUM_*` の集計スコープ（RES-003A／Issue #257）

`LAST_DAMAGE_*` は **1解決スコープ（=1行動）** の直前結果（R-SKL-08）だが、`SUM_*` は **1回の `EffectSequence` 解決** を単位に集計する。実行時の集計キーには、まさにその単位で採番される既存の `SkillUseId` を使う — AS/EX（`action-skill-use-resolver.ts`）、チャージ解放（`action-charge-resolver.ts`）、PS 自身の解決（`passive-activation-service.ts` の `activatePassiveCandidate`）がそれぞれ `nextSkillUseId()` で新規採番し、`scope: EFFECT_SEQUENCE` の `RuntimeCounter`（EFF-006）も同じキーを使う。

この分離により、**同じ行動中に PS 連鎖が与えたダメージは、そのスキル自身の累計へ混入しない**（PS の解決は別の `EffectSequence`＝別の `SkillUseId` に属するため）。raw 原文（例:「与えたダメージの70%分回復する」）が意図する「そのスキルが与えたダメージ」と一致する。

境界の扱いは次のとおり。

- まだ 1 件も `DAMAGE` 結果が確定していない `EffectSequence` では、空集合の合計として **0** を返す（「直前結果が存在しない」＝値そのものが無い `LAST_DAMAGE_*` とは異なり、合計は 0 として定義される）。DAMAGE step が対象 0 件に解決された場合でも、後続の `HEAL` は例外にならず 0 回復になる。
- MISS・対象不在などで適用されなかった `DAMAGE` 結果は 0 として加算する（R-SKL-08 の直前結果と同じ契約）。累計は 0 の加算で変化しないため、それまでの合計をそのまま保つ。
- `EffectSequence` の外（`continuous-heal-service.ts` の継続回復など）から評価される場合は `SUM_*` を `FormulaEvaluationContext` へ渡さず、`FormulaEvaluator` が `DomainValidationError` で明確に拒否する（暗黙の 0 にしない）。

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

| kind                  | 追加フィールド                         | 意味                                                                                               |
| --------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TRUE`                | なし                                   | 常に成立                                                                                           |
| `AND`                 | `conditions[]`                         | 全条件                                                                                             |
| `OR`                  | `conditions[]`                         | いずれか                                                                                           |
| `NOT`                 | `condition`                            | 否定                                                                                               |
| `TARGET_STATE`        | `target`, `field`, `op`, `value`       | 対象状態比較                                                                                       |
| `TARGET_HAS_MARKER`   | `target`, `markerId`, `countCondition` | Marker所持                                                                                         |
| `EVENT_PAYLOAD`       | `field`, `op`, `value`                 | trigger payload比較                                                                                |
| `DAMAGE_MAX_HP_RATIO` | `field`, `op`, `value`                 | trigger payloadの被弾量を被弾ユニットの最大HP比で比較（`R-PS-01`）                                 |
| `LAST_RESULT`         | `field`, `op`, `value`                 | 直前結果比較                                                                                       |
| `RUNTIME_COUNTER`     | `counter`, `op`, `value`, `modulo`     | SkillRuntime等のcounter比較                                                                        |
| `TURN_NUMBER`         | `op`, `value`, `modulo`                | ターン番号条件                                                                                     |
| `ALIVE_UNIT_COUNT`    | `side`, `excludeSelf`, `op`, `value`   | 生存ユニット数の直接比較（G-03、Issue #44）                                                        |
| `POSITION_RELATION`   | `target`, `relation`                   | PS所有者から見た対象のFormation位置関係（M6、`TRIGGER_POSITION_RELATION`、Issue #144）             |
| `RESOLUTION_PHASE`    | `phase`, `negate`                      | 現在のroot/ancestorイベントが属するBattle/Turn phase（M6、`TRIGGER_EXCLUSION_TIMING`、Issue #144） |
| `TARGET_SET_COUNT`    | `target`, `countOf`, `op`, `value`     | 対象集合（`TargetReference`が解決する集合）の件数しきい値判定（RES-004集合条件、Issue #227）       |

`EVENT_PAYLOAD`の`field`は、そのtriggerの`eventType`が実際に持つpayloadプロパティ名（[`08_ドメインイベント.md`](./08_ドメインイベント.md)の各payload節）を直接指す。`EffectApplied`で効果の分類を発動契機にする場合は、M7-011（Issue #265）が追加した`categories`（`BUFF`/`DEBUFF`/`STATUS`等の配列。R-STS-01により状態異常は`STATUS`と`DEBUFF`の両方を持つ）を`op: CONTAINS`で、効果の種類を見る場合は`effectKind`（`EffectActionDefinition.kind`）を`op: EQ`で判定する。状態異常の種別まで絞り込む場合は`statusKind`を`op: EQ`で見る。

```yaml
# 例: 「敵にデバフが付与された際に発動」（SKL_KEI_JACKKNIFE_PS2）
- { kind: EVENT_PAYLOAD, field: categories, op: CONTAINS, value: DEBUFF }
# 例: 「敵に状態異常が付与された際に発動」（SKL_SIENA_DIVA_PS1）
#     effectKind: APPLY_STATUS ではSTEALTH等の有利な状態まで拾うため使わない
- { kind: EVENT_PAYLOAD, field: categories, op: CONTAINS, value: STATUS }
# 例: 「敵に気絶が付与された際に発動」（SKL_NADYA_SUCCESSOR_PS2）
- { kind: EVENT_PAYLOAD, field: statusKind, op: EQ, value: STUN }
```

`DAMAGE_MAX_HP_RATIO`は`EVENT_PAYLOAD`の変種で、`field`が指すpayloadの被弾量（数値）を`TRIGGER_TARGET`（被弾ユニット）の最大HPで割った**比率**を`op`/`value`（数値）と比較する。リテラル比較では表せない「1ヒットで最大HP×N%以上のダメージを負った際」を表す（`R-PS-01`）。`field`は被弾量を持つpayloadプロパティ名（`HitPointReduced`の`hitPointDamage`＝シールド吸収後に実際へHPを減らした量、が代表）を直接指す。trigger条件（`TriggerDefinition.condition`）専用であり、`EVENT_PAYLOAD`と違いEffectStep評価器がこの条件を処理しないため、skillType・Memoryを問わずすべてのresolution step位置はCatalogロード時に拒否する（`DAMAGE_MAX_HP_RATIO_REQUIRES_TRIGGER`）。

```yaml
# 例: 「自身が敵からの攻撃1ヒットで、最大HP×15%以上のダメージを負った際に発動」
triggers:
  - eventType: HitPointReduced
    category: FACT
    sourceSelector: ENEMY
    targetSelector: SELF
    condition: { kind: DAMAGE_MAX_HP_RATIO, field: hitPointDamage, op: GTE, value: 0.15 }
```

`TARGET_SET_COUNT`の`countOf`は集合の生存側・戦闘不能側のどちらを数えるかを選ぶ（`ALIVE`／`DEFEATED`、省略時`ALIVE` = Issue #227時点の既定の意味）。`DEFEATED`は`POST_DAMAGE_SURVIVAL_BRANCH`（`DMG-003`／Issue #196）が追加した——対象集合の大きさは実行時にしか分からないため、「この攻撃で敵を倒した場合」を`ALIVE`側のしきい値（`生存数 < 集合の大きさ`）では表せないためである。判定対象はスキル自身の対象binding（production例: `SKL_HIIRO_LONEWOLF_AS2`の`TGT_COLUMN`）とする — bindingはR-SKL-01により再評価されず同じunit集合を指し続け、状態だけが最新化されるため、DAMAGE後に撃破された構成員も数え漏らさない。

`LAST_RESULT`の`field`は`resultKind`／`effectActionKind`／`effectActionDefinitionId`／`targetUnitIds`に加えて`criticalHitCount`（直前ACTION step全体で実際に適用された会心ヒット数、`POST_DAMAGE_CRITICAL_BRANCH`／`DMG-003`／Issue #196）を取れる。R-SKL-08を正本とする。

```yaml
# 例: 「この攻撃で会心攻撃が発生した場合」（SKL_FEE_BATH_AS2 ほか計6定義）
- { kind: LAST_RESULT, field: criticalHitCount, op: GTE, value: 1 }
# 例: 「この攻撃で敵を倒した場合」（SKL_HIIRO_LONEWOLF_AS2）
- {
    kind: TARGET_SET_COUNT,
    target: { kind: BINDING, targetBindingId: TGT_COLUMN },
    countOf: DEFEATED,
    op: GTE,
    value: 1,
  }
```

`RUNTIME_COUNTER`の`modulo`は`TURN_NUMBER`と同じ意味を持つ。省略時は`op`/`value`のみで判定する（従来どおり）。指定時は「更新後の`value`を`modulo`で割った余りが0」を追加条件とし、N回ごとの発動を表す（`RUNTIME_COUNTER_MODULO`、Issue #143）。

### counterUpdates（RuntimeCounterの更新契機、Issue #143）

`RUNTIME_COUNTER` Conditionが参照するcounterは、`SkillDefinition.counterUpdates`（`RuntimeCounterUpdateDefinition[]`、省略時`[]`）が更新契機を宣言する。TriggerDefinition/activationConditionが参照するcounterは、必ずいずれかの`counterUpdates[].counter`と一致しなければならない。`SKILL_RUNTIME`更新は`SkillDefinition.counterUpdates`が担う。Issue #166で従来の`<skillId>_ACTIVATIONS`/`<skillId>_CUMULATIVE_DAMAGE_RATIO`も明示的な更新定義へ移行した。`AppliedEffect`スコープの`counterUpdates`は`SkillDefinition`ではなく`DurationDefinition`が宣言する（下記「counterUpdates（AppliedEffectスコープ、EFF-005）」参照）。

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

`trigger`は`TriggerDefinition`と同じ形（`eventType`/`category`/`sourceSelector`/`targetSelector`/`condition`）で、対象の更新契機を独立に判定する。`scope`は`RuntimeCounter`の所有スコープ（`BATTLE`／`BATTLE_UNIT`／`SKILL_RUNTIME`／`APPLIED_EFFECT`／`EFFECT_SEQUENCE`、`05_ドメインモデル.md`「RuntimeCounter」参照）で、`SkillDefinition.counterUpdates`は`SKILL_RUNTIME`だけを受理する。`BATTLE`／`BATTLE_UNIT`はCatalogロード時点（`createRuntimeCounterUpdateDefinition`）で明示的に拒否する（Issue #143: 当初「Catalogとして受理するが評価器が実行時に拒否する」契約だったが、未対応スコープを実行前に検出できるよう変更した）。利用するproduction定義が現れるまではFeature Complete必須対象に含めず、必要な定義を追加する際にそのproduction経路と同じTaskで実装・検証する。

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

公開値（`value`）が変わらない更新（例: 累計ダメージ閾値未到達のヒット）でも、内部端数（`carry`）が変化していれば`RuntimeCounterChanged`を発行する（`value`不変・`carry`不変（トリガー自体が不成立、または加算量0）の場合だけ何も発行しない）。可変状態の変化を必ずイベント列から追跡できるようにするため。

`INCREMENT`によるカウントは、`RUNTIME_COUNTER` Conditionを対象イベント自身（`counterUpdates[].trigger`と同じ`eventType`）へ直接付与し、`modulo`で周期を絞り込む。一方`CUMULATIVE_DAMAGE_THRESHOLD`は、`counterUpdates[].trigger`（`DamageApplied`など）ごとに閾値を超えたとは限らないため、`RUNTIME_COUNTER`をそのまま使うと閾値を超えていない被ダメージでも「前回超えた時のvalueがまだ条件を満たす」まま誤って再発火しうる。そのため`CUMULATIVE_DAMAGE_THRESHOLD`を消費するPSは、`counterUpdates[].trigger`ではなく`RuntimeCounterChanged`をtriggerのeventTypeとする。

ただし`RuntimeCounterChanged`は上記のとおりcarryのみの変化でも発行されるため（`valueChanged: false`）、`EVENT_PAYLOAD`で`counter`フィールドを自身のcounter IDと比較するだけでは閾値未到達の被弾ごとに誤発動する（Issue #143）。`counter`の一致に加えて`valueChanged`が`true`であることも`AND`で要求し、実際に閾値を跨いだ（`before !== after`）更新だけに絞り込む。

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

`BRANCH`は`target`を持たず単一の`condition`が常にstep-wideスコープのままのため、今も`TARGET_STATE`/`TARGET_HAS_MARKER`（対象ごとに真偽が変わる対象別条件）と`TARGET_SET_COUNT`（step全体で1回だけ評価する集合条件）を`AND`/`OR`/`NOT`で同時に含められない。両者は単一のbooleanへ還元する意味論が異なり（前者は「対象ごとの適用可否フィルタ」、後者は「step自体のskip判定」）、混在させると量化の位置に依存して結果が変わってしまう。`TARGET_STATE`/`TARGET_HAS_MARKER`が参照する`TargetReference`が`step.target`と一致するかどうかは問わない — `TARGET_SET_COUNT`単独の評価経路は対象ごとの文脈を持たないため、参照先を問わず例外になる。Catalog検証（`catalog-integrity.ts`の`MIXED_STEP_TARGET_SET_CONDITION`）がロード時点で明示的に拒否する。

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

`APPLY_MARKER.duration.counterUpdates`はCatalogロード時点で明示的に拒否する（`UNSUPPORTED_MARKER_DURATION`）— `MarkerState`も同じ`DurationDefinition`/`EffectDurationState`を再利用するためschema上は設定できてしまうが、Marker自身のconsumption/expiration機構が別途未実装のため、宣言してもMarkerが失効しないまま静かに無視される事態を防ぐ。`resetScope`（`RESOLUTION_SCOPE`）はこの位置では意味を持たない（`AppliedEffect`スコープのcounterは効果インスタンス自身の失効がリセットを兼ねるため、`RuntimeCounterReset`を発行しない）。利用するproduction定義は現状存在せず、明示的Scenarioでのみ検証している。

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

`counterUpdates`を宣言する`EffectSequence`は、**CHARGEスキルの開始側（トップレベルの`steps`/`targetBindings`）に宣言することはできない**（`resolveChargeStart`が一度もこのEffectSequenceを解決しないため、宣言しても更新もResetも一切発生しない — Catalogロード時点で明示的に拒否する）。`chargeRelease`側（`resolveChargeRelease`が実際に解決する）にだけ宣言できる。利用するproduction定義は現状存在せず、明示的Scenarioでのみ検証している。

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

`UNIT_TYPE` / `ROLE` はCatalogの`UnitDefinition`を参照して解決する（M7-001E、Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）。ACTION step条件・BRANCH条件では`EffectStepTargetContext.unitDefinitions`が、PSのtrigger／`activationCondition`では`RuntimeCounterLookupContext.unitDefinitions`（`passive-trigger-matcher.ts`が候補検出へ、`reconfirm-passive-candidate.ts`が発動直前再確認へ、同じ参照表を渡す）が正本になる。参照表を渡さない呼び出しでこれらの`field`へ到達した場合は、黙って不成立にせず`DomainValidationError`で隔離する。

`HAS_STATUS` は「対象が保持している`APPLY_STATUS`由来の状態種別のいずれかが`op`/`value`に一致するか」という**存在量化**として評価する — 対象は気絶と暗闇を同時に保持しうるため、他の`field`のように単一値へは解決しない。

`HAS_STATUS`が担うのは**個別の状態異常種別**（「対象が気絶している場合」等、R-EFF-02の照会粒度#2）だけである。「対象が状態異常にある場合」という**総称**を`op: EQ`のORで書いてはならない（`RES-004-STATUS-CONDITION`／Issue #224）— `APPLY_STATUS`由来の種別しか見ないため、同じく状態異常である炎上・毒（`APPLY_CONTINUOUS_DAMAGE`）を必ず取りこぼす。総称は`TARGET_HAS_EFFECT`の`categories: ["STATUS"]`で表す。M7-001Eがこの形で書いた4定義（`SKL_MERU_FLATSPIN_AS1`〜`AS3`・`SKL_NANAE_COMMANDER_PS1`）はIssue #224が移設済みで、`HAS_STATUS`の現行production利用は0件である。

### TARGET_HAS_EFFECT

M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、`CAP_TARGET_EFFECT_QUERY`）。「対象が何らかのバフ／デバフ／状態異常を保持しているか」を、R-EFF-02/03の分類軸で照会する。

```yaml
condition:
  kind: TARGET_HAS_EFFECT
  target: { kind: BINDING, targetBindingId: TGT_BASE }
  categories: [DEBUFF]
  continuousDamageKinds: [POISON]
  statKinds: [ATTACK]
```

| フィールド                  | 型       | 必須 | 制約                                                                                      |
| --------------------------- | -------- | ---- | ----------------------------------------------------------------------------------------- |
| `target`                    | object   | ✓    | `TargetReference`                                                                         |
| `categories`                | string[] | ✓    | 1件以上。`BUFF` / `DEBUFF` / `STATUS` / `DAMAGE_MOD` / `SHIELD` / `SUBUNIT`               |
| `continuousDamageKinds`     | string[] | —    | 1件以上。`FIXED` / `BURN` / `POISON`。**値ごと**に到達可能な`categories`が異なる（下表）  |
| `statKinds`                 | string[] | —    | 1件以上。`StatKind`。`categories`が`BUFF`または`DEBUFF`を含む場合だけ指定できる           |
| `effectActionDefinitionIds` | string[] | —    | 1件以上。一致対象を特定のEffectAction定義由来の付与へ絞る（`DMG-007`／Issue #187）        |
| `grantedBy`                 | enum     | —    | `SELF` のみ。一致対象を「この条件を評価しているユニット自身が付与した」インスタンスへ絞る |

判定は「`categories`のいずれかに一致する`AppliedEffect`を対象が1つ以上保持している」ことであり、絞り込み（`continuousDamageKinds`／`statKinds`）はその一致へANDで重ねる。到達できない組み合わせ（例: `categories: [SHIELD]`に`statKinds`）はCatalogロード時点で拒否する — `EFFECT_IMMUNITY.statusKinds`と同じく「schemaは通るが実行時に一切一致しない定義」を作らせないためである。

`continuousDamageKinds`の到達可能性は**フィールド単位ではなく値単位**で判定する。`APPLY_CONTINUOUS_DAMAGE`は常に`DEBUFF`だが、`STATUS`になるのは`R-STS-01`が状態異常として定義する炎上・毒だけであり、固定継続ダメージ（`FIXED`）は名前付きの状態異常ではないためである。

| 値                | 実行時に分類されるcategory | 指定できる`categories`                     |
| ----------------- | -------------------------- | ------------------------------------------ |
| `FIXED`           | `DEBUFF`                   | `DEBUFF`を含むこと                         |
| `BURN` / `POISON` | `DEBUFF` + `STATUS`        | `DEBUFF`または`STATUS`のいずれかを含むこと |

したがって`categories: [STATUS]` + `continuousDamageKinds: [FIXED]`は実行時に絶対一致しないためロード時に拒否する。`[POISON, FIXED]`のように到達可能な値と不能な値を混ぜた指定も、`FIXED`側が黙って無効になるため同じく拒否する（エラーの`path`は`...continuousDamageKinds[i]`と値単位で示す）。

`categories: ["STATUS"]`は「対象が状態異常にある場合」という**総称**の照会であり、`R-STS-01`が定める5種（気絶・凍結・暗闇＝`APPLY_STATUS`、炎上・毒＝`APPLY_CONTINUOUS_DAMAGE`）すべてに一致する（`RES-004-STATUS-CONDITION`／Issue #224）。Catalog側で種別を列挙してはならない — 列挙は必ず取りこぼしうる近似になる。個別種別を問う場合だけ`continuousDamageKinds`（毒・炎上）や`TARGET_STATE.field: HAS_STATUS`（気絶・凍結・暗闇）で明示的に絞り込む。production例: `SKL_CHIYURU_MAZE_EX`（AOEの`targetCondition`。条件成立対象だけへ気絶と被ダメージ増デバフを適用する）、`SKL_MERU_FLATSPIN_AS1`〜`AS3`・`SKL_NANAE_COMMANDER_PS1`（BRANCH）。

`MARKER`と`SPECIFIC_EFFECT`は`categories`に指定できない。`MarkerState`は`AppliedEffect`ではなく`TARGET_HAS_MARKER`が照会し、`SPECIFIC_EFFECT`は分類軸ではなく`effectActionDefinitionId`の直接一致だからである。その直接一致を表す正しい場所が`effectActionDefinitionIds`（`DMG-007`／Issue #187、`EFFECT_IMMUNITY`の同名fieldと同じ参照方式）で、`categories`とはANDで重ねる。

`grantedBy: SELF`は「**自身が**付与したインスタンスだけ」に絞る（`AppliedEffect.sourceUnitId`との一致）。production例は`SKL_DOROTHEA_PIONEER_PS2`の「自身がダメージリンクを付与した敵が倒された際に発動」で、定義IDの一致だけでは同名ユニットが両陣営に居る場合に他者が付与したリンクも拾ってしまうため必要になる。「自身」を知っているのは評価元の`BattleUnit`（`context.owner`）を受け取る**Skillの**trigger条件evaluatorだけである。次の位置は評価元ユニットを持たないため、そこへ書くと黙って常に偽になる。したがって`GRANTED_BY_OUTSIDE_TRIGGER`としてCatalogロード時点で拒否する。

- EffectSequence内の条件（`stepCondition`／`targetCondition`／BRANCHの`condition`）と`activationCondition`
- **Memoryのtrigger条件**（`memory-trigger-matcher.ts`はR-MEM-04どおり`ownerSide`（陣営）だけを渡す。Memoryには「自身が付与した」に相当する付与者ユニットがそもそも存在しない）

`effectActionDefinitionIds`が実在の`EffectActionDefinition`を指しているかは、`ConditionDefinition`を置けるすべての位置を走査して`DANGLING_REFERENCE`で検証する。

- Skill: `triggers[]`／`counterUpdates[].trigger`／`activationCondition`／EffectSequence内のstep条件（BRANCH・RANDOM_BRANCH・REPEATの入れ子を含む）
- Memory: `trigger`／EffectSequence内のstep条件
- `DurationDefinition`: `expiration.conditions`（R-EFF-08）と`counterUpdates[].trigger.condition`（EFF-005）

`EFFECT_IMMUNITY`/`REMOVE_EFFECTS`のpayload参照と同じ規則である — 存在しないIDを指す条件は実行時に一切一致しないsilent no-opになるためロード時に落とす。

分類の正本は`REMOVE_EFFECTS`/`EFFECT_IMMUNITY`と同じ`effect-category-classifier.ts`の`effectCategoriesOf`ただ1つで、`grantEffect`が付与時点に`AppliedEffect.categories`（および`APPLY_STAT_MOD`の`statModStat`）へ焼き込む。`EffectApplied.payload.categories`・`EffectSnapshot.categories`も同じ値を運ぶため、独立Reducerで復元した状態でも同じ判定になる。

評価スコープは`TARGET_STATE`/`TARGET_HAS_MARKER`と同一である。BRANCHとAS/EXの`activationCondition`は、どちらも対象ごとの評価コンテキストを持たない（量化規則を持たない）ため、参照する`TargetReference`が高々1体に解決されることをCatalogロード時点で要求する。PSのtrigger／`activationCondition`だけは、`triggering/`の評価器が解決した`BattleUnitId`集合へ存在量化するため複数対象でも評価できる。

`activationCondition`が参照できる`TargetReference`の**種別**も、評価する側がskill typeごとに異なるためCatalogロード時点で制約する（`ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE`）。AS/EXは行動選択時に評価されトリガーイベントも直前結果も存在しないため`SELF`と解決済み`BINDING`だけ、PSは候補判定時に解決済みTargetBindingを持たないため`SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`だけを許可する。CHARGEスキルの`activationCondition`は行動選択時（チャージ開始の可否判定）に評価されるため、解決される`targetBindings`は**開始側**だけであり、`chargeRelease`側のbindingは参照できない。

**相補的な条件を2つのACTION stepへ分けてはならない**。`targetCondition`は各stepの`EffectStepStarting`とそこから生じるPS/Memory連鎖の**後**に最新stateで評価されるため、条件Xと`NOT(X)`を別stepに置くと、先行stepの解決中に`X`が変化した場合に両方が実行されうる。「通常版か強化版のどちらか一方」は`BRANCH`（分岐の選択を一度だけ確定する）で表し、`TRIGGER_TARGET`のようにBRANCHで参照できない対象では「基本効果を無条件、増加分だけを条件付き」の加算形にして条件付きstepを1つに保つ（production例: `SKL_NOEL_RUMBLE_AS1`/`SKL_SHOUKA_SCHEMER_AS3`はBRANCH、`SKL_FLUTE_INFLUENCER_PS2`は加算形）。

| スコープ                          | 可否 | 備考                                                                                                                                                   |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ACTION `targetCondition`          | ✓    | 対象ごとに評価。`target`はそのstep自身の`target`と一致していなければならない                                                                           |
| BRANCH `condition`                | ✓    | 高々1体に解決される参照のみ（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`が保証）                                                                         |
| AS/EX `activationCondition`       | ✓    | `SELF`、または高々1体に解決される開始側`BINDING`のみ（`ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE`／`ACTIVATION_CONDITION_UNBOUNDED_REFERENCE`が保証） |
| PS trigger／`activationCondition` | ✓    | `SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`のみ                                                                                                           |
| ACTION `stepCondition`            | ✗    | 対象ごとに真偽が変わりうるため、`TARGET_STATE`と同じ理由で除外する                                                                                     |

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
  reapply:
    existingRemaining:
      op: EQ
      value: 1
    count: 2
  removeOnSourceDefeated: false
```

| フィールド               | 型          | 必須 | 制約                                                                                                              |
| ------------------------ | ----------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `timeLimit`              | object      | —    | 省略時は即時効果                                                                                                  |
| `consumption`            | object      | —    | 消費型効果                                                                                                        |
| `expiration`             | object      | —    | 特殊失効                                                                                                          |
| `dispellable`            | boolean     | —    | 省略時 true                                                                                                       |
| `linkedEffectGroupId`    | string/null | —    | 親子連動                                                                                                          |
| `linkedEffectGroupRole`  | enum        | —    | `PARENT` / `CHILD`。`linkedEffectGroupId`必須。省略時は理由を問わずグループ全体へ対称にカスケードするレガシー扱い |
| `reapply`                | object      | —    | 再付与時の動的期間（R-EFF-12）。`timeLimit`必須                                                                   |
| `removeOnSourceDefeated` | boolean     | —    | 付与者の戦闘不能で解除（R-EFF-10）。`APPLY_MARKER`専用。省略時は宣言なし扱い                                      |

`removeOnSourceDefeated`（R-EFF-10、`MARKER_REMOVAL_ON_SOURCE_DEATH`、`M7-020`／Issue #279）: `true`を宣言したMarkerは、付与者（`MarkerState.sourceUnitId` ＝直近の付与者）が戦闘不能になった時点でスタック数を問わず解除され、`MarkerRemoved`（`reason: SOURCE_DEFEATED`）を発行する。同じ`linkedEffectGroupId`を持つ子効果はR-EFF-09のカスケードで連動して失効する。production Catalogの例は`ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU`（「「高揚」は付与者が倒れると同時に解除される」）。

`APPLY_MARKER`以外の`EffectActionDefinition`の`duration`へ宣言した場合はCatalogロード時点で拒否する（`UNSUPPORTED_SOURCE_DEFEATED_REMOVAL`）— `AppliedEffect`には付与者の戦闘不能を判定する失効機構が無く（`ConditionDefinition`にもユニットの戦闘不能を判定するkindが存在しない）、宣言しても「付与自体は成功するのに付与者が倒れても何も起きない」silent partial implementationになるため。`expiration.conditions`（R-EFF-08）ではなく専用フィールドにしたのは、Marker側のexpiration機構自体が未実装（`UNSUPPORTED_MARKER_DURATION`）であり、Condition表現を導入すると同機構ごと実装する必要があるためである。

`linkedEffectGroupRole`（R-EFF-09）: `linkedEffectGroupId`が同じメンバー間のカスケード方向を明示する。`PARENT`が失効すると理由を問わず同グループ全体（他の`PARENT`・`CHILD`）へカスケードするが、`CHILD`が単独で失効してもカスケードしない（「子効果だけが消費条件で失効した場合、親効果は維持する」）。どちらのメンバーも`linkedEffectGroupRole`を持たないグループは従来どおり対称にカスケードする。

同じ`linkedEffectGroupId`は`APPLY_MARKER`（`MarkerState`を生成する）と非Marker種別（`AppliedEffect`を生成する）が混在して宣言できる — R-EFF-09第1項が「同じ`linkedEffectGroupId`を持つ`AppliedEffect`**と**`MarkerState`は親子連動グループとして扱う」と規定するcross-typeグループで、`M7-013`（Issue #267）が実装した。それまでは`catalog-integrity.ts`が`UNSUPPORTED_MARKER_LINKED_GROUP`としてCatalogロード時点で拒否していた。production Catalogの例は`TARISA_TROUBLEMAKER_PS1_LINK`（Marker「負けん気」＝`PARENT`、`ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP`＝`CHILD`）と`AOI_ELEGANT_AS1_KOUYOU_LINK`（Marker「高揚」＝`PARENT`、`ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN`／`ACT_AOI_ELEGANT_AS1_KOUYOU_DOT`＝`CHILD`）。`dispellable: false`とカスケードは両立する — `REMOVE_EFFECTS`では解除できない子効果も、親Markerの解除には連動して失効する。

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

### reapply

R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、`M7-014`／Issue #268）: 同じ効果が付与対象に残っている場合だけ、初期残り回数を `timeLimit.count` の代わりに `reapply.count` にする。

| フィールド                | 型      | 必須 | 制約                                                       |
| ------------------------- | ------- | ---- | ---------------------------------------------------------- |
| `existingRemaining.op`    | enum    | ✓    | `GT` / `GTE` / `LT` / `LTE` / `EQ` / `NEQ`（数値比較のみ） |
| `existingRemaining.value` | integer | ✓    | 0以上。既存インスタンスの残り回数と比較する                |
| `count`                   | integer | ✓    | 1以上。差し替え後の初期残り回数                            |

期間単位（`timeLimit.unit`）とownerは差し替えない。`existingRemaining` の比較が常に同じ期間単位どうしになるようにするためであり、`timeLimit` を持たない（即時効果の）durationへ `reapply` を宣言することはできない。

「同じ効果」は、再付与が状態種別単位で1インスタンスへ集約される状態異常（`STUN`＝R-STS-02、`FREEZE`＝R-STS-03）だけを状態種別で、それ以外はすべて `effectActionDefinitionId` で一致させる（前者は付与元スキルを問わない）。`BLIND`（R-STS-04により複数インスタンスを独立処理）・`STEALTH`・`EVASION`・`DAMAGE_IMMUNITY` 等は集約されないため後者に含まれる — 解除・免疫判定の分類（R-STS-01の `STATUS` カテゴリ＝気絶・凍結・暗闇）とは別の区別である。一致インスタンスが複数ある場合は残り回数が最大のものと比較する。

`APPLY_MARKER`（再付与は `stack.policy` が解決する、R-EFF-10）と `APPLY_STATUS` の `status: FREEZE`（再付与は新しい付与内容を一切反映しない、R-STS-03）には宣言できない。宣言しても評価されないため、`catalog-integrity.ts` が `UNSUPPORTED_DYNAMIC_DURATION_REAPPLY` としてCatalogロード時点で拒否する。

production例（`ACT_SIENA_DIVA_PS1_STUN`、raw「1行動の気絶を付与する。対象に1行動の気絶が付与されていた場合は、2行動の気絶に上書きする」）:

```yaml
duration:
  timeLimit:
    unit: ACTION
    count: 1
  dispellable: true
  reapply:
    existingRemaining:
      op: EQ
      value: 1
    count: 2
```

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
metadata:
  displayName: "Colorful Bouquet"
  tags: []
```

### フィールド詳細

| フィールド           | 型       | 必須 | 制約                  |
| -------------------- | -------- | ---- | --------------------- |
| `memoryDefinitionId` | string   | ✓    | 一意                  |
| `triggeredEffects`   | object[] | ✓    | 1件以上。v2唯一の表現 |
| `metadata`           | object   | ✓    | displayName / tags    |

単純な「戦闘開始時に味方へ stat 補正」も、`APPLY_STAT_MOD` を持つ `triggeredEffects` として表現する（`eventType: BattleStarted`、`side: ALLY` の `selector`、`duration.timeLimit: { unit: BATTLE, count: 1 }`）。`modifiers` 省略記法は廃止した。

Memory発動エンジン（`BattleStarted` での `triggeredEffects` 解決、`R-MEM-01`〜`04`）は M7-006（Issue #179）で実装した。

`R-MEM-04`「具体的な発生源 BattleUnit が必要なEffectActionをMemoryから使用する場合は、Catalog検証またはpreflightで拒否する」は、Catalog整合性検証の `MEMORY_REQUIRES_SOURCE_UNIT` が担う。Memory の `triggeredEffects` は次を宣言できない。

- 発生源ユニットを必要とするEffectAction種別: `DAMAGE`、`HEAL`、`APPLY_CONTINUOUS_HEAL`、`MODIFY_RESOURCE`、`COOLDOWN_MANIPULATION`、`APPLY_MARKER`（`MarkerState` は常に「直近の付与者」を持つ、[10_API設計.md](./10_API設計.md)）。
- 使用者を指す参照を payload に埋め込むEffectAction: `FormulaDefinition` の `SKILL_SOURCE`（`STAT_RATIO`/`MAX_HP_RATIO` などの `source`、`SUM`/`MIN`/`MAX`/`CLAMP` の入れ子内も含む）、`TargetReference` の `SELF`（例: `APPLY_HEALING_LINK.transferTo`）、`LAST_DAMAGE_*`/`SUM_DAMAGE_*` を読む `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`（直前・累計DAMAGE結果は使用者ごとに記録されるため、Memoryの解決では評価contextへ渡らない）。
- `DurationDefinition.timeLimit.owner: EFFECT_SOURCE`（減算契機が付与者の行動・ターン完了になるため）。ただし `DurationDefinition` 配下のそれ以外（`expiration.conditions` や `counterUpdates`）は**効果保持者**のスコープであり、そこに現れる `SELF` は保持者を指す正当な参照として受理する（`effect-expiration-condition-service.ts` は各効果の保持者を `owner` として評価する）。
- 対象参照 `SELF`（`R-MEM-04` が明示的に禁止）。
- 使用者を基準にする `TargetSelectorDefinition`（`kind: SELF`、`order` の `NEAREST`/`FARTHEST`/`SELF_LOWEST_PRIORITY`、`BINDING_DERIVED` 以外で `base` が暗黙に使用者になる `area`、`EXCLUDE_RESOLVED_UNIT` の `SELF` 参照）。
- 所有者を必要とする `ConditionDefinition`（`TriggerDefinition.condition` と EffectStep の各 condition の両方）: `POSITION_RELATION`、`RUNTIME_COUNTER`、`excludeSelf: true` の `ALIVE_UNIT_COUNT`、対象参照 `SELF`。
- `EffectSequence` スコープの `counterUpdates`（保持先が解決ユニットになるため）。

実行時（`FormulaEvaluator`・`TargetSelectionPolicy`・`EffectActionGroupResolver`）も同じ構成を明確なエラーで拒否するが、戦闘開始後に効果解決の途中で失敗させないため、Catalogロード時点で先に検出する。

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
```

---

## 参照整合性規則

Catalog v3 検証器は次を確認する。

1. ID一意性。
2. Unit が参照する Skill が存在し、`skillType` が一致する。
3. Skill / Memory の `effectSequence.steps` が参照する `effectActionDefinitionId` が存在する。
4. `TargetReference.kind: BINDING` が同じ sequence 内の `targetBindings` に存在する。
5. `ConditionDefinition` と `FormulaDefinition` の参照 field が許可一覧に存在する。
6. `schemaVersion` が `3` である。
7. `triggeredEffects` を1件以上持つ Memory だけを許可する。
8. AS/EX の `triggers` は空、PS の `triggers` は1件以上。
9. EX Skill の `cost.resource` は `EX_GAUGE` で、`cost.amount` が Unit の `extraGaugeMaximum` と一致する。
10. `EFFECT_IMMUNITY` / `REMOVE_EFFECTS` の `payload.effectActionDefinitionIds`（`categories` に `SPECIFIC_EFFECT` を含む場合）が参照する `EffectActionDefinition` が存在する。

---

## Authoring への影響

Unit / Memory Markdown から Catalog v3 へ変換する際は、次をテンプレートへ追加する。

- Unit metadata: `characterName`, `characterId`, `affiliations`
- Unit generated fields: `baseStats.affinityBonus = 0.25`, `baseStats.criticalDamageBonus = 0.5`, `extraGaugeMaximum = EX skill cost.amount`
- Skill: `targetBindings`, `steps`
- EffectAction: `formula`, `duration`, `stacking`
- Memory: `triggeredEffects`
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

## Issue #6実装で判明した制約

Catalog v2 DTO・Domain Definition・Mapperの実装（Issue #6）で、本書の記述だけでは一意に決まらない箇所が見つかった。次はpayload例やenum一覧が未確定であり、production Catalogの authoring 前に本書へ追記が必要。

1. `EffectActionDefinition.kind` のうち `APPLY_HEALING_MOD`、`MODIFY_RESOURCE_CAPACITY`、`APPLY_SHIELD`、`REMOVE_EFFECTS`、`APPLY_DAMAGE_LINK` の5種はpayload例が示されていなかった。Issue #44でこのうち `APPLY_HEALING_MOD`・`MODIFY_RESOURCE_CAPACITY`・`APPLY_SHIELD`・`REMOVE_EFFECTS` の4種のpayload形状を本書へ追記し、Mapperへ実装した（下記「Issue #44実装で追加した拡張」）。`APPLY_DAMAGE_LINK` はCover/Reflect/DamageLinkの割り込み順（本書「後続設計で具体化する点」#3）が未確定のため長く未サポートのままだったが、`DMG-006`（Issue #188）がその割り込み順を `R-INT-01` #1〜#5 として確定させたため、`DMG-007`（Issue #187）が上記「APPLY_DAMAGE_LINK」のpayload形状を本書へ追記しMapperへ実装した。`REMOVE_MARKER` は `APPLY_MARKER` の対称形（`markerId` のみ）として実装した。
2. `FormulaDefinition` の `HP_RATIO_SCALE.direction` は値候補が本書のどこにも列挙されておらず、Mapperは長らく `HP_RATIO_SCALE` 自体を未サポートとして拒否していた。`DMG-002`（Issue #192、`HP_RATIO_SCALE_FORMULA`）が下記「HP_RATIO_SCALE」節へ2値を定義し、Mapper・`FormulaEvaluator` へ実装して解消した。
3. `APPLY_STAT_MOD.stacking.mode` / `APPLY_DAMAGE_MOD.stacking.mode` は例で `STACKABLE` しか示されていない。「重複なし」(`R-STA-03`) に対応する値が未定義のため、Mapperは `STACKABLE` のみを許可していた。`M7-012`（Issue #266）が `APPLY_STAT_MOD` 側について `NON_STACKABLE` と重複上限 `stacking.max` を本書「APPLY_STAT_MOD」節へ定義し、Mapper・実ライフサイクルへ実装して解消した（`R-EFF-05` 完了）。`APPLY_DAMAGE_MOD`・`APPLY_HEALING_MOD`・`APPLY_RESOURCE_GAIN_MOD` は最強選択を行う合成経路を持たないため引き続き `STACKABLE` のみである。
4. Formulaの `source`/`target` 参照（`STAT_RATIO.source`、`MARKER_COUNT_SCALE.target` など）はHEAL/MARKER_COUNT_SCALE例では `{kind: ...}` オブジェクト形式、APPLY_SUBUNIT例 (`source: SKILL_SOURCE`) では裸のenum文字列形式と表記が揺れている。Mapperはオブジェクト形式 `{kind, targetBindingId?}` に統一した（`BINDING` 種別が追加フィールドを要するため）。
5. `TriggerDefinition.sourceSelector` / `targetSelector` の値候補は本書に一覧化されていない。実装では `08_ドメインイベント.md` と本書の例に実際に現れる値（`SELF`、`ALLY`、`ENEMY`、`ANY`、`EFFECT_OWNER`）だけを許可した。`REF-028`（Issue #358）が `OTHER_ALLY`（味方のうち所有者自身を除く）を追加した — production 原文の「**他の**味方が〜した際に発動」（14スキル）は `ALLY` が所有者自身を含むため表せず、自分の行動が自分のPSを呼んでしまう。`ALLY` と違い解決可能な発生源／対象の `BattleUnitId` を必須にする — 「他の味方」は所有者以外の味方 BattleUnit を指す語彙であり、`sourceSide` だけを持つイベントは陣営が一致しても成立させない。Memory の trigger は所有ユニットを持たない（`R-MEM-04`）ため `OTHER_ALLY` を `EFFECT_OWNER` と同じく明示的に拒否する。
6. `MarkerDefinition` はUnit/Skill/EffectAction/Memoryのような専用Catalogファイルを持たず、`MarkerId` 参照のみが登場する。Issue #6では `MarkerId` のformat検証のみを実装し、スタック上限や関連効果を持つ独立したMarkerカタログは未実装とした。

## Issue #44実装で追加した拡張

Issue #41（代表10ユニットのv2 Catalog変換パイロット）で、当時のMapperでは表現できずfixtureから省略した10項目（G-01〜G-10）について、設計方針を確定し、実装するもの・見送るものを区分した。

### 実装したもの（Mapper拡張済み、fixtureで実データ再変換済み）

| #    | 内容                                                                  | 追加したschema要素                                                                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G-01 | 回復量増減の被付与                                                    | `EffectActionDefinition.kind: APPLY_HEALING_MOD`                                                                                                                                                                                                                                                                               |
| G-02 | 継続ダメージ(DoT)                                                     | `EffectActionDefinition.kind: APPLY_CONTINUOUS_DAMAGE`                                                                                                                                                                                                                                                                         |
| G-03 | 生存ユニット数を直接比較する条件                                      | `ConditionDefinition.kind: ALIVE_UNIT_COUNT`                                                                                                                                                                                                                                                                                   |
| G-04 | 効果解除                                                              | `EffectActionDefinition.kind: REMOVE_EFFECTS`                                                                                                                                                                                                                                                                                  |
| G-06 | `DAMAGE_IMMUNITY`のダメージ量しきい値                                 | `APPLY_STATUS.payload.damageThreshold`（既存kindへのフィールド追加）                                                                                                                                                                                                                                                           |
| G-08 | シールド付与                                                          | `EffectActionDefinition.kind: APPLY_SHIELD`                                                                                                                                                                                                                                                                                    |
| G-09 | 最大リソース上限変更                                                  | `EffectActionDefinition.kind: MODIFY_RESOURCE_CAPACITY`                                                                                                                                                                                                                                                                        |
| G-10 | 同一EffectSequence内のDAMAGE結果合算参照                              | `FormulaDefinition` の `sourceResult: SUM_DAMAGE_DEALT` / `SUM_DAMAGE_RECEIVED`                                                                                                                                                                                                                                                |
| G-05 | リソース「獲得量」自体を増減させるModifier（実装: M7-002/Issue #185） | `EffectActionDefinition.kind: APPLY_RESOURCE_GAIN_MOD`。`resource`は当初計画の`AP`/`PP`/`EX_GAUGE`から`EX_GAUGE`固定へ絞った（合成経路がEXゲージ増加だけを対象にするため、AP/PP/HPを受理しても機能しない「無効な定義」になってしまうことをレビューで指摘され修正）。`UNIT_MAIA_SALON`/`UNIT_KARINA_DOWNER`を実データ再変換済み |

Mapper/schemaレベルでの受理と、対応するBattle Engineの実行（HP/リソース状態遷移、イベント発行）は分離して段階的に実装した。Engine側の実装は各Task（DoTはDMG-008／Issue #189、ShieldはDMG-004／Issue #194、SubUnitへのDamage適用はDMG-005／Issue #190、効果解除・無効化・CombatStat再計算はM7-001／Issue #181、`MODIFY_RESOURCE_CAPACITY`はM7-002A／Issue #255）で追跡した。

`MODIFY_RESOURCE` は一回限りの加減算のままとし、`APPLY_RESOURCE_GAIN_MOD` とは別kindとして扱う（「Duration付与時に確定した符号付き量を加算する」既存の`APPLY_DAMAGE_MOD`/`APPLY_HEALING_MOD`と同じモデルへ揃え、将来の獲得イベントへ事後的にフックする新モデルは導入しない）。フィールド名・丸め規則・複数Modifier合成順は、M7-002（Issue #185）で`resource: EX_GAUGE`固定の契約として確定・実装済み（上記「実装したもの」表のG-05、および[APPLY_RESOURCE_GAIN_MOD](#apply_resource_gain_mod)参照）。

### 見送ったもの（設計課題を明記し、実装を見送り）

| #    | 内容                                    | 見送り理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-07 | `APPLY_DAMAGE_MOD` の動的な相対比較条件 | 「対象HP割合が自身より低い敵にのみ与ダメージ+10%」は、`APPLY_DAMAGE_MOD` が付与時（skill使用時）に1回だけ評価される現行モデルに対し、以後発生する個々の`DAMAGE`解決のたびに、その時点の対象で条件を再評価する必要がある。単に `condition: ConditionDefinition` フィールドを追加するだけでは、条件内の `TargetReference` が「このDamageModifierが今まさに適用されようとしている対象」を指す手段（既存の `TargetReference` kindはBINDING/SELF/TRIGGER_SOURCE/TRIGGER_TARGET/LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETSのみで、この用途を持たない）がなく、新しいTargetReference kindとDamage pipeline側の評価フックの両方の設計を要する。防御貫通はDMG-001（Issue #195）、複数hitはDMG-002（Issue #192）でDamage pipelineを完成させ、per-hit評価の設計が固まってから着手する。 |

G-05（カリナPS2 包囲かんりょ～）該当箇所はM7-002（Issue #185）で実装済み。G-07（コトハPS2 起死回生）該当箇所は、Issue #41時点のfixtureのまま近似表現（該当効果を省略）を維持する。

## Issue #46実装で見つかった追加課題

代表10ユニットのfixtureをproduction Catalog候補（`catalog/`）へ昇格するにあたり raw と再照合した際に、G-01〜G-10 とは別の新しい表現ギャップが1件見つかった。

| #    | 内容                                                                                                                                   | 影響ユニット・スキル                                                                                            | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-11 | `TargetSelectorDefinition.fallback` で対象が差し替わったとき、適用する `EffectAction` 自体（威力など）を候補経路ごとに変える手段がない | リディア EX リディアたいちょうのめいれい（右列・左列に敵がいない場合は威力113.76ではなく威力100の別攻撃にする） | **見送り**。`fallback` は対象選択のみを差し替える仕組みで、`resolution.steps[].actions[]` は選択された対象の由来（通常フィルタ経由か `fallback` 経由か）を区別しない。現状の fixture は `TGT_COLUMNS` の埋め込み `fallback`（対象が0件のとき最近の敵1体を選ぶ）で対象選択だけは表現しつつ、命中した対象には通常と同じ `ACT_LYDIA_EX_DAMAGE_COLUMN`（威力113.76）を適用する近似とする。`CAP_TARGET_BINDING_FALLBACK`（TGT-003、Issue #168）と `CAP_TARGET_FILTER_ORDER`（TGT-002、Issue #169）がいずれも実装済みになった時点で、この近似は production でも到達可能になった（`TGT_COLUMNS` の `filters` が対象0件のとき `fallback` が実際に評価される）。単に威力を分ける `EffectAction` を fallback 側に追加するだけでは実行されず、`fallback` 経由か否かを steps へ伝播する新しいフィールド（例: `EffectStepDefinition.target.kind: BINDING` に `viaFallback` の分岐先を持たせる）の設計を要するため、対象フォールバック機構そのものを実装する際にあわせて設計する。 |

Issue #41パイロット実施時に宣言されていた `TGT_FALLBACK` targetBinding と `ACT_LYDIA_EX_DAMAGE_FALLBACK`（威力100の専用DAMAGE）は、どの `resolution.steps` からも参照されない死んだ定義だったため、Issue #46でproduction Catalog候補へ昇格する際に削除した。上記の近似表現に置き換わる実装ができるまで、威力100の専用アクションを復活させない。
