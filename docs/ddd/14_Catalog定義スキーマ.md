# Catalog 定義スキーマ

## 目的

本書は、Catalog 実装（M1）に先行して Unit・Skill・Effect・Memory の JSON 契約を確定する。

- 実装者が推測なしで JSON Schema を作成できる
- 保留4仕様を Capability として表現・隔離できる
- 定義順と参照型の意味を一元管理できる

前提文書: [`05_ドメインモデル.md`](./05_ドメインモデル.md)・[`07_戦闘ルール詳細.md`](./07_戦闘ルール詳細.md)・[`08_ドメインイベント.md`](./08_ドメインイベント.md)・[`11_インフラストラクチャ設計.md`](./11_インフラストラクチャ設計.md)

---

## Authoring ワークフロー

Unit・Memory の実データを Catalog へ投入する手順は次のとおりとする。

1. **自然言語転記**: Unit または Memory ごとに、参考資料からスキル効果・ステータス・数値を `docs/units/` または `docs/memories/` 配下の Markdown へ自然文として書き出す。
2. **テンプレート構造化**: `docs/templates/Unit定義テンプレート.md` または `docs/templates/Memory定義テンプレート.md` を複製し、前ステップの内容を `catalog-unit` / `catalog-skill` / `catalog-effect` / `catalog-memory` YAML ブロックへ転記する。換算が生じた場合は `catalog-decisions` ブロックへ根拠を記録する。
3. **レビュー**: テンプレートのチェックリスト（Source / Domain / Catalog / Behavior review）を完了する。`TBD` が残らないこと、`status: APPROVED` へ昇格できることを確認する。
4. **Catalog 変換**: テンプレートの YAML ブロックを JSON Catalog ファイルへ変換・格納し、manifest を更新する。

---

## テンプレートから Catalog JSON への変換契約

### ブロック構造とその扱い

テンプレートファイルの各 YAML ブロックには `source` と `definition` の2つのセクションがある。

| セクション | 役割 | Catalog JSON への含め方 |
| --- | --- | --- |
| `source` | authoring 時の参考テキスト・参照先。ソースレビューと監査証跡として保持する | **含めない**。Catalog JSON には出力しない |
| `definition` | ドメイン契約として確定した構造化フィールド | **そのままルートへ展開する**。`definition` キーは使用せず、フィールドを直接ルートに置く |

**例（Skill テンプレートから Catalog JSON への変換）**

テンプレート YAML（`catalog-skill` ブロック）:

```yaml
source:
  sourceSlot: AS1
  level: MAXIMUM
  effectText: >-
    敵単体に物理ダメージを与え、攻撃力を2ターン低下させる。
definition:
  skillDefinitionId: SKL_001_AS1
  skillType: AS
  ...
```

変換後 Catalog JSON（`skills.json` 内の1エントリ）:

```json
{
  "skillDefinitionId": "SKL_001_AS1",
  "skillType": "AS",
  "..."
}
```

### 出典と revision の保持

- **出典（sourceReference）**: テンプレートの `source` セクションに記録する。Skill・Effect 定義では `metadata.sourceReference` フィールドへ保持することで Catalog JSON にも残すことができる（省略可）。Unit・Memory では `metadata.sourceReference` が必須。
- **Catalog revision**: 定義ごとではなく `manifest.json` の `catalogRevision` でカタログ全体を一括管理する。定義エントリに個別の revision フィールドは持たない。

---

## Catalog Manifest

`catalog/manifest.json` を Catalog ルートに置く（[`11_インフラストラクチャ設計.md`](./11_インフラストラクチャ設計.md) Battle Catalog 節と同一契約）。

```json
{
  "schemaVersion": 1,
  "catalogRevision": "2026-06-28.1",
  "files": {
    "units.json":   "sha256:abc123...",
    "skills.json":  "sha256:def456...",
    "effects.json": "sha256:ghi789...",
    "memories.json":"sha256:jkl012..."
  }
}
```

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `schemaVersion` | **integer** | 現バージョン `1` 固定。未知の値はロード時に拒否する |
| `catalogRevision` | string | 不透明な文字列。APIレスポンスへそのまま返す。形式は `YYYY-MM-DD.N` を推奨するが検証しない |
| `files` | object | キーは Catalog ファイル名、値は `"sha256:{hex}"` 形式のハッシュ。必須キー: `units.json`・`skills.json`・`effects.json`・`memories.json` |

ハッシュ検証により不完全な配備・意図しない混在を検出する（`11_インフラストラクチャ設計.md` 参照）。Catalog ファイルは次の構成とする。

```text
catalog/
  manifest.json
  units.json      ← UnitDefinition の配列
  skills.json     ← SkillDefinition の配列（AS / PS / EX を混在）
  effects.json    ← SkillEffectDefinition の配列
  memories.json   ← MemoryDefinition の配列
```

**不正例**

```json
{ "schemaVersion": "1", "catalogRevision": "2025-01-01" }
```

→ `schemaVersion` が文字列のため拒否。

---

## ID 体系と命名規則

### プレフィックス規約

| 種別 | プレフィックス | 例 |
| --- | --- | --- |
| Unit 定義 | `UNIT_` | `UNIT_001` |
| Skill 定義 | `SKL_` | `SKL_001_AS1`、`SKL_001_PS1`、`SKL_001_EX` |
| Skill Effect 定義 | `EFF_` | `EFF_001_DMG`、`EFF_001_DEBUFF` |
| Memory 定義 | `MEM_` | `MEM_001` |

- ID は ASCII 英数字とアンダースコアのみ許可する。
- Catalog 全体で各 ID は一意でなければならない。
- `SKL_{UNIT番号}_{種別}` のような体系的命名を推奨するが、一意性は ID 文字列そのもので保証する（命名を検証ルールとして強制しない）。

---

## Unit 定義スキーマ

### YAML 全体像

