# Unit v2 Catalog 変換検討

## 目的

`raw/units/` の一部ユニットを対象に、v2 Catalog schema へ変換する際の表現方法、必要な Capability、追加確認が必要な点を整理する。

本書は production Catalog の完成データではなく、変換テスト前の authoring 方針メモである。

## 対象ユニット

- `raw/units/【純真無垢なるジーニアス】リディア・エルドリッジ.md`
- `raw/units/【省エネ主義の天才ハッカー】エヴィ・レーナルト.md`
- `raw/units/【みんなを見守る山ガール】黒森ラウラ.md`
- `raw/units/【スタチュービューティー】ステラ・ブレーメル.md`
- `raw/units/【ダウナーギャルな副委員長】カリナ・ジェンティーレ.md`
- `raw/units/【憎まれ口の大賢者】ハリエット・ミルズ.md`
- `raw/units/【世界への反逆者】コトハ.md`
- `raw/units/【ナチュラルボーンサバイバー】鎧衣美琴.md`
- `raw/units/【人見知りの聖騎士】ケイト・フルニエ.md`
- `raw/units/【＃激カワ吸血鬼配信者♪】フルート・メルヴィル.md`

## 前提

- `extraGaugeMaximum` は EX skill の `cost.amount` と同値で生成する。
- `baseStats.criticalDamageBonus` は `0.5`、`baseStats.affinityBonus` は `0.25` を既定値で生成する。
- Q-TGT-05、Q-EFF-04、Q-EFF-05、Q-EFF-06 は決定済みであり、`Q-*` Capability として隔離しない。
- 仕様は決定済みだが初期実装を分ける機能は `CAP_*` として `requiredCapabilities` に付与する。

## 全体結論

10ユニットはいずれも v2 Catalog の `EffectSequence`, `TargetSelector`, `Condition`, `Formula`, `Marker`, `RuntimeCounter`, `TriggerDefinition` で構造化できる。

ただし、実装段階ではほぼ全ユニットが `CAP_*` を必要とする。特に、回復、与被ダメージ補正、リソース操作、派生対象、確率分岐、Marker、RuntimeCounter、挑発・肩代わり、反射、致死耐え、複雑な失効条件が多い。

## 追加確認・小修正候補

| ID        | 内容                                                                                                                                                          | 影響ユニット                                     | 対応案                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-UNIT-01 | `14_Catalog定義スキーマ.md` の `TriggerDefinition.eventType` 候補に `EffectApplied` がないが、`08_ドメインイベント.md` では定義済み。                         | ケイト                                           | `EffectApplied` を trigger event 候補へ追加する。凍結付与時PSは `payload.effectKind=APPLY_STATUS`, `payload.status=FREEZE` で判定する。                                    |
| C-UNIT-02 | `APPLY_COVER`, `APPLY_TARGET_REDIRECT`, `APPLY_REFLECT`, `APPLY_DEATH_SURVIVAL`, `EFFECT_IMMUNITY`, `EVASION` の payload 詳細が Catalog schema 上はまだ粗い。 | エヴィ、ステラ、カリナ、コトハ、フルート、ケイト | v2 Catalog の変換JSONを作る前に、各 payload の必須フィールドを小さく定義する。                                                                                             |
| C-UNIT-03 | 「同タイミングでは発動しない」を `simultaneousActivationLimited` だけで表すか、明示的な排他グループを持たせるか。                                             | ステラ                                           | 初期変換では該当PS双方に `simultaneousActivationLimited: true` を設定する。必要なら `exclusiveActivationGroupId` を追加検討する。                                          |
| C-UNIT-04 | 「右列」「左列」「前後列」の authoring 規約。                                                                                                                 | リディア、フルート                               | Q-TGT-06 の共通座標に従い、`LEFT` / `RIGHT` は俯瞰時の絶対列として扱う。フルートの「敵前後列」は最近対象と同じ縦列の前後2マスとして `SAME_COLUMN_AS_BASE` で表す案が自然。 |

## ユニット別サマリ

