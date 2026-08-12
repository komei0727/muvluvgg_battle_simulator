import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions } from "../features/simulation/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
} from "../features/simulation/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: {},
  memoryImageMap: {},
  definitionImageMap: {},
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function catalogResponse(): BattleSimulationCatalogResponse {
  return {
    schemaVersion: 1,
    catalogRevision: "rev-1",
    units: [
      {
        unitDefinitionId: "UNIT_A",
        displayName: "アルファ",
        characterName: "Alpha",
        attribute: "CUTE",
        unitType: "ATTACKER",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT"],
      },
      {
        unitDefinitionId: "UNIT_B",
        displayName: "ブラボー",
        characterName: "Bravo",
        attribute: "SMART",
        unitType: "ATTACKER",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
    ],
    memories: [],
  };
}

function readyGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>(() =>
    Promise.resolve({ ok: true, response: catalogResponse() }),
  );
}

function renderPage() {
  return render(
    <BattleSimulatorPage
      apiBaseUrl="https://api.example.com"
      getCatalogImpl={readyGetCatalogImpl()}
    />,
  );
}

async function waitForCatalog() {
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
  });
}

async function switchMode(user: UserEvent, label: "通常戦闘" | "戦術演習") {
  await user.click(screen.getByRole("tab", { name: label }));
}

function allySection() {
  return screen.getByRole("region", { name: /ALLY FORMATION/ });
}

/** 味方の学園レベル入力。敵側にも同名の入力があるため陣営でスコープする。 */
function allyAcademyLevelInput(label: string) {
  return within(allySection()).getByLabelText(label);
}

async function enableAllyEnhancement(user: UserEvent) {
  await user.click(within(allySection()).getByRole("checkbox", { name: /強化/ }));
}

async function placeAlly(user: UserEvent, unitName: string) {
  await user.click(within(allySection()).getByRole("button", { name: "前衛1にユニットを追加" }));
  await user.click(screen.getByRole("button", { name: `${unitName}を選択` }));
}

async function setAllyUnitLevel(user: UserEvent, level: string) {
  await user.click(within(allySection()).getByRole("button", { name: /の強化を編集/ }));
  const input = screen.getByLabelText("現在レベル");
  await user.clear(input);
  await user.type(input, level);
  await user.click(screen.getByRole("button", { name: "閉じる" }));
}

// 01_UI要求・画面設計.md §5.9: 手持ちデータ（学園レベル・ユニットレベル・ギア）は
// モードに依らない味方の育成情報であり、どのモードで編集しても共通・永続化される。
describe("BattleSimulatorPage — 手持ちデータはモード共通 (UI-AC-030)", () => {
  it("carries an academy level edited in the battle mode into the exercise mode", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();

    await enableAllyEnhancement(user);
    await user.clear(allyAcademyLevelInput("物理"));
    await user.type(allyAcademyLevelInput("物理"), "50");

    await switchMode(user, "戦術演習");

    expect(allyAcademyLevelInput("物理")).toHaveValue(50);
  });

  it("carries an academy level edited in the exercise mode back into the battle mode", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await switchMode(user, "戦術演習");

    await enableAllyEnhancement(user);
    await user.clear(allyAcademyLevelInput("キュート"));
    await user.type(allyAcademyLevelInput("キュート"), "37");

    await switchMode(user, "通常戦闘");

    expect(allyAcademyLevelInput("キュート")).toHaveValue(37);
  });

  it("restores an academy level edited in the exercise mode after a remount", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await enableAllyEnhancement(user);
    await user.clear(allyAcademyLevelInput("敏捷"));
    await user.type(allyAcademyLevelInput("敏捷"), "42");
    await waitFor(() => {
      expect(window.localStorage.getItem("mlgg:player-data")).toContain("42");
    });
    first.unmount();

    renderPage();
    await waitForCatalog();

    expect(allyAcademyLevelInput("敏捷")).toHaveValue(42);
  });

  it("prefills a unit level edited in the exercise mode when the same unit is placed in the battle mode", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await switchMode(user, "戦術演習");
    await enableAllyEnhancement(user);
    await placeAlly(user, "アルファ");
    await setAllyUnitLevel(user, "220");

    await switchMode(user, "通常戦闘");
    await enableAllyEnhancement(user);
    await placeAlly(user, "アルファ");
    await user.click(within(allySection()).getByRole("button", { name: /の強化を編集/ }));

    expect(screen.getByLabelText("現在レベル")).toHaveValue(220);
  });

  // 手持ちデータの書き戻しは編集操作でだけ起こす。モードを行き来しただけで、
  // 離れたモードのdraftが持つ古い値が最新の手持ちデータを上書きしてはならない。
  it("never rewrites the saved growth data on a bare mode switch", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForCatalog();
    await enableAllyEnhancement(user);
    await placeAlly(user, "アルファ");
    await setAllyUnitLevel(user, "180");

    await switchMode(user, "戦術演習");
    await enableAllyEnhancement(user);
    await placeAlly(user, "アルファ");
    await setAllyUnitLevel(user, "250");

    await switchMode(user, "通常戦闘");
    await switchMode(user, "戦術演習");
    await switchMode(user, "通常戦闘");

    // 直近に編集したのは演習側なので、手持ちデータは250のまま。
    await waitFor(() => {
      expect(window.localStorage.getItem("mlgg:player-data")).toContain('"level":250');
    });
  });
});
