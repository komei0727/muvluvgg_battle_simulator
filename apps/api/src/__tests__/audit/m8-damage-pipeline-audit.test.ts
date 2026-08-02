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
 * である（`17_残作業対応表.md`「DMG-001」節の再割当表）。個々のTaskは自分が追加した
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

const BATTLES = SELECTABLE_UNIT_IDS.map((unitDefinitionId) => ({
  unitDefinitionId,
  result: runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
    turnLimit: 5,
    randomValue: 0.5,
  }),
}));

describe("M8 damage pipeline audit (DMG-011)", () => {
  it("IT-AUDIT-M8-001 (R-DMG-05): every hit in every production battle emits the 9 damage steps in order", () => {
    const violations: string[] = [];
    let observedHits = 0;
    const observedStages = new Set<number>();

    for (const battle of BATTLES) {
      for (const hit of splitIntoHits(battle.unitDefinitionId, battle.result.events)) {
        observedHits++;
        let stage = 0;
        let sawAdditionalDamage = false;
        for (const event of hit.events) {
          const next = PIPELINE_STAGE.get(event.type)!;
          observedStages.add(next);
          const floor = sawAdditionalDamage ? APPLICATION_STAGE_FLOOR : stage;
          if (next < floor) {
            violations.push(
              `${battle.unitDefinitionId} seq=${event.sequence} ${event.type} (stage ${next}) followed stage ${stage}: ${hit.events
                .map((e) => e.type)
                .join(" -> ")}`,
            );
            break;
          }
          if (next === 9) {
            sawAdditionalDamage = true;
          }
          stage = next;
        }
      }
    }

    expect(violations, `hits violating the R-DMG-05 order: ${JSON.stringify(violations)}`).toEqual(
      [],
    );
    // 空振り防止: 9手順のすべてがproduction戦闘のどこかで実際に観測されていること。
    expect(observedHits).toBeGreaterThan(0);
    expect([...observedStages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