```yaml
unitDefinitionId: UNIT_001
attribute: AGGRESSIVE
unitType: PHYSICAL
role: PHYSICAL_ATTACKER
positionAptitudes:
  - FRONT
  - BACK
baseStats:
  maximumHp: 12000
  attack: 3200
  defense: 1500
  criticalRate: 0.20
  actionSpeed: 850
  affinityBonus: 0.05
  criticalDamageBonus: 0.10
  maximumAp: 3
  maximumPp: 10
extraGaugeMaximum: 1000
activeSkillDefinitionIds:
  - SKL_001_AS1
  - SKL_001_AS2
passiveSkillDefinitionIds:
  - SKL_001_PS1
extraSkillDefinitionId: SKL_001_EX
requiredCapabilities: []
metadata:
  displayName: "テストユニット"
  sourceReference: "https://example.com"
  tags: []
```

### フィールド詳細

| フィールド | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `unitDefinitionId` | string | ✓ | Catalog 内で一意 |
| `attribute` | enum | ✓ | → 下表 |
| `unitType` | enum | ✓ | → 下表 |
| `role` | enum | ✓ | → 下表 |
| `positionAptitudes` | enum[] | ✓ | `FRONT` / `BACK` の1件以上 |
| `baseStats` | object | ✓ | 下表の全フィールドを含む |
| `baseStats.maximumHp` | integer | ✓ | >= 1 |
| `baseStats.attack` | integer | ✓ | >= 0 |
| `baseStats.defense` | integer | ✓ | >= 0 |
| `baseStats.criticalRate` | number | ✓ | 割合表現（20% → `0.20`）。判定時のみ 0〜1 に補正 (`R-NUM-03`) |
| `baseStats.actionSpeed` | integer | ✓ | >= 0 |
| `baseStats.affinityBonus` | number | ✓ | 割合表現。有利属性時のみ加算 (`R-ATR-02`) |
| `baseStats.criticalDamageBonus` | number | ✓ | 割合表現。会心倍率に加算 (`R-CRT-02`) |
| `baseStats.maximumAp` | integer | ✓ | >= 1 |
| `baseStats.maximumPp` | integer | ✓ | >= 1 |
| `extraGaugeMaximum` | integer | ✓ | >= 1（`Q-CAT-04` により必須） |
| `activeSkillDefinitionIds` | string[] | ✓ | 1件以上。**順序 = AS 選択優先順** (`R-ACT-02`) |
| `passiveSkillDefinitionIds` | string[] | ✓ | 0件可。**順序 = タイブレーカー** (`R-PS-02`) |
| `extraSkillDefinitionId` | string | ✓ | EX スキル1件 |
| `requiredCapabilities` | string[] | ✓ | 空配列可 |
| `metadata` | object | ✓ | displayName / sourceReference / tags を含む |
| `metadata.displayName` | string | ✓ | 表示名 |
| `metadata.sourceReference` | string | ✓ | 参考 URL またはドキュメント識別子 |
| `metadata.tags` | string[] | ✓ | 空配列可 |

未知プロパティは拒否する（`additionalProperties: false`）。`baseStats` 配下も同様。

### 列挙値

**attribute**

| 値 | 属性 |
| --- | --- |
| `AGGRESSIVE` | アグレッシブ |
| `SHY` | シャイ |
| `CUTE` | キュート |
| `SMART` | スマート |
| `COMICAL` | コミカル（編成ボーナスで最適属性に自動評価, `R-BON-02`） |
| `CLEVER` | クレバー（人数ボーナス累積, `R-BON-03`） |

**unitType**

| 値 | 説明 |
| --- | --- |
| `PHYSICAL` | 物理タイプ |
| `ENERGY` | ENタイプ |
| `AGILE` | 敏捷タイプ |

**role**

| 値 | ロール |
| --- | --- |
| `PHYSICAL_ATTACKER` | 物理アタッカー |
| `EN_ATTACKER` | ENアタッカー |
| `TANK` | タンク |
| `SUPPORT` | サポート |
| `CONTROL` | コントロール |

**positionAptitudes 要素**

| 値 | 意味 |
| --- | --- |
| `FRONT` | 前衛適正あり |
| `BACK` | 後衛適正あり |

---

## Skill 定義スキーマ

### YAML 全体像（共通）

```yaml
skillDefinitionId: SKL_001_AS1
skillType: AS
cost:
  resource: AP
  amount: 3
activationCondition:
  kind: TRUE
targeting:
  kind: SELECT
  side: ENEMY
  count: 1
  method: DEFAULT
  columnPreference: null
  includeDefeated: false
resolution:
  kind: IMMEDIATE
  hitCount: 1
  effectDefinitionIds:
    - EFF_001_DMG
cooldown:
  unit: ACTION
  count: 0
traits:
  guaranteedHit: false
  defensePiercing: false
  priorityAttack: false
  simultaneousActivationLimited: false
passiveTriggers: []
requiredCapabilities: []
metadata:
  sourceReference: "https://example.com"
  tags: []
```

### フィールド詳細

