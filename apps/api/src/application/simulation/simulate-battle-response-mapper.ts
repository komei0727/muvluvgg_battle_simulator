import { ApplicationError } from "../contracts/application-error.js";
import { shieldPoolsOf } from "../../domain/battle/combat/shield-policy.js";
import { subUnitInstances } from "../../domain/battle/combat/sub-unit-policy.js";
import type { BattleLogEvent } from "../observation/battle-log-event.js";
import type { StateTransition } from "../observation/battle-observation.js";
import type {
  ActionReservationResponseBody,
  BattleSimulationResponseBody,
  BattleStateDeltaResponseBody,
  BattleStateResponseBody,
  BattleUnitStateResponseBody,
  ChargeStateResponseBody,
  CooldownStateResponseBody,
  EffectStateResponseBody,
  EntityCollectionDeltaResponseBody,
  MarkerStateResponseBody,
  SubUnitStateResponseBody,
  UnitStateDeltaResponseBody,
  ValueChangeBody,
} from "../contracts/response.js";
import type { BattleLogEventResponseBody } from "../contracts/battle-log.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import type {
  BattleUnitRosterEntry,
  BattleUnitSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type {
  CooldownState,
  EffectSnapshot,
  MarkerSnapshot,
  StateDelta,
  UnitStateDelta,
} from "../../domain/battle/events/state-delta.js";
import type { PositionColumn } from "../../domain/catalog/definitions/catalog-enums.js";
import type { SkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";

const SCHEMA_VERSION = 1;

const REVERSE_COLUMNS: Record<PositionColumn, number> = { LEFT: 0, CENTER: 1, RIGHT: 2 };
const PERCENTAGE_POINT_SCALE = 100;

function combatStatusOf(hp: number): string {
  return hp === 0 ? "DEFEATED" : "ACTIVE";
}

/**
 * R-NUM-01: Domain内部の割合は`1.0 = 100%`で保持する。`10_API設計.md`
 * 「CombatStatsResponse」はパーセントポイントで返す契約(`criticalRate: 15`は
 * 15%)のため、公開境界でだけ100倍する。
 */
function toPercentagePoints(ratio: number): number {
  return ratio * PERCENTAGE_POINT_SCALE;
}

/**
 * `10_API設計.md`「CooldownStateResponse」: `unit`に応じて`setAtActionId`/
 * `setAtTurnNumber`のどちらか一方だけを持つdiscriminated unionを構築する。
 * Domainの`CooldownState`はこのXORをコンパイル時には強制しない（`unit`と
 * `setActionId`/`setTurnNumber`が独立したoptionalフィールドのため）ので、ここで
 * 実行時に検証する。反対側のscopeフィールドが同時に存在する場合も、黙って
 * 捨てて正常化するのではなく例外にする（M5レビュー4巡目[P3]: Domain不変条件が
 * 破れているサインを握りつぶさない）。
 */
function toCooldownStateResponseBody(
  skillDefinitionId: string,
  state: CooldownState,
): CooldownStateResponseBody {
  if (state.unit === "ACTION") {
    if (state.setActionId === undefined) {
      throw new Error(
        `cooldowns["${skillDefinitionId}"] has unit "ACTION" but no setActionId (violates the ACTION/TURN setting-scope XOR)`,
      );
    }
    if (state.setTurnNumber !== undefined) {
      throw new Error(
        `cooldowns["${skillDefinitionId}"] has unit "ACTION" but also has setTurnNumber (violates the ACTION/TURN setting-scope XOR)`,
      );
    }
    return {
      skillDefinitionId,
      unit: "ACTION",
      remaining: state.remaining,
      setAtActionId: state.setActionId,
    };
  }
  if (state.setTurnNumber === undefined) {
    throw new Error(
      `cooldowns["${skillDefinitionId}"] has unit "TURN" but no setTurnNumber (violates the ACTION/TURN setting-scope XOR)`,
    );
  }
  if (state.setActionId !== undefined) {
    throw new Error(
      `cooldowns["${skillDefinitionId}"] has unit "TURN" but also has setActionId (violates the ACTION/TURN setting-scope XOR)`,
    );
  }
  return {
    skillDefinitionId,
    unit: "TURN",
    remaining: state.remaining,
    setAtTurnNumber: state.setTurnNumber,
  };
}

/** `10_API設計.md`「BattleUnitStateResponse.cooldowns」: 残数があるスキルクールタイムだけを返す。 */
function toCooldownStateResponseBodies(
  cooldowns: BattleUnitSnapshot["cooldowns"],
): readonly CooldownStateResponseBody[] {
  if (cooldowns === undefined) {
    return [];
  }
  return (Object.entries(cooldowns) as [SkillDefinitionId, CooldownState][])
    .filter(([, state]) => state.remaining > 0)
    .map(([skillDefinitionId, state]) => toCooldownStateResponseBody(skillDefinitionId, state));
}

/** `10_API設計.md`「ChargeStateResponse.status」: M5時点のDomainはCHARGING以外の状態を生成しない。 */
function toChargeStateResponseBody(
  charge: BattleUnitSnapshot["charge"],
): ChargeStateResponseBody | undefined {
  if (charge === undefined) {
    return undefined;
  }
  return {
    skillDefinitionId: charge.skillDefinitionId,
    startedActionId: charge.startedActionId,
    status: "CHARGING",
  };
}

/**
 * `10_API設計.md`「EffectStateResponse.category」。R-STS-01「状態異常はデバフの
 * 一種とする」に従い、状態異常だけを`STATUS_ABNORMALITY`として区別して返す。
 *
 * 分類は`EffectSnapshot.categories`——`effect-category-classifier.ts`
 * （R-EFF-02/03の解除・免疫判定の正本）が付与時点に確定し、`EffectApplied`・
 * `BattleUnitSnapshot`・独立Reducerが同じ値を運ぶ——だけを読む。
 *
 * PR #288レビュー[P1]（RES-004-STATUS-CONDITION、Issue #224）: 以前は
 * `statusKind`の有無で分岐し、持たない効果を`magnitude`の符号で分類していた。
 * `APPLY_CONTINUOUS_DAMAGE`は`statusKind`を持たず`magnitude`（ダメージ量）が
 * 正値のため、毒・炎上・固定継続ダメージがすべて公開API上だけ`BUFF`になり、
 * Domain分類（毒・炎上＝`STATUS`+`DEBUFF`、固定＝`DEBUFF`）と矛盾していた。
 * 符号から導き直すのをやめ、分類元を1つに保つ。
 *
 * `STEALTH`/`EVASION`/`DAMAGE_IMMUNITY`等の対象自身に有利な`APPLY_STATUS`が
 * `BUFF`になること（PR #264レビュー[P1]）は`categories`側が`["BUFF"]`を返すため
 * 変わらない。`SHIELD`/`SUBUNIT`のように極性を持たない分類も、デバフでない以上
 * 従来どおり`BUFF`へ落ちる。
 */
function effectCategoryOf(effect: EffectSnapshot): string {
  if (effect.categories.includes("STATUS")) {
    return "STATUS_ABNORMALITY";
  }
  return effect.categories.includes("DEBUFF") ? "DEBUFF" : "BUFF";
}

/**
 * `10_API設計.md`「EffectStateResponse」。`statusKind`は`APPLY_STATUS`由来の効果が
 * どの状態か（有利な状態を含む）をクライアントが定義ID命名から推測せずに表示する
 * ための任意プロパティ（「バージョニング」の後方互換な追加、M7-009／Issue #182）。
 * `value`は`effectKindKey`ごとの具体Schema（`oneOf`によるdiscriminated union）が
 * 定まるまでは、`EffectSnapshot`が実際に持つ`magnitude`だけを構造化して返す
 * （`response.ts`の`EffectStateResponseBody.value`コメント参照）。
 */
function toEffectStateResponseBody(effect: EffectSnapshot): EffectStateResponseBody {
  return {
    effectInstanceId: effect.effectInstanceId,
    effectDefinitionId: effect.effectDefinitionId,
    ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
    // R-MEM-04（M7-006、Issue #179）: Memory由来の効果は付与者ユニットを持たず、付与元の陣営を持つ。
    ...(effect.sourceSide !== undefined ? { sourceSide: effect.sourceSide } : {}),
    category: effectCategoryOf(effect),
    effectKindKey: effect.kindKey,
    ...(effect.statusKind !== undefined ? { statusKind: effect.statusKind } : {}),
    stackMode: effect.duplicate ? "STACKABLE" : "NON_STACKING",
    isEffective: effect.isEffective,
    value: { magnitude: effect.magnitude },
    ...(effect.duration !== undefined ? { duration: effect.duration } : {}),
    appliedTurnNumber: effect.appliedTurnNumber,
    ...(effect.appliedActionId !== undefined ? { appliedActionId: effect.appliedActionId } : {}),
  };
}

/**
 * `10_API設計.md`「SubUnitStateResponse」（DMG-005、Issue #190）: `APPLY_SUBUNIT`
 * 由来の効果インスタンスを、消費順（付与順）のまま1件ずつ返す。`durability`の
 * `maximum`は付与時の最大耐久力（`EffectSnapshot.magnitude`）、`current`は吸収で
 * 減った残量（`subUnit.durability`）である。
 */
function toSubUnitStateResponseBody(effect: EffectSnapshot): SubUnitStateResponseBody {
  return {
    subUnitInstanceId: effect.effectInstanceId,
    subUnitDefinitionId: effect.effectDefinitionId,
    ...(effect.sourceUnitId !== undefined ? { sourceUnitId: effect.sourceUnitId } : {}),
    durability: { current: effect.subUnit!.durability, maximum: effect.magnitude },
    appliedTurnNumber: effect.appliedTurnNumber,
    ...(effect.appliedActionId !== undefined ? { appliedActionId: effect.appliedActionId } : {}),
  };
}

/**
 * `10_API設計.md`「MarkerStateResponse」(R-EFF-10、EFF-004、PR #210レビュー[P1]):
 * `MarkerSnapshot`をそのまま外部形へ写す（`sourceUnitId`は直近の付与者を表す
 * 監査用の値）。
 *
 * PR #262レビュー[P1]: R-MEM-04（M7-008、Issue #176）のMemory由来Markerは付与者
 * ユニットを持たない（`MarkerSnapshot.sourceUnitId`が`undefined`）が、v1契約は
 * `sourceUnitId`を必須のまま据え置く（既存必須プロパティの削除は
 * `10_API設計.md`「バージョニング」の破壊的変更に当たる）。そうしたMarkerを生む
 * 唯一のproduction定義（`MEM_ALWAYS_PICO_BESIDE_YOU`）は
 * `CAP_MEMORY_GRANTED_MARKER`（`runtimeStatus: PLANNED`、`REL-008`／Issue #263）が
 * Capability preflightで編成不可として弾くため、ここへは到達しない。将来
 * preflightをすり抜けた場合に「付与元不明のMarkerを黙って返す」ことがないよう、
 * 実装不変条件違反として明確に失敗させる。
 */
function toMarkerStateResponseBody(marker: MarkerSnapshot): MarkerStateResponseBody {
  if (marker.sourceUnitId === undefined) {
    throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
      {
        definitionId: marker.markerId,
        reason:
          "Marker has no source BattleUnit, which the v1 MarkerStateResponse contract cannot represent (Memory-granted Markers stay gated by CAP_MEMORY_GRANTED_MARKER until REL-008 / issue #263)",
      },
    ]);
  }
  return {
    markerInstanceId: marker.markerInstanceId,
    markerId: marker.markerId,
    sourceUnitId: marker.sourceUnitId,
    stackCount: marker.stackCount,
    stackMax: marker.stackMax,
    ...(marker.duration !== undefined ? { duration: marker.duration } : {}),
  };
}

