import { useEffect, useRef, useState } from "react";
import { buildFormationStatPreviewRequest } from "./request-mapper.js";
import type { BattleDraft } from "../../entities/battle-draft.js";
import type {
  FormationStatPreviewMode,
  FormationStatPreviewRequest,
  FormationStatPreviewUnit,
} from "../../shared/api/api-contract.js";

import { previewFormationStats as defaultPreviewFormationStats } from "../../shared/api/api-client.js";

// docs/ui-design/04_コンポーネント・状態管理設計.md §4「ステータスプレビュー状態」.
export type FormationStatPreviewState =
  | { readonly status: "unavailable" }
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | {
      readonly status: "ready";
      readonly bySlotKey: ReadonlyMap<string, FormationStatPreviewUnit>;
    };

type PreviewFormationStatsFn = typeof defaultPreviewFormationStats;

/** 応答の1件を突き合わせる相手。リクエストへ実際に載せた枠そのもの。 */
interface PreviewSlot {
  readonly slotKey: string;
  readonly side: "ALLY" | "ENEMY";
  readonly unitDefinitionId: string;
  readonly column: number;
  readonly row: string;
}

/** effectへ直列化して渡す、1回ぶんの取得に必要な値。 */
interface PreviewPayload {
  readonly request: FormationStatPreviewRequest;
  readonly slots: readonly PreviewSlot[];
}

/** 陣営内で一意な配置（Command検証が重複を弾く）を突き合わせの鍵にする。 */
function positionKey(side: string, column: number, row: string): string {
  return `${side}:${row}:${String(column)}`;
}

function toPreviewSlots(
  formation: FormationStatPreviewRequest["allyFormation"],
  side: "ALLY" | "ENEMY",
  slotKeys: readonly string[],
): PreviewSlot[] {
  return formation.units.map((unit, index) => ({
    slotKey: slotKeys[index] ?? "",
    side,
    unitDefinitionId: unit.unitDefinitionId,
    column: unit.position.column,
    row: unit.position.row,
  }));
}

export interface UseFormationStatPreviewOptions {
  readonly previewImpl?: PreviewFormationStatsFn;
  /**
   * R-TEX-11 #5: プレビューにも編成プール検証が掛かる。演習で省略すると敵枠が
   * `EXERCISE_ENEMY`である限り422になり、枠のステータス表示が落ちる。
   */
  readonly mode?: FormationStatPreviewMode;
  /**
   * REF-059: モード別コンテナは非活性中も常時マウントされたままになる
   * （タブ切替でも実行中の状態を失わないため）。`false`にすると取得を
   * 一切行わず`unavailable`のまま止め、非表示のモードが裏で送信し続けるのを防ぐ。
   */
  readonly enabled?: boolean;
}

/**
 * UI-AC-027／UI-CMP-017: 編成draftから開始時ステータスを取得する。実行状態
 * （`use-simulation-execution.ts`）とは独立したstateを持ち、失敗しても戦闘実行の
 * 可否へ影響させない（docs/ui-design/03_API・データ連携設計.md §2.5）。
 *
 * 再取得の条件は「送信するリクエストのJSON表現が変わったとき」だけにする。
 * draftオブジェクトの同一性で判定すると、無関係な入力（ターン上限など）の
 * 変更でも毎回送り直してしまう。
 */
export function useFormationStatPreview(
  baseUrl: string,
  draft: BattleDraft,
  options: UseFormationStatPreviewOptions = {},
): FormationStatPreviewState {
  const previewImpl = options.previewImpl ?? defaultPreviewFormationStats;
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<FormationStatPreviewState>({ status: "unavailable" });
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);

  // 送る内容（リクエストと枠の対応表）そのものをeffectの依存にする。オブジェクト
  // 参照は毎レンダー変わり、レンダー中にrefへ写す方式は並行レンダリング下で
  // 書き込みが破棄され得るため（`catalog-loader.ts`の同じ注記を参照）、
  // 直列化した1つの文字列を唯一の依存にして、effect側で復元する。
  const build = enabled
    ? buildFormationStatPreviewRequest(draft, options.mode ?? "NORMAL")
    : ({ ok: false } as const);
  const payloadKey = build.ok
    ? JSON.stringify({
        request: build.request,
        slots: [
          ...toPreviewSlots(build.request.allyFormation, "ALLY", build.allyUnitSlotKeys),
          ...toPreviewSlots(build.request.enemyFormation, "ENEMY", build.enemyUnitSlotKeys),
        ],
      } satisfies PreviewPayload)
    : "";

  useEffect(() => {
    abortControllerRef.current?.abort();
    // 送信できる編成が無くなった場合もtokenを進める。abortは既に解決済みのPromiseを
    // 取り消せないため、ここで進めておかないと、中断と競合して完了した古い結果が
    // この後の`unavailable`を上書きし、現在のdraftと異なるステータスを表示し得る。
    const token = ++requestTokenRef.current;
    if (payloadKey === "") {
      setState({ status: "unavailable" });
      return;
    }
    const payload = JSON.parse(payloadKey) as PreviewPayload;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setState({ status: "loading" });

    void previewImpl(payload.request, { baseUrl, signal: controller.signal }).then((result) => {
      if (requestTokenRef.current !== token) {
        return;
      }
      if (!result.ok) {
        setState({ status: "failed" });
        return;
      }
      const bySlotKey = toBySlotKey(result.response.units, payload.slots);
      // 契約違反はプレビュー全体を失敗にする。一部だけ対応づけて表示すると、
      // どの枠の値が信用できるのか画面から区別できない。
      setState(bySlotKey === undefined ? { status: "failed" } : { status: "ready", bySlotKey });
    });

    return () => {
      controller.abort();
    };
  }, [payloadKey, baseUrl, previewImpl]);

  return state;
}

/**
 * UI-API-020: 応答の各要素を`side`＋`formationPosition`でリクエストの枠へ突き合わせる。
 * プレビューは戦闘を実行しないため`battleUnitId`が無く、契約上は「味方→敵、各陣営内は
 * リクエスト順」だが、並び順だけを信じると同数のまま順序が入れ替わった応答で他の枠の
 * ステータスをその枠へ表示してしまう。位置と`unitDefinitionId`まで一致を要求し、
 * 1件でも食い違えば`undefined`を返してプレビュー全体を失敗させる。
 */
function toBySlotKey(
  units: readonly FormationStatPreviewUnit[],
  slots: readonly PreviewSlot[],
): ReadonlyMap<string, FormationStatPreviewUnit> | undefined {
  if (units.length !== slots.length) {
    return undefined;
  }
  const unmatched = new Map(
    slots.map((slot) => [positionKey(slot.side, slot.column, slot.row), slot]),
  );
  const bySlotKey = new Map<string, FormationStatPreviewUnit>();
  for (const unit of units) {
    const key = positionKey(unit.side, unit.formationPosition.column, unit.formationPosition.row);
    const slot = unmatched.get(key);
    if (slot === undefined || slot.unitDefinitionId !== unit.unitDefinitionId) {
      return undefined;
    }
    unmatched.delete(key);
    bySlotKey.set(slot.slotKey, unit);
  }
  return bySlotKey;
}
