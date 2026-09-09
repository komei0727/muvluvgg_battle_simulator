import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  type MemoryBoardOverrides,
  observeMemory,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { observeEffectExpiry } from "../../../testing/production-unit/effect-expiry.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_FATHERS_AND_MY_WISH`（父さんの、そして私の願い）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1（`BattleStarted`）: 【疾走する自由の狐狼】榊野ヒイロ(`UNIT_HIIRO_FREEWOLF`)に
 * 「闘志」を4つ、他の味方全体に2つ付与する。どちらも1行動ごとに1つずつ消滅する
 * （`APPLY_MARKER.decay`、Issue #674で追加した`MARKER_STACK_DECAY_OVER_TIME`の
 * production初使用）。ヒイロが編成されていない場合はどちらも発動しない。
 *
 * 効果2はMemory側に実装しない（`SKL_HIIRO_FREEWOLF_PS2`のRESETトリガーへ統合済み、
 * R-MEM-04維持のため）ため、この結合テストの対象外。
 *
 * `UNIT_DEFINITION` TargetFilter（Issue #674）のproduction初使用でもある。
 */

const MEMORY_DEFINITION_ID = "MEM_FATHERS_AND_MY_WISH";
const FIGHTING_SPIRIT = "MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT";

/** ヒイロを前衛左のスロットへ配置する。 */
const HIIRO_ON_BOARD: MemoryBoardOverrides = {
  unitDefinitionIdsBySlot: { FRONT_LEFT: "UNIT_HIIRO_FREEWOLF" },
};