| Unit       | 変換可否 | 主な `CAP_*`                                                                                                                                                                                                             | 変換上の要点                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| リディア   | 可能     | `CAP_ADVANCED_TARGETING`, `CAP_TARGET_FALLBACK`, `CAP_DERIVED_TARGETS`, `CAP_DAMAGE_MOD`, `CAP_HEAL`, `CAP_RESOURCE_MOD`, `CAP_CONSUMABLE_EFFECT`, `CAP_RUNTIME_COUNTER`, `CAP_EFFECT_CONDITION`, `CAP_CRITICAL_CONTROL` | 複数範囲、fallback、対象生存分岐、生存味方数参照、戦闘中1回制限を使う。                 |
| エヴィ     | 可能     | `CAP_TARGET_REDIRECT`, `CAP_COVER_DAMAGE`, `CAP_HEAL`, `CAP_RESOURCE_MOD`, `CAP_RESOURCE_CAPACITY_MOD`, `CAP_ADVANCED_PASSIVE_TRIGGER`, `CAP_RUNTIME_COUNTER`                                                            | 前半3スキルは単純。PSは肩代わり、HP閾値、戦闘中1回、横一列の他味方が難所。              |
| ラウラ     | 可能     | `CAP_RANDOM_BRANCH`, `CAP_DERIVED_TARGETS`, `CAP_DAMAGE_MOD`, `CAP_HEAL`, `CAP_FORMULA`, `CAP_EFFECT_CONDITION`                                                                                                          | 独立60%抽選が2つある。生存味方数に応じた攻撃力上昇は Formula。                          |
| ステラ     | 可能     | `CAP_HIT_COUNT_EVASION`, `CAP_MARKER`, `CAP_MARKER_STACK_FORMULA`, `CAP_SPECIFIC_IMMUNITY`, `CAP_EFFECT_CONDITION`, `CAP_REFLECT_DAMAGE`, `CAP_HEAL`, `CAP_FORMULA`                                                      | 「惑光」は Marker。現在HP割合ダメージ、攻撃力上限、反撃、同タイミング排他が必要。       |
| カリナ     | 可能     | `CAP_DERIVED_TARGETS`, `CAP_RESOURCE_MOD`, `CAP_MARKER`, `CAP_MARKER_STACK_FORMULA`, `CAP_TARGET_REDIRECT`, `CAP_COVER_DAMAGE`, `CAP_SPECIFIC_IMMUNITY`, `CAP_DAMAGE_MOD`, `CAP_FORMULA`                                 | 「警棒」は Marker。Marker数によるダメージ増加、後列攻撃への介入、HP量比例デバフがある。 |
| ハリエット | 可能     | `CAP_HEAL`, `CAP_CONTINUOUS_HEAL`, `CAP_MARKER`, `CAP_RESOURCE_MOD`, `CAP_CONSUMABLE_EFFECT`, `CAP_COMPLEX_EXPIRATION`, `CAP_EFFECT_CONDITION`, `CAP_ADVANCED_PASSIVE_TRIGGER`                                           | 「カース」は Marker と linked effect。4個目でPP全削り、Marker全解除。                   |
| コトハ     | 可能     | `CAP_EFFECT_CONDITION`, `CAP_RESOLUTION_BRANCH`, `CAP_PARTIAL_PIERCING`, `CAP_HEAL`, `CAP_CONTINUOUS_HEAL`, `CAP_MARKER`, `CAP_MARKER_STACK_FORMULA`, `CAP_DEATH_SURVIVAL`, `CAP_RUNTIME_COUNTER`                        | HP条件分岐、憤怒Marker数による攻撃内容変化、致死耐えが中心。                            |
| 鎧衣美琴   | 可能     | `CAP_CRITICAL_CONTROL`, `CAP_DERIVED_TARGETS`, `CAP_EFFECT_CONDITION`, `CAP_RUNTIME_COUNTER`, `CAP_RESOURCE_MOD`, `CAP_DAMAGE_MOD`                                                                                       | 累計被ダメージカウンターとAP有無分岐が必要。                                            |
| ケイト     | 可能     | `CAP_RANDOM_BRANCH`, `CAP_HEAL`, `CAP_RESOURCE_MOD`, `CAP_DAMAGE_MOD`, `CAP_HIT_COUNT_EVASION`, `CAP_EFFECT_CONDITION`, `CAP_ADVANCED_PASSIVE_TRIGGER`                                                                   | EX/ASで確率分岐が多い。凍結付与時PSには `EffectApplied` trigger が必要。                |
| フルート   | 可能     | `CAP_DERIVED_TARGETS`, `CAP_HEAL`, `CAP_EFFECT_CONDITION`, `CAP_RESOURCE_CAPACITY_MOD`, `CAP_MARKER`, `CAP_REFLECT_DAMAGE`, `CAP_HIT_COUNT_EVASION`, `CAP_DEATH_SURVIVAL`, `CAP_DAMAGE_MOD`, `CAP_RUNTIME_COUNTER`       | 「極限」は解除不可Marker。HP消費、最大AP増加、極限中の発動抑止、致死耐えがある。        |

