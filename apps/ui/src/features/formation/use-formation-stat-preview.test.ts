import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFormationStatPreview } from "./use-formation-stat-preview.js";
import { createInitialDraft, slotKeyOf } from "./types.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "./types.js";
import type {
  FormationStatPreviewApiResult,
  FormationStatPreviewUnit,
} from "../../shared/api/api-contract.js";

function withUnit(
  draft: BattleDraft,
  side: Side,
  row: UiRow,
  column: UiColumn,
  unitDefinitionId: string,
): BattleDraft {
  const slotKey = slotKeyOf(side, row, column);
  const update = (slots: BattleDraft["allySlots"]) =>
    slots.map((slot) => (slot.slotKey === slotKey ? { ...slot, unitDefinitionId } : slot));
  return side === "ally"
    ? { ...draft, allySlots: update(draft.allySlots) }
    : { ...draft, enemySlots: update(draft.enemySlots) };
}

function baseDraft(): BattleDraft {
  let draft = createInitialDraft();
  draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
  draft = withUnit(draft, "enemy", "FRONT", 0, "UNIT_ENEMY");
  return draft;
}

function previewUnit(overrides: Partial<FormationStatPreviewUnit> = {}): FormationStatPreviewUnit {
  return {
    side: "ALLY",
    unitDefinitionId: "UNIT_ALLY",
    formationPosition: { column: 0, row: "FRONT" },
    maximumHp: 1000,
    combatStats: {
      attack: 100,
      defense: 50,
      criticalRate: 12.5,
      actionSpeed: 12,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    },
    ...overrides,
  };
}

function okResult(units: readonly FormationStatPreviewUnit[]): FormationStatPreviewApiResult {
  return { ok: true, response: { schemaVersion: 1, catalogRevision: "rev-1", units } };
}

describe("useFormationStatPreview (UI-CMP-017/UI-API-020/021)", () => {
  it("maps the response entries onto slot keys in ally-then-enemy request order", async () => {
    const previewImpl = vi
      .fn()
      .mockResolvedValue(
        okResult([
          previewUnit(),
          previewUnit({ side: "ENEMY", unitDefinitionId: "UNIT_ENEMY", maximumHp: 2000 }),
        ]),
      );

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    if (result.current.status !== "ready") return;
    expect(result.current.bySlotKey.get(slotKeyOf("ally", "FRONT", 0))?.maximumHp).toBe(1000);
    expect(result.current.bySlotKey.get(slotKeyOf("enemy", "FRONT", 0))?.maximumHp).toBe(2000);
  });

  it("refetches when the enhancement changes and leaves the request untouched when only the turn limit changes", async () => {
    const previewImpl = vi.fn().mockResolvedValue(okResult([previewUnit(), previewUnit()]));
    const draft = baseDraft();

    const { rerender } = renderHook(
      ({ current }: { current: BattleDraft }) =>
        useFormationStatPreview("https://api.example", current, { previewImpl }),
      { initialProps: { current: draft } },
    );

    await waitFor(() => {
      expect(previewImpl).toHaveBeenCalledTimes(1);
    });

    rerender({ current: { ...draft, turnLimit: 42 } });
    expect(previewImpl).toHaveBeenCalledTimes(1);

    rerender({
      current: {
        ...draft,
        allyEnhancement: { ...draft.allyEnhancement, enabled: true },
      },
    });
    await waitFor(() => {
      expect(previewImpl).toHaveBeenCalledTimes(2);
    });
    const [secondRequest] = previewImpl.mock.calls[1] as [
      { allyFormation: { enhancement?: unknown } },
    ];
    expect(secondRequest.allyFormation.enhancement).toBeDefined();
  });

  it("reports a failed preview as its own state instead of throwing, keeping the failure out of the execution state", async () => {
    const previewImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      error: { kind: "SERVER", message: "boom" },
    } satisfies FormationStatPreviewApiResult);

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
  });

  it("reports unavailable without calling the API while no unit is placed", () => {
    const previewImpl = vi.fn();

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", createInitialDraft(), { previewImpl }),
    );

    expect(result.current.status).toBe("unavailable");
    expect(previewImpl).not.toHaveBeenCalled();
  });

  it("fails a response whose unit count does not match the request, rather than shifting stats onto the wrong slots", async () => {
    const previewImpl = vi.fn().mockResolvedValue(okResult([previewUnit()]));

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
  });
});

