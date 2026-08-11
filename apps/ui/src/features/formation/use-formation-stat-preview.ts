import { useEffect, useRef, useState } from "react";
import { buildFormationStatPreviewRequest } from "./request-mapper.js";
import type { FormationStatPreviewRequest } from "./request-mapper.js";
import type { BattleDraft } from "./types.js";
import { previewFormationStats as defaultPreviewFormationStats } from "../simulation/api-client.js";
import type { FormationStatPreviewUnit } from "../simulation/api-contract.js";

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

/** effectへ直列化して渡す、1回ぶんの取得に必要な値。 */
interface PreviewPayload {
  readonly request: FormationStatPreviewRequest;
  /** 味方→敵の順に連結した枠キー。応答の`units`と同じ並びになる。 */
  readonly slotKeys: readonly string[];
}

export interface UseFormationStatPreviewOptions {
  readonly previewImpl?: PreviewFormationStatsFn;
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
  const [state, setState] = useState<FormationStatPreviewState>({ status: "unavailable" });
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);

  // 送る内容（リクエストと枠の対応表）そのものをeffectの依存にする。オブジェクト
  // 参照は毎レンダー変わり、レンダー中にrefへ写す方式は並行レンダリング下で
  // 書き込みが破棄され得るため（`catalog-loader.ts`の同じ注記を参照）、
  // 直列化した1つの文字列を唯一の依存にして、effect側で復元する。
  const build = buildFormationStatPreviewRequest(draft);
  const payloadKey = build.ok
    ? JSON.stringify({
        request: build.request,
        slotKeys: [...build.allyUnitSlotKeys, ...build.enemyUnitSlotKeys],
      })
    : "";

  useEffect(() => {
    abortControllerRef.current?.abort();
    if (payloadKey === "") {
      setState({ status: "unavailable" });
      return;
    }
    const payload = JSON.parse(payloadKey) as PreviewPayload;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const token = ++requestTokenRef.current;
    setState({ status: "loading" });

    void previewImpl(payload.request, { baseUrl, signal: controller.signal }).then((result) => {
      if (requestTokenRef.current !== token) {
        return;
      }
      if (!result.ok) {
        setState({ status: "failed" });
        return;
      }
      setState({
        status: "ready",
        bySlotKey: toBySlotKey(result.response.units, payload.slotKeys),
      });
    });

    return () => {
      controller.abort();
    };
  }, [payloadKey, baseUrl, previewImpl]);

  return state;
}

/**
 * UI-API-020: 応答の`units`は味方→敵の順、各陣営内はリクエストの`units`と同じ
 * 並びである。プレビューは戦闘を実行しないため`battleUnitId`が存在せず、
 * この並び順だけが枠との対応の根拠になる。件数が食い違う応答は対応づけを
 * 諦める（部分的にずれた値を枠へ出さない）。
 */
function toBySlotKey(
  units: readonly FormationStatPreviewUnit[],
  orderedSlotKeys: readonly string[],
): ReadonlyMap<string, FormationStatPreviewUnit> {
  if (orderedSlotKeys.length !== units.length) {
    return new Map();
  }
  return new Map(orderedSlotKeys.map((slotKey, index) => [slotKey, units[index]!]));
}
