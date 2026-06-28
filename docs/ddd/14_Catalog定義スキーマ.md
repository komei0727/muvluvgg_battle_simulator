# Catalog 定義スキーマ

## 目的

本書は、Catalog 実装（M1）に先行して Unit・Skill・Effect・Memory の JSON 契約を確定する。

- 実装者が推測なしで JSON Schema を作成できる
- 保留4仕様を Capability として表現・隔離できる
- 定義順と参照型の意味を一元管理できる

前提文書: [`05_ドメインモデル.md`](./05_ドメインモデル.md)・[`07_戦闘ルール詳細.md`](./07_戦闘ルール詳細.md)

---

## Authoring ワークフロー

Unit・Memory の実データを Catalog へ投入する手順は次のとおりとする。

1. **自然言語転記**: Unit または Memory ごとに、参考資料からスキル効果・ステータス・数値を `docs/units/` または `docs/memories/` 配下の Markdown へ自然文として書き出す。
2. **テンプレート構造化**: `docs/templates/Unit定義テンプレート.md` または `docs/templates/Memory定義テンプレート.md` を複製し、前ステップの内容を `catalog-unit` / `catalog-skill` / `catalog-effect` / `catalog-memory` YAML ブロックへ転記する。換算が生じた場合は `catalog-decisions` ブロックへ根拠を記録する。
3. **レビュー**: テンプレートのチェックリスト（Source / Domain / Catalog / Behavior review）を完了する。`TBD` が残らないこと、`status: APPROVED` へ昇格できることを確認する。
4. **Catalog 変換**: テンプレートの YAML ブロックを JSON Catalog ファイルへ変換・格納し、manifest を更新する。

---

## Catalog Manifest

Catalog ルートディレクトリに `catalog.manifest.json` を置く。

```json
{
  "schemaVersion": "1",
  "catalogRevision": "2025-01-01-a",
  "unitDefinitionIds": ["UNIT_001"],
  "skillDefinitionIds": ["SKL_001_AS1", "SKL_001_PS1", "SKL_001_EX"],
  "skillEffectDefinitionIds": ["EFF_001_DMG", "EFF_001_DEBUFF"],
  "memoryDefinitionIds": ["MEM_001"]
}
```

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `schemaVersion` | string | 現バージョン `"1"` 固定。未知の値はロード時に拒否する。 |
| `catalogRevision` | string | `YYYY-MM-DD` または `YYYY-MM-DD-[suffix]` 形式。 |
| `unitDefinitionIds` | string[] | Catalog 内の全 Unit 定義 ID を列挙する。 |
| `skillDefinitionIds` | string[] | Catalog 内の全 Skill 定義 ID を列挙する。 |
| `skillEffectDefinitionIds` | string[] | Catalog 内の全 Effect 定義 ID を列挙する。 |
| `memoryDefinitionIds` | string[] | Catalog 内の全 Memory 定義 ID を列挙する。 |

