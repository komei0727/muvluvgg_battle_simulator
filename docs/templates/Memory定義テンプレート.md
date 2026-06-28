---
documentType: MEMORY
authoringSchemaVersion: 1
definitionId: TBD
displayName: TBD
status: DRAFT
sources:
  - url: TBD
    checkedAt: TBD
    note: TBD
profile:
  gameMode: STANDARD
---

# Memory定義：TBD

このファイルを複製して使用する。`TBD` は調査中だけ許可され、`IN_REVIEW` または `APPROVED` へ変更する前にすべて解消する。

## 転記時の確認事項

- [ ] 表示名とレアリティを確認した
- [ ] 通常戦闘の効果をすべて確認した
- [ ] 効果ごとの対象、stat、value type、値を確認した
- [ ] 採用しないmodeの効果を混ぜていない
- [ ] 参考URLと確認日を記入した

## Memory

`source.effects` と `definition.modifiers` の対応をレビューできる順序で記入する。

```yaml catalog-memory
source:
  selectedMode: STANDARD
  sourceModeLabel: TBD
  effects:
    - name: TBD
      text: >-
        TBD
definition:
  memoryDefinitionId: TBD
  modifiers:
    - targetFilter: TBD
      stat: TBD
      valueType: TBD
      value: TBD
  requiredCapabilities: []
  metadata:
    displayName: TBD
    sourceReference: TBD
    tags: []
```

効果が複数ある場合は `source.effects` と `definition.modifiers` を追加する。同じMemory内で対象や補正値が異なる場合は、modifierを分けて各 `targetFilter` を設定する。

## 判断記録

```yaml catalog-decisions
decisions: []
```

記入例：

```yaml
decisions:
  - fieldPath: modifiers[0].value
    sourceText: 攻撃力を4％上昇
    normalizedValue: 0.04
    ruleId: PERCENTAGE_POINT_TO_RATIO
    note: 100で除算
```

## レビュー

### Source review

- [ ] 転記値が参考資料と一致する
- [ ] 通常戦闘の効果を省略していない
- [ ] メイズ探索等の効果を混ぜていない
- [ ] 参考資料に存在しない値を推測していない

### Domain review

- [ ] 各効果の対象条件が正しい
- [ ] `RATIO` と `FIXED` の区別が正しい
- [ ] 同じ対象への複数modifierを落としていない
- [ ] 静的modifierで表現できない動的効果を近似していない

### Catalog review

- [ ] front matterとMemory IDが一致する
- [ ] modifierが1件以上存在する
- [ ] ID重複がない
- [ ] `TBD` が残っていない

### Behavior review

- [ ] 対象Unitへ補正が適用される
- [ ] 対象外Unitへ補正されない
- [ ] 複数modifierの合成結果を検算した