| フィールド | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `skillDefinitionId` | string | ✓ | Catalog 内で一意 |
| `skillType` | enum | ✓ | `AS` \| `PS` \| `EX` |
| `cost` | object | ✓ | |
| `cost.resource` | enum | ✓ | `AS` → `AP`、`PS` → `PP`、`EX` → `EX_GAUGE` |
| `cost.amount` | integer | ✓ | >= 0。EX は全量消費のため Catalog 上は参照値 |
| `activationCondition` | object | ✓ | AS / EX のみ実質的意味あり。PS には `kind: TRUE` を推奨 |
| `targeting` | object | ✓ | → 後述 |
| `resolution` | object | ✓ | |
| `resolution.kind` | enum | ✓ | `IMMEDIATE` \| `CHARGE` |
| `resolution.hitCount` | integer | — | >= 1。省略時 `1`。DAMAGE Effect の繰り返し数 |
| `resolution.effectDefinitionIds` | string[] | ✓ | 1件以上。**順序 = 解決順** (`R-SKL-01`) |
| `cooldown` | object | ✓ | |
| `cooldown.unit` | enum | ✓ | `ACTION` \| `TURN` |
| `cooldown.count` | integer | ✓ | >= 0。`0` = クールタイムなし |
| `traits` | object | ✓ | 4フィールドすべて必須 |
| `traits.guaranteedHit` | boolean | ✓ | 必中。回避を無効化するが暗闇 MISS は受ける |
| `traits.defensePiercing` | boolean | ✓ | 防御貫通 (`R-DMG-03`) |
| `traits.priorityAttack` | boolean | ✓ | 先制攻撃（PS のみ有効, `R-PS-08`） |
| `traits.simultaneousActivationLimited` | boolean | ✓ | 同時発動制限（PS のみ有効, `R-PS-03`） |
| `passiveTriggers` | object[] | ✓ | **PS は1件以上必須**。AS / EX は空配列必須 |
| `requiredCapabilities` | string[] | ✓ | 空配列可 |
| `metadata` | object | — | 省略可。含める場合は `sourceReference`・`tags` を含む |
| `metadata.sourceReference` | string | — | 参考 URL またはドキュメント識別子 |
| `metadata.tags` | string[] | — | 省略可、含める場合は空配列可 |

未知プロパティは拒否する（`additionalProperties: false`）。

### activationCondition（発動条件式）

`R-ACT-02` の AS 使用可否判定で評価する。

| kind | 追加フィールド | 意味 |
| --- | --- | --- |
| `TRUE` | なし | 常に成立 |
| `HP_RATIO_BELOW` | `target`, `threshold` | 対象の現在HP / 最大HP < threshold |
| `HP_RATIO_ABOVE` | `target`, `threshold` | 対象の現在HP / 最大HP > threshold |
| `ALLY_COUNT_BELOW` | `count` | 生存味方数 < count |
| `ENEMY_COUNT_BELOW` | `count` | 生存敵数 < count |
| `AND` | `conditions[]` | 全サブ条件が成立 |
| `OR` | `conditions[]` | いずれかのサブ条件が成立 |

`target` の値: `SELF` / `ANY_ALLY` / `ANY_ENEMY`

```yaml
# 例: 自身の HP が 50% 未満のとき
activationCondition:
  kind: HP_RATIO_BELOW
  target: SELF
  threshold: 0.5
```

### targeting（対象選択定義）

```yaml
# SELECT: 候補から N 体選ぶ（AS / EX の多くで使用）
targeting:
  kind: SELECT
  side: ENEMY           # ENEMY | ALLY | ALL
  count: 1              # integer >= 1, または "ALL"
  method: DEFAULT       # DEFAULT | FARTHEST | ADJACENT | DIRECTLY_AHEAD | COLUMN_PRIORITY
  columnPreference: null  # LEFT | CENTER | RIGHT | FRONT_ROW | BACK_ROW (COLUMN_PRIORITY のみ)
  includeDefeated: false

# SELF: 使用者自身
targeting:
  kind: SELF

# PARTY: 陣営全体（全体バフ / デバフ）
targeting:
  kind: PARTY
  side: ALLY            # ALLY | ENEMY

# TRIGGER_SOURCE: トリガーイベント発生源（PS のみ）
targeting:
  kind: TRIGGER_SOURCE

# TRIGGER_TARGET: トリガーイベント対象（PS のみ）
targeting:
  kind: TRIGGER_TARGET
```

**SELECT.method と R-TGT の対応**

| method | ルール | 意味 |
| --- | --- | --- |
| `DEFAULT` | `R-TGT-02` | マンハッタン距離昇順 → 前列 → 絶対左列 |
| `FARTHEST` | `R-TGT-03` | DEFAULT の逆順 |
| `ADJACENT` | `R-TGT-04` | 第一優先対象から上下左右1マス（陣営境界不越） |
| `DIRECTLY_AHEAD` | `R-TGT-05` | 第一優先対象の同列1マス前。前列は候補なし（スキル発動不能） |
| `COLUMN_PRIORITY` | `R-TGT-06` | `columnPreference` 列を優先 |

**targeting フィールド必須/省略可**

| フィールド | kind=SELECT | kind=SELF | kind=PARTY | kind=TRIGGER_* |
| --- | --- | --- | --- | --- |
| `side` | ✓ | — | ✓ | — |
| `count` | ✓ | — | — | — |
| `method` | ✓ | — | — | — |
| `columnPreference` | method=COLUMN_PRIORITY のみ | — | — | — |
| `includeDefeated` | — (省略時 false) | — | — | — |

### resolution（解決定義）

| kind | 意味 |
| --- | --- |
| `IMMEDIATE` | 通常即時解決 |
| `CHARGE` | チャージスキル（`R-SKL-05`） |

CHARGE の場合は `chargeRelease` フィールドも必須:

```yaml
resolution:
  kind: CHARGE
  hitCount: 1
  effectDefinitionIds:          # チャージ開始時の Effect（省略可、省略時は空）
    - EFF_XXX_CHARGE_START
  chargeRelease:
    hitCount: 2
    effectDefinitionIds:        # チャージ発動時の Effect（1件以上必須）
      - EFF_XXX_CHARGE_RELEASE
```

### passiveTriggers（PS のみ）

PS がどのドメインイベントで発動候補になるかを定義する（[`08_ドメインイベント.md`](./08_ドメインイベント.md) `PassiveTriggerDefinition` 節と同一契約）。

複数トリガーを列挙した場合はいずれか1件が一致すれば候補になる（OR）。

#### 基本構造

```yaml
passiveTriggers:
  - eventType: DamageApplied       # ドメインイベント種別名（PascalCase）
    category: FACT                  # FACT | TIMING（省略時 = 分類を問わない）
    sourceSelector: ANY_ALLY        # イベント発生源の条件（省略時 = 無制限）
    targetSelector: SELF            # イベント対象の条件（省略時 = 無制限）
    predicate:                      # イベント payload や所有者状態への追加条件（省略可）
      field: payload.hpDamage
      op: GT
      value: 0
```