Manifest に列挙された全 ID に対応するファイルが存在すること、かつファイル内 ID と一致することを検証する。逆方向（ファイルが manifest に含まれない）も同様に検出する。

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

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `unitDefinitionId` | string | Catalog 内で一意 |
| `attribute` | enum | → 下表 |
| `unitType` | enum | → 下表 |
| `role` | enum | → 下表 |
| `positionAptitudes` | enum[] | `FRONT`・`BACK` の1件以上。適正外配置では HP・攻撃力・防御力が5%低下 (`R-STA-01`) |
| `baseStats.maximumHp` | integer | >= 1 |
| `baseStats.attack` | integer | >= 0 |
| `baseStats.defense` | integer | >= 0 |
| `baseStats.criticalRate` | number | 割合表現（20% → `0.20`）。上限・下限なし（判定時のみ 0〜1 に補正, `R-NUM-03`） |
| `baseStats.actionSpeed` | integer | >= 0 |
| `baseStats.affinityBonus` | number | 割合表現。有利属性ダメージ倍率に加算 (`R-ATR-02`) |
| `baseStats.criticalDamageBonus` | number | 割合表現。会心倍率に加算 (`R-CRT-02`) |
| `baseStats.maximumAp` | integer | >= 1 |
| `baseStats.maximumPp` | integer | >= 1 |
| `extraGaugeMaximum` | integer | >= 1。`Q-CAT-04` により必須項目 |
| `activeSkillDefinitionIds` | string[] | **定義順 = AS 選択優先順**（`R-ACT-02`）。1件以上 |
| `passiveSkillDefinitionIds` | string[] | **定義順 = タイブレーカー優先順**（`R-PS-02`）。0件可 |
| `extraSkillDefinitionId` | string | 1件必須 |
| `requiredCapabilities` | string[] | このユニットを戦闘に参加させるだけで必要な Capability |
| `metadata.displayName` | string | 表示名 |
| `metadata.sourceReference` | string | 参考 URL またはドキュメント識別子 |
| `metadata.tags` | string[] | 任意タグ |

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
```

### フィールド詳細

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `skillDefinitionId` | string | Catalog 内で一意 |
| `skillType` | enum | `AS` \| `PS` \| `EX` |
| `cost.resource` | enum | `AS` → `AP`、`PS` → `PP`、`EX` → `EX_GAUGE` |
| `cost.amount` | integer | >= 0。EX は全量消費のため Catalog 上は参照値 |
| `activationCondition` | object | AS / EX のみ実質的な意味を持つ。PS では `kind: TRUE` を推奨 |
| `targeting` | object | 対象選択定義 |
| `resolution.kind` | enum | `IMMEDIATE` \| `CHARGE` |
| `resolution.hitCount` | integer | >= 1。DAMAGE Effect の繰り返し数（`R-SKL-03`）。省略時 `1` |
| `resolution.effectDefinitionIds` | string[] | **定義順 = 解決順**（`R-SKL-01`）。1件以上 |
| `cooldown.unit` | enum | `ACTION` \| `TURN` |
| `cooldown.count` | integer | >= 0。`0` = クールタイムなし |
| `traits.guaranteedHit` | boolean | 必中（特別な回避を発動させない）。暗闇 MISS は受ける（`R-HIT-02`, `R-HIT-03`） |
| `traits.defensePiercing` | boolean | 防御貫通（シールドとダメージ軽減を無視, `R-DMG-03`） |
| `traits.priorityAttack` | boolean | 先制攻撃（PS のみ有効, `R-PS-08`） |
| `traits.simultaneousActivationLimited` | boolean | 同時発動制限（PS のみ有効, `R-PS-03`） |
| `passiveTriggers` | object[] | **PS は1件以上必須**。AS / EX は空配列必須 |
| `requiredCapabilities` | string[] | このスキルを保持するユニットが戦闘に参加するだけで必要な Capability |

### cost.resource と skillType の対応

| skillType | resource |
| --- | --- |
| `AS` | `AP` |
| `PS` | `PP` |
| `EX` | `EX_GAUGE` |

### activationCondition（発動条件式）

`R-ACT-02` の AS 使用可否判定で評価する条件式。

```yaml
# 常に発動可能
activationCondition:
  kind: TRUE

# 自身の HP が 50% 未満のとき
activationCondition:
  kind: HP_RATIO_BELOW
  target: SELF
  threshold: 0.5

# 生存味方数が2体未満のとき
activationCondition:
  kind: ALLY_COUNT_BELOW
  count: 2

# 複合条件（AND）
activationCondition:
  kind: AND
  conditions:
    - kind: HP_RATIO_BELOW
      target: SELF
      threshold: 0.5
    - kind: ENEMY_COUNT_BELOW
      count: 3
