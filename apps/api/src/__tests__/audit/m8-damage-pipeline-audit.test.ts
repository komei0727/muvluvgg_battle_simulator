import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import {
  runProductionUnitBattle,
  selectableProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * DMG-011（Issue #186、M8完了監査）: `R-DMG-05`「ダメージイベント順」の9手順と
 * `08_ドメインイベント.md` 不変条件#6（ダメージ保存則）を、**実 `catalog/` の全
 * production Unit の実戦闘**に対して通しで検証する。
 *
 * `R-DMG-05`の完了責任がDMG-011にあるのは、9手順のうち #5（防御介入、`DMG-006`）・
 * #7（シールド／サブユニット、`DMG-004`／`DMG-005`）・#9（リンク／反射、`DMG-007`／
 * `DMG-006`）が4つのTaskへまたがり、単一の実装Taskでは全体順序を固定できないため
 * である（`docs/ddd/archive/17_残作業対応表_完了履歴.md`「DMG-001」節の再割当表）。個々のTaskは自分が追加した
 * イベントの前後関係だけをunit levelで検証しており、9手順が1本の列として成立して
 * いることはどこにも固定されていなかった。ここがその欠けている検証にあたる。
 *
 * 同様に保存則も、`DMG-004`（シールド）・`DMG-005`（サブユニット）が
 * それぞれ自分のproduction定義に対してだけ検証しており、`subUnitAbsorbed`を含む
 * 5項の等式が全ダメージイベントで成立することは固定されていなかった。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SELECTABLE_UNIT_IDS = selectableProductionUnitIds(CATALOG_DIR);

/**
 * `R-DMG-05`の9手順に対応する段階。1ヒットの窓の中で、この段階番号は単調非減少
 * でなければならない。#9（リンク・反射）が生成する追加ダメージの適用は同じ窓の
 * 中で#7以降をもう一度たどるため、段階9を観測した後は適用段階（7〜9）だけを許す。
 */
const PIPELINE_STAGE: ReadonlyMap<string, number> = new Map([
  // #1 攻撃対象の確定
  ["UNIT_BEING_ATTACKED", 1],
  // #2 命中判定
  ["EVASION_ACTIVATED", 2],
  ["HIT_CONFIRMED", 2],
  // #3 会心判定
  ["CRITICAL_CHECK_RESOLVED", 3],
  // #4 ダメージ計算前のTIMINGイベント
  ["DAMAGE_WILL_BE_APPLIED", 4],
  // #5 防御介入（`R-INT-01`。引き寄せ・肩代わりだけがこの評価点で防御側を差し替える）
  ["DAMAGE_REDIRECTED", 5],
  // #6 ダメージ計算
  ["DAMAGE_CALCULATED", 6],
  // #7 シールド・サブユニット・HPへの適用
  ["SHIELD_CONSUMED", 7],
  ["SUB_UNIT_DAMAGED", 7],
  ["LETHAL_DAMAGE_SURVIVED", 7],
  ["HIT_POINT_REDUCED", 7],
  ["DAMAGE_APPLIED", 7],
  ["DAMAGE_CONVERTED_TO_HEAL", 7],
  // #8 戦闘不能
  ["UNIT_DEFEATED", 8],
  // #9 リンク・反射などの追加ダメージ
  ["LINKED_DAMAGE_GENERATED", 9],
  ["REFLECTED_DAMAGE_GENERATED", 9],
]);

/** 適用段階。#9が開いた追加ダメージの適用でもう一度現れてよい段階。 */
const APPLICATION_STAGE_FLOOR = 7;

interface Hit {
  readonly unitDefinitionId: string;
  readonly events: readonly BattleLogEvent[];
}

/**
 * イベント列を「1ヒットの窓」へ分割する。
 *
 * 単純に発行順で切ると、1ヒットの途中で発火したPS連鎖（`R-ACTN-01` #6）が自分の
 * ヒットを内側で完走させるため、親ヒットの残りの手順が子ヒットの後ろへ回り込んで
 * 「#7の後に#4」に見える。実データでは`SKL_EVIE_KYONSHI_PS1`（`CriticalCheckResolved`
 * を契機にDAMAGEを撃つPS）がこの形をとる。ヒットは常に一つのスキル解決に属する
 * （`08_ドメインイベント.md`「同じスキル解決に属するイベントは同じ`skillUseId`を持つ」）
 * ため、まず`skillUseId`で分けてから`UNIT_BEING_ATTACKED`（#1）で窓を開く。
 */
function splitIntoHits(
  unitDefinitionId: string,
  events: readonly BattleLogEvent[],
): readonly Hit[] {
  const hits: Hit[] = [];
  const open = new Map<string, BattleLogEvent[]>();
  const close = (scope: string): void => {
    const current = open.get(scope);
    if (current !== undefined) {
      hits.push({ unitDefinitionId, events: current });
      open.delete(scope);
    }
  };
  for (const event of events) {
    if (!PIPELINE_STAGE.has(event.type)) {
      continue;
    }
    const scope = String(event.skillUseId ?? "no-skill-use");
    if (event.type === "UNIT_BEING_ATTACKED") {
      close(scope);
      open.set(scope, [event]);
      continue;
    }
    open.get(scope)?.push(event);
  }
  for (const scope of [...open.keys()]) {
    close(scope);
  }
  return hits;
}

function damageDetailsOf(event: BattleLogEvent): Record<string, number | undefined> {
  return event.details as Record<string, number | undefined>;
}

/**
 * 1ヒットが辿りうる終端。`R-DMG-05` は9手順を並べるが、途中で終わる正当な経路が
 * 2つある — MISS（#2で終わる）と幻惑による回復変換（`R-DTH-01` が #7 の適用段階
 * だけを差し替え、`DamageApplied` の代わりに `DamageConvertedToHeal` を発行して
 * 終わる）。それ以外のヒットは必ず適用まで到達する。
 */
type HitOutcome = "MISSED" | "CONVERTED_TO_HEAL" | "APPLIED";

/** 終端ごとの必須部分列。ヒットのイベント列がこの順で全要素を含まなければ違反。 */
const REQUIRED_SPINE: Readonly<Record<HitOutcome, readonly string[]>> = {
  MISSED: ["UNIT_BEING_ATTACKED", "EVASION_ACTIVATED"],
  CONVERTED_TO_HEAL: [
    "UNIT_BEING_ATTACKED",
    "HIT_CONFIRMED",
    "CRITICAL_CHECK_RESOLVED",
    "DAMAGE_WILL_BE_APPLIED",
    "DAMAGE_CALCULATED",
    "DAMAGE_CONVERTED_TO_HEAL",
  ],
  APPLIED: [
    "UNIT_BEING_ATTACKED",
    "HIT_CONFIRMED",
    "CRITICAL_CHECK_RESOLVED",
    "DAMAGE_WILL_BE_APPLIED",
    "DAMAGE_CALCULATED",
    "HIT_POINT_REDUCED",
    "DAMAGE_APPLIED",
  ],
};

/**
 * 終端ごとに、そのヒットへ現れてよいpipelineイベント（allowlist）。
 *
 * PR #302再レビュー[P2]: 当初は「現れてはならないイベント」の列挙（blocklist）で
 * 書いていたが、列挙は必ず取りこぼす — 実際に`MISSED`が`ShieldConsumed`・
 * `SubUnitDamaged`・`DamageRedirected`・`UnitDefeated`を、`CONVERTED_TO_HEAL`が
 * `ShieldConsumed`・`SubUnitDamaged`・`LethalDamageSurvived`を禁止できておらず、
 * 「回避したヒットがシールドだけ誤消費する」回帰が段階の単調性も必須部分列も
 * 満たしたまま通り抜けた。許可側を書く形へ反転し、`PIPELINE_STAGE`へ新しい
 * イベントを足したときの既定を「`MISSED`／`CONVERTED_TO_HEAL`では不許可」に
 * している（下の`APPLIED`は全pipelineイベントから導出するため、新イベントは
 * 適用経路でだけ自動的に許可される）。
 */
const ALLOWED_EVENT_TYPES: Readonly<Record<HitOutcome, ReadonlySet<string>>> = {
  // `R-HIT-01`: MISSの場合、対象へのダメージと効果を適用しない。命中判定より後の
  // 手順（#3以降）は一つも発行されない。
  MISSED: new Set(["UNIT_BEING_ATTACKED", "EVASION_ACTIVATED"]),
  // `R-DTH-01`: #1〜#6（命中・会心・防御介入・ダメージ計算）は通常どおり通し、
  // #7の適用段階だけを`DamageConvertedToHeal`へ差し替える。ダメージを適用しない
  // ため、シールド・サブユニットの吸収も致死耐えも`UnitDefeated`もリンク・反射も
  // 起きない。
  CONVERTED_TO_HEAL: new Set([
    "UNIT_BEING_ATTACKED",
    "HIT_CONFIRMED",
    "CRITICAL_CHECK_RESOLVED",
    "DAMAGE_WILL_BE_APPLIED",
    "DAMAGE_REDIRECTED",
    "DAMAGE_CALCULATED",
    "DAMAGE_CONVERTED_TO_HEAL",
  ]),
  // 適用まで到達するヒットは9手順のどのイベントも発行しうる。唯一の例外は
  // `DamageConvertedToHeal`で、これが出た時点で終端は`CONVERTED_TO_HEAL`である。
  APPLIED: new Set(
    [...PIPELINE_STAGE.keys()].filter((type) => type !== "DAMAGE_CONVERTED_TO_HEAL"),
  ),
};

function classifyHit(types: readonly string[]): HitOutcome {
  if (types.includes("EVASION_ACTIVATED")) {
    return "MISSED";
  }
  return types.includes("DAMAGE_CONVERTED_TO_HEAL") ? "CONVERTED_TO_HEAL" : "APPLIED";
}

/** `required` が `types` の（順序を保った）部分列であるか。 */
function containsInOrder(types: readonly string[], required: readonly string[]): boolean {
  let cursor = 0;
  for (const type of types) {
    if (type === required[cursor]) {
      cursor++;
    }
  }
  return cursor === required.length;
}

const BATTLES = SELECTABLE_UNIT_IDS.map((unitDefinitionId) => ({
  unitDefinitionId,
  result: runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
    turnLimit: 5,
    randomValue: 0.5,
  }),
}));