#### eventType 一覧

| eventType | category | 発生タイミング |
| --- | --- | --- |
| `TurnStarted` | FACT | ターン開始時 |
| `ActionStarted` | FACT | 行動開始時 |
| `SkillUseStarting` | TIMING | スキル使用開始前 |
| `SkillUseStarted` | FACT | スキル使用開始後（効果解決前） |
| `SkillUseCompleted` | FACT | スキル使用完了後 |
| `HitConfirmed` | FACT | 命中確認後 |
| `DamageApplied` | FACT | ダメージ適用後 |
| `UnitDefeated` | FACT | ユニット戦闘不能後 |
| `EffectApplied` | FACT | 効果付与後 |
| `TurnCompleting` | TIMING | ターン終了処理中 |

PS の発動タイミングは固定一覧に限定しない。新しいドメインイベントが定義された際は本表へ追記する。

#### sourceSelector / targetSelector

| 値 | 意味 |
| --- | --- |
| `SELF` | PS 所有者 |
| `ALLY` | PS 所有者と同じ陣営の任意ユニット（自身を含む） |
| `ALLY_EXCLUDING_SELF` | PS 所有者と同じ陣営で自身以外 |
| `ENEMY` | PS 所有者と反対陣営の任意ユニット |
| `ANY` | 任意ユニット（陣営問わず） |

省略した場合はその側に制限を設けない。

#### predicate（構造化述語）

イベントの payload フィールドや PS 所有者の現在状態に対する条件を安全な構造化形式で記述する。任意の関数呼び出しや動的コードは許可しない。

**単純述語**（`kind` を省略 = SIMPLE とみなす）

```yaml
predicate:
  field: payload.hpDamage    # ドット記法フィールドパス
  op: GT                      # GT | GTE | LT | LTE | EQ | NEQ
  value: 0                    # 比較値
```

**複合述語**

```yaml
predicate:
  kind: AND                   # AND | OR
  conditions:
    - field: payload.hpDamage
      op: GT
      value: 0
    - field: payload.damageType
      op: EQ
      value: PHYSICAL
```

**predicate で参照できるフィールドパス**

| フィールドパス | イベント | 型 | 意味 |
| --- | --- | --- | --- |
| `payload.hpDamage` | `DamageApplied` | integer | HP へ適用された実ダメージ量。0 = シールド完全吸収 |
| `payload.skillType` | `SkillUseStarting` / `SkillUseCompleted` | string | `ACTIVE` / `PASSIVE` / `EXTRA` |
| `payload.damageType` | `DamageApplied` | string | `PHYSICAL` / `EN` |
| `owner.hpRatio` | 任意 | number | 評価時点での PS 所有者の HP 割合（0.0〜1.0） |

新しいドメインイベントが追加された際は、参照可能なフィールドパスを本表へ追記する。

#### passiveTriggers の記述例

```yaml
# 例1: 敵ユニットが戦闘不能になったとき
passiveTriggers:
  - eventType: UnitDefeated
    targetSelector: ENEMY

# 例2: 自分以外の味方が AS を使用開始したとき
passiveTriggers:
  - eventType: SkillUseStarting
    sourceSelector: ALLY_EXCLUDING_SELF
    predicate:
      field: payload.skillType
      op: EQ
      value: ACTIVE

# 例3: ターン開始時（無条件）
passiveTriggers:
  - eventType: TurnStarted

# 例4: 自身が HP ダメージを受けたとき（シールド完全吸収は除く）
passiveTriggers:
  - eventType: DamageApplied
    category: FACT
    targetSelector: SELF
    predicate:
      field: payload.hpDamage
      op: GT
      value: 0

# 例5: 複数トリガー（いずれかで発動）
passiveTriggers:
  - eventType: SkillUseCompleted
    sourceSelector: ALLY
    predicate:
      field: payload.skillType
      op: EQ
      value: ACTIVE
  - eventType: TurnStarted
```

---

## Effect 定義スキーマ

### 共通フィールド

```yaml
skillEffectDefinitionId: EFF_001_DMG
definitionType: SKILL_EFFECT
kind: DAMAGE
target:
  kind: SKILL_TARGETS
payload: ...
requiredCapabilities: []
```

| フィールド | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `skillEffectDefinitionId` | string | ✓ | Catalog 内で一意 |
| `definitionType` | string | ✓ | `"SKILL_EFFECT"` 固定 |
| `kind` | enum | ✓ | → 種別一覧 |
| `target` | object | ✓ | `{ kind: <target.kind> }` |
| `target.kind` | enum | ✓ | → 下表 |
| `payload` | object | ✓ | kind ごとに異なる（→ 各種別を参照） |
| `requiredCapabilities` | string[] | ✓ | 空配列可 |

未知プロパティは拒否する（`additionalProperties: false`）。payload 内も同様。

**target.kind**

| kind | 意味 |
| --- | --- |
| `SKILL_TARGETS` | スキルが選択した対象（最も一般的） |
| `SKILL_SOURCE` | スキル使用者自身 |
| `ALL_ALLIES` | スキル使用者と同じ陣営の全ユニット |
| `ALL_ENEMIES` | 相手陣営の全ユニット |

### Effect 種別と payload

---

#### `DAMAGE` — ダメージ

対象に HP ダメージを与える（`R-DMG-01`, `R-DMG-02`）。

```yaml
kind: DAMAGE
payload:
  damageType: PHYSICAL    # PHYSICAL | EN（必須）
  power: 1.20             # スキル威力倍率（必須。120% → 1.20）
  hitCount: 1             # ヒット数（省略時 1）
  linkEnabled: false      # リンクダメージを発生させるか（省略時 false）
```

`resolution.hitCount` が N のとき、このEffect が N 回繰り返される。合計ヒット数は `resolution.hitCount × payload.hitCount`。