```

**kind 一覧**

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

### targeting（対象選択定義）

```yaml
# N 体選択（多くの AS / EX）
targeting:
  kind: SELECT
  side: ENEMY        # ENEMY | ALLY | ALL
  count: 1           # integer >= 1, または "ALL"
  method: DEFAULT    # DEFAULT | FARTHEST | ADJACENT | DIRECTLY_AHEAD | COLUMN_PRIORITY
  columnPreference: null  # LEFT | CENTER | RIGHT | FRONT_ROW | BACK_ROW (COLUMN_PRIORITY のみ)
  includeDefeated: false

# 使用者自身（自己バフなど）
targeting:
  kind: SELF

# 陣営全体（全体バフ / デバフ）
targeting:
  kind: PARTY
  side: ALLY         # ALLY | ENEMY

# 発動トリガーのイベント発生源（PS のみ）
targeting:
  kind: TRIGGER_SOURCE

# 発動トリガーのイベント対象（PS のみ）
targeting:
  kind: TRIGGER_TARGET
```

**method と R-TGT の対応**

| method | ルール | 意味 |
| --- | --- | --- |
| `DEFAULT` | `R-TGT-02` | マンハッタン距離昇順 → 前列 → 絶対左列 |
| `FARTHEST` | `R-TGT-03` | DEFAULT の逆順 |
| `ADJACENT` | `R-TGT-04` | 第一優先対象から上下左右1マス |
| `DIRECTLY_AHEAD` | `R-TGT-05` | 第一優先対象と同列の1マス前。前列の場合は候補なし（スキル発動不能） |
| `COLUMN_PRIORITY` | `R-TGT-06` | columnPreference で指定した列を優先 |

`DIRECTLY_AHEAD` を使うスキルが、代替対象なしのステルス絡みで保留仕様（Q-TGT-05）に到達し得る場合は `CAP_TGT_STEALTH_NO_FALLBACK` を `requiredCapabilities` へ追加する。

### resolution.kind

| kind | 意味 |
| --- | --- |
| `IMMEDIATE` | 通常即時解決 |
| `CHARGE` | チャージスキル（`R-SKL-05`）。チャージ開始時と発動時で別の Effect リストを定義する |

**CHARGE 構造**

```yaml
resolution:
  kind: CHARGE
  hitCount: 1
  effectDefinitionIds:          # チャージ開始時の Effect（省略時は空）
    - EFF_XXX_CHARGE_START
  chargeRelease:
    hitCount: 2
    effectDefinitionIds:        # チャージ発動時の Effect（1件以上必須）
      - EFF_XXX_CHARGE_RELEASE
```

### passiveTriggers（PS のみ）

PS がどのドメインイベントで発動候補になるかを定義する。複数トリガーを列挙した場合はいずれかが一致すれば候補になる（OR）。同一トリガー内の `conditions` は全件 AND 評価する。

```yaml
passiveTriggers:
  - eventKind: SKILL_USE_STARTING
    conditions:
      - kind: SOURCE_SIDE
        value: ALLY
      - kind: SOURCE_IS_NOT_SELF
      - kind: EVENT_SKILL_TYPE
        value: AS
