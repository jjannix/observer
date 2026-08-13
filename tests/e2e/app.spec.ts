import { test, expect } from "@playwright/test";

test.describe("Observer UI", () => {
  test("overview renders the primary instrument readout", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Overview");
    await expect(page.getByText("Usage over time", { exact: true })).toBeVisible();
    await expect(page.getByText("Token composition", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i }).first()).toBeVisible();
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
