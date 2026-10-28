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

  test("overview compares the top 3 or 5 models by the selected metric", async ({ page }) => {
    const models = ["model-a", "model-b", "model-c", "model-d", "model-e", "model-f"];
    await page.route("**/api/v1/timeseries?**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const providers = query.get("groupBy") === "model" ? models : ["codex"];
      const values = query.get("metric") === "requests" ? [60, 50, 40, 30, 20, 10] : [10, 20, 30, 40, 50, 60];
      return route.fulfill({ json: {
        metric: query.get("metric"), groupBy: query.get("groupBy"),
        buckets: ["2026-09-01", "2026-09-02"], providers,
        points: providers.flatMap((provider, index) => [
          { date: "2026-09-01", provider, value: values[index] },
          { date: "2026-09-02", provider, value: values[index] * 2 },
        ]),
      } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const legend = page.locator(".usage-section .overview-legend button");
    await expect(legend).toHaveText(["model-f", "model-e", "model-d"]);
    await expect(page.getByRole("img", { name: "Model usage comparison over time" })).toBeVisible();
    await page.getByRole("button", { name: "Top 5", exact: true }).click();
    await expect(legend).toHaveText(["model-f", "model-e", "model-d", "model-c", "model-b"]);
    await expect(page.locator(".usage-section .comparison-signal")).toHaveCount(5);
    await legend.first().click();
    await expect(legend.first()).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Chart metric").click();
    await page.getByRole("option", { name: "Requests", exact: true }).click();
    await expect(legend).toHaveText(["model-a", "model-b", "model-c", "model-d", "model-e"]);
    await page.getByRole("button", { name: "Harnesses", exact: true }).click();
    await expect(page.getByRole("group", { name: "Number of top models" })).toHaveCount(0);
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.getByRole("button", { name: "Top 5", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Top 3", exact: true }).click();
    await expect(legend).toHaveText(["model-a", "model-b", "model-c"]);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("button", { name: "Top 5", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("cache hit rate charts show weighted percentages and zero-rate models", async ({ page }) => {
    await page.route("**/api/v1/timeseries?**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const points = [
        { date: "2026-09-01", provider: "high-cache", value: 0.9, inputTokens: 900 },
        { date: "2026-09-01", provider: "low-cache", value: 0.1, inputTokens: 100 },
      ];
      if (query.get("groupBy") !== "provider") {
        points.push({ date: "2026-09-01", provider: "zero-cache", value: 0, inputTokens: 200 });
      }
      return route.fulfill({ json: {
        metric: query.get("metric"), groupBy: query.get("groupBy"),
        buckets: ["2026-09-01"], providers: points.map((point) => point.provider), points,
      } });
    });
    await page.goto("/");
    await page.getByLabel("Chart metric").click();
    await page.getByRole("option", { name: "Cache hit rate", exact: true }).click();
    await expect(page.getByLabel("Chart metric")).toHaveText("Cache hit rate");
    await expect(page.locator(".usage-section .axis")).toContainText("25.0%");
    await page.getByRole("img", { name: "Usage over time", exact: true }).hover();
    await expect(page.locator(".usage-section .t-total strong")).toHaveText("82.0%");
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.locator(".usage-section .overview-legend button")).toHaveText(["high-cache", "low-cache", "zero-cache"]);
    await page.getByRole("img", { name: "Model usage comparison over time" }).hover();
    await expect(page.locator(".usage-section .comparison-tip")).toContainText("0.0%");
    await page.reload();
    await expect(page.getByLabel("Chart metric")).toHaveText("Cache hit rate");
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

  test("sessions can be searched, inspected, bookmarked and closed with the keyboard", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.locator("h1")).toHaveText("Sessions");
    await expect(page.getByText("Observed sessions", { exact: true })).toBeVisible();
    await page.getByLabel("Sort sessions", { exact: true }).selectOption("tokens");
    await expect(page.getByLabel("Sort sessions", { exact: true })).toHaveValue("tokens");
    const firstSession = page.locator(".session-browser-table a[data-session-id]").first();
    await expect(firstSession).toBeVisible();
    const id = await firstSession.getAttribute("data-session-id");
    await firstSession.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Token composition", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Models used", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "All requests", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full session", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/session=/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Largest requests", exact: true })).toBeVisible();
    const requestOrder = page.getByLabel("Request order", { exact: true });
    await requestOrder.selectOption("largest");
    await expect(page.locator(".session-requests-table tbody tr").first()).toBeVisible();
    await expect(requestOrder).toHaveValue("largest");
    await page.locator(".session-large-request").first().click();
    await expect(page.getByRole("region", { name: "Selected request accounting" })).toBeFocused();
    await page.getByRole("button", { name: "Close request", exact: true }).click();
    await expect(page.locator(".session-large-request").first()).toBeFocused();
    await page.getByRole("button", { name: "Selected period & filters", exact: true }).click();
    await expect(page.getByRole("button", { name: "Selected period & filters", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Full session", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Observed sessions", { exact: true })).toBeVisible();
    await expect(page.locator(".session-browser-table a[data-session-id]").first()).toBeFocused();
    await page.getByRole("searchbox", { name: "Search sessions" }).fill(id!);
    await expect(page.locator(".session-browser-table tbody tr")).toHaveCount(1);
    await expect(page.locator(".session-browser-table a[data-session-id]")).toHaveAttribute("data-session-id", id!);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("no-such-session-xyz");
    await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
    await page.getByRole("button", { name: "Show all sessions", exact: true }).click();
    await expect(page.locator(".session-browser-table tbody tr").first()).toBeVisible();
  });

  test("session table headers sort and reverse order with keyboard support", async ({ page }) => {
    await page.goto("/sessions");
    const sessions = page.locator(".session-browser-table");
    await expect(sessions.locator("tbody tr").first()).toBeVisible();
    const processedHeader = sessions.getByRole("button", { name: "Sort by Processed", exact: true });
    await processedHeader.focus();
    await page.keyboard.press("Enter");
    await expect(sessions.locator("th").nth(3)).toHaveAttribute("aria-sort", "descending");
    await expect(page).toHaveURL(/direction=desc/);
    const sessionValues = async () => sessions.locator("tbody tr td:nth-child(4)").evaluateAll(cells => cells.map(cell => Number(cell.getAttribute("title")!.replaceAll(",", ""))));
    await expect.poll(async () => { const values = await sessionValues(); return values.length > 0 && values.every((value, i) => i === 0 || values[i - 1] >= value); }).toBe(true);
    await processedHeader.click();
    await expect(sessions.locator("th").nth(3)).toHaveAttribute("aria-sort", "ascending");
    await expect.poll(async () => { const values = await sessionValues(); return values.length > 0 && values.every((value, i) => i === 0 || values[i - 1] <= value); }).toBe(true);
    await page.reload();
    await expect(sessions.locator("th").nth(3)).toHaveAttribute("aria-sort", "ascending");
    // Choose a large session so request paging and multiple models can be exercised.
    await page.getByLabel("Sort sessions", { exact: true }).selectOption("tokens");
    await expect.poll(async () => { const values = await sessionValues(); return values.length > 0 && values.every((value, i) => i === 0 || values[i - 1] >= value); }).toBe(true);
    await sessions.locator("a[data-session-id]").first().click();
    const models = page.locator(".session-model-table");
    await models.getByRole("button", { name: "Sort by Model / provider", exact: true }).click();
    await expect(models.locator("th").first()).toHaveAttribute("aria-sort", "ascending");
    await models.getByRole("button", { name: "Sort by Model / provider", exact: true }).click();
    await expect(models.locator("th").first()).toHaveAttribute("aria-sort", "descending");
    const requests = page.locator(".session-requests-table");
    const requestProcessed = requests.getByRole("button", { name: "Sort by Processed", exact: true });
    await requestProcessed.click();
    await expect(requests.locator("th").nth(2)).toHaveAttribute("aria-sort", "descending");
    await page.getByRole("button", { name: "Next requests", exact: true }).click();
    await expect(page.locator(".session-pagination").last()).toContainText("51-");
    await requestProcessed.click();
    await expect(requests.locator("th").nth(2)).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByRole("button", { name: "Previous requests", exact: true })).toBeDisabled();
    const requestValues = async () => requests.locator("tbody tr td:nth-child(3)").evaluateAll(cells => cells.map(cell => Number(cell.getAttribute("title")!.replaceAll(",", ""))));
    await expect.poll(async () => { const values = await requestValues(); return values.length > 0 && values.every((value, i) => i === 0 || values[i - 1] <= value); }).toBe(true);
    await expect(page.getByText("Inspect →", { exact: true })).toHaveCount(0);
  });

  test("sorting keeps tables, focus and geometry stable while responses are pending", async ({ page }) => {
    await page.goto("/sessions");
    const sessions = page.locator(".session-browser-table");
    await expect(sessions.locator("tbody tr").first()).toBeVisible();
    let releaseSessionSort!: () => void;
    const sessionGate = new Promise<void>(resolve => { releaseSessionSort = resolve; });
    await page.route("**/api/v1/sessions?**", async route => {
      if (new URL(route.request().url()).searchParams.get("sort") === "tokens") await sessionGate;
      await route.continue();
    });
    const tableHandle = await sessions.elementHandle();
    const originalCount = await sessions.locator("tbody tr").count();
    const originalWidths = await sessions.locator("th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
    const processed = sessions.getByRole("button", { name: "Sort by Processed", exact: true });
    await processed.focus();
    const originalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.keyboard.press("Enter");
    await expect(sessions.locator("..")).toHaveAttribute("aria-busy", "true");
    expect(await tableHandle!.evaluate(element => element.isConnected)).toBe(true);
    await expect(sessions.locator("tbody tr")).toHaveCount(originalCount);
    await expect(processed).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(originalHeight);
    expect(await sessions.locator("th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))).toEqual(originalWidths);
    await expect(page.locator(".session-loading")).toHaveCount(0);
    await expect(page.locator(".session-result-status .session-update-status")).toHaveText("Updating…");
    // A second activation must remain possible while the first sort is in flight.
    await page.keyboard.press("Enter");
    await expect(sessions.locator("th").nth(3)).toHaveAttribute("aria-sort", "ascending");
    releaseSessionSort();
    await expect(sessions.locator("..")).toHaveAttribute("aria-busy", "false");
    await expect(processed).toBeFocused();
    expect(await sessions.locator("th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))).toEqual(originalWidths);
    await page.unroute("**/api/v1/sessions?**");
    await processed.click();
    await expect(sessions.locator("..")).toHaveAttribute("aria-busy", "false");
    await sessions.locator("a[data-session-id]").first().click();
    const requests = page.locator(".session-requests-table");
    await expect(requests.locator("tbody tr").first()).toBeVisible();
    let releaseRequestSort!: () => void;
    const requestGate = new Promise<void>(resolve => { releaseRequestSort = resolve; });
    await page.route("**/api/v1/sessions/*/requests?**", async route => {
      if (new URL(route.request().url()).searchParams.get("sort") === "largest") await requestGate;
      await route.continue();
    });
    const requestHandle = await requests.elementHandle();
    const requestProcessed = requests.getByRole("button", { name: "Sort by Processed", exact: true });
    await requestProcessed.focus();
    const beforeSort = await page.evaluate(() => ({ scroll: scrollY, height: document.documentElement.scrollHeight }));
    const requestCount = await requests.locator("tbody tr").count();
    await page.keyboard.press("Enter");
    await expect(requests.locator("..")).toHaveAttribute("aria-busy", "true");
    expect(await requestHandle!.evaluate(element => element.isConnected)).toBe(true);
    await expect(requests.locator("tbody tr")).toHaveCount(requestCount);
    await expect(requestProcessed).toBeFocused();
    expect(await page.evaluate(() => ({ scroll: scrollY, height: document.documentElement.scrollHeight }))).toEqual(beforeSort);
    await expect(page.getByRole("button", { name: "Next requests", exact: true })).toBeDisabled();
    releaseRequestSort();
    await expect(requests.locator("..")).toHaveAttribute("aria-busy", "false");
    await expect(requestProcessed).toBeFocused();
    await page.unroute("**/api/v1/sessions/*/requests?**");
  });

  test("session details remain usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/sessions");
    const usageCell = page.locator(".session-browser-table tbody tr").first().locator("td").nth(3);
    await expect(usageCell).toBeVisible();
    expect(await usageCell.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    })).toBe(true);
    await page.locator(".session-browser-table a[data-session-id]").first().click();
    await expect(page.locator("#session-detail-heading")).toBeVisible();
    await expect(page.getByRole("button", { name: "Full session", exact: true })).toBeVisible();
    await expect(page.locator(".session-usage-strip")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Request order", { exact: true }).selectOption("largest");
    await expect(page.locator(".session-requests-table tbody tr").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "← All sessions", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Search sessions" })).toBeVisible();
  });

  test("session query errors have retry recovery", async ({ page }) => {
    await page.route("**/api/v1/sessions?**", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
    await page.goto("/sessions");
    await expect(page.getByRole("alert")).toContainText("Sessions couldn’t be loaded");
    await page.unroute("**/api/v1/sessions?**");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator(".session-browser-table tbody tr").first()).toBeVisible();
  });

  test("day-scoped sessions recover after the time zone fails to load", async ({ page }) => {
    // Keep the tested day inside the observation period, independently of today.
    await page.addInitScript(() => {
      localStorage.setItem("observer.filters", JSON.stringify({
        range: "custom", from: "2026-09-05T04:00:00.000Z", to: "2026-09-07T03:00:00.000Z",
      }));
    });
    const sessionsQueries: URLSearchParams[] = [];
    await page.route("**/api/v1/sessions?**", (route) => {
      sessionsQueries.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
    });
    await page.route("**/api/v1/config", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
    await page.goto("/sessions?day=2026-09-06");
    await expect(page.getByRole("alert")).toContainText("The time zone couldn’t be loaded");
    await expect(page.locator(".session-result-status")).toContainText("Unable to load");
    expect(sessionsQueries).toHaveLength(0);

    await page.unroute("**/api/v1/config");
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: { timezone: "America/Santiago" } }));
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No matching sessions" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(sessionsQueries).toHaveLength(1);
    expect(sessionsQueries[0].get("from")).toBe("2026-09-06T04:00:00.000Z");
    expect(sessionsQueries[0].get("to")).toBe("2026-09-07T03:00:00.000Z");
  });

  test("session activity graph shades days, explains them on hover and lists a day's sessions", async ({ page }) => {
    const days = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 8, 10 + index)).toISOString().slice(0, 10);
      const active = index % 3 !== 0;
      return {
        date,
        sessions: active ? index : 0,
        processedTokens: active ? index * 1000 : 0,
        requests: active ? index * 2 : 0,
        harnesses: active
          ? [
              { harness: "codex", sessions: index - 1, processedTokens: index * 600, requests: index },
              { harness: "pi", sessions: 1, processedTokens: index * 400, requests: index },
            ]
          : [],
      };
    });
    // The graph follows the main period selector (30D by default).
    const activityFrom: string[] = [];
    await page.route("**/api/v1/activity?**", (route) => {
      activityFrom.push(new URL(route.request().url()).searchParams.get("from") ?? "");
      return route.fulfill({ json: {
        timezone: "Europe/Berlin", start: "2026-09-10", end: "2026-10-09", days,
        totals: { sessions: 300, processedTokens: 290_000, requests: 580, activeDays: 20 },
      } });
    });
    let sessionsQuery: URLSearchParams | null = null;
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: { timezone: "Europe/Berlin" } }));
    await page.route("**/api/v1/sessions?**", (route) => {
      sessionsQuery = new URL(route.request().url()).searchParams;
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
    });
    await page.goto("/sessions");
    await expect(page.locator("h1")).toHaveText("Sessions");
    await expect(page.locator(".activity-cell[data-date]")).toHaveCount(30);
    expect(Date.now() - Date.parse(activityFrom[0])).toBeGreaterThan(29 * 86_400_000);
    expect(Date.now() - Date.parse(activityFrom[0])).toBeLessThan(31 * 86_400_000);
    await expect(page.locator('.activity-cell[data-date="2026-09-10"]')).toHaveAttribute("data-level", "0");
    await expect(page.locator('.activity-cell[data-date="2026-10-08"]')).toHaveAttribute("data-level", "4");
    await expect(page.locator(".activity-legend")).toContainText("20 active days · 300 sessions · 290K tokens");

    await page.locator('.activity-cell[data-date="2026-10-08"]').hover();
    const tip = page.locator(".activity-tip");
    await expect(tip).toContainText("Thu, Oct 8, 2026");
    await expect(tip).toContainText("28K tokens");
    await expect(tip).toContainText("28 sessions");
    await expect(tip).toContainText("Codex");
    await expect(tip).toContainText("Pi");

    await page.getByRole("group", { name: "Shade days by" }).getByRole("button", { name: "Sessions" }).click();
    await expect(page).toHaveURL(/activityBy=sessions/);
    await expect(page.locator(".activity-tip")).toHaveCount(0);

    // Keyboard: today is focusable; ArrowLeft moves back one week.
    await page.locator('.activity-cell[tabindex="0"]').focus();
    await expect(page.locator('.activity-cell[tabindex="0"]')).toHaveAttribute("data-date", "2026-10-09");
    await page.keyboard.press("ArrowLeft");
    const picked = page.locator('.activity-cell[data-date="2026-10-02"]');
    await expect(picked).toBeFocused();

    // Enter scopes the list below to that day.
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/day=2026-10-02/);
    await expect(picked).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".session-day")).toContainText("Fri, Oct 2, 2026 (Europe/Berlin)");
    await expect.poll(() => sessionsQuery?.get("from")).toBe("2026-10-01T22:00:00.000Z");
    expect(sessionsQuery!.get("to")).toBe("2026-10-02T22:00:00.000Z");
    // The period selector keeps showing the period the graph covers.
    await expect(page.getByRole("button", { name: "30D", exact: true })).toHaveClass(/active/);

    // Picking the day again, the explicit link, or a new period returns to the selected period.
    await picked.click();
    await expect(page).not.toHaveURL(/day=/);
    await expect(picked).toHaveAttribute("aria-selected", "false");
    await page.locator('.activity-cell[data-date="2026-10-08"]').click();
    await expect(page).toHaveURL(/day=2026-10-08/);
    await page.getByRole("button", { name: "Show selected period", exact: true }).click();
    await expect(page).not.toHaveURL(/day=/);
    await page.locator('.activity-cell[data-date="2026-10-08"]').click();
    await expect(page).toHaveURL(/day=2026-10-08/);
    await page.getByRole("button", { name: "90D", exact: true }).click();
    await expect(page).not.toHaveURL(/day=/);
    await expect.poll(() => Date.now() - Date.parse(activityFrom.at(-1)!)).toBeGreaterThan(89 * 86_400_000);
  });

  test("picked activity edge days stay inside the selected custom period", async ({ page }) => {
    const from = "2026-10-08T00:00:00.000Z";
    const to = "2026-10-09T00:00:00.000Z";
    await page.addInitScript(({ from, to }) => {
      localStorage.setItem("observer.filters", JSON.stringify({ range: "custom", from, to }));
    }, { from, to });
    await page.route("**/api/v1/config", (route) => route.fulfill({ json: { timezone: "Europe/Berlin" } }));
    const days = ["2026-10-08", "2026-10-09"].map((date) => ({
      date, sessions: 1, processedTokens: 100, requests: 1,
      harnesses: [{ harness: "codex", sessions: 1, processedTokens: 100, requests: 1 }],
    }));
    await page.route("**/api/v1/activity?**", (route) => route.fulfill({ json: {
      timezone: "Europe/Berlin", start: days[0].date, end: days[1].date, days,
      totals: { sessions: 2, processedTokens: 200, requests: 2, activeDays: 2 },
    } }));
    let sessionsQuery: URLSearchParams | null = null;
    await page.route("**/api/v1/sessions?**", (route) => {
      sessionsQuery = new URL(route.request().url()).searchParams;
      const total = sessionsQuery.get("from") === from && sessionsQuery.get("to") === to ? 2 : 1;
      return route.fulfill({ json: { items: [], total, page: 1, pageSize: 25 } });
    });
    await page.goto("/sessions");
    const resultCount = page.locator(".session-result-status [role=status]").last();
    await expect(resultCount).toHaveText("2 sessions");
    await page.locator('.activity-cell[data-date="2026-10-08"]').click();
    await expect(page).toHaveURL(/day=2026-10-08/);
    await expect.poll(() => sessionsQuery?.get("from")).toBe(from);
    expect(sessionsQuery!.get("to")).toBe("2026-10-08T22:00:00.000Z");
    await page.locator('.activity-cell[data-date="2026-10-09"]').click();
    await expect(page).toHaveURL(/day=2026-10-09/);
    await expect.poll(() => sessionsQuery?.get("from")).toBe("2026-10-08T22:00:00.000Z");
    expect(sessionsQuery!.get("to")).toBe(to);
    await expect(resultCount).toHaveText("1 session");
    await page.getByRole("button", { name: "Show selected period", exact: true }).click();
    await expect(page).not.toHaveURL(/day=/);
    // Returning to a fresh cached period need not trigger another request.
    await expect(resultCount).toHaveText("2 sessions");
  });

  test("activity days cannot be picked from a previous period while loading", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-09T10:00:00Z"));
    const days = Array.from({ length: 31 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 8, 9 + index)).toISOString().slice(0, 10),
      sessions: 1, processedTokens: 100, requests: 1,
      harnesses: [{ harness: "codex", sessions: 1, processedTokens: 100, requests: 1 }],
    }));
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let newPeriodRequested = false;
    await page.route("**/api/v1/activity?**", async (route) => {
      const from = new URL(route.request().url()).searchParams.get("from")!;
      const short = from.startsWith("2026-10-02");
      if (short) {
        newPeriodRequested = true;
        await pending;
      }
      const visible = short ? days.slice(-8) : days;
      await route.fulfill({ json: {
        timezone: "Europe/Berlin", start: visible[0].date, end: visible.at(-1)!.date, days: visible,
        totals: { sessions: visible.length, processedTokens: visible.length * 100, requests: visible.length, activeDays: visible.length },
      } });
    });
    await page.goto("/sessions");
    const oldDay = page.locator('.activity-cell[data-date="2026-09-25"]');
    await expect(oldDay).toBeVisible();
    await page.getByRole("button", { name: "7D", exact: true }).click();
    await expect.poll(() => newPeriodRequested).toBe(true);
    await expect(oldDay).toHaveAttribute("aria-disabled", "true");
    // Dispatch both selection paths while the previous period is still drawn.
    await oldDay.dispatchEvent("click");
    await oldDay.press("Enter");
    await expect(page).not.toHaveURL(/day=/);
    release();
    await expect(page.locator(".activity-cell[data-date]")).toHaveCount(8);
    const currentDay = page.locator('.activity-cell[data-date="2026-10-08"]');
    await expect(currentDay).toHaveAttribute("aria-disabled", "false");
    await currentDay.click();
    await expect(page).toHaveURL(/day=2026-10-08/);
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
    await expect(harnessMetrics.getByRole("rowheader", { name: /Processed tokens/ })).toBeVisible();
    await expect(harnessMetrics.getByRole("rowheader", { name: /Observed cache-read share/ })).toBeVisible();
    await expect(harnessMetrics.getByRole("rowheader", { name: /Provider-adjusted lift/ })).toBeVisible();
    const metricHelp = harnessMetrics.getByRole("button", { name: "Explain metric" }).first();
    await metricHelp.hover();
    await expect(metricHelp.locator("xpath=following-sibling::*[@role='tooltip']")).toBeVisible();
    const leadingCell = harnessMetrics.locator("td.is-best").first();
    await expect(leadingCell).toBeVisible();
    await leadingCell.hover();
    await expect(leadingCell).toHaveClass(/is-active-column/);
    await expect(page.getByText("Comparison metrics", { exact: true })).toBeVisible();
    await expect(page.getByText("Cache attribution", { exact: true })).toBeVisible();
    await expect(page.locator(".cache-provider-table")).toBeVisible();
  });

  test("settings route shows config file location and actions", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h1")).toHaveText("Settings");
    await expect(page.getByText("Configuration", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now", exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: /rebuild index/i })).toBeVisible();
  });
});