リンクダメージ（`R-LNK-01`）: `linkEnabled: true` のとき最終ダメージと同量をリンク対象へ発生させる。リンク先での属性・会心・ダメージ増減は再計算しない。リンク先からのさらなるリンクは発生しない（`R-LNK-03`）。

---

#### `APPLY_STAT_MOD` — ステータス補正（バフ / デバフ）

対象のステータスを補正する（`R-STA-01`, `R-STA-02`, `R-STA-03`）。

```yaml
kind: APPLY_STAT_MOD
payload:
  stat: ATTACK            # → stat 一覧参照（必須）
  valueType: RATIO        # RATIO | FIXED（必須）
  value: 0.20             # 正数 = バフ、負数 = デバフ（RATIO は割合表現）（必須）
  stackable: true         # true = 重複あり, false = 重複なし（必須）
  duration:
    unit: ACTION          # ACTION | TURN（必須）
    count: 3              # >= 1（必須）
```

重複なし（`stackable: false`）の `EffectKindKey` は `stat` フィールドで区別する。同一 `stat` かつ `stackable: false` の効果を同種グループとし、最も強い1件だけを計算へ採用する（`R-STA-03`）。

---

#### `APPLY_STUN` — 気絶

対象に気絶を付与する（`R-STS-02`）。

```yaml
kind: APPLY_STUN
payload:
  duration:
    unit: ACTION          # 必須（気絶は行動単位）
    count: 2              # >= 1（必須）
```

再付与時は残り回数が長い方を一つだけ残す。

---

#### `APPLY_FREEZE` — 凍結

対象に凍結を付与する（`R-STS-03`）。

```yaml
kind: APPLY_FREEZE
payload:
  duration:
    unit: TURN            # 必須
    count: 2              # >= 1（必須）
  damageRelease: false    # 攻撃スキルのダメージで解除するか（省略時 false）
```

`damageRelease: true` を使用する定義は `requiredCapabilities: ["Q-EFF-05"]` を必須とする（凍結解除ダメージ増幅率が未確定, Q-EFF-05）。

---

#### `APPLY_BLIND` — 暗闇

対象に暗闇を付与する（`R-STS-04`, `R-HIT-03`）。

```yaml
kind: APPLY_BLIND
payload:
  missRate: 0.30          # MISS 確率 0〜1（必須）
  duration:
    unit: ACTION          # 必須
    count: 2              # >= 1（必須）
```

複数の暗闇は付与順に独立して判定し、確率を合算しない。

---

#### `APPLY_EVASION` — 特別な回避効果

対象に特別な回避効果を付与する（`R-HIT-02`）。

```yaml
kind: APPLY_EVASION
payload:
  evasionRate: 1.0        # 回避確率 0〜1（必須）
  duration:
    unit: ACTION          # 必須
    count: 1              # >= 1（必須）
```

必中スキルには発動しない。チャージ中の対象は自身の回避効果を発動させない。

---

#### `APPLY_SHIELD` — シールド

対象にシールドを付与する（`R-SHD-01`）。

```yaml
kind: APPLY_SHIELD
payload:
  shieldType: PHYSICAL    # PHYSICAL | EN | TYPELESS（必須）
  value: 3000             # シールド付与量（固定値）（必須、>= 1）
  duration:
    unit: TURN            # 必須
    count: 2              # >= 1（必須）
```

同タイプのシールド値は加算する。ダメージ適用順: タイプあり → タイプなし → サブユニット → HP（`R-SHD-02`）。

---

#### `REMOVE_EFFECTS` — 効果解除

対象から指定カテゴリの効果を解除する（`R-EFF-02`）。

```yaml
kind: REMOVE_EFFECTS
payload:
  categories:             # 解除対象カテゴリ（1件以上必須）
    - DEBUFF
  count: null             # 解除数（null = 全解除, integer >= 1 = 指定数）
```

**categories 値**

| 値 | 対象 |
| --- | --- |
| `BUFF` | バフ効果（状態異常以外） |
| `DEBUFF` | デバフ効果（状態異常を含む） |
| `STATUS` | 状態異常のみ（気絶・凍結・暗闇など） |
| `SHIELD` | シールド |

---

#### `EFFECT_IMMUNITY` — 効果無効

対象への指定カテゴリ効果の付与を拒否する（`R-EFF-03`）。

```yaml
kind: EFFECT_IMMUNITY
payload:
  categories:             # 1件以上必須
    - DEBUFF
  duration:
    unit: TURN            # 必須
    count: 2              # >= 1（必須）
```

---

#### `APPLY_DAMAGE_IMMUNITY` — ダメージ無効

対象へのダメージを無効化する。ダメージ発生スキルでは依然として最低1ダメージが発生する（`R-DMG-02`）。

```yaml
kind: APPLY_DAMAGE_IMMUNITY
payload:
  duration:
    unit: ACTION          # 必須
    count: 1              # >= 1（必須）
```

---

#### `APPLY_STEALTH` — ステルス

対象にステルスを付与する（`R-TGT-08`）。

```yaml
kind: APPLY_STEALTH
payload:
  duration:
    unit: ACTION          # 必須
    count: 1              # >= 1（必須）
```

ステルス適用後に代替対象がいない場合（Q-TGT-05）に到達し得る定義は `requiredCapabilities: ["Q-TGT-05"]` を追加すること。

---

#### `CONTINUOUS_DAMAGE_FIXED` — 固定継続ダメージ

対象に固定継続ダメージを付与する（`R-DOT-01`, `R-DOT-02`）。

```yaml
kind: CONTINUOUS_DAMAGE_FIXED
payload:
  damageType: PHYSICAL    # PHYSICAL | EN（必須）
  power: 0.30             # 付与時の付与者攻撃力に対する割合（必須）
  duration:
    unit: ACTION          # 必須
    count: 3              # >= 1（必須）
```

付与時の付与者攻撃力をスナップショットとして記録する。付与後の変化や戦闘不能は計算に影響しない（`R-DOT-01`）。

---

#### `CONTINUOUS_DAMAGE_BURN` — 炎上

対象に炎上を付与する（`R-DOT-01`, `R-DOT-03`）。

