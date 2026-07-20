# Affiliation 台帳

## 目的

Issue #161（CAT-001）の一環として、次の3点を確定する。

1. `raw/memories/` にのみ依存しない Memory 変換元の出典管理。`raw/` は `.gitignore` 対象でCI環境に存在しないため、所属条件を持つ Memory の原文引用を本書へ転記し、`raw/` 抜きでも変換内容を検証できるようにする。
2. 所属条件を持つ Memory が参照する `affiliationId`（`AFF_*`）の採番方針と、確定した ID 一覧。
3. 上記 `affiliationId` に所属するキャラクターの手動確認結果と、それを反映した production Catalog Unit（`catalog-src/units/*/unit.json`）の `metadata.affiliations` 更新。

機械可読な正本は [`18_Affiliation台帳.json`](./18_Affiliation台帳.json) とする。本書はその decision record（採番理由・出典引用）を保持し、`apps/api/src/testing/traceability/affiliation-registry.test.ts` が両者の整合と ID 形式を検証する。

前提文書: [`14_Catalog定義スキーマ.md`](./14_Catalog定義スキーマ.md)「metadata」、[`15_Unit_Memory変換台帳.md`](./15_Unit_Memory変換台帳.md)「後続バッチへの申し送り」。

## affiliationId 採番方針

- prefix は `AFF_` に固定する（`14_Catalog定義スキーマ.md` の `AFFILIATION` filter が参照する `affiliationId` と同じ命名系列）。
- Memory の `名前：` フィールドが英語表記そのもの（例: `Chaos Maiden`）の場合、その英語表記を大文字化・アンダースコア区切りにしたものをそのまま採用する（`AFF_CHAOS_MAIDEN` 等）。
- 英語表記が無く仮名/漢字表記のみの所属名（`風紀委員会`、`クラスナ`、`プレ・クラスーＡ`）は、既存の `MARKER_*`（例: `MARKER_AOI_ELEGANT_UKIASHI`「浮足」、`MARKER_AOI_ELEGANT_KOUYOU`「高揚」）と同じ表音ローマ字化を用いる。ただし「プレ」のように出典自体が英語借用語である場合は、表音ローマ字（`PURE`）ではなく借用元の英語（`PRE`）を採用する（可読性を優先する判断。将来別の借用語で同種の判断が必要な場合は本書へ追記する）。
- 同一の所属名を指す複数 Memory は同じ `affiliationId` を共有する（例: `カオスメイデン` は `Chaos Maiden` と `駆け落ちフルスロットル！` の2件から参照される）。
- 表記が異なる所属名（`クラスナ` と `プレ・クラスーＡ`）は、関連を示す追加情報が出典に無いため統合しない。統合が必要になった場合は出典を明記した上で本書を更新する。

## 確定した affiliationId 一覧

Memoryごとに `raw/memories/` の原文（効果１・効果２の全文）を逐語転記する。同じ `affiliationId` を複数 Memory が参照する場合も、Memoryごとに固有の原文を記載する（要約や代表1件への統合はしない）。