function toUnitStateResponseBody(
  roster: BattleUnitRosterEntry,
  snapshot: BattleUnitSnapshot,
): BattleUnitStateResponseBody {
  const charge = toChargeStateResponseBody(snapshot.charge);
  return {
    battleUnitId: roster.battleUnitId,
    unitDefinitionId: roster.unitDefinitionId,
    side: roster.side,
    formationPosition: {
      column: REVERSE_COLUMNS[roster.position.column],
      row: roster.position.row === "FRONT" ? "FRONT" : "REAR",
    },
    coordinate: { x: roster.globalCoordinate.x, y: roster.globalCoordinate.y },
    combatStatus: combatStatusOf(snapshot.hp),
    hp: { current: snapshot.hp, maximum: snapshot.combatStats.maximumHp },
    resources: {
      ap: { current: snapshot.ap, maximum: roster.maximumAp },
      pp: { current: snapshot.pp, maximum: roster.maximumPp },
      extraGauge: { current: snapshot.extraGauge, maximum: roster.maximumExtraGauge },
    },
    // R-STA-04: AppliedEffectの付与・失効・解除のたびに再計算される現在値
    // (`snapshot.combatStats`) を返す。`roster.combatStats`は編成補正・適性補正
    // だけを反映した開始時点の基準値であり、この応答が表す時点の実効値とは
    // 別物（`battle-state-snapshot.ts`のフィールドコメント参照）。
    combatStats: {
      attack: snapshot.combatStats.attack,
      defense: snapshot.combatStats.defense,
      criticalRate: toPercentagePoints(snapshot.combatStats.criticalRate),
      actionSpeed: snapshot.combatStats.actionSpeed,
      affinityBonus: toPercentagePoints(snapshot.combatStats.affinityBonus),
      criticalDamageBonus: toPercentagePoints(snapshot.combatStats.criticalDamageBonus),
    },
    // `10_API設計.md`「ShieldStateResponse」: タイプ別プールは`APPLY_SHIELD`由来の
    // 効果インスタンス（R-SHD-01第3項）からの導出値であり、実体を別に持たない
    // （DMG-004、Issue #194）。
    shields: shieldPoolsOf(snapshot.effects ?? []),
    // `10_API設計.md`「SubUnitStateResponse」（DMG-005、Issue #190、R-SUB-01第3項）:
    // サブユニットは「消費順と固有効果を追跡するためインスタンスごとに返す」ため、
    // `shields`のようなプール合計へは合算せず`APPLY_SUBUNIT`由来の効果インスタンスを
    // そのまま並べる。耐久力が0のインスタンスは失効済み（`SUBUNIT_DEPLETED`）として
    // 除外する（`subUnitInstances`と同じ規約）。
    subUnits: subUnitInstances(snapshot.effects ?? []).map(toSubUnitStateResponseBody),
    effects: (snapshot.effects ?? []).map(toEffectStateResponseBody),
    markers: (snapshot.markers ?? []).map(toMarkerStateResponseBody),
    cooldowns: toCooldownStateResponseBodies(snapshot.cooldowns),
    ...(charge !== undefined ? { charge } : {}),
  };
}