```yaml
kind: CONTINUOUS_DAMAGE_BURN
payload:
  damageType: PHYSICAL    # PHYSICAL | EN（必須）
  power: 0.50             # 付与時の付与者攻撃力に対する割合（必須）
  duration:
    unit: ACTION          # 必須
    count: 3              # >= 1（必須）
```

最大3インスタンスまで保持する。3重複到達の可能性がある定義は `requiredCapabilities: ["Q-EFF-06"]` を追加すること（Q-EFF-06）。

---

#### `CONTINUOUS_DAMAGE_POISON` — 毒

対象に毒を付与する（`R-DOT-01`, `R-DOT-04`）。

```yaml
kind: CONTINUOUS_DAMAGE_POISON
payload:
  poisonRate: 0.10        # 現在HP に対する割合（必須）
  attackCapRate: 1.0      # 付与時攻撃力に対する上限割合（必須、通常 1.0）
  duration:
    unit: ACTION          # 必須
    count: 3              # >= 1（必須）
```

毒ダメージはシールドとサブユニットで受けない。既存の毒へ再付与した場合、期間は長い方・効果量は大きい方を引き継いだ1インスタンスを残す（`R-DOT-04`）。

---

#### `APPLY_SUBUNIT` — サブユニット

所持者の攻撃に追加ダメージを付与する（`R-SUB-01`, `R-SUB-02`）。

```yaml
kind: APPLY_SUBUNIT
payload:
  hp: 5000                # サブユニット耐久値（必須、>= 1）
  additionalPower: 0.20   # 追加ダメージ倍率（必須）
  damageType: PHYSICAL    # PHYSICAL | EN（必須）
```

所持者の攻撃力が対象の防御力を下回る場合の特殊減衰式（Q-EFF-04）は未確定のため、その条件に到達し得る定義は `requiredCapabilities: ["Q-EFF-04"]` を追加すること。

---

### stat 一覧（APPLY_STAT_MOD で使用）

| stat | 意味 | baseStats フィールド |
| --- | --- | --- |
| `HP` | 最大 HP | `maximumHp` |
| `ATTACK` | 攻撃力 | `attack` |
| `DEFENSE` | 防御力 | `defense` |
| `CRITICAL_RATE` | 会心率 | `criticalRate` |
| `ACTION_SPEED` | 行動速度 | `actionSpeed` |
| `AFFINITY_BONUS` | 属性相性ボーナス | `affinityBonus` |
| `CRITICAL_DAMAGE_BONUS` | 会心ダメージボーナス | `criticalDamageBonus` |

---

## Memory 定義スキーマ

### YAML 全体像

```yaml
memoryDefinitionId: MEM_001
modifiers:
  - targetFilter:
      kind: ALL
    stat: ATTACK
    valueType: RATIO
    value: 0.04
requiredCapabilities: []
metadata:
  displayName: "テストメモリー"
  sourceReference: "https://example.com"
  tags: []
```

### フィールド詳細

| フィールド | 型 | 必須 | 制約 |
| --- | --- | --- | --- |
| `memoryDefinitionId` | string | ✓ | Catalog 内で一意 |
| `modifiers` | object[] | ✓ | 1件以上 |
| `modifiers[].targetFilter` | object | ✓ | → 下記参照 |
| `modifiers[].stat` | enum | ✓ | → stat 一覧参照 |
| `modifiers[].valueType` | enum | ✓ | `RATIO` \| `FIXED` |
| `modifiers[].value` | number | ✓ | > 0（補正量）。割合の場合は割合表現（4% → `0.04`） |
| `requiredCapabilities` | string[] | ✓ | 空配列可 |
| `metadata` | object | ✓ | |
| `metadata.displayName` | string | ✓ | 表示名 |
| `metadata.sourceReference` | string | ✓ | 参考 URL またはドキュメント識別子 |
| `metadata.tags` | string[] | ✓ | 空配列可 |

未知プロパティは拒否する（`additionalProperties: false`）。

### valueType

| valueType | 適用規則 |
| --- | --- |
| `RATIO` | 重複ありバフとして戦闘中割合補正へ加算（`R-STA-02`, `Q-STA-03`） |
| `FIXED` | 乗算後に加算するメモリー固定値補正（`R-STA-01`, `Q-STA-03`） |

### targetFilter

Memory 補正が適用される味方ユニットを絞り込む。

```yaml
# 全味方
targetFilter:
  kind: ALL

# 指定ロールの味方のみ
targetFilter:
  kind: ROLE
  role: PHYSICAL_ATTACKER

# 指定属性の味方のみ
targetFilter:
  kind: ATTRIBUTE
  attribute: AGGRESSIVE

# 指定ユニットタイプの味方のみ
targetFilter:
  kind: UNIT_TYPE
  unitType: PHYSICAL

# 前衛の味方のみ
targetFilter:
  kind: POSITION_ROW
  row: FRONT              # FRONT | BACK

# AND 条件
targetFilter:
  kind: AND
  conditions:
    - kind: ROLE
      role: PHYSICAL_ATTACKER
    - kind: UNIT_TYPE
      unitType: PHYSICAL
```

**targetFilter フィールド必須/省略可**

| フィールド | ALL | ROLE | ATTRIBUTE | UNIT_TYPE | POSITION_ROW | AND |
| --- | --- | --- | --- | --- | --- | --- |
| `role` | — | ✓ | — | — | — | — |
| `attribute` | — | — | ✓ | — | — | — |
| `unitType` | — | — | — | ✓ | — | — |
| `row` | — | — | — | — | ✓ | — |
| `conditions` | — | — | — | — | — | ✓（1件以上） |

---

## Capability 体系

### 目的

実装済みの機能セットを Capability ID で管理し、未実装 Capability を参照する定義を含む編成を `SimulationPreflightValidator` が戦闘開始前に拒否する（[`11_インフラストラクチャ設計.md`](./11_インフラストラクチャ設計.md) 保留仕様の表現節と同一契約）。