describe("M8 damage pipeline audit (DMG-011)", () => {
  it("IT-AUDIT-M8-001 (R-DMG-05): every hit in every production battle emits the 9 damage steps in order, and each hit individually carries the steps its outcome requires", () => {
    const orderViolations: string[] = [];
    const spineViolations: string[] = [];
    let observedHits = 0;
    const observedStages = new Set<number>();
    const observedOutcomes = new Map<HitOutcome, number>();

    for (const battle of BATTLES) {
      for (const hit of splitIntoHits(battle.unitDefinitionId, battle.result.events)) {
        observedHits++;
        const types = hit.events.map((event) => event.type);

        // (a) 段階の単調非減少。#9（リンク・反射）が開いた追加ダメージの適用は
        //     同じ窓の中で#7以降をもう一度たどるため、そこからは適用段階を許す。
        let stage = 0;
        let sawAdditionalDamage = false;
        for (const event of hit.events) {
          const next = PIPELINE_STAGE.get(event.type)!;
          observedStages.add(next);
          const floor = sawAdditionalDamage ? APPLICATION_STAGE_FLOOR : stage;
          if (next < floor) {
            orderViolations.push(
              `${battle.unitDefinitionId} seq=${event.sequence} ${event.type} (stage ${next}) followed stage ${stage}: ${types.join(" -> ")}`,
            );
            break;
          }
          if (next === 9) {
            sawAdditionalDamage = true;
          }
          stage = next;
        }

        // (b) ヒット単位の必須部分列。(a)だけでは「そのヒットで`DamageCalculated`や
        //     `DamageApplied`が欠落しても、別のヒットが同じ段階を出していれば成功する」
        //     ため、終端に応じた必須手順をヒットごとに要求する（PR #302レビュー[P2]）。
        const outcome = classifyHit(types);
        observedOutcomes.set(outcome, (observedOutcomes.get(outcome) ?? 0) + 1);
        if (!containsInOrder(types, REQUIRED_SPINE[outcome])) {
          spineViolations.push(
            `${battle.unitDefinitionId} seq=${hit.events[0]!.sequence} ${outcome} hit misses ${JSON.stringify(REQUIRED_SPINE[outcome])}: ${types.join(" -> ")}`,
          );
          continue;
        }
        // (c) 終端が許すイベントだけで構成されていること。必須部分列は「足りない」
        //     ことしか見ないため、終端の意味に反する余分なイベント（回避したヒットの
        //     シールド誤消費など）は許可側の集合で弾く（PR #302再レビュー[P2]）。
        const disallowed = [...new Set(types)].filter(
          (type) => !ALLOWED_EVENT_TYPES[outcome].has(type),
        );
        if (disallowed.length > 0) {
          spineViolations.push(
            `${battle.unitDefinitionId} seq=${hit.events[0]!.sequence} ${outcome} hit also emitted ${JSON.stringify(disallowed.sort())}: ${types.join(" -> ")}`,
          );
        }
      }
    }

    expect(
      orderViolations,
      `hits violating the R-DMG-05 order: ${JSON.stringify(orderViolations)}`,
    ).toEqual([]);
    expect(
      spineViolations,
      `hits missing a required step, or emitting one their outcome forbids: ${JSON.stringify(spineViolations)}`,
    ).toEqual([]);

    // 許可集合そのものの健全性: 綴り違いのイベント名が「どのヒットにも現れない
    // ので通る」形で紛れ込まないよう、全要素が`PIPELINE_STAGE`の実在キーであり、
    // 途中終了する2終端が適用経路の真部分集合であることを固定する。
    for (const [outcome, allowed] of Object.entries(ALLOWED_EVENT_TYPES)) {
      const unknown = [...allowed].filter((type) => !PIPELINE_STAGE.has(type));
      expect(unknown, `${outcome} allows a type absent from PIPELINE_STAGE`).toEqual([]);
    }
    for (const outcome of ["MISSED", "CONVERTED_TO_HEAL"] as const) {
      expect(ALLOWED_EVENT_TYPES[outcome].size).toBeLessThan(ALLOWED_EVENT_TYPES.APPLIED.size);
    }

    // 空振り防止: 9手順のすべてと、3つの終端すべてがproduction戦闘で実際に
    // 観測されていること。
    expect(observedHits).toBeGreaterThan(0);
    expect([...observedStages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...observedOutcomes.keys()].sort()).toEqual(["APPLIED", "CONVERTED_TO_HEAL", "MISSED"]);

    // 上の3終端が現行production Catalogのヒットを尽くしていることは、`classifyHit`が
    // 全ヒットをいずれかへ分類する以上、必須部分列の検査と合わせて保証される。
    // ここで意図的に許していないのは、`R-DMG-05`が持つもう一組の正当な途中終了
    // — PS連鎖によるヒットの取り消し（`UT-R-DMG-05-004`／`008`／`009`）と、
    // 吸収中に使用者が戦闘不能になる中断（`UT-R-SUB-02-016`）— である。
    // どちらも現行のproduction定義では発生しないため、発生した時点で必須部分列の
    // 検査が失敗する。その場合は上の`REQUIRED_SPINE`へ終端を足すのではなく、
    // まず「production Catalogにその経路が現れた」ことを監査結果として扱う。
  });

  it("IT-AUDIT-M8-002 (08_ドメインイベント.md 不変条件#6): shield, sub unit, HP, and discarded damage always account for the calculated damage", () => {
    const violations: string[] = [];
    let typedShieldAbsorptions = 0;
    let untypedShieldAbsorptions = 0;
    let subUnitAbsorptions = 0;
    let discards = 0;
    let continuousDamageEvents = 0;

    for (const battle of BATTLES) {
      for (const event of battle.result.events) {
        if (event.type !== "DAMAGE_APPLIED" && event.type !== "CONTINUOUS_DAMAGE_APPLIED") {
          continue;
        }
        const details = damageDetailsOf(event);
        const typed = details["typedShieldAbsorbed"] ?? 0;
        const untyped = details["untypedShieldAbsorbed"] ?? 0;
        const subUnit = details["subUnitAbsorbed"] ?? 0;
        const hitPoint = details["hitPointDamage"] ?? 0;
        const discarded = details["discardedDamage"] ?? 0;
        if (typed + untyped + subUnit + hitPoint + discarded !== details["calculatedDamage"]) {
          violations.push(
            `${battle.unitDefinitionId} seq=${event.sequence} ${JSON.stringify(details)}`,
          );
        }
        if (typed > 0) typedShieldAbsorptions++;
        if (untyped > 0) untypedShieldAbsorptions++;
        if (subUnit > 0) subUnitAbsorptions++;
        if (discarded > 0) discards++;
        if (event.type === "CONTINUOUS_DAMAGE_APPLIED") continuousDamageEvents++;
      }
    }

    expect(
      violations,
      `damage events breaking the conservation law: ${JSON.stringify(violations)}`,
    ).toEqual([]);
    // 空振り防止: 5項のうち0にならない項が実データで観測されていること。
    expect(typedShieldAbsorptions).toBeGreaterThan(0);
    expect(untypedShieldAbsorptions).toBeGreaterThan(0);
    expect(subUnitAbsorptions).toBeGreaterThan(0);
    expect(discards).toBeGreaterThan(0);
    expect(continuousDamageEvents).toBeGreaterThan(0);
  });

  it("IT-AUDIT-M8-003 (R-LNK-03 / R-INT-03): linked and reflected damage never generates further linked or reflected damage", () => {
    // リンク・反射の適用は防御介入の評価（`R-INT-01`）自体を通らないことで再発を
    // 防いでいる。実データでは「直前に確定した`DAMAGE_APPLIED`が
    // `isLinkedDamage`／`isReflectedDamage`を持つ状態で、さらに
    // `LINKED_DAMAGE_GENERATED`／`REFLECTED_DAMAGE_GENERATED`が現れない」形で
    // 観測できる — 追加ダメージを生むのは常に元ダメージだけである。
    const violations: string[] = [];
    let linkedApplications = 0;
    let reflectedApplications = 0;
    let additionalDamageEvents = 0;

    for (const battle of BATTLES) {
      for (const hit of splitIntoHits(battle.unitDefinitionId, battle.result.events)) {
        let lastApplicationWasAdditional = false;
        for (const event of hit.events) {
          if (event.type === "DAMAGE_APPLIED") {
            const details = event.details as Record<string, unknown>;
            const linked = details["isLinkedDamage"] === true;
            const reflected = details["isReflectedDamage"] === true;
            if (linked) linkedApplications++;
            if (reflected) reflectedApplications++;
            lastApplicationWasAdditional = linked || reflected;
            continue;
          }
          if (PIPELINE_STAGE.get(event.type) !== 9) {
            continue;
          }
          additionalDamageEvents++;
          if (lastApplicationWasAdditional) {
            violations.push(
              `${battle.unitDefinitionId} seq=${event.sequence} ${event.type} follows an already linked/reflected DamageApplied`,
            );
          }
        }
      }
    }

    expect(violations, `re-linked or re-reflected damage: ${JSON.stringify(violations)}`).toEqual(
      [],
    );
    // 空振り防止: リンク・反射の適用が実データに存在すること。
    expect(additionalDamageEvents).toBeGreaterThan(0);
    expect(linkedApplications).toBeGreaterThan(0);
    expect(reflectedApplications).toBeGreaterThan(0);
  });
});