```

**eventKind 一覧**

| eventKind | 発生タイミング |
| --- | --- |
| `TURN_STARTED` | ターン開始時 |
| `ACTION_STARTED` | 行動開始時 |
| `SKILL_USE_STARTING` | スキル使用開始前 |
| `SKILL_USE_COMPLETED` | スキル使用完了後 |
| `HIT_CONFIRMED` | 命中確認後 |
| `DAMAGE_APPLIED` | ダメージ適用後 |
| `UNIT_DEFEATED` | ユニット戦闘不能後 |
| `EFFECT_APPLIED` | 効果付与後 |
| `TURN_COMPLETING` | ターン終了処理中 |

**condition kind 一覧**

| kind | 追加フィールド | 意味 |
| --- | --- | --- |
| `SOURCE_SIDE` | `value: ALLY\|ENEMY\|ANY` | イベント発生源の陣営 |
| `TARGET_SIDE` | `value: ALLY\|ENEMY\|ANY` | イベント対象の陣営 |
| `SOURCE_IS_SELF` | なし | 発生源がこの PS 所有者 |
| `TARGET_IS_SELF` | なし | 対象がこの PS 所有者 |
| `SOURCE_IS_NOT_SELF` | なし | 発生源がこの PS 所有者以外 |
| `TARGET_IS_NOT_SELF` | なし | 対象がこの PS 所有者以外 |
| `EVENT_SKILL_TYPE` | `value: AS\|PS\|EX` | 関連するスキルの種別 |
| `EVENT_DAMAGE_TYPE` | `value: PHYSICAL\|EN` | ダメージタイプ |
| `OWNER_HP_RATIO_BELOW` | `threshold: 0.5` | 所有者の HP 割合 < threshold（trigger 評価時点） |
| `OWNER_HP_RATIO_ABOVE` | `threshold: 0.5` | 所有者の HP 割合 > threshold（trigger 評価時点） |

**passiveTriggers の記述例**

```yaml
# 例1: 敵ユニットが戦闘不能になったとき
passiveTriggers:
  - eventKind: UNIT_DEFEATED
    conditions:
      - kind: TARGET_SIDE
        value: ENEMY

# 例2: 自分以外の味方がASを使用開始したとき（自分のAS使用は対象外）
passiveTriggers:
  - eventKind: SKILL_USE_STARTING
    conditions:
      - kind: SOURCE_SIDE
        value: ALLY
      - kind: SOURCE_IS_NOT_SELF
      - kind: EVENT_SKILL_TYPE
        value: AS

# 例3: ターン開始時（無条件）
passiveTriggers:
  - eventKind: TURN_STARTED
    conditions: []

# 例4: 自身がダメージを受けたとき
passiveTriggers:
  - eventKind: DAMAGE_APPLIED
    conditions:
      - kind: TARGET_IS_SELF
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
  damageType: PHYSICAL    # PHYSICAL | EN
  power: 1.20             # スキル威力倍率（120% → 1.20）
  hitCount: 1             # ヒット数（省略時 1）。resolution.hitCount と組み合わせる
  linkEnabled: false      # リンクダメージを発生させるか（R-LNK-01）
```

`resolution.hitCount` が N のとき、この Effect が N 回繰り返される。1回あたりのヒット数が `payload.hitCount` で、合計ヒット数は `resolution.hitCount × payload.hitCount` となる。

リンクダメージ（Q-EFF-03, `R-LNK-01`）: `linkEnabled: true` のとき、最終ダメージと同量をリンク対象へ発生させる。リンク先での属性・会心・ダメージ増減は再計算しない。リンク先からさらにリンクを発生させない（`R-LNK-03`）。

---

#### `APPLY_STAT_MOD` — ステータス補正（バフ / デバフ）

対象のステータスを補正する（`R-STA-01`, `R-STA-02`, `R-STA-03`）。

```yaml
kind: APPLY_STAT_MOD
payload:
  stat: ATTACK            # → stat 一覧参照
  valueType: RATIO        # RATIO | FIXED
  value: 0.20             # 正数 = バフ、負数 = デバフ（RATIO のとき割合表現）
  stackable: true         # true = 重複あり（R-STA-02）、false = 重複なし（R-STA-03）
  duration:
    unit: ACTION          # ACTION | TURN
    count: 3              # >= 1
```

重複なし（`stackable: false`）効果の `EffectKindKey` は `stat` フィールドで区別する。同一 `stat` の重複なし効果は同種グループとして扱い、最も強い1件だけを計算へ採用する（`R-STA-03`）。

---

#### `APPLY_STUN` — 気絶

対象に気絶を付与する（`R-STS-02`）。

```yaml
kind: APPLY_STUN
payload:
  duration:
    unit: ACTION
    count: 2              # 待機回数（対象自身のアクティブ行動機会を消費）