## 追加確認・小修正候補の解消状況

上表のC-UNIT-01〜04は、`14_Catalog定義スキーマ.md` の以降の更新（Issue #5/#6のレビュー対応、`Issue #6実装で判明した制約` 節の追記を含む）で以下の通りすべて反映済みであることを、Issue #41のパイロット実装時に確認した。

- C-UNIT-01: `TriggerDefinition.eventType` 候補に `EffectApplied` が追加済み（`14_Catalog定義スキーマ.md` の `eventType 候補` 表）。
- C-UNIT-02: `APPLY_COVER` / `APPLY_TARGET_REDIRECT` / `APPLY_REFLECT` / `APPLY_DEATH_SURVIVAL` / `EFFECT_IMMUNITY` の payload は例が整備済み。ただし `EVASION` は独立した `kind` ではなく `APPLY_STATUS` の `status: EVASION` として実装されている（`effect-action-definition.ts`）。
- C-UNIT-03: `traits.exclusiveActivationGroupId` が実装済み（`skill-definition.ts`）。
- C-UNIT-04: 「位置指定の authoring 規約」節が追加済み（`14_Catalog定義スキーマ.md`）。

## パイロット実施結果 (Issue #41)

対象10ユニット全ての全スキル（EX/AS/PS、計50スキル・125 EffectActionDefinition）を実際にv2 CatalogのJSON fixtureとして作成し、`src/infrastructure/catalog/__fixtures__/pilot-units/` に配置した。`loadCatalogFromDirectory`（Read→Hash→Shape→Resolve→Semantic→Freeze の全段）と `pnpm run validate-catalog` の両方で検証可能であることを確認済み（`src/infrastructure/catalog/catalog-pilot-units.test.ts`）。

推奨順（エヴィ→リディア→ラウラ/ケイト→ステラ/カリナ/ハリエット/コトハ/フルート→鎧衣美琴）通りに変換ログを積み、`RANDOM_BRANCH`（`WEIGHTED_ONE`/`INDEPENDENT`）、`BRANCH` のネスト、`Marker`・`linkedEffectGroupId`、`APPLY_DEATH_SURVIVAL`、`RUNTIME_COUNTER` 条件、`APPLY_COVER`/`APPLY_TARGET_REDIRECT` の組み合わせなど、Catalog v2の主要な表現要素を一通り実地で確認できた。

### 変換不能・要設計対応の項目（schema/Mapper不足） — Issue #44で対応済み

パイロット変換中に見つかった、当時のMapper（`src/domain/catalog/effect-action-definition.ts` ほか）では表現できずfixtureから省略した項目。Issue #44でG-01〜G-10すべての設計方針を確定し、G-01〜G-04・G-06・G-08〜G-10は実装してfixtureを実データへ再変換した。G-05・G-07は設計課題を明記した上で実装を見送った（詳細は `14_Catalog定義スキーマ.md`「Issue #44実装で追加した拡張」）。

