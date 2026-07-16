import { expect, test } from "@playwright/test";
import { catalogFixture } from "./fixtures/catalog.js";
import { mockCatalog } from "./support/mock-api.js";

// UI-ARCH-001/002 foundation smoke test: the built shell must load from the
// GitHub Pages base path with no failed asset requests. Feature flows are
// covered by later M4.5 UI issues once they exist.
test("loads the app shell from the Pages base path without failed requests", async ({ page }) => {
  await mockCatalog(page, { status: 200, body: catalogFixture });
  const failedRequests: string[] = [];
  page.on("requestfailed", (request) => {
    failedRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto("./");

  await expect(page.getByRole("banner")).toContainText("BATTLE ANALYTICS CONSOLE");
  await expect(page.getByRole("region", { name: "戦闘パラメータ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /ALLY FORMATION/ })).toBeVisible();
  expect(failedRequests).toEqual([]);
});