function toBattleStateResponseBody(
  stateVersion: number,
  snapshot: SimulateBattleResult["initialState"],
  roster: readonly BattleUnitRosterEntry[],
): BattleStateResponseBody {
  const units = roster.map((entry) => {
    const unitSnapshot = snapshot.units[entry.battleUnitId];
    if (unitSnapshot === undefined) {
      throw new Error(
        `unitRoster references a BattleUnitId absent from the state snapshot: "${entry.battleUnitId}"`,
      );
    }
    return toUnitStateResponseBody(entry, unitSnapshot);
  });
  // M3時点ではinitialState(READY)/finalState(COMPLETED)いずれも周回外・未行動
  // 予約なしの境界状態しか公開しないため、cycleNumber/actionQueueは常にこの値。
  const actionQueue: readonly ActionReservationResponseBody[] = [];
  return {
    stateVersion,
    battleStatus: snapshot.status,
    turnNumber: snapshot.currentTurn,
    cycleNumber: 0,
    units,
    actionQueue,
  };
}

function toBattleLogEventResponseBody(event: BattleLogEvent): BattleLogEventResponseBody {
  return {
    sequence: event.sequence,
    type: event.type,
    category: event.category,
    turnNumber: event.turnNumber,
    cycleNumber: event.cycleNumber,
    ...(event.actionId !== undefined ? { actionId: event.actionId } : {}),
    ...(event.skillUseId !== undefined ? { skillUseId: event.skillUseId } : {}),
    ...(event.parentSequence !== undefined ? { parentSequence: event.parentSequence } : {}),
    rootSequence: event.rootSequence,
    ...(event.sourceUnitId !== undefined ? { sourceUnitId: event.sourceUnitId } : {}),
    ...(event.sourceSide !== undefined ? { sourceSide: event.sourceSide } : {}),
    targetUnitIds: event.targetUnitIds,
    details: event.details,
    stateVersionBefore: event.stateVersionBefore,
    stateVersionAfter: event.stateVersionAfter,
    ...(event.stateTransitionIndex !== undefined
      ? { stateTransitionIndex: event.stateTransitionIndex }
      : {}),
  };
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse.cooldowns」(`EntityCollectionDelta`)。
 * `10_API設計.md`「BattleUnitStateResponse.cooldowns」の「残数があるスキルだけを
 * 返す」規則をここでも適用し、可視状態への出入りから`added`/`updated`/`removed`を
 * 導出する（before===0で新規出現=`added`、after===0で消滅=`removed`、それ以外は
 * `updated`）。`added`は`CooldownStateResponseBody`と同じ完全な形（`setAtActionId`/
 * `setAtTurnNumber`を含む）で持たせ、`stateTransitions`単体（`events`のlogLevel
 * フィルタに依存しない）から`finalState`を厳密に復元できるようにする
 * （`10_API設計.md`「差分の適用」`reconstructedFinalState === finalState`）。
 */
function toCooldownEntityCollectionDeltaResponseBody(
  cooldowns: UnitStateDelta["cooldowns"],
): EntityCollectionDeltaResponseBody | undefined {
  if (cooldowns === undefined) {
    return undefined;
  }
  const added: unknown[] = [];
  const updated: { id: string; before: unknown; after: unknown }[] = [];
  const removed: { id: string; before: unknown }[] = [];
  for (const [skillDefinitionId, change] of Object.entries(cooldowns)) {
    if (change.before === 0) {
      added.push(
        toCooldownStateResponseBody(skillDefinitionId, {
          unit: change.unit,
          remaining: change.after,
          ...(change.setActionId !== undefined ? { setActionId: change.setActionId } : {}),
          ...(change.setTurnNumber !== undefined ? { setTurnNumber: change.setTurnNumber } : {}),
        }),
      );
    } else if (change.after === 0) {
      removed.push({ id: skillDefinitionId, before: change.before });
    } else {
      updated.push({ id: skillDefinitionId, before: change.before, after: change.after });
    }
  }
  return { added, updated, removed };
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse.charge」(`ValueChange`)。「値がなくなった
 * ことを表す必要がある場合だけ`after: null`を使用する」規則に従い、Domainの
 * `undefined`(未チャージ)を`null`へ明示的に変換する。`status`はM5時点で
 * `CHARGING`以外の値を取り得ない定数のため、`toChargeStateResponseBody`と同じ値を
 * ここでも補い、`ChargeStateResponseBody`と同じ完全な形にする(`reconstructedFinalState
 * === finalState`)。
 */
function toChargeValueChangeResponseBody(
  charge: UnitStateDelta["charge"],
): ValueChangeBody<unknown> | undefined {
  if (charge === undefined) {
    return undefined;
  }
  return {
    before:
      charge.before !== undefined
        ? {
            skillDefinitionId: charge.before.skillDefinitionId,
            startedActionId: charge.before.startedActionId,
            status: "CHARGING",
          }
        : null,
    after:
      charge.after !== undefined
        ? {
            skillDefinitionId: charge.after.skillDefinitionId,
            startedActionId: charge.after.startedActionId,
            status: "CHARGING",
          }
        : null,
  };
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse.markers」(`EntityCollectionDelta`、
 * R-EFF-10、PR #210レビュー[P1]): `state-delta.ts`の`UnitStateDelta.markers`
 * （`MarkerInstanceId`をキーとする`ValueChange<MarkerSnapshot | undefined>`）を、
 * `toCooldownEntityCollectionDeltaResponseBody`と同じ`added`/`updated`/`removed`
 * 変換へ写す。`before: undefined`は新規付与（`MarkerApplied`）、
 * `after: undefined`は除去（`MarkerRemoved`）、両方存在する場合はスタック/
 * Duration変更（`MarkerUpdated`）を表す — `effects`と異なりcooldownsのような
 * 数値sentinelを使わず、`state-delta.ts`のbefore/after自体がこの意味を持つ。
 */
function toMarkerEntityCollectionDeltaResponseBody(
  markers: UnitStateDelta["markers"],
): EntityCollectionDeltaResponseBody | undefined {
  if (markers === undefined) {
    return undefined;
  }
  const added: unknown[] = [];
  const updated: { id: string; before: unknown; after: unknown }[] = [];
  const removed: { id: string; before: unknown }[] = [];
  for (const [markerInstanceId, change] of Object.entries(markers)) {
    if (change.before === undefined) {
      added.push(toMarkerStateResponseBody(change.after!));
    } else if (change.after === undefined) {
      removed.push({ id: markerInstanceId, before: toMarkerStateResponseBody(change.before) });
    } else {
      updated.push({
        id: markerInstanceId,
        before: toMarkerStateResponseBody(change.before),
        after: toMarkerStateResponseBody(change.after),
      });
    }
  }
  return { added, updated, removed };
}

/**
 * `10_API設計.md`「UnitStateDeltaResponse.effects」(`EntityCollectionDelta`、
 * R-EFF-01、PRレビュー[P1] fix、Issue #243): `state-delta.ts`の`UnitStateDelta.
 * effects`（`EffectInstanceId`をキーとする`ValueChange<EffectSnapshot | undefined>`）
 * を、`toMarkerEntityCollectionDeltaResponseBody`と同じ`added`/`updated`/`removed`
 * 変換へ写す。`markers`と同じくcooldownsのような数値sentinelを使わず、
 * `before`/`after`自体のundefinedがこの意味を持つ（`before: undefined`は新規付与
 * `EffectApplied`、`after: undefined`は失効・解除、両方存在する場合は
 * `blockedCount`変化等の更新）。この変換が欠けていると、`APPLY_STAT_MOD`/
 * `APPLY_STATUS`/`EFFECT_IMMUNITY`等が付与する`AppliedEffect`が戦闘終了まで
 * 残る場合、`finalState.effects`には存在する一方で公開`stateTransitions`側の
 * 付与差分が空のままになり、`10_API設計.md`「差分の適用」の
 * `initialState + stateTransitions = finalState`契約を満たせない。
 */
function toEffectEntityCollectionDeltaResponseBody(
  effects: UnitStateDelta["effects"],
): EntityCollectionDeltaResponseBody | undefined {
  if (effects === undefined) {
    return undefined;
  }
  const added: unknown[] = [];
  const updated: { id: string; before: unknown; after: unknown }[] = [];
  const removed: { id: string; before: unknown }[] = [];
  for (const [effectInstanceId, change] of Object.entries(effects)) {
    if (change.before === undefined) {
      added.push(toEffectStateResponseBody(change.after!));
    } else if (change.after === undefined) {
      removed.push({ id: effectInstanceId, before: toEffectStateResponseBody(change.before) });
    } else {
      updated.push({
        id: effectInstanceId,
        before: toEffectStateResponseBody(change.before),
        after: toEffectStateResponseBody(change.after),
      });
    }
  }
  return { added, updated, removed };
}

/**
 * `08_ドメインイベント.md`のフラットな`hp`/`ap`/`pp`/`extraGauge`を、
 * `10_API設計.md`「UnitStateDeltaResponse」の`hp`/`resources.{ap,pp,extraGauge}`
 * 形へ組み替える。`hp`が0を跨ぐ変化を伴う場合は、Domainが明示的には記録しない
 * `combatStatus`変化を同じ値から導出して補う（`isDefeated`と同じ規則）。
 */
function toUnitStateDeltaResponseBody(delta: UnitStateDelta): UnitStateDeltaResponseBody {
  const resources =
    delta.ap !== undefined || delta.pp !== undefined || delta.extraGauge !== undefined
      ? {
          ...(delta.ap !== undefined ? { ap: delta.ap } : {}),
          ...(delta.pp !== undefined ? { pp: delta.pp } : {}),
          ...(delta.extraGauge !== undefined ? { extraGauge: delta.extraGauge } : {}),
        }
      : undefined;
  const combatStatusBefore = delta.hp !== undefined ? combatStatusOf(delta.hp.before) : undefined;
  const combatStatusAfter = delta.hp !== undefined ? combatStatusOf(delta.hp.after) : undefined;
  const combatStatus =
    combatStatusBefore !== undefined &&
    combatStatusAfter !== undefined &&
    combatStatusBefore !== combatStatusAfter
      ? { before: combatStatusBefore, after: combatStatusAfter }
      : undefined;
  const cooldowns = toCooldownEntityCollectionDeltaResponseBody(delta.cooldowns);
  const markers = toMarkerEntityCollectionDeltaResponseBody(delta.markers);
  const effects = toEffectEntityCollectionDeltaResponseBody(delta.effects);
  const charge = toChargeValueChangeResponseBody(delta.charge);

  return {
    ...(delta.hp !== undefined ? { hp: delta.hp } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(combatStatus !== undefined ? { combatStatus } : {}),
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(markers !== undefined ? { markers } : {}),
    ...(effects !== undefined ? { effects } : {}),
    ...(charge !== undefined ? { charge } : {}),
  };
}

function toBattleStateDeltaResponseBody(delta: StateDelta): BattleStateDeltaResponseBody {
  const battle =
    delta.battleStatus !== undefined || delta.turnNumber !== undefined
      ? {
          ...(delta.battleStatus !== undefined ? { battleStatus: delta.battleStatus } : {}),
          ...(delta.turnNumber !== undefined ? { turnNumber: delta.turnNumber } : {}),
        }
      : undefined;
  const unitEntries = Object.entries(delta.units ?? {}) as [BattleUnitId, UnitStateDelta][];
  const units =
    unitEntries.length > 0
      ? Object.fromEntries(
          unitEntries.map(([battleUnitId, unitDelta]) => [
            battleUnitId,
            toUnitStateDeltaResponseBody(unitDelta),
          ]),
        )
      : undefined;

  return {
    ...(battle !== undefined ? { battle } : {}),
    ...(units !== undefined ? { units } : {}),
  };
}

/**
 * `10_API設計.md`「StateTransitionResponse」: `causedBySequence`/`stateVersion*`は
 * Applicationの`StateTransition`とそのまま同じ意味を持つため直接写す。
 */
function toStateTransitionResponseBody(transition: StateTransition) {
  return {
    causedBySequence: transition.causedBySequence,
    stateVersionBefore: transition.stateVersionBefore,
    stateVersionAfter: transition.stateVersionAfter,
    delta: toBattleStateDeltaResponseBody(transition.stateDelta),
  };
}

/**
 * `09_アプリケーション設計.md`のApplication Result(`SimulateBattleResult`)を
 * `10_API設計.md`のBattleSimulationResponseへ変換する。ドメインのbranded
 * type（`BattleId`/`BattleUnitId`など）はここで通常の`string`へ落ちる境界。
 */
export function toBattleSimulationResponseBody(
  result: SimulateBattleResult,
): BattleSimulationResponseBody {
  const stateTransitions = result.stateTransitions.map(toStateTransitionResponseBody);
  const finalStateVersion =
    stateTransitions.length > 0
      ? stateTransitions[stateTransitions.length - 1]!.stateVersionAfter
      : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    battleId: result.battleId,
    catalogRevision: result.catalogRevision,
    result: {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
    },
    initialState: toBattleStateResponseBody(0, result.initialState, result.unitRoster),
    finalState: toBattleStateResponseBody(finalStateVersion, result.finalState, result.unitRoster),
    events: result.events.map(toBattleLogEventResponseBody),
    stateTransitions,
  };
}
