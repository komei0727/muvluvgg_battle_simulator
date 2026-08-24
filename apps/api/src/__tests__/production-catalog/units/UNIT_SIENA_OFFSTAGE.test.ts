import { describe, expect, it } from "vitest";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import {
  resolveChargeRelease,
  resolveChargeStart,
} from "../../../domain/battle/resolution/action-charge-resolver.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import {
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import {
  observeChargeEvasion,
  observeChargeLifecycle,
  observeOwnerCharging,
} from "../../../testing/production-unit/charge-restriction.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SIENA_OFFSTAGE`(【舞台を降りた元歌姫】シエナ・クラーク)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SIENA_OFFSTAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * 「チャージ中は回避しない」（`R-HIT-04`）は抑止する側（このユニットのチャージAS）と
 * 抑止される側（`HIT_EVASION` を配るスキル）が別ユニットにあるため、回避効果の
 * 供給元だけをsnapshotへ併読する。どちらの定義も未改変のまま使う。
 */
const WITH_EVASION_SOURCE = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_FLUTE_VAMPIRE",
]);

/** PS1のBRANCHが `elseSteps` を選ぶ盤面（対象が物理タイプでない）。 */
const NON_PHYSICAL_TARGET: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      unitType: "ENERGY",
      state: { currentExtraGauge: 3 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** PS1が削るEXゲージを持つ敵陣（既定の物理タイプのまま）。 */
const PHYSICAL_TARGET: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { currentExtraGauge: 3 },
    },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX",
    intent:
      "敵全体に威力189.6でEN攻撃し、最もHP割合の低い敵1体に対して追加で威力47.4のEN攻撃を行う。さらに自身に次の攻撃で与えるダメージを30%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX" },
    expected: {
      // HP割合が並ぶ盤面では前列・左優先の同点処理で enemy:left が追加攻撃を受ける。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DAMAGE_EXTRA",
          targets: ["enemy:left"],
        },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -948, "enemy:left": -1185, "enemy:back": -948 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_EX_DMG_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
    intent: "スキルの発動タイミングでチャージを開始（消費ポイント2・クールタイム2行動）",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", phase: "START" },
    expected: {
      charge: "SKL_SIENA_OFFSTAGE_AS1",
      resources: [{ unitId: "ally:subject", resource: "AP", delta: -2 }],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
    intent: "次に自身の行動順が巡ってきた際、敵全体に威力212でEN攻撃する",
    use: { kind: "CHARGE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", phase: "RELEASE" },
    expected: {
      // チャージ解放も「自身がアクティブスキルで攻撃した後」に当たるため、解放効果の
      // 解決とチャージ状態終了の後（`ChargeReleaseCompleted`）にPS2が連鎖する。
      // 与ダメージバフは解放攻撃自身には乗らない（3体とも素の1060のまま）。
      charge: null,
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -1060, "enemy:left": -1060, "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP",
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      // 解放も自身の1行動であるため、開始時に置かれた自分のクールタイムが1つ減る。
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2",
    intent: "最もHP割合の低い敵単体に威力180.2でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2" },
    expected: {
      // 攻撃ASの使用完了そのものがPS2の契機になるため、同じスキル使用の中で
      // 自己バフ2件が連鎖する。
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:left": -901 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP",
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // AS使用分の1と、連鎖したPS2の消費PP分の2。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
    intent:
      "ターン開始時に発動。敵単体の会心率を5%低下させ、EXゲージを1削る。さらに対象が物理タイプだった場合、対象が次に受ける攻撃の被ダメージを40%増加させるデバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: PHYSICAL_TARGET,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_DMG_UP", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_DMG_UP",
          magnitude: 0.4,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
    intent: "（物理タイプでない対象）被ダメージ増加デバフの腕は選ばれない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: NON_PHYSICAL_TARGET,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_EX_DOWN", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS1_CRIT_DOWN",
          magnitude: -0.05,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。2行動の間自身の行動速度を50上昇させる（重複可）さらに自身に次の攻撃で与えるダメージを20%上昇させるバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
      // 攻撃ASの完了。契機は攻撃先の陣営ではなく使用スキルIDで判定される。
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:left"],
        skillType: "AS",
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_SPEED_UP",
          magnitude: 50,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
    intent: "(不成立): 攻撃を伴わないEXの使用完了では発動しない（契機は攻撃ASに限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SIENA_OFFSTAGE_PS2",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SIENA_OFFSTAGE (【舞台を降りた元歌姫】シエナ・クラーク)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SIENA-OFFSTAGE-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-SIENA-OFFSTAGE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-SIENA-OFFSTAGE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-SIENA-OFFSTAGE-004 (R-SKL-05/R-PS-01): チャージ解放でもPS2が連鎖する。契機の `ChargeReleaseCompleted` は解放攻撃が全て確定しチャージ状態が終わった後に発行されるため、PS2の与ダメージバフはその攻撃自身には乗らない", () => {
    // `-001` の表は「何が起きたか」を見る。ここは発行順そのもの — 攻撃3件が確定した
    // 後に契機が出て、PS2の付与がさらにその後に来る — を固定する。順序が崩れると
    // 与ダメージバフが解放攻撃へ乗り、原文の「攻撃した後」に反する。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const recorder = new EventRecorder(createBattleId("B_SIENA_CHARGE"));
    const started = resolveChargeStart(
      board.subject,
      skillFrom(snapshot, "SKL_SIENA_OFFSTAGE_AS1"),
      "AS",
      "AS",
      board.units,
      board.definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId("B_SIENA_CHARGE:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const releaseRecorder = new EventRecorder(createBattleId("B_SIENA_RELEASE"));
    const released = resolveChargeRelease(
      started.units.find((unit) => unit.battleUnitId === "ally:subject")!,
      "AS",
      started.units,
      board.definitions,
      noMissNoCrit(),
      releaseRecorder,
      1,
      1,
      createActionId("B_SIENA_RELEASE:action:1"),
      releaseRecorder.nextResolutionScopeId(),
    );
    const events = releaseRecorder.getEvents();

    const damageIndices = events.flatMap((event, index) =>
      event.eventType === "DamageApplied" ? [index] : [],
    );
    const completedIndex = events.findIndex(
      (event) => event.eventType === "ChargeReleaseCompleted",
    );
    const buffIndex = events.findIndex(
      (event) =>
        event.eventType === "EffectApplied" &&
        event.payload.effectActionDefinitionId === "ACT_SIENA_OFFSTAGE_PS2_DMG_UP",
    );
    expect(damageIndices).toHaveLength(3);
    expect(completedIndex).toBeGreaterThan(Math.max(...damageIndices));
    expect(buffIndex).toBeGreaterThan(completedIndex);

    // 契機はチャージ状態の終了後に出る（`passive-trigger-matcher.ts` は
    // 「チャージ中は自身のパッシブスキルが使用できない」として保持者のPSを外すため、
    // 終了前に発行するとPS2は一度も候補化されない）。
    expect(
      released.units.find((unit) => unit.battleUnitId === "ally:subject")!.charge,
    ).toBeUndefined();
    expect(events.some((event) => event.eventType === "PassiveActivated")).toBe(true);
  });

  it("IT-UNIT-SIENA-OFFSTAGE-005 [R-SKL-05] (R-SKL-05): 実 SKL_SIENA_OFFSTAGE_AS1 のチャージ開始はEffectSequenceを一つも解決せず、チャージ状態だけを ChargeStarted の StateDelta へ載せる。終了差分は ChargeReleaseCompleted が単独で所有し、開始直後・解放後のどちらも独立Reducerで復元できる", () => {
    // `-001` の CHARGE 行は `charge`／消費／クールタイムまでを持つが、`StateDelta` の
    // 所有者と独立Reducer復元、Catalog契約（開始側 `steps` が空であること）は
    // スキル使用1回の観測の外にある。
    expect(
      observeChargeLifecycle({
        snapshot,
        chargerUnitDefinitionId: UNIT_DEFINITION_ID,
        chargeSkillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
      }),
    ).toEqual({
      // 開始側は EffectSequence を持たない（`targetBindings` だけが
      // `activationCondition` のスコープとして意味を持つ）。解放側は必ず持つ。
      startSteps: 0,
      releaseSteps: 1,
      // 「チャージ中」を表す `APPLY_MARKER` は `charge` 状態と重複するため除去済み。
      chargeMarkerEffectActionIds: [],
      afterStart: { charge: "SKL_SIENA_OFFSTAGE_AS1", markerStates: 0, appliedEffects: 0 },
      startEventTypes: [
        "ActionStarted",
        "CooldownStarted",
        "ChargeStarted",
        "ActionCompleting",
        "ActionCompleted",
      ],
      chargeStarted: {
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
        chargeDelta: {
          before: undefined,
          after: {
            skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
            startedActionId: "B_CHARGE:action:1",
          },
        },
      },
      replayedChargeAfterStart: {
        skillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
        startedActionId: "B_CHARGE:action:1",
      },
      chargeAfterRelease: null,
      // 終了差分を後続の `ActionCompleting` へ持たせると、独立Reducerでは完了イベントの
      // 時点でまだチャージ中に見えてしまう。
      chargeClearingEventTypes: ["ChargeReleaseCompleted"],
      replayedChargeAfterRelease: null,
    });
  });

  it("IT-UNIT-SIENA-OFFSTAGE-006 [R-PS-04] (R-PS-04): SKL_SIENA_OFFSTAGE_AS1 でチャージ中は自身の SKL_SIENA_OFFSTAGE_PS1 が候補にならず、候補化済みの同じ候補も発動直前確認で OWNER_CHARGING として破棄される。解放でこの制限は解ける", () => {
    // `-001` のPS行は「発動して何が起きたか」を見るもので、チャージ中の破棄理由も、
    // 候補判定（R-PS-01）と発動直前確認（R-PS-04）のどちらで落ちたのかも表せない。
    expect(
      observeOwnerCharging({
        snapshot,
        chargerUnitDefinitionId: UNIT_DEFINITION_ID,
        chargeSkillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
        passiveSkillDefinitionId: "SKL_SIENA_OFFSTAGE_PS1",
      }),
    ).toEqual({
      idle: { candidates: 1, reconfirm: { ok: true } },
      charging: { candidates: 0, reconfirm: { ok: false, reason: "OWNER_CHARGING" } },
      afterRelease: { candidates: 1, reconfirm: { ok: true } },
      // 実 `PassiveActivationRuntime` でも同じ結論になる（`PassiveActivated` が
      // 出たかどうかではなく、PS1が発動したかどうかで見る）。
      runtimeActivated: { idle: true, charging: false, afterRelease: true },
    });
  });

  it("IT-UNIT-SIENA-OFFSTAGE-007 [R-HIT-04] (R-HIT-04): SKL_SIENA_OFFSTAGE_AS1 でチャージ中のシエナは、保持している実 ACT_FLUTE_VAMPIRE_PS2_EVASION を発動させず、回避が成立しなかった被ヒットでその被ヒット消費も減らさない", () => {
    const options = {
      snapshot: WITH_EVASION_SOURCE,
      chargerUnitDefinitionId: UNIT_DEFINITION_ID,
      chargeSkillDefinitionId: "SKL_SIENA_OFFSTAGE_AS1",
      evasionEffectActionId: "ACT_FLUTE_VAMPIRE_PS2_EVASION",
    };

    expect(observeChargeEvasion({ ...options, charging: true })).toEqual({
      charge: "SKL_SIENA_OFFSTAGE_AS1",
      // 2ヒットとも命中しているのに `consumptionRemaining` が初期値のまま残る。
      heldEvasion: { statusKind: "HIT_EVASION", probability: 1, consumptionRemaining: 1 },
      evasionActivated: 0,
      hitConfirmed: 2,
      damaged: true,
    });

    // 対照: チャージしていなければ1ヒット目を回避し、その被ヒットで消費が尽きる。
    expect(observeChargeEvasion({ ...options, charging: false })).toEqual({
      charge: null,
      heldEvasion: null,
      evasionActivated: 1,
      hitConfirmed: 1,
      damaged: true,
    });
  });
});
