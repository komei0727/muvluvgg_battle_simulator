import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { resolveTargets } from "../../domain/battle/targeting/target-selection-policy.js";
import {
  createTargetBindingId,
  type TargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, skillFrom, unitFrom } from "../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  productionBoard,
  type BoardOverrides,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * Issue #495: 補助 `targetBinding` が0件になるだけでAS/EXが発動不能になる誤りの
 * 再発防止。R-ACT-02「必要な対象候補が1体以上存在する」の判定は
 * `optional: true` を持たない binding だけを見る（#494）ため、盤面の減りで空に
 * なり得る補助 binding に印が無いと、そのスキルは丸ごと行動候補から落ちる。
 *
 * ユニット単位の結合テストは**そのユニットが持つ盤面**しか回さないので、
 * 新しく追加されたユニットが同じ形の binding を無印で持ち込んでも誰も気づけない。
 * ここは全production定義を横断して「先に解決できた binding があるのに、
 * `optional` でない後続 binding が空になる」組み合わせを洗い出す。
 */

const unitIds = (
  JSON.parse(readFileSync(`${PRODUCTION_CATALOG_DIR}/units.json`, "utf8")) as {
    readonly unitDefinitionId: string;
  }[]
).map((u) => u.unitDefinitionId);

/**
 * 空になること自体が「発動しない」を意味する binding。原文が不発動条件として
 * 明記しているものだけをここへ載せる（`R-TGT-05`「目の前」と同じ性質）。
 *
 * - `SKL_ELENA_MOODMAKER_AS1`/`TGT_OTHER_ALLIES`: 原文「このスキルは、以下のいずれかの
 *   場合には発動しない・…・自身以外の味方が生存していない場合」。`activationCondition`
 *   にも `TARGET_SET_COUNT >= 1` として入っている。
 */
const INTENTIONALLY_REQUIRED = new Set(["SKL_ELENA_MOODMAKER_AS1/TGT_OTHER_ALLIES"]);

/** 補助 binding が空になりやすい、人数・配置の偏った盤面。 */
const BOARDS: readonly (readonly [string, BoardOverrides])[] = [
  ["敵1体(中央前)", { enemies: [{ id: "e1", position: { column: "CENTER", row: "FRONT" } }] }],
  ["敵1体(左後)", { enemies: [{ id: "e1", position: { column: "LEFT", row: "BACK" } }] }],
  [
    "敵2体(前列 左+右)",
    {
      enemies: [
        { id: "e1", position: { column: "LEFT", row: "FRONT" } },
        { id: "e2", position: { column: "RIGHT", row: "FRONT" } },
      ],
    },
  ],
  [
    "敵3体(前列のみ)",
    {
      enemies: [
        { id: "e1", position: { column: "LEFT", row: "FRONT" } },
        { id: "e2", position: { column: "CENTER", row: "FRONT" } },
        { id: "e3", position: { column: "RIGHT", row: "FRONT" } },
      ],
    },
  ],
  ["味方1体(自身のみ)", { allies: [] }],
];

interface AuditResult {
  /** 印が要るのに無い binding（`<unitId> / <skillId>/<bindingId> (<盤面>)`）。 */
  readonly findings: readonly string[];
  /** 許可リストによって findings から除外されたキー（`<skillId>/<bindingId>`）。 */
  readonly suppressed: readonly string[];
}

/** 走査はCatalog全体を5盤面へ通すため、2つのケースで1回の結果を共有する。 */
let cached: AuditResult | undefined;

function auditOptionality(): AuditResult {
  if (cached !== undefined) return cached;

  const findings = new Set<string>();
  const suppressed = new Set<string>();

  for (const unitDefinitionId of unitIds) {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [unitDefinitionId]);
    const unit = unitFrom(snapshot, unitDefinitionId);
    const skillDefinitionIds = [
      ...unit.activeSkillDefinitionIds,
      ...(unit.extraSkillDefinitionId === undefined ? [] : [unit.extraSkillDefinitionId]),
    ];

    for (const skillDefinitionId of skillDefinitionIds) {
      const bindings = skillFrom(snapshot, skillDefinitionId).resolution.targetBindings ?? [];
      // binding が1つだけなら、それが空＝対象が誰も居ないことなので発動不能で正しい。
      if (bindings.length < 2) continue;

      for (const [boardName, overrides] of BOARDS) {
        const board = productionBoard(snapshot, unitDefinitionId, overrides);
        const resolved = new Map<TargetBindingId, readonly BattleUnit[]>();
        let anyEarlierResolved = false;

        for (const binding of bindings) {
          const units = resolveTargets(
            binding.selector,
            board.subject,
            board.units,
            resolved,
            undefined,
            board.definitions.unitDefinitions,
          );
          resolved.set(createTargetBindingId(binding.targetBindingId, "audit"), units);

          const key = `${skillDefinitionId}/${binding.targetBindingId}`;
          if (units.length === 0 && binding.optional !== true && anyEarlierResolved) {
            if (INTENTIONALLY_REQUIRED.has(key)) {
              suppressed.add(key);
            } else {
              findings.add(`${unitDefinitionId} / ${key} (${boardName})`);
            }
          }
          if (units.length > 0) anyEarlierResolved = true;
        }
      }
    }
  }

  cached = { findings: [...findings].sort(), suppressed: [...suppressed].sort() };
  return cached;
}

describe("production Catalog の補助 targetBinding は optional を持つ (Issue #495)", () => {
  it("IT-CAT-OPTBIND-001: 先行bindingが解決できている盤面で空になる後続bindingは、すべて optional か、原文が不発動条件として定めるものである", () => {
    const { findings } = auditOptionality();

    expect(findings, `optional が要る補助 binding:\n${findings.join("\n")}`).toEqual([]);
  }, 60000);

  it("IT-CAT-OPTBIND-002: 許可リストの各登録は、実際に検出を抑止しているものだけである", () => {
    // 「実在するか」ではなく「**いま検出を抑止しているか**」で照合する。存在確認だけだと、
    // 登録済みbindingへ後から `optional` を付けても binding 自体は残るためテストが通り、
    // 用済みの登録が居座る。その状態で誤って `optional` を外すと、残った登録が
    // `-001` の検出を抑止して不具合を見逃す。
    const { suppressed } = auditOptionality();

    expect(suppressed).toEqual([...INTENTIONALLY_REQUIRED].sort());
  }, 60000);
});
