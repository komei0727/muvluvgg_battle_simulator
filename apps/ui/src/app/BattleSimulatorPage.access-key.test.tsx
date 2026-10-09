import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCatalogOptions, SimulateOptions } from "../shared/api/api-client.js";
import { readStoredAccessKey, writeStoredAccessKey } from "../shared/api/access-key.js";
import type {
  BattleSimulationCatalogResponse,
  CatalogApiResult,
  FormationStatPreviewApiResult,
  FormationStatPreviewRequest,
} from "../shared/api/api-contract.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

vi.mock("../features/catalog-selection/definition-image-map.js", () => ({
  unitImageMap: {},
  memoryImageMap: {},
  definitionImageMap: {},
}));

const GOOD_KEY = "g".repeat(40);
const BAD_KEY = "b".repeat(40);

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
    ],
    memories: [],
  };
}

const UNAUTHORIZED = {
  ok: false,
  status: 401,
  error: {
    kind: "UNAUTHORIZED",
    message: "A valid access key is required.",
    status: 401,
    code: "UNAUTHORIZED",
  },
} as const;

/** `GOOD_KEY`だけを受け付けるAPI。 */
function keyCheckingGetCatalogImpl() {
  return vi.fn<(options: GetCatalogOptions) => Promise<CatalogApiResult>>((options) =>
    Promise.resolve(
      options.accessKey === GOOD_KEY ? { ok: true, response: catalogResponse() } : UNAUTHORIZED,
    ),
  );
}

async function waitForCatalog() {
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: /ALLY FORMATION/ })).toBeInTheDocument();
  });
}

describe("BattleSimulatorPage — アクセスキー", () => {
  it("UI-CT-155: asks for a key when the catalog answers 401, then loads the catalog with the entered key and keeps it for the next visit", async () => {
    const user = userEvent.setup();
    const getCatalogImpl = keyCheckingGetCatalogImpl();
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    const input = await screen.findByLabelText("アクセスキー");
    // キー入力欄がCatalog失敗の扱いを引き受けるため、サーバーの生messageと再読込は出さない。
    expect(screen.queryByText("A valid access key is required.")).toBeNull();
    expect(screen.queryByRole("button", { name: "再読込" })).toBeNull();

    await user.type(input, GOOD_KEY);
    await user.click(screen.getByRole("button", { name: "保存して接続" }));

    await waitForCatalog();
    expect(getCatalogImpl.mock.calls.at(-1)?.[0].accessKey).toBe(GOOD_KEY);
    expect(screen.queryByLabelText("アクセスキー")).toBeNull();
    expect(readStoredAccessKey()).toBe(GOOD_KEY);
  });

  it("UI-CT-156: explains a rejected key, forgets it, and accepts a corrected key", async () => {
    const user = userEvent.setup();
    writeStoredAccessKey(BAD_KEY);
    const getCatalogImpl = keyCheckingGetCatalogImpl();
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("アクセスキーが正しくないか");
    expect(readStoredAccessKey()).toBeUndefined();

    // 同じ誤りキーを入れ直しても、取得し直して再び拒否されることを示す。
    await user.type(screen.getByLabelText("アクセスキー"), BAD_KEY);
    await user.click(screen.getByRole("button", { name: "保存して接続" }));
    await waitFor(() => {
      expect(getCatalogImpl).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("アクセスキーが正しくないか");

    await user.clear(screen.getByLabelText("アクセスキー"));
    await user.type(screen.getByLabelText("アクセスキー"), GOOD_KEY);
    await user.click(screen.getByRole("button", { name: "保存して接続" }));

    await waitForCatalog();
  });

  it("UI-CT-157: uses a stored key without asking, and the header action forgets it and refetches without a key", async () => {
    const user = userEvent.setup();
    writeStoredAccessKey(GOOD_KEY);
    const getCatalogImpl = keyCheckingGetCatalogImpl();
    render(
      <BattleSimulatorPage apiBaseUrl="https://api.example.com" getCatalogImpl={getCatalogImpl} />,
    );

    await waitForCatalog();
    expect(screen.queryByLabelText("アクセスキー")).toBeNull();

    await user.click(screen.getByRole("button", { name: "アクセスキーを再設定" }));

    expect(await screen.findByLabelText("アクセスキー")).toBeInTheDocument();
    expect(readStoredAccessKey()).toBeUndefined();
    expect(getCatalogImpl.mock.calls.at(-1)?.[0].accessKey).toBeUndefined();
  });

  it("UI-CT-158: hides the reset action when no key is stored, since there is nothing to forget", async () => {
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={vi.fn(() =>
          Promise.resolve<CatalogApiResult>({ ok: true, response: catalogResponse() }),
        )}
      />,
    );

    await waitForCatalog();
    expect(screen.queryByRole("button", { name: "アクセスキーを再設定" })).toBeNull();
  });

  it("UI-CT-159: a 401 from a later API call (key revoked mid-session) brings the key form back and sends the stored key to that call", async () => {
    const user = userEvent.setup();
    writeStoredAccessKey(GOOD_KEY);
    const previewFormationStatsImpl = vi.fn<
      (
        request: FormationStatPreviewRequest,
        options: SimulateOptions,
      ) => Promise<FormationStatPreviewApiResult>
    >(() => Promise.resolve(UNAUTHORIZED));
    render(
      <BattleSimulatorPage
        apiBaseUrl="https://api.example.com"
        getCatalogImpl={keyCheckingGetCatalogImpl()}
        previewFormationStatsImpl={previewFormationStatsImpl}
      />,
    );
    await waitForCatalog();

    const allySection = screen.getByRole("region", { name: /ALLY FORMATION/ });
    await user.click(within(allySection).getByRole("button", { name: "前衛1にユニットを追加" }));
    await user.click(screen.getByRole("button", { name: "アルファを選択" }));

    // 編成の検証表示など別のalertも並び得るため、キー入力欄の文言そのもので探す。
    expect(await screen.findByText(/アクセスキーが正しくないか/)).toBeInTheDocument();
    expect(screen.getByLabelText("アクセスキー")).toBeInTheDocument();
    expect(previewFormationStatsImpl.mock.calls[0]?.[1].accessKey).toBe(GOOD_KEY);
    expect(readStoredAccessKey()).toBeUndefined();
  });
});
