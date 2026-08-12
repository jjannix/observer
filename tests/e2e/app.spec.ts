import { test, expect } from "@playwright/test";

test.describe("diagnostic UI", () => {
  test("overview renders source cards and metrics", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Overview");
    await expect(page.getByText("Usage over time", { exact: true })).toBeVisible();
    await expect(page.getByText("Token composition", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i }).first()).toBeVisible();
  });

  test("events route renders the table shell", async ({ page }) => {
    await page.goto("/events");
    await expect(page.locator("h1")).toHaveText("Events");
  });

  test("settings route shows config file location and actions", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.getByText("Configuration", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: /rebuild index/i })).toBeVisible();
  });
});