Capability ID には既存の **保留論点 ID**（`Q-*`）をそのまま使用する。

### 保留4仕様に対応する Capability

| Capability ID | 保留仕様 | 未確定内容 |
| --- | --- | --- |
| `Q-TGT-05` | ステルス適用後に代替対象がいない場合 | 元の対象へ発動するか、スキルを不発にするか |
| `Q-EFF-04` | サブユニット追加ダメージの特殊減衰式 | 攻撃力 ≤ 防御力のときの計算式 |
| `Q-EFF-05` | 凍結解除時の被ダメージ増幅率 | 固定値とするか、効果ごとの定義値とするか |
| `Q-EFF-06` | 炎上3重複時の2倍処理 | 合計ダメージを2倍か、各炎上ダメージを2倍か |

これら4件は M1 以降の段階では **未実装** であり、`ImplementedCapabilities` 集合に含めない。仕様が確定した時点で `02_仕様確認事項.md` の保留から決定事項へ移し、Capability を実装済み集合へ追加する。

### requiredCapabilities の配置場所

| 配置場所 | 意味 |
| --- | --- |
| `UnitDefinition.requiredCapabilities` | そのユニットを編成に含めるだけで必要な Capability |
| `SkillDefinition.requiredCapabilities` | そのスキルを保持するユニットを編成に含めるだけで必要な Capability |
| `SkillEffectDefinition.requiredCapabilities` | その Effect を解決するために必要な Capability |
| `MemoryDefinition.requiredCapabilities` | そのメモリーを編成に含めるだけで必要な Capability |

`SimulationPreflightValidator` は編成に含まれる全定義の推移的グラフを走査し、未実装 Capability を1つでも発見した場合に対象 ID を添えて `UNSUPPORTED_RULE` を返す。

---

## 参照整合性規則

Catalog 検証器（M1）は次をすべて確認する。

1. **ID 一意性**: Catalog 全体で各 ID が重複しない（`units.json`・`skills.json`・`effects.json`・`memories.json` をまたいで一意）。
2. **参照解決**:
   - `Unit.activeSkillDefinitionIds` の各 ID が `skills.json` に存在し `skillType: AS` を持つ。
   - `Unit.passiveSkillDefinitionIds` の各 ID が `skills.json` に存在し `skillType: PS` を持つ。
   - `Unit.extraSkillDefinitionId` が `skills.json` に存在し `skillType: EX` を持つ。
   - `Skill.resolution.effectDefinitionIds` の各 ID が `effects.json` に存在する。
   - CHARGE スキルの `resolution.chargeRelease.effectDefinitionIds` も同様。
3. **passiveTriggers 存在**: `skillType: PS` の定義は `passiveTriggers` を1件以上持つ。`skillType: AS` / `EX` の定義は `passiveTriggers: []`。
4. **cost.resource 整合性**: AS → `AP`、PS → `PP`、EX → `EX_GAUGE`。
5. **Manifest 完全性**: `files` の4ファイル全てが存在し、ハッシュが一致する。各ファイルの内容が JSON 配列であること。

---

## 定義順の意味

### Unit.activeSkillDefinitionIds

`R-ACT-02` の「定義順で最初に使用可能なものを選ぶ」に対応する。**インデックス 0 が最優先 AS**。順序変更は戦闘結果に影響するためレビューを要する。

### Unit.passiveSkillDefinitionIds

同一ユニットの複数 PS が同じイベントで候補になった場合の `R-PS-02` タイブレーカーに使用する。**インデックス 0 が最優先**。

### Skill.resolution.effectDefinitionIds

`R-SKL-01` の「効果を定義順に解決する」に対応する。**インデックス 0 の Effect から順に解決**し、各 Effect 後に PS 連鎖を照合する。

### passiveTriggers の順序

複数トリガーは OR 評価のため発動優先順に影響しない。デバッグ上、主要なトリガーを先頭に置くことを推奨する。

---

## Schema Version と Catalog Revision

### schemaVersion

Catalog ファイル構造バージョン（`11_インフラストラクチャ設計.md` と同一契約）。

- **型**: **integer**（文字列は不正）
- 現バージョン: `1`
- 未知の値はロード時に拒否する
- 破壊的な構造変更時にインクリメントする

### catalogRevision

Catalog コンテンツの版識別子。APIレスポンスへそのまま返す不透明な文字列。

- **型**: string
- 形式を検証しない（`YYYY-MM-DD.N` 形式を推奨）
- Worker 初期化時に全ファイルのハッシュを再検証し、manifest と不一致の場合は起動失敗とする
- 異なる revision の Catalog が同一 Worker プール内に混在することを防ぐ

---

## 変換ルール（Authoring 判断基準）

Markdown から Catalog へ変換する際の標準換算ルール（`catalog-decisions` ブロックの `ruleId` として記入する）。

| ruleId | 内容 |
| --- | --- |
| `PERCENTAGE_POINT_TO_RATIO` | ゲーム表記 N% を内部値 N÷100 に変換（20% → `0.20`） |
| `ACTION_SPEED_DIRECT` | 行動速度は表記値をそのまま使用 |
| `STAT_DIRECT` | HP・攻撃力・防御力は表記値をそのまま整数で使用 |
| `EXTRA_GAUGE_DIRECT` | EXゲージ最大値は表記値をそのまま整数で使用（`Q-CAT-04`） |

---

## 正常・不正 JSON 例

### 正常例: 最小 Unit

```json
{
  "unitDefinitionId": "UNIT_001",
  "attribute": "AGGRESSIVE",
  "unitType": "PHYSICAL",
  "role": "PHYSICAL_ATTACKER",
  "positionAptitudes": ["FRONT", "BACK"],
  "baseStats": {
    "maximumHp": 12000,
    "attack": 3200,
    "defense": 1500,
    "criticalRate": 0.20,
    "actionSpeed": 850,
    "affinityBonus": 0.05,
    "criticalDamageBonus": 0.10,
    "maximumAp": 3,
    "maximumPp": 10
  },
  "extraGaugeMaximum": 1000,
  "activeSkillDefinitionIds": ["SKL_001_AS1"],
  "passiveSkillDefinitionIds": ["SKL_001_PS1"],
  "extraSkillDefinitionId": "SKL_001_EX",
  "requiredCapabilities": [],
  "metadata": {
    "displayName": "テストユニット",
    "sourceReference": "internal",
    "tags": []
  }
}
```