```

再付与時は残り回数が長い方を一つだけ残す。

---

#### `APPLY_FREEZE` — 凍結

対象に凍結を付与する（`R-STS-03`）。

```yaml
kind: APPLY_FREEZE
payload:
  duration:
    unit: TURN
    count: 2
  damageRelease: false    # 攻撃スキルのダメージで解除するか
```

`damageRelease: true` を使用する定義は、凍結解除ダメージの増幅率（Q-EFF-05）が未定のため `requiredCapabilities` に `CAP_EFF_FREEZE_AMPLIFICATION` を追加すること。

---

#### `APPLY_BLIND` — 暗闇

対象に暗闇を付与する（`R-STS-04`, `R-HIT-03`）。

```yaml
kind: APPLY_BLIND
payload:
  missRate: 0.30          # MISS 確率（0〜1）
  duration:
    unit: ACTION
    count: 2
```

複数の暗闇を付与順に独立して処理し、確率を加算・合算しない（`R-HIT-03`）。

---

#### `APPLY_EVASION` — 特別な回避効果

対象に特別な回避効果を付与する（`R-HIT-02`）。

```yaml
kind: APPLY_EVASION
payload:
  evasionRate: 1.0        # 回避確率（0〜1）
  duration:
    unit: ACTION
    count: 1
```

必中スキルには発動しない。チャージ中の所有者には自身の回避効果を発動させない。

---

#### `APPLY_SHIELD` — シールド

対象にシールドを付与する（`R-SHD-01`）。

```yaml
kind: APPLY_SHIELD
payload:
  shieldType: PHYSICAL    # PHYSICAL | EN | TYPELESS
  value: 3000             # シールド付与量（固定値）
  duration:
    unit: TURN
    count: 2
```

同じタイプのシールド付与値は加算する。タイプあり → タイプなし → サブユニット → HP の順でダメージを受ける（`R-SHD-02`）。

---

#### `REMOVE_EFFECTS` — 効果解除

対象から指定カテゴリの効果を解除する（`R-EFF-02`）。

```yaml
kind: REMOVE_EFFECTS
payload:
  categories:
    - DEBUFF              # BUFF | DEBUFF | STATUS | SHIELD
  count: null             # 解除数（null = 全解除）
```

**categories 値**

| 値 | 対象 |
| --- | --- |
| `BUFF` | バフ効果（状態異常以外） |
| `DEBUFF` | デバフ効果（状態異常を含む） |
| `STATUS` | 状態異常のみ（気絶・凍結・暗闇など） |
| `SHIELD` | シールド（`R-SHD-01`） |

---

#### `EFFECT_IMMUNITY` — 効果無効

対象への指定カテゴリ効果の付与を拒否する（`R-EFF-03`）。

```yaml
kind: EFFECT_IMMUNITY
payload:
  categories:
    - DEBUFF
  duration:
    unit: TURN
    count: 2
```

---

#### `APPLY_DAMAGE_IMMUNITY` — ダメージ無効

対象へのダメージを無効化する。ダメージを発生させる攻撃では依然として最低1ダメージが発生する（`R-DMG-02`）。

```yaml
kind: APPLY_DAMAGE_IMMUNITY
payload:
  duration:
    unit: ACTION
    count: 1
```

---

#### `APPLY_STEALTH` — ステルス

対象にステルスを付与する（`R-TGT-08`）。

```yaml
kind: APPLY_STEALTH
payload:
  duration:
    unit: ACTION
    count: 1
```

ステルス適用後に代替対象がいないケース（Q-TGT-05）に到達し得る定義は `requiredCapabilities` に `CAP_TGT_STEALTH_NO_FALLBACK` を追加すること。

---

#### `CONTINUOUS_DAMAGE_FIXED` — 固定継続ダメージ

対象に固定継続ダメージを付与する（`R-DOT-01`, `R-DOT-02`）。

```yaml
kind: CONTINUOUS_DAMAGE_FIXED
payload:
  damageType: PHYSICAL    # PHYSICAL | EN
  power: 0.30             # 付与時の付与者攻撃力に対する割合
  duration:
    unit: ACTION
    count: 3