| #    | 内容                                                                                                                                                                                                          | 影響ユニット・スキル                                                                                         | 状態                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | `APPLY_HEALING_MOD`（回復量増減の被付与）が未実装                                                                                                                                                             | リディア PS2 がんばるね、おにいちゃん（対象への回復量-50%）、ラウラ PS1 整いサウナ（炎上対象への回復量-20%） | 実装済み。fixtureへ `ACT_LYDIA_PS2_HEALING_DOWN` / `ACT_LAURA_PS1_BURN_HEALING_DOWN` を追加。エヴィ PS2は原文に回復量デバフの記載がなく対象外と判明（Issue #41時点の記述誤り）                                            |
| G-02 | 継続ダメージ（DoT）を表す `EffectAction.kind` が存在しない（`APPLY_CONTINUOUS_HEAL` の対になる kind がない）                                                                                                  | ラウラ PS1（炎上）、カリナ EX フェイスストライク（行動時継続ダメージ）                                       | 実装済み。`APPLY_CONTINUOUS_DAMAGE` を追加し、`ACT_LAURA_PS1_BURN` / `ACT_KARINA_EX_DOT` をfixtureへ追加                                                                                                                  |
| G-03 | `ConditionDefinition` に生存ユニット数を直接比較するkindがない（`ALIVE_UNIT_COUNT_SCALE` はFormula側の倍率計算のみ）                                                                                          | ラウラ PS2 みんなと一緒！（自身以外の味方が0体なら不発）                                                     | 実装済み。`ALIVE_UNIT_COUNT` conditionを追加し、`SKL_LAURA_PS2.activationCondition` に設定                                                                                                                                |
| G-04 | `REMOVE_EFFECTS`（効果解除）が未実装                                                                                                                                                                          | ステラ EX 極夜のマスカレード（自身のデバフを全解除）                                                         | 実装済み。`ACT_STELLA_EX_REMOVE_DEBUFFS` をfixtureへ追加                                                                                                                                                                  |
| G-05 | リソース「獲得量」自体を増減させるModifierに相当するkindがない（`MODIFY_RESOURCE` は一回限りの加減算/設定のみ）                                                                                               | カリナ PS2 包囲かんりょ～（1行動の間EXゲージ獲得量+50%）                                                     | **見送り**。将来の獲得イベントへ事後的に倍率を掛けるModifier評価モデルが未設計。理由は `14_Catalog定義スキーマ.md` 参照。fixtureは当該デバフを引き続き省略                                                                |
| G-06 | `APPLY_STATUS`（特に `DAMAGE_IMMUNITY`）に、ダメージ量のしきい値で無効化可否を切り替えるフィールドがない                                                                                                      | ハリエット AS2 セイントバリア（現在HP35%超の攻撃のみ無効）                                                   | 実装済み。`APPLY_STATUS.payload.damageThreshold` を追加し、`ACT_HARRIET_AS2_IMMUNITY` へ設定                                                                                                                              |
| G-07 | `APPLY_DAMAGE_MOD` に `condition` フィールドがなく、将来解決される対象の動的な相対比較（例: 対象HP割合が自身より低い場合のみ）を後から評価できない                                                            | コトハ PS2 起死回生（対象HP割合が自身より低い敵にのみ与ダメ+10%）                                            | **見送り**。付与時一度きりの評価モデルでは対象ごとに変わる動的条件を表現できず、新しいTargetReference kindとDamage pipeline側のフックが必要。理由は `14_Catalog定義スキーマ.md` 参照。fixtureは当該ボーナスを引き続き省略 |
| G-08 | `APPLY_SHIELD`（シールド付与）が未実装                                                                                                                                                                        | 鎧衣美琴 EX 飽和爆撃（攻撃力×45%のシールド）                                                                 | 実装済み。`ACT_MIKOTO_EX_SHIELD` をfixtureへ追加                                                                                                                                                                          |
| G-09 | `MODIFY_RESOURCE_CAPACITY`（最大リソース上限変更）が未実装                                                                                                                                                    | フルート PS1 イモータル・ヴァンパイア（最大APを1増やす）                                                     | 実装済み。`ACT_FLUTE_PS1_MAX_AP_UP` をfixtureへ追加                                                                                                                                                                       |
| G-10 | `FormulaDefinition` に、同一 `EffectSequence` 内で複数回発生した `DAMAGE` 結果を合算して参照する手段がない（`DAMAGE_DEALT_RATIO.sourceResult` は `LAST_DAMAGE_DEALT` / `LAST_DAMAGE_RECEIVED` の直前1件のみ） | フルート EX ＃ぽよ・オア・トリート（列攻撃+条件付き追撃の合計与ダメージ60%を自己回復）                       | 実装済み。`sourceResult: SUM_DAMAGE_DEALT` を追加し、`ACT_FLUTE_EX_SELF_HEAL` を `LAST_DAMAGE_DEALT` から差し替え                                                                                                         |

