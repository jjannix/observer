import { test, expect } from "@playwright/test";

test.describe("Observer UI", () => {
  test("overview renders the primary instrument readout", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Overview");
    await expect(page.getByText("Usage over time", { exact: true })).toBeVisible();
    await expect(page.getByText("Token composition", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i }).first()).toBeVisible();
  });

  test("observation filters persist across reloads", async ({ page }) => {
    await page.route("**/api/v1/dimensions", (route) => route.fulfill({
      json: { harnesses: ["codex"], providers: [], models: [], projects: [] },
    }));
    await page.goto("/");
    const sevenDays = page.getByRole("button", { name: "7D", exact: true });

    await sevenDays.click();
    await page.getByLabel("Chart metric").selectOption("costUsd");
    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByRole("button", { name: /^Harness/ }).click();
    await page.getByRole("checkbox", { name: "codex" }).check();
    await expect(sevenDays).toHaveClass(/active/);
    await page.reload();

    await expect(page.getByRole("button", { name: "7D", exact: true })).toHaveClass(/active/);
    await expect(page.getByLabel("Chart metric")).toHaveValue("costUsd");
    await expect(page.getByRole("button", { name: "Clear codex" })).toBeVisible();
  });

  test("sessions route renders the observation table", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.locator("h1")).toHaveText("Sessions");
    await expect(page.getByText("Observed sessions", { exact: true })).toBeVisible();
  });

  test("analysis route renders the analytical views", async ({ page }) => {
    await page.goto("/analysis");
    await expect(page.locator("h1")).toHaveText("Analysis");
    await expect(page.getByText("Cache economics", { exact: true })).toBeVisible();
    await expect(page.getByText("Usage by provider", { exact: true })).toBeVisible();
  });

  test("settings route shows config file location and actions", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.getByText("Configuration", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: /rebuild index/i })).toBeVisible();
  });
});