```

付与時の付与者攻撃力をスナップショットとして記録し、付与後の変化や戦闘不能は計算に影響しない（`R-DOT-01`）。

---

#### `CONTINUOUS_DAMAGE_BURN` — 炎上

対象に炎上を付与する（`R-DOT-01`, `R-DOT-03`）。

```yaml
kind: CONTINUOUS_DAMAGE_BURN
payload:
  damageType: PHYSICAL    # PHYSICAL | EN
  power: 0.50
  duration:
    unit: ACTION
    count: 3
```

最大3インスタンスまで保持する。3重複到達の可能性がある定義は `requiredCapabilities` に `CAP_EFF_BURN_TRIPLE_STACK` を追加すること（Q-EFF-06）。

---

#### `CONTINUOUS_DAMAGE_POISON` — 毒

対象に毒を付与する（`R-DOT-01`, `R-DOT-04`）。

```yaml
kind: CONTINUOUS_DAMAGE_POISON
payload:
  poisonRate: 0.10        # 現在HP に対する割合（毒効果率）
  attackCapRate: 1.0      # 付与時攻撃力に対する上限割合（通常 1.0）
  duration:
    unit: ACTION
    count: 3
```

毒ダメージはシールドとサブユニットで受けない。既存の毒へ再付与した場合、期間は長い方・効果量は大きい方を引き継いだ1インスタンスを残す（`R-DOT-04`）。

---

#### `APPLY_SUBUNIT` — サブユニット

所持者の攻撃に追加ダメージを付与する（`R-SUB-01`, `R-SUB-02`）。

```yaml
kind: APPLY_SUBUNIT
payload:
  hp: 5000                # サブユニット耐久値
  additionalPower: 0.20   # 追加ダメージ倍率（付与者攻撃力に対する割合）
  damageType: PHYSICAL    # PHYSICAL | EN
```

所持者の攻撃力が対象の防御力を下回る場合の特殊減衰式（Q-EFF-04）は未定のため、その条件に到達し得る定義は `requiredCapabilities` に `CAP_EFF_SUBUNIT_ATTENUATION` を追加すること。

---

### stat 一覧（APPLY_STAT_MOD で使用）

| stat | 意味 | 対応基本ステータスフィールド |
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
  - targetFilter:
      kind: ROLE
      role: PHYSICAL_ATTACKER
    stat: HP
    valueType: FIXED
    value: 500
requiredCapabilities: []
metadata:
  displayName: "テストメモリー"
  sourceReference: "https://example.com"
  tags: []
```

### フィールド詳細

| フィールド | 型 | 制約 |
| --- | --- | --- |
| `memoryDefinitionId` | string | Catalog 内で一意 |
| `modifiers` | object[] | 1件以上 |
| `modifiers[].targetFilter` | object | → 下記参照 |
| `modifiers[].stat` | enum | → stat 一覧参照 |
| `modifiers[].valueType` | enum | `RATIO` \| `FIXED` |
| `modifiers[].value` | number | 正数（補正量）。割合の場合は割合表現（4% → `0.04`） |
| `requiredCapabilities` | string[] | このメモリーを戦闘に含めるだけで必要な Capability |

### valueType

| valueType | 適用規則 |
| --- | --- |
| `RATIO` | 重複ありバフとして戦闘中割合補正へ加算（`R-STA-02`, `Q-STA-03`） |
| `FIXED` | 乗算後に加算するメモリー固定値補正（`R-STA-01`, `Q-STA-03`） |

### targetFilter（対象フィルター）

Memory の補正が適用される味方ユニットを絞り込む。