G-08・G-09は `14_Catalog定義スキーマ.md`「Issue #6実装で判明した制約」で既に未実装と明記済みの項目が実際のunit変換で初めて具体的なユースケースにヒットした例。G-01〜G-07、G-10はIssue #41で新たに顕在化した不足。すべてのkind/フィールド追加、実装・見送りの区分、payload設計は `14_Catalog定義スキーマ.md`「Issue #44実装で追加した拡張」に記録している。

### 軽微な authoring 判断（ブロッカーではないが設計確認が望ましい）

- `RuntimeCounterId` はCatalogファイル上で定義を持たず、`RUNTIME_COUNTER` condition から文字列IDで参照するのみ（`14_Catalog定義スキーマ.md`）。「戦闘中に1度しか発動しない」は `counter: "<SkillId>_ACTIVATIONS", op: LT, value: 1` という命名規約で表現したが、カウンタの増分（誰がいつ+1するか）を定義するCatalog上の仕組みがなく、Engine側の暗黙規約に依存する。鎧衣美琴PS1「累計で最大HP×10%のダメージ」も同様に、正規化済みの比率カウンタを前提とした近似表現になっている。
- `TriggerDefinition.condition` の `EVENT_PAYLOAD.field` に使った `skillType` / `effectKind` / `status` は、`08_ドメインイベント.md` にイベントペイロードのフィールド名一覧がないため、Catalog側の推測で命名した。実装時にイベントペイロードの実フィールド名と突き合わせる必要がある。

### フォローアップ

上記 G-01〜G-10 は Issue #44「[Catalog] v2 EffectAction/Formula/Condition の未実装拡張を追加する」で対応した。G-01〜G-04・G-06・G-08〜G-10はschema/Mapperを拡張し、対象ユニット別変換メモとfixtureを実データへ更新済み。G-05・G-07は設計課題が残るため見送り、`14_Catalog定義スキーマ.md`にフォローアップ方針を記録した。

## ユニット別変換メモ

### 【純真無垢なるジーニアス】リディア・エルドリッジ

- `extraGaugeMaximum`: `7`
- EX `リディアたいちょうのめいれい`
  - `TargetBinding`: 敵 `POSITION_COLUMN=RIGHT`、敵 `POSITION_COLUMN=LEFT`、敵 `POSITION_ROW=BACK` を別 binding にする。
  - 後列横一列は `CAP_CRITICAL_CONTROL` 付きの会心攻撃として扱う。
  - 対象範囲に敵がいない場合は `fallback` で `NEAREST` 敵単体へ威力100。`CAP_TARGET_FALLBACK`。
- AS `ジャマしちゃ、めっ……だよ？`
  - 左右列に敵がいない場合は fallback を持たず、発動不能。
  - 自身への与ダメージ増加は `APPLY_DAMAGE_MOD`、重複可、duration省略またはBATTLE相当の扱いを要確認。
