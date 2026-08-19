import { test, expect } from "@playwright/test";

test.describe("Observer UI", () => {
  test("overview renders the primary instrument readout", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Overview");
    await expect(page.getByText("Usage over time", { exact: true })).toBeVisible();
    await expect(page.getByText("Token composition", { exact: true })).toBeVisible();

    const composition = page.locator(".composition-section .composition");
    const cachedLegend = composition.locator('.comp-legend .item[data-label="Cached input"]');
    const cachedSegment = composition.locator('.comp-segment[data-label="Cached input"]');
    await cachedLegend.hover();
    await expect(cachedLegend).toHaveClass(/is-active/);
    await expect(cachedSegment).toHaveClass(/is-active/);
    await expect(composition.locator('.comp-legend .item[data-label="Uncached input"]')).toHaveClass(/is-muted/);
    await cachedSegment.hover();
    await expect(cachedLegend).toHaveClass(/is-active/);

    const totalGrouping = page.getByRole("button", { name: "Total", exact: true });
    const harnessGrouping = page.getByRole("button", { name: "Harnesses", exact: true });
    await expect(totalGrouping).toHaveAttribute("aria-pressed", "true");
    await harnessGrouping.click();
    await expect(harnessGrouping).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Daily harness comparison/)).toBeVisible();
    await expect(page.locator(".usage-section .comparison-area").first()).toBeVisible();

    await expect(page.getByRole("button", { name: /sync now/i }).first()).toBeVisible();
  });

  test("observation filters persist across reloads", async ({ page }) => {
    await page.route("**/api/v1/dimensions", (route) => route.fulfill({
      json: { harnesses: ["codex"], providers: [], models: [], projects: [] },
    }));
    await page.goto("/");
    const sevenDays = page.getByRole("button", { name: "7D", exact: true });

    await sevenDays.click();
    await page.getByLabel("Chart metric").click();
    await page.getByRole("option", { name: "Cost (USD)" }).click();
    await page.getByRole("button", { name: /^Filter/ }).click();
    const filterDialog = page.getByRole("dialog", { name: "Observation filters" });
    await filterDialog.getByRole("button", { name: /^Harness/ }).click();
    await page.getByRole("checkbox", { name: "codex" }).check();
    await expect(sevenDays).toHaveClass(/active/);
    await page.reload();

    await expect(page.getByRole("button", { name: "7D", exact: true })).toHaveClass(/active/);
    await expect(page.getByLabel("Chart metric")).toHaveText("Cost (USD)");
    await expect(page.getByRole("button", { name: "Clear codex" })).toBeVisible();
  });

  test("sessions route renders the observation table", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.locator("h1")).toHaveText("Sessions");
    await expect(page.getByText("Observed sessions", { exact: true })).toBeVisible();
    const firstSession = page.locator(".sessions-table tbody tr[role=button]").first();
    await firstSession.click();
    await expect(page.getByRole("complementary", { name: /Session/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: /Session/ })).toBeHidden();
  });

  test("analysis route renders the analytical views", async ({ page }) => {
    await page.goto("/analysis");
    await expect(page.locator("h1")).toHaveText("Analysis");
    await expect(page.getByText("Cache economics", { exact: true })).toBeVisible();
    await expect(page.getByText("Usage by provider", { exact: true })).toBeVisible();
    await expect(page.getByText("Usage by harness", { exact: true })).toBeVisible();

    const providerToggle = page.getByRole("button", { name: "Collapse provider sidebar" });
    await expect(providerToggle).toHaveAttribute("aria-expanded", "true");
    await providerToggle.click();
    await expect(page.getByRole("button", { name: "Expand provider sidebar" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#provider-breakdown")).toBeHidden();

    const harnessToggle = page.getByRole("button", { name: "Collapse harness sidebar" });
    await harnessToggle.click();
    await expect(page.getByRole("button", { name: "Expand harness sidebar" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#harness-breakdown")).toBeHidden();

    const harnessMetrics = page.locator(".harness-metric-matrix");
    await expect(harnessMetrics).toBeVisible();
    await expect(harnessMetrics.getByText("Processed tokens", { exact: true })).toBeVisible();
    await expect(harnessMetrics.getByText("Cache hit rate", { exact: true })).toBeVisible();
    const leadingCell = harnessMetrics.locator("td.is-best").first();
    await expect(leadingCell).toBeVisible();
    await leadingCell.hover();
    await expect(leadingCell).toHaveClass(/is-active-column/);
    await expect(page.getByText("Comparison metrics", { exact: true })).toBeVisible();
  });

  test("settings route shows config file location and actions", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.getByText("Configuration", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: /rebuild index/i })).toBeVisible();
  });
});