```yaml
# 全味方
targetFilter:
  kind: ALL

# 指定ロールの味方のみ
targetFilter:
  kind: ROLE
  role: PHYSICAL_ATTACKER   # → role 一覧参照

# 指定属性の味方のみ
targetFilter:
  kind: ATTRIBUTE
  attribute: AGGRESSIVE     # → attribute 一覧参照

# 指定ユニットタイプの味方のみ
targetFilter:
  kind: UNIT_TYPE
  unitType: PHYSICAL        # PHYSICAL | ENERGY | AGILE

# 前衛の味方のみ
targetFilter:
  kind: POSITION_ROW
  row: FRONT                # FRONT | BACK

# AND 条件（例: アタッカーかつ物理タイプ）
targetFilter:
  kind: AND
  conditions:
    - kind: ROLE
      role: PHYSICAL_ATTACKER
    - kind: UNIT_TYPE
      unitType: PHYSICAL
```

---

## Capability 体系

### 目的

実装済みの機能セットを Capability ID で管理し、未実装 Capability を参照する定義を含む編成を `SimulationPreflightValidator` が戦闘開始前に拒否する。保留仕様を仮値（0%・100%など）で代替しない（`13_実装計画.md` 保留仕様隔離参照）。

### 保留4仕様に対応する Capability

| Capability ID | 対応保留仕様 | 未決定内容 |
| --- | --- | --- |
| `CAP_TGT_STEALTH_NO_FALLBACK` | Q-TGT-05 | ステルス適用後に代替対象がいない場合の挙動 |
| `CAP_EFF_SUBUNIT_ATTENUATION` | Q-EFF-04 | 所持者攻撃力 ≤ 対象防御力時のサブユニット追加ダメージ計算式 |
| `CAP_EFF_FREEZE_AMPLIFICATION` | Q-EFF-05 | 凍結解除ダメージの増幅率（固定値 or 効果ごと定義） |
| `CAP_EFF_BURN_TRIPLE_STACK` | Q-EFF-06 | 炎上3重複時の2倍処理（合計に対してか各々に対してか） |

これら4件は M1 以降の段階では **未実装** であり、`ImplementedCapabilities` 集合に含めない。仕様が確定した時点で保留事項から決定事項へ移し、Capability を実装済み集合へ追加する（`13_実装計画.md` 変更管理参照）。

### requiredCapabilities の配置場所

| 配置場所 | 意味 |
| --- | --- |
| `UnitDefinition.requiredCapabilities` | そのユニットを編成に含めるだけで必要な Capability |
| `SkillDefinition.requiredCapabilities` | そのスキルを保持するユニットを編成に含めるだけで必要な Capability |
| `SkillEffectDefinition.requiredCapabilities` | その Effect を解決するために必要な Capability |
| `MemoryDefinition.requiredCapabilities` | そのメモリーを編成に含めるだけで必要な Capability |

`SimulationPreflightValidator` は、編成に含まれる全定義の推移的グラフを走査し、未実装 Capability を1つでも発見した場合に対象 ID を添えて `UNSUPPORTED_RULE` を返す。

---

## 参照整合性規則

Catalog 検証器（M1 実装対象）は次をすべて確認する。

1. **ID 一意性**: Catalog 全体で各 ID が重複しない。
2. **参照解決**:
   - `Unit.activeSkillDefinitionIds` の各 ID が Catalog 内に存在し `skillType: AS` を持つ。
   - `Unit.passiveSkillDefinitionIds` の各 ID が Catalog 内に存在し `skillType: PS` を持つ。
   - `Unit.extraSkillDefinitionId` が Catalog 内に存在し `skillType: EX` を持つ。
   - `Skill.resolution.effectDefinitionIds` の各 ID が Catalog 内に存在する。
   - チャージスキルの `resolution.chargeRelease.effectDefinitionIds` も同様。
3. **passiveTriggers 存在**: `skillType: PS` の定義は `passiveTriggers` を1件以上持つ。`skillType: AS` および `EX` の定義は `passiveTriggers: []`。
4. **cost.resource 整合性**: AS → `AP`、PS → `PP`、EX → `EX_GAUGE`。
5. **Manifest 網羅性**: manifest に列挙された全 ID にファイルが対応し、逆も成立する。

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