| affiliationId          | 所属名（raw表記）    | 出典 Memory                  | 出典引用（`raw/memories/`原文）                                                                                                                                       |
| ---------------------- | -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFF_CHAOS_MAIDEN`     | カオスメイデン       | `Chaos Maiden`               | 「効果１：戦闘開始時に発動。カオスメイデンに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の防御力を200上昇させる」                   |
| `AFF_CHAOS_MAIDEN`     | カオスメイデン       | `駆け落ちフルスロットル！`   | 「効果１：戦闘開始時に発動。カオスメイデンに所属するキャラクターの与えるダメージを2.5％上昇させる 効果２：戦闘開始時に発動。敵後衛の行動速度を70下降させる」          |
| `AFF_COLORFUL_BOUQUET` | カラフルブーケ       | `Colorful Bouquet`           | 「効果１：戦闘開始時に発動。カラフルブーケに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の攻撃力を250上昇させる」                   |
| `AFF_PYXIS_MA_SOEUR`   | ピクシス・マスール   | `Pyxis Ma Soeur`             | 「効果１：戦闘開始時に発動。ピクシス・マスールに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の行動速度を12上昇させる」              |
| `AFF_PYXIS_MA_SOEUR`   | ピクシス・マスール   | `お忍びシスターの冒険`       | 「効果１：戦闘開始時に発動。ピクシス・マスールに所属するキャラクターの防御力を800上昇させる 効果２：戦闘開始時に発動。物理アタッカーの攻撃力を2.5％上昇させる」       |
| `AFF_SIRIUS_SUGAR`     | シリウスシュガー     | `Sirius Sugar`               | 「効果１：戦闘開始時に発動。シリウスシュガーに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体のHPを300上昇させる」                     |
| `AFF_TREBLE_QUINTET`   | トレブルクインテット | `Treble Quintet`             | 「効果１：戦闘開始時に発動。トレブルクインテットに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の会心率を1%上昇させる」              |
| `AFF_TRINITY_JEWEL`    | トリニティ・ジュエル | `Trinity Jewel`              | 「効果１：戦闘開始時に発動。トリニティ・ジュエルに所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の防御力を200上昇させる」             |
| `AFF_FUUKI_IINKAI`     | 風紀委員会           | `風紀委員会`                 | 「効果１：戦闘開始時に発動。風紀委員会に所属するキャラクターの攻撃力を250上昇させる 効果２：戦闘開始時に発動。味方全体の行動速度を12上昇させる」                      |
| `AFF_KURASUNA`         | クラスナ             | `家族のかたちを象りながら`   | 「効果１：戦闘開始時に発動。クラスナに所属するキャラクターの与えるダメージを2.5%上昇させる 効果２：戦闘開始時に発動。コントロールの味方全員の攻撃力を1250上昇させる」 |
| `AFF_PRE_KURASU_A`     | プレ・クラスーＡ     | `密着！？テントの中の珍騒動` | 「効果１：戦闘開始時に発動。プレ・クラスーＡに所属するキャラクターの与えるダメージを2.5％上昇させる 効果２：戦闘開始時に発動。味方前衛の防御力を2.5％上昇させる」     |

9件の `affiliationId` が、所属条件を持つ11件の Memory（`15_Unit_Memory変換台帳.md`「Memory 変換台帳」で「所属条件あり」と分類した行）を重複なく分類する。機械可読な正本は [`18_Affiliation台帳.json`](./18_Affiliation台帳.json) の `affiliations[].sourceMemories` とし、`apps/api/src/testing/traceability/affiliation-registry.test.ts` が本表とJSONの11件全件の一致（Memory名・出典引用とも）を検証する。

## 所属キャラクター一覧（手動入力）

各 `affiliationId` に所属するキャラクターを手動で記録する。`raw/units/` に所属を明示するフィールドが無いため、`characterId` / `characterName` は他資料（外部Wiki等）で確認できたものだけを追記し、`出典` 列に確認元（引用文・URL・確認者と確認日）を必ず記載する。出典が無い行は追加しない。

未確認のまま残す場合は行を追加せず空欄のテーブルのままにする。機械可読な正本は [`18_Affiliation台帳.json`](./18_Affiliation台帳.json) の `affiliations[].members` とし、下表はその写しとする。`apps/api/src/testing/traceability/affiliation-registry.test.ts` が両者の一致と、対応する production Catalog Unit（`catalog-src/units/*/unit.json` の `metadata.affiliations`）への反映を検証する。

| affiliationId          | characterId              | characterName              | 出典                                       |
| ---------------------- | ------------------------ | -------------------------- | ------------------------------------------ |
| `AFF_CHAOS_MAIDEN`     | `CHAR_YURIA_BURNES`      | ユリア・バーンズ           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_CHAOS_MAIDEN`     | `CHAR_SUIRAN_LIU`        | 劉翠蘭                     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_CHAOS_MAIDEN`     | `CHAR_SAYA_SHIUN`        | 紫雲沙耶                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_CHAOS_MAIDEN`     | `CHAR_ANIS_BENNETT`      | アニス・ベネット           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_CHAOS_MAIDEN`     | `CHAR_FEE_DREZE`         | フィー・ドレーゼ           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_COLORFUL_BOUQUET` | `CHAR_AOI_IKOMA`         | 生駒葵                     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_COLORFUL_BOUQUET` | `CHAR_URUU_HASE`         | 波瀬うるう                 | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_COLORFUL_BOUQUET` | `CHAR_CLARA_KIRA`        | 綺羅クララ                 | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_COLORFUL_BOUQUET` | `CHAR_SENKA_HIMEKAWA`    | 姫川泉花                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_COLORFUL_BOUQUET` | `CHAR_MAIA_YUNAGI`       | 夕凪舞亜                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PYXIS_MA_SOEUR`   | `CHAR_DOROTHEA_KIRKLAND` | ドロテア・カークランド     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PYXIS_MA_SOEUR`   | `CHAR_LUCIE_MOORCROFT`   | リュシー・ムーアクロフト   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PYXIS_MA_SOEUR`   | `CHAR_HARRIET_MILLS`     | ハリエット・ミルズ         | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PYXIS_MA_SOEUR`   | `CHAR_MIRIAM_HEYWARD`    | ミリアム・ヘイワード       | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PYXIS_MA_SOEUR`   | `CHAR_KATE_FOURNIER`     | ケイト・フルニエ           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_SIRIUS_SUGAR`     | `CHAR_MERU_MOMOZONO`     | 桃園める                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_SIRIUS_SUGAR`     | `CHAR_CHIYURU_TSUKIGASE` | 月ヶ瀬ちゆる               | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_SIRIUS_SUGAR`     | `CHAR_NANAE_NARUTAKI`    | 鳴滝七彩                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_SIRIUS_SUGAR`     | `CHAR_RAMI_KUZUHA`       | 朽葉ラミ                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_SIRIUS_SUGAR`     | `CHAR_SHIRANA_ICHIJO`    | 一条白奈                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TREBLE_QUINTET`   | `CHAR_EVIE_RENALT`       | エヴィ・レーナルト         | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TREBLE_QUINTET`   | `CHAR_LAYLA_JENKINS`     | レイラ・ジェンキンス       | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TREBLE_QUINTET`   | `CHAR_ROSIE_HUGHES`      | ロージー・ヒューズ         | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TREBLE_QUINTET`   | `CHAR_FLUTE_MELVILLE`    | フルート・メルヴィル       | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TREBLE_QUINTET`   | `CHAR_SIENA_CLARK`       | シエナ・クラーク           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TRINITY_JEWEL`    | `CHAR_RAVEL_BRIGHTLEAF`  | レイヴェル・ブライトリーフ | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TRINITY_JEWEL`    | `CHAR_LUNA_MELLOW`       | ルナ・メロウ               | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_TRINITY_JEWEL`    | `CHAR_LYDIA_ELDRIDGE`    | リディア・エルドリッジ     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_FUUKI_IINKAI`     | `CHAR_LILY_LAVOIE`       | リリー・ラヴォア           | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_FUUKI_IINKAI`     | `CHAR_KARINA_GENTILE`    | カリナ・ジェンティーレ     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_FUUKI_IINKAI`     | `CHAR_SHOUKA_KYOU`       | 姜小花                     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_FUUKI_IINKAI`     | `CHAR_MAO_OGA`           | 大賀真桜                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_KURASUNA`         | `CHAR_NADYA_VOLKOVA`     | ナージャ・ヴォルコワ       | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_KURASUNA`         | `CHAR_OLGA_VOLKOVA`      | オルガ・ヴォルコワ         | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_KURASUNA`         | `CHAR_TATIANA_DROZDOVA`  | タチアナ・ドロズドヴァ     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_KURASUNA`         | `CHAR_ELENA_PASTELKOVA`  | エレーナ・パステルコワ     | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PRE_KURASU_A`     | `CHAR_NOEL_ARUE`         | ノエル・アルエ             | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PRE_KURASU_A`     | `CHAR_KOKORO_HIMUKAI`    | 樋向心香                   | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PRE_KURASU_A`     | `CHAR_JULIE_STACEY`      | ジュリー・ステイシー       | 手動確認（プロジェクト所有者、2026-07-21） |
| `AFF_PRE_KURASU_A`     | `CHAR_KUROMORI_LAURA`    | 黒森ラウラ                 | 手動確認（プロジェクト所有者、2026-07-21） |

同じ `affiliationId` に複数キャラクターが所属する場合は行を追加する（`affiliationId` 列を複製してよい）。表記ゆれ（例: 「劉翠嵐」「紫雲沙邪馬」「桃園メル」「リリー・ラヴィオ」）は、既存 production Catalog の `characterName`（`15_Unit_Memory変換台帳.md`「Unit 変換台帳」参照）へ正規化して記載した。

上表40キャラクター・58 Unitの `metadata.affiliations` へ、対応する `affiliationId` を反映済み（`catalog-src/units/*/unit.json`、Unit metadata 更新方針の1〜2参照）。

## Unit metadata 更新方針

`raw/units/` の全69ファイルを確認した結果、所属を明示するフィールド（例: `所属：`）は存在しない。3ユニット（`【シリウスシュガーのエース】桃園める`、`【ダウナーギャルな副委員長】カリナ・ジェンティーレ`、`【風紀委員会の策謀家】姜小花`）の衣装タイトルが上表の所属名と字面一致していたが、これは表示名の一部一致にとどまり、raw本文に「このキャラクターは◯◯に所属する」という明示的な記述はない。表示名の一致だけを根拠に `metadata.affiliations` を確定させることは、根拠のない近似（fabrication）にあたるため避けた（実際、後述の手動確認でこの3件は上表の所属で確定したが、それは字面一致とは独立に確認された結果である）。

したがって、本Issueでは次を方針として確定する。

1. `metadata.affiliations` は、raw本文・別途引用可能な出典（例: 外部Wikiの該当ページ）、またはプロジェクト所有者による直接確認（本書「所属キャラクター一覧（手動入力）」への記入）のいずれかが「このキャラクターは所属affiliationIdの所属名に属する」と明示している場合にのみ値を追加する。表示名の字面一致のみでは追加しない。
2. 上記いずれかの出典が確認できるまで、対象ユニットの `metadata.affiliations` は空配列のままとする。本Issueでは、「所属キャラクター一覧（手動入力）」に記録された40キャラクター・58 Unitについて、対応する `affiliationId` を `catalog-src/units/*/unit.json` の `metadata.affiliations` へ反映し、`generate-catalog`（`catalogRevision: 2026-07-21.1`）で production Catalog（`catalog/`）へ反映した。それ以外のUnitは出典が無いため空配列のままとする。
3. 所属条件を持つ11 Memory の production Catalog 変換（`triggeredEffects` 実装）は `M7-008`（Issue #176、[`17_残作業対応表.json`](./17_残作業対応表.json) `unconvertedMemoryAssignments` 参照）が担当する。対象UnitへのaffiliationId付与自体は本Issueで完了したため、M7-008は既存の `metadata.affiliations` を参照するだけでよい。M7-008が新たに所属を確認する場合は、先に本書へ出典を追記してから `metadata.affiliations` を更新する。
4. 出典を伴わない所属判定が必要になった場合は、先に本書へ出典（引用文またはURL）を追記してから `metadata.affiliations` を更新する。
