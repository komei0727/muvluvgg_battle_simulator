---
documentType: UNIT
authoringSchemaVersion: 1
definitionId: TBD
displayName: TBD
status: DRAFT
sources:
  - url: TBD
    checkedAt: TBD
    note: TBD
profile:
  skillLevel: MAXIMUM
---

# Unit定義：TBD

このファイルを複製して使用する。`TBD` は調査中だけ許可され、`IN_REVIEW` または `APPROVED` へ変更する前にすべて解消する。

## 転記時の確認事項

- [ ] 表示名、レアリティ、属性、タイプ、ロール、配置適正を確認した
- [ ] 現在のHP、攻撃力、防御力、会心率、行動速度、AP、PPを確認した
- [ ] 各Skillの最大レベル時の効果と数値を確認した
- [ ] 属性相性ボーナスと会心ダメージボーナスを確認した
- [ ] EXゲージ最大値を確認した
- [ ] EX、AS、PSの種別と定義順を確認した
- [ ] 各Skillのcost、cooldown、対象、hit数、効果文を確認した
- [ ] 参考URLと確認日を記入した

## Unit

```yaml catalog-unit
unitDefinitionId: TBD
attribute: TBD
unitType: TBD
role: TBD
positionAptitudes:
  - TBD
baseStats:
  maximumHp: TBD
  attack: TBD
  defense: TBD
  criticalRate: TBD
  actionSpeed: TBD
  affinityBonus: TBD
  criticalDamageBonus: TBD
  maximumAp: TBD
  maximumPp: TBD
extraGaugeMaximum: TBD
activeSkillDefinitionIds: []
passiveSkillDefinitionIds: []
extraSkillDefinitionId: TBD
requiredCapabilities: []
metadata:
  displayName: TBD
  sourceReference: TBD
  tags: []
```

## Skill

Skill一件につき、この節を複製する。EX、AS、PSをすべて記入する。

### Skill：TBD

```yaml catalog-skill
source:
  sourceSlot: TBD
  level: MAXIMUM
  effectText: >-
    TBD
definition:
  skillDefinitionId: TBD
  skillType: TBD
  cost:
    resource: TBD
    amount: TBD
  activationCondition:
    kind: TRUE
  targeting: TBD
  resolution:
    kind: IMMEDIATE
    effectDefinitionIds:
      - TBD
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

## Effect

Skillから参照するEffect一件につき、この節を複製する。Applied Effectも同じ `catalog-effect` blockへ記入する。

### Effect：TBD

```yaml catalog-effect
source:
  sourceText: >-
    TBD
definition:
  skillEffectDefinitionId: TBD
  definitionType: SKILL_EFFECT
  kind: TBD
  target:
    kind: SKILL_TARGETS
  payload: TBD
  requiredCapabilities: []
```

## 判断記録

元表記からの換算、別資料による補完、Schema上の判断を記録する。不要なら空配列のままとする。

```yaml catalog-decisions
decisions: []
```

記入例：

```yaml
decisions:
  - fieldPath: baseStats.criticalRate
    sourceText: 会心率20%
    normalizedValue: 0.20
    ruleId: PERCENTAGE_POINT_TO_RATIO
    note: 100で除算
```

## レビュー

### Source review

- [ ] 転記値が参考資料と一致する
- [ ] 最大レベル時の効果文を途中で省略していない
- [ ] 最大レベルで追加される効果を反映している
- [ ] 参考資料に存在しない値を推測していない

### Domain review

- [ ] AS・PSの定義順が正しい
- [ ] 条件、対象、効果、処理順がすべて構造化されている
- [ ] buff／debuff／状態異常の期間とstack ruleが正しい
- [ ] cost、EX増加、cooldownが既存ルールと一致する
- [ ] 必要Capabilityが列挙されている

### Catalog review

- [ ] front matterとUnit IDが一致する
- [ ] Unitが参照する全Skill blockが存在する
- [ ] Skillが参照する全Effect blockが存在する
- [ ] ID重複と参照切れがない
- [ ] `TBD` が残っていない

### Behavior review

- [ ] 代表的なASをfixtureで確認した
- [ ] 代表的なPSをfixtureで確認した
- [ ] EXをfixtureで確認した
- [ ] 条件分岐の各枝を確認した
- [ ] イベントログと状態差分を検算した