- AS `わるいこはおしおき`
  - 2ヒット後、同じ対象が生存している場合に `BRANCH` で追加攻撃。
  - 次の攻撃の与ダメージ低下は `consumption.kind=NEXT_OUTGOING_ATTACK`。
- PS `みんなをおたすけ`
  - `SkillUseCompleted`、source=self、skillType=AS。
  - 味方全体へ `NEXT_INCOMING_ATTACK` の被ダメージ低下。効果量は `ALIVE_UNIT_COUNT_SCALE`、max `0.25`。
- PS `がんばるね、おにいちゃん`
  - `TurnStarted`、戦闘中1回は `RuntimeCounter`。
  - 最遠敵へ先制攻撃、`MODIFY_RESOURCE` でPP `-2`、`APPLY_HEALING_MOD` で2行動の回復量低下。

### 【省エネ主義の天才ハッカー】エヴィ・レーナルト

- `extraGaugeMaximum`: `5`
- EX、AS1、AS2はいずれも単体Damageと状態・DamageModifierで表現しやすい。
- PS `デコイプロトコル`
  - `UnitBeingAttacked`、他味方が攻撃対象のとき。
  - `APPLY_TARGET_REDIRECT` と `APPLY_COVER` を同時付与。50%ガードは cover payload に `guardRatio=0.5` 相当を持たせる。
  - `(同時発動制限)` は `traits.simultaneousActivationLimited=true`。
- PS `リカバリーブースト`
  - `DamageApplied` またはHP変化後の条件で `self.hpRatio <= 0.4`。
  - 戦闘中1回は `RuntimeCounter`。
  - 自身への即時回復、防御力上昇、戦闘終了までの攻撃力低下、同横一列の他味方への防御力上昇を別 step に分ける。

### 【みんなを見守る山ガール】黒森ラウラ

- `extraGaugeMaximum`: `8`
- EX `ラウラＳＯＳ！`
  - 敵全体Damage + 攻撃力低下。
- PS `整いサウナ`
  - `SkillUseStarting`、source=self、skillType=AS。
  - 自身の次の攻撃だけ攻撃力上昇。効果量は生存味方数に応じる Formula。
  - 60%炎上付与と60%隣接攻撃は `RANDOM_BRANCH` の `INDEPENDENT`。
  - 隣接攻撃は base target から `ADJACENT_ORTHOGONAL` を派生。
- PS `みんなと一緒！`
  - `TurnStarted`。自身以外の生存味方が0なら発動しない。
  - 会心率と会心ダメージ上昇。
- PS `私も混ぜて～！`
  - 他味方のAS攻撃後、攻撃された敵へ追撃。

### 【スタチュービューティー】ステラ・ブレーメル

- `extraGaugeMaximum`: `8`
- EX `極夜のマスカレード`
  - 味方全体へ1行動、1ヒットまで100%回避。
  - 敵全体へ Marker `MARKER_WAKKOU` を `KEEP_EXISTING` で付与。
  - 自身のデバフ解除と1行動のデバフ無効。
- AS `ブラックアウト・ラビリンス`
  - 敵横一列へ暗闇。暗闇の命中失敗率55%は `APPLY_STATUS` payload。
  - 味方全体へ会心率上昇。
- AS `オーロラとの戯れ`
  - 対象が `MARKER_WAKKOU` を持つ場合、当該Damageに `+50%` の DamageModifier。
  - 自身へ1行動、1ヒットまで60%回避。
- PS `氷結のシンフォニー`
  - `DamageApplied` 後またはHP変化後に、`MARKER_WAKKOU` 所持かつHP50%以下で発動。
  - 現在HP×90%、上限=自身攻撃力×150%は `MIN(CURRENT_HP_RATIO, STAT_RATIO)`。
  - 攻撃後に `MARKER_WAKKOU` を全解除。
- PS `ベルセルクの洗礼`
  - 自身が攻撃を受けた直後、攻撃者へ受けたダメージ50%の反撃、自身を不足HP35%回復。
  - `氷結のシンフォニー` と同タイミング排他は C-UNIT-03。

