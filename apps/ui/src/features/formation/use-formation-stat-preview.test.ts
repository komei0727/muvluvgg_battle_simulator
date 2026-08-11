import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFormationStatPreview } from "./use-formation-stat-preview.js";
import { createInitialDraft, slotKeyOf } from "./types.js";
import type { BattleDraft, Side, UiColumn, UiRow } from "./types.js";
import type {
  FormationStatPreviewApiResult,
  FormationStatPreviewUnit,
} from "../simulation/api-contract.js";

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

  it("drops a response whose unit count does not match the request, rather than shifting stats onto the wrong slots", async () => {
    const previewImpl = vi.fn().mockResolvedValue(okResult([previewUnit()]));

    const { result } = renderHook(() =>
      useFormationStatPreview("https://api.example", baseDraft(), { previewImpl }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    if (result.current.status !== "ready") return;
    expect(result.current.bySlotKey.size).toBe(0);
  });
});