describe("production Catalog MEM_FATHERS_AND_MY_WISH (父さんの、そして私の願い)", () => {
  it("IT-MEM-FATHERS-AND-MY-WISH-001: grants 4 stacks of Fighting Spirit to UNIT_HIIRO_FREEWOLF and 2 to every other ally when she is on the board", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", HIIRO_ON_BOARD);
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#0`]);
    // REPEAT4(ヒイロへ付与) → REPEAT2(他の味方へ付与)の定義順で実行される。
    // 各REPEATの1回目の反復で「闘志」マーカーと固定量ATK/会心ダメージバフ1組を
    // 同じstepの`actions`定義順で付与する（Issue #673レビュー対応、AS1と同じ
    // 「マーカー1スタックにつきバフ1組」設計）。
    expect(observed.actionOrder).toEqual([
      {
        triggeredEffectIndex: 0,
        actionIds: [
          "ACT_MEM_FATHERS_AND_MY_WISH_HIIRO_MARKER",
          "ACT_MEM_FATHERS_AND_MY_WISH_ATK_UP",
          "ACT_MEM_FATHERS_AND_MY_WISH_CRIT_DMG_UP",
          "ACT_MEM_FATHERS_AND_MY_WISH_ALLY_MARKER",
        ],
      },
    ]);

    // `markersOf`はmarkerId単位で集約しスタック数を1つに畳むため（`MEM_CHAOS_MAIDEN`の
    // combatStats検証と同じ理由）、ヒイロ(4)と他の味方(2)というスタック数の違いは
    // ユニットごとに直接読む。
    const hiiro = observed.started.allyUnits.find(
      (unit) => unit.battleUnitId === "ally:FRONT_LEFT",
    );
    const others = observed.started.allyUnits.filter(
      (unit) => unit.battleUnitId !== "ally:FRONT_LEFT",
    );
    expect(others).toHaveLength(5);

    expect(hiiro?.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)).toMatchObject(
      {
        stackCount: 4,
        decayingStackCount: 4,
      },
    );
    for (const unit of others) {
      expect(unit.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)).toMatchObject(
        { stackCount: 2, decayingStackCount: 2 },
      );
    }
    // 敵側には一切付与されない。
    expect(
      observed.started.enemyUnits.some((unit) =>
        unit.markerStates.some((marker) => marker.markerId === FIGHTING_SPIRIT),
      ),
    ).toBe(false);
  });

  it("IT-MEM-FATHERS-AND-MY-WISH-002 [R-MEM-04]: the same Memory declared by the ENEMY side lands on the mirrored slots, never the ALLY side", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ENEMY", HIIRO_ON_BOARD);
    const hiiro = observed.started.enemyUnits.find(
      (unit) => unit.battleUnitId === "enemy:FRONT_LEFT",
    );
    expect(hiiro?.markerStates.find((marker) => marker.markerId === FIGHTING_SPIRIT)).toMatchObject(
      { stackCount: 4 },
    );
    expect(
      observed.started.allyUnits.some((unit) =>
        unit.markerStates.some((marker) => marker.markerId === FIGHTING_SPIRIT),
      ),
    ).toBe(false);
  });

  it("IT-MEM-FATHERS-AND-MY-WISH-003 [不成立]: grants nothing at all when UNIT_HIIRO_FREEWOLF is not on the board", () => {
    // ヒイロ未編成では対象(a)が0件になり、(a)(b)双方のACTION stepに重複付与した
    // `stepCondition: TARGET_SET_COUNT(binding: TGT_HIIRO_FREEWOLF, GTE 1)`が
    // 不成立になる — 他の味方全体への2個付与も道連れで発動しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#0`]);
    expect(observed.grants).toEqual([]);
    expect(
      observed.started.allyUnits.some((unit) =>
        unit.markerStates.some((marker) => marker.markerId === FIGHTING_SPIRIT),
      ),
    ).toBe(false);
  });

  it("IT-MEM-FATHERS-AND-MY-WISH-004: every EffectAction this Memory declares was actually executed", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY", HIIRO_ON_BOARD).executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-FATHERS-AND-MY-WISH-005 [R-EFF-10 MARKER_STACK_DECAY_OVER_TIME]: both grants decay by exactly 1 stack per action taken by their holder, and decay.linkedEffects removes exactly one instance of each buff (ATK/CRITICAL_DAMAGE_BONUS) per decayed stack (レビュー対応: マーカーだけでなくバフ組の実効値も結合検証する)", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", HIIRO_ON_BOARD);
    const units = [...observed.started.allyUnits, ...observed.started.enemyUnits];

    const decay = observeEffectExpiry({
      units,
      definitions: observed.started.definitions,
      steps: [
        { kind: "ACTION_END", actor: "ally:FRONT_LEFT" },
        { kind: "ACTION_END", actor: "ally:FRONT_LEFT" },
        { kind: "ACTION_END", actor: "ally:FRONT_CENTER" },
      ],
      watchMarkers: ["ally:FRONT_LEFT", "ally:FRONT_CENTER"],
      watch: [
        { unitId: "ally:FRONT_LEFT", stat: "attack" },
        { unitId: "ally:FRONT_LEFT", stat: "criticalDamageBonus" },
        { unitId: "ally:FRONT_CENTER", stat: "attack" },
        { unitId: "ally:FRONT_CENTER", stat: "criticalDamageBonus" },
      ],
      battleId: "B_FATHERS_AND_MY_WISH_DECAY",
    });

    // 開始直後: ヒイロ(闘志4)はATK 1000×1.16=1160・会心ダメージ0.5+4×0.03=0.62、
    // 他の味方(闘志2)はATK 1000×1.08=1080・会心ダメージ0.5+2×0.03=0.56
    // （`IT-MEM-FATHERS-AND-MY-WISH-001`で確認済みのスタック数と対応）。
    // 各行動終了で闘志が1つ減るたび、`decay.linkedEffects`がATK・会心ダメージの
    // バフインスタンスも1個ずつ解除し、CombatStatが連動して下がる。
    expect(decay.steps).toEqual([
      {
        step: "ACTION_END(ally:FRONT_LEFT)",
        remaining: {},
        markers: {
          "ally:FRONT_LEFT/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 3,
          "ally:FRONT_CENTER/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 2,
        },
        // 闘志4→3: ATK 1160→1120、会心ダメージ0.62→0.59。
        stats: {
          "ally:FRONT_LEFT/attack": 1120,
          "ally:FRONT_LEFT/criticalDamageBonus": 0.59,
        },
      },
      {
        step: "ACTION_END(ally:FRONT_LEFT)",
        remaining: {},
        markers: {
          "ally:FRONT_LEFT/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 2,
          "ally:FRONT_CENTER/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 2,
        },
        // 闘志3→2: ATK 1120→1080、会心ダメージ0.59→0.56。
        stats: {
          "ally:FRONT_LEFT/attack": 1080,
          "ally:FRONT_LEFT/criticalDamageBonus": 0.56,
        },
      },
      {
        step: "ACTION_END(ally:FRONT_CENTER)",
        remaining: {},
        markers: {
          "ally:FRONT_LEFT/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 2,
          "ally:FRONT_CENTER/MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT": 1,
        },
        // 闘志2→1: ATK 1080→1040、会心ダメージ0.56→0.53。ヒイロ側は今回の
        // 行動者ではないため変化なし（stats差分に現れない）。
        stats: {
          "ally:FRONT_CENTER/attack": 1040,
          "ally:FRONT_CENTER/criticalDamageBonus": 0.53,
        },
      },
    ]);
  });
});