### 正常例: AS（物理1ヒットダメージ + 攻撃デバフ）

```json
{
  "skillDefinitionId": "SKL_001_AS1",
  "skillType": "AS",
  "cost": { "resource": "AP", "amount": 3 },
  "activationCondition": { "kind": "TRUE" },
  "targeting": {
    "kind": "SELECT",
    "side": "ENEMY",
    "count": 1,
    "method": "DEFAULT",
    "columnPreference": null,
    "includeDefeated": false
  },
  "resolution": {
    "kind": "IMMEDIATE",
    "hitCount": 1,
    "effectDefinitionIds": ["EFF_001_DMG", "EFF_001_ATK_DEBUFF"]
  },
  "cooldown": { "unit": "ACTION", "count": 0 },
  "traits": {
    "guaranteedHit": false,
    "defensePiercing": false,
    "priorityAttack": false,
    "simultaneousActivationLimited": false
  },
  "passiveTriggers": [],
  "requiredCapabilities": []
}
```

### 正常例: PS（味方AS使用開始時に自己攻撃バフ）

```json
{
  "skillDefinitionId": "SKL_001_PS1",
  "skillType": "PS",
  "cost": { "resource": "PP", "amount": 3 },
  "activationCondition": { "kind": "TRUE" },
  "targeting": { "kind": "SELF" },
  "resolution": {
    "kind": "IMMEDIATE",
    "hitCount": 1,
    "effectDefinitionIds": ["EFF_001_SELF_ATK_BUFF"]
  },
  "cooldown": { "unit": "ACTION", "count": 2 },
  "traits": {
    "guaranteedHit": false,
    "defensePiercing": false,
    "priorityAttack": false,
    "simultaneousActivationLimited": false
  },
  "passiveTriggers": [
    {
      "eventType": "SkillUseStarting",
      "sourceSelector": "ALLY_EXCLUDING_SELF",
      "predicate": {
        "field": "payload.skillType",
        "op": "EQ",
        "value": "ACTIVE"
      }
    }
  ],
  "requiredCapabilities": []
}
```

### 正常例: Effect（DAMAGE）

```json
{
  "skillEffectDefinitionId": "EFF_001_DMG",
  "definitionType": "SKILL_EFFECT",
  "kind": "DAMAGE",
  "target": { "kind": "SKILL_TARGETS" },
  "payload": {
    "damageType": "PHYSICAL",
    "power": 1.20,
    "hitCount": 1,
    "linkEnabled": false
  },
  "requiredCapabilities": []
}
```

### 正常例: Memory（PHYSICAL_ATTACKER の攻撃力+4%）

```json
{
  "memoryDefinitionId": "MEM_001",
  "modifiers": [
    {
      "targetFilter": { "kind": "ROLE", "role": "PHYSICAL_ATTACKER" },
      "stat": "ATTACK",
      "valueType": "RATIO",
      "value": 0.04
    }
  ],
  "requiredCapabilities": [],
  "metadata": {
    "displayName": "テストメモリー",
    "sourceReference": "internal",
    "tags": []
  }
}
```

### 不正例一覧

| 不正内容 | 具体例 |
| --- | --- |
| `schemaVersion` が文字列 | `"schemaVersion": "1"` |
| Manifest に `files` ではなく ID 配列を使用 | `"unitDefinitionIds": [...]` |
| PS が `passiveTriggers` を持たない | `skillType: "PS"` かつ `passiveTriggers: []` |
| AS が `passiveTriggers` を持つ | `skillType: "AS"` かつ `passiveTriggers: [{...}]` |
| AS の `cost.resource` が `AP` 以外 | `"resource": "PP"` |
| 存在しない Skill ID を参照 | `activeSkillDefinitionIds: ["SKL_UNKNOWN"]` |
| PS ID が `activeSkillDefinitionIds` に含まれる | skillType: PS の ID を activeSkillDefinitionIds に記載 |
| passiveTriggers に `conditions` を使用（旧形式） | `conditions: [{ kind: "SOURCE_SIDE", value: "ALLY" }]` |
| predicate に動的コードを使用 | `"predicate": "eval('...')"` |
| 未実装 Capability を持つ定義を含む編成 | `requiredCapabilities: ["Q-EFF-05"]` を持つ定義を使う |
| 未知の `schemaVersion` | `"schemaVersion": 999` |
| Catalog 内で重複する ID | 同じ `unitDefinitionId` が2エントリに存在 |
| 未知プロパティ | `{ "unitDefinitionId": "UNIT_001", "unknownField": "x" }` |

---

## 次の設計への申し送り

実装（M1）で具体化が必要な項目を示す。

- manifest ハッシュ計算の具体的アルゴリズム（現在は `sha256:{hex}` 形式を指定; hex エンコードの大文字/小文字を統一すること）
- `EffectKindKey` の実装上の識別子（`stat` フィールド値をキーとする場合の型定義）
- `APPLY_STAT_MOD` の `FIXED` valueType を Memory 以外の Skill Effect で使う場合の `R-STA-01` 計算順の確認
- predicate `field` パスの型安全な解釈方法（JSON Pointer / dot-notation のいずれか、実装時に確定）
- 将来追加しうる Effect 種別（HP 回復・AP/PP 回復・EXゲージ操作など）は本スキーマを拡張して追加する。破壊的変更時は `schemaVersion` をインクリメントする
- passiveTriggers の `eventType` 一覧は `08_ドメインイベント.md` と同期を維持する。新規ドメインイベント追加時は両文書を同時更新すること