### 【ダウナーギャルな副委員長】カリナ・ジェンティーレ

- `extraGaugeMaximum`: `7`
- EX `フェイスストライク`
  - 最近敵 + 隣接敵へDamage。
  - 2行動の継続ダメージと攻撃力低下。
- AS `とりしまり～`
  - 敵全体Damage + EXゲージ `-1`。
  - `MARKER_KEIBO` 数に応じたダメージ増加は `MARKER_COUNT_SCALE`、max `0.45`。
- AS `弱点はそこかな？`
  - 最遠敵Damage + 攻撃力低下。
- PS `風紀委員会の管轄だよ～`
  - 他味方が後列敵に攻撃される前、かつ自身HP40%以上。
  - 自身へこの行動中のデバフ無効。
  - 攻撃者へ `MARKER_KEIBO` 付与、当該行動中の攻撃力低下。
  - `APPLY_TARGET_REDIRECT` + `APPLY_COVER`。
  - 後列敵への3行動攻撃力低下。
- PS `包囲かんりょ～`
  - `TurnCompleting`。敵全体へ次の攻撃の与ダメージ低下。効果量はHP割合が高いほど最大30%。
  - 味方全体へ1行動のEXゲージ獲得量増加。リソース獲得量Modifierとして payload 詳細が必要。

### 【憎まれ口の大賢者】ハリエット・ミルズ

- `extraGaugeMaximum`: `7`
- EX `治癒魔法『グレーターヒール』`
  - 味方全体へ即時回復。
  - 回復後の不足HP30%を基準に2行動の継続回復を付与。回復後HPを参照するため、直前結果または解決後状態を Formula で参照する。
- AS `攻撃魔法『ホーリーレイ』`
  - 最近敵 + 隣接2体へEN攻撃。
  - `MARKER_CURSE` を付与。Markerに linked effect として攻撃力低下、与ダメージ低下をぶら下げる。
  - 4個目付与時は `MarkerCountChanged` または付与直後Branchで、PPを0へし、`MARKER_CURSE` を全解除。
- AS `防御魔法『セイントバリア』`
  - 最低HP割合の味方へ、現在HP35%超の攻撃だけを2ヒットまで無効化。
  - 継続回復は解除不可だが、無効効果消滅と同時に消滅するため `linkedEffectGroupId`。
- PS `治癒魔法『ヒール』`
  - ターン開始時、味方後列と前列に1ターン継続回復。
  - 使用者戦闘不能で解除するため `expiration=SOURCE_DEFEATED` 相当。
- PS `強化魔法『スピードブースト』`
  - `ChargeStarted`。チャージ開始味方へAP +1、1行動の速度+100。

### 【世界への反逆者】コトハ

- `extraGaugeMaximum`: `7`
- EX `支配への反逆`
  - 自身HP50%以上なら最低HP割合敵へDamage。
  - 自身HP100%なら防御力とシールドを20%無視。`CAP_PARTIAL_PIERCING`。
  - 自身HP50%未満なら最大HP35%回復 + 2行動継続回復。
- AS `快刀乱麻`
  - 単体2ヒット + 対象を含む縦一列へ2ヒット追加攻撃。
  - 自身へ `MARKER_FUNDO` 付与。
- AS `怒髪衝天`
  - `MARKER_FUNDO` 数で `BRANCH`。
  - 1以下、2、3以上で威力とヒット数が変わる。
  - 4以上なら当該攻撃の与ダメージ+50%。
  - 自身攻撃力5%上昇は共通step。
- PS `報仇雪恨`
  - 他味方が倒された際、自身攻撃力上昇。
- PS `起死回生`
  - 戦闘中1回。ターン開始時に致死耐え + 最大HP65%回復を付与。
  - 対象HP割合が自身より低い敵への与ダメージ増加は conditional DamageModifier。

### 【ナチュラルボーンサバイバー】鎧衣美琴

- `extraGaugeMaximum`: `8`
- EX `飽和爆撃`
  - 最低HP割合敵へDamage。
  - 自身へ2行動の会心保証と攻撃力45%シールド。シールドは2行動後失効。