本書の構造バージョン。破壊的変更時にインクリメントする。

- 現バージョン: `"1"`
- 未知の `schemaVersion` を持つ Catalog はロード時に拒否する。

### catalogRevision

Catalog コンテンツのバージョン。定義内容を変更するたびに更新する。

- 形式: `"YYYY-MM-DD"` または `"YYYY-MM-DD-a"` のサフィックス付き
- Worker 初期化時に全ファイルの revision を確認し、不一致があれば起動失敗とする。
- 異なる revision の Catalog が同一 Worker プール内に混在することを防ぐ。

---

## 設計上の判断記録（変換ルール）

Markdown から Catalog へ変換する際の標準換算ルール（`catalog-decisions` の `ruleId` として記入する）。

| ruleId | 内容 |
| --- | --- |
| `PERCENTAGE_POINT_TO_RATIO` | ゲーム表記 N% を内部値 N÷100 に変換（例: 20% → `0.20`） |
| `ACTION_SPEED_DIRECT` | 行動速度は表記値をそのまま使用 |
| `STAT_DIRECT` | HP・攻撃力・防御力は表記値をそのまま整数で使用 |
| `EXTRA_GAUGE_DIRECT` | EXゲージ最大値は表記値をそのまま整数で使用（`Q-CAT-04`） |

---

## 正常・不正 JSON 例

### 正常例: 最小 Unit（PHYSICAL_ATTACKER, 前衛・後衛両適正）

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

### 正常例: AS（即時1ヒットダメージ + 攻撃デバフ、敵1体）

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

### 正常例: PS（味方 AS 使用開始時に自己バフ）

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
      "eventKind": "SKILL_USE_STARTING",
      "conditions": [
        { "kind": "SOURCE_SIDE", "value": "ALLY" },
        { "kind": "SOURCE_IS_NOT_SELF" },
        { "kind": "EVENT_SKILL_TYPE", "value": "AS" }
      ]
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

### 正常例: Memory（ATTACKERの攻撃力+4%）

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
| PS が `passiveTriggers` を持たない | `skillType: "PS"` かつ `passiveTriggers: []` |
| AS が `passiveTriggers` を持つ | `skillType: "AS"` かつ `passiveTriggers: [{...}]` |
| AS の `cost.resource` が `AP` 以外 | `"resource": "PP"` |
| 存在しない Skill ID を参照 | `activeSkillDefinitionIds: ["SKL_UNKNOWN"]` |
| PS ID が `activeSkillDefinitionIds` に含まれる | `skillType: "PS"` の ID を `activeSkillDefinitionIds` に記載 |
| 存在しない Effect ID を参照 | `effectDefinitionIds: ["EFF_UNKNOWN"]` |
| 未実装 Capability を持つ定義を含む編成 | `requiredCapabilities: ["CAP_EFF_FREEZE_AMPLIFICATION"]` を持つ定義を使う |
| 未知の `schemaVersion` | `"schemaVersion": "999"` |
| Catalog 内で重複する ID | 同じ `unitDefinitionId` が2ファイルに存在する |
| Manifest に存在しない ID がファイルに存在する | ファイルが manifest の ID リストに含まれていない |

---

## 次の設計への申し送り

実装（M1）で具体化が必要な項目を示す。

- manifest ハッシュ検証（ファイル内容の改ざん検出）の具体的な方式
- `EffectKindKey` による重複なし効果のグループ識別（同一 `stat` を同種とするか、Effect ID を参照するかの実装判断）
- `APPLY_STAT_MOD` の `FIXED` と `RATIO` を Memory 以外の Skill Effect で使う場合の `R-STA-01` 計算順
- 将来追加しうる Effect 種別（HP 回復・AP/PP 回復・EXゲージ操作など）は、本スキーマを拡張して追加する。破壊的変更が生じた場合は `schemaVersion` をインクリメントする