describe("useFormationStatPreview — 古い応答の破棄と枠の突き合わせ", () => {
  /** 解決を手動で制御できるプレビュー実装。 */
  function deferredPreviewImpl() {
    const resolvers: ((result: FormationStatPreviewApiResult) => void)[] = [];
    const impl = vi.fn(
      () =>
        new Promise<FormationStatPreviewApiResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return { impl, resolvers };
  }

  it("discards a request that was invalidated before it resolved, so a stale success cannot overwrite the unavailable state", async () => {
    const { impl, resolvers } = deferredPreviewImpl();
    const draft = baseDraft();

    const { result, rerender } = renderHook(
      ({ current }: { current: BattleDraft }) =>
        useFormationStatPreview("https://api.example", current, { previewImpl: impl }),
      { initialProps: { current: draft } },
    );

    await waitFor(() => {
      expect(impl).toHaveBeenCalledTimes(1);
    });

    // 学園レベルを未入力へ戻すと、リクエストを組み立てられない状態になる
    // （枠にはユニットが残っているため、古い値を表示し得る）。
    rerender({
      current: {
        ...draft,
        allyEnhancement: {
          ...draft.allyEnhancement,
          enabled: true,
          academyLevels: {
            ...draft.allyEnhancement.academyLevels,
            unitTypes: { ...draft.allyEnhancement.academyLevels.unitTypes, PHYSICAL: "" },
          },
        },
      },
    });
    expect(result.current.status).toBe("unavailable");

    // abortと競合して先に完了していた古い成功が、いま到着する。
    await act(async () => {
      resolvers[0]?.(okResult([previewUnit(), previewUnit({ side: "ENEMY" })]));
      await Promise.resolve();
    });

    expect(result.current.status).toBe("unavailable");
  });

  it("maps each response entry by side and formationPosition, so a reordered response never lands on the wrong slot", async () => {
    let draft = createInitialDraft();
    draft = withUnit(draft, "ally", "FRONT", 0, "UNIT_ALLY");
    draft = withUnit(draft, "ally", "REAR", 2, "UNIT_REAR");
    const previewImpl = vi.fn().mockResolvedValue(
      okResult([
        // リクエストの並び（FRONT:0 → REAR:2）とは逆順で返す。
        previewUnit({
          unitDefinitionId: "UNIT_REAR",
          formationPosition: { column: 2, row: "REAR" },
          maximumHp: 2222,
        }),
        previewUnit({
          unitDefinitionId: "UNIT_ALLY",
          formationPosition: { column: 0, row: "FRONT" },
          maximumHp: 1111,
        }),
      ]),
    );

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", draft, { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    if (result.current.status !== "ready") return;
    expect(result.current.bySlotKey.get(slotKeyOf("ally", "FRONT", 0))?.maximumHp).toBe(1111);
    expect(result.current.bySlotKey.get(slotKeyOf("ally", "REAR", 2))?.maximumHp).toBe(2222);
  });

  it("fails the whole preview when a response entry names a unit the request never placed at that position", async () => {
    const previewImpl = vi
      .fn()
      .mockResolvedValue(
        okResult([
          previewUnit({ unitDefinitionId: "UNIT_SOMETHING_ELSE" }),
          previewUnit({ side: "ENEMY", unitDefinitionId: "UNIT_ENEMY" }),
        ]),
      );

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
  });

  it("fails the whole preview when an entry's side does not match the requested slot", async () => {
    const previewImpl = vi
      .fn()
      .mockResolvedValue(okResult([previewUnit(), previewUnit({ side: "ALLY" })]));

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("failed");
    });
  });
});