- AS `制圧支援`
  - 最近敵と隣接2体への別威力攻撃。
  - 対象全体へ1行動防御力低下。
- AS `点射`
  - 対象撃破時、味方全体会心率上昇。
- PS `フェイルセーフ`
  - 累計で最大HP10%のダメージを受けた際は `RuntimeCounter`。
  - 自身APが残っている場合はAP -1、EX満タン、攻撃力上昇、他味方EX +1。
  - APがない場合はEX満タンのみ。
- PS `諸元修正`
  - 自身AS攻撃後、1行動の与ダメージ上昇。

### 【人見知りの聖騎士】ケイト・フルニエ

- `extraGaugeMaximum`: `7`
- EX `聖剣『ディバインキャリバー』`
  - `RANDOM_BRANCH` の `WEIGHTED_ONE` で3分岐。
  - 5ヒットEN攻撃。
  - 敵全体3行動凍結。解除時被ダメージ+150%は `damageAmplificationOnBreak: 1.5`。
  - 味方全体最大HP45%回復 + 最低HP割合味方へ追加回復。
- AS `祝福の斬撃`
  - 4ヒット攻撃を2回。各攻撃ごとに同確率4分岐を `RANDOM_BRANCH` で表す。
  - 与ダメージ100%回復は `DAMAGE_DEALT_RATIO`。
- AS `聖剣の峰打ち`
  - 75%分岐: 最高攻撃力敵へEN攻撃 + 気絶。
  - 25%分岐: 自身へ被ダメージ軽減、2ヒット回避、自身へ気絶。
- AS `聖騎士の威光`
  - 最近敵 + 隣接敵へEN攻撃。
- PS `聖なる剣筋`
  - 敵に凍結が付与された際。`EffectApplied` trigger が必要。
  - 付与された敵へEN追撃。

### 【＃激カワ吸血鬼配信者♪】フルート・メルヴィル

- `extraGaugeMaximum`: `7`
- EX `＃ぽよ・オア・トリート`
  - 「自身に最も近い敵前後列」は C-UNIT-04 の規約に従い、最近敵をbaseに `SAME_COLUMN_AS_BASE` で前後列を派生する案。
  - 攻撃後、最近敵が生存していれば追加攻撃。
  - 与ダメージ60%の自己回復は `DAMAGE_DEALT_RATIO`。
- AS `かぷっとファンサ`
  - 自身が `MARKER_KYOKUGEN` を持つ場合、発動時に現在HP25%を消費する。
  - HP消費は `HEAL` の負値ではなく、HP resource操作または専用Damageとして扱うか payload 詳細が必要。
- PS `イモータル・ヴァンパイア`
  - HP10%以下、戦闘中1回。
  - 最大HP100%回復、最大AP +1、解除不可 `MARKER_KYOKUGEN`、2行動与ダメージ上昇。
- PS `アウェイキング・ヴァンパイア`
  - 自身がASで攻撃された後。`MARKER_KYOKUGEN` がない場合だけ発動。
  - 攻撃者へ反撃、自身へ1ヒット回避。
- PS `あなたにマーキング`
  - ターン開始時、最遠敵へ次に受ける攻撃の被ダメージ増加。
  - 自身へHP1で耐える致死耐え。戦闘中1回。

## 変換テストの推奨順

1. **エヴィ**: 単体攻撃、気絶、DamageModifier、肩代わり、HP閾値回復を一通り確認できる。
2. **リディア**: 複数範囲、fallback、対象生存分岐、次回攻撃デバフを確認できる。
3. **ラウラ / ケイト**: `RANDOM_BRANCH` の `INDEPENDENT` と `WEIGHTED_ONE` を確認できる。
4. **ステラ / カリナ / ハリエット / コトハ / フルート**: Marker、linkedEffectGroup、特殊防御、致死耐え、複雑な発動条件を確認する。
5. **鎧衣美琴**: RuntimeCounter とリソース分岐を確認する。
