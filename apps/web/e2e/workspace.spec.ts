import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("alice@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Stratus local Alice demo 2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Deployments", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Deployment history").getByRole("button").first(),
  ).toBeVisible();
});

test("workspace search, environment fields and filters work", async ({
  page,
}) => {
  const history = page.getByLabel("Deployment history");
  await page.getByLabel("Search deployments").fill("no-such-deployment");
  await expect(history.getByText("No matching deployments")).toBeVisible();
  await page.getByLabel("Search deployments").clear();
  await page.getByRole("button", { name: "Failed", exact: true }).click();
  const rows = history.getByRole("button");
  for (const row of await rows.all()) await expect(row).toContainText("Failed");
  await page
    .getByRole("button", { name: "All deployments", exact: true })
    .click();
  await expect(rows.first()).toBeVisible();
  await page
    .getByRole("button", { name: "Node.js server", exact: true })
    .click();
  await expect(
    page.getByLabel("Git repository or local project path"),
  ).toHaveValue("fixtures/demo-server");
  await page
    .getByRole("button", { name: "Environment variables", exact: true })
    .click();
  await page.getByLabel("Variable name 1", { exact: true }).fill("API_KEY");
  await page
    .getByLabel("Variable value 1", { exact: true })
    .fill("private-test-value");
  await expect(
    page.getByLabel("Variable value 1", { exact: true }),
  ).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Add variable" }).click();
  await expect(
    page.getByLabel("Variable name 2", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Remove variable 2").click();
  await expect(page.getByLabel("Variable name 2", { exact: true })).toHaveCount(
    0,
  );
});

test("workspace desktop and mobile are accessible without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(page.getByRole("region", { name: "Build logs" })).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  }
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});

test("destructive dialog traps focus, supports Escape and returns focus", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Failed", exact: true }).click();
  await page
    .getByLabel("Deployment history")
    .getByRole("button")
    .first()
    .click();
  const trigger = page.getByRole("button", {
    name: "Delete deployment",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Delete deployment", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("delete confirmation keeps its target when the deployment list refreshes", async ({
  page,
}) => {
  const pending = {
    id: "dep-confirm-pending",
    git_url: "fixtures/pending-preview",
    status: "READY",
    live_url: "about:blank",
    created_at: Date.now(),
  };
  const replacement = {
    ...pending,
    id: "dep-confirm-replacement",
    git_url: "fixtures/replacement-preview",
    status: "READY",
  };
  const deleting = { ...replacement, id: "dep-confirm-deleting", git_url: "fixtures/deleting-preview", status: "DELETING" };
  let deployments = [pending, replacement, deleting];
  const deleteTargets: string[] = [];

  await page.route("**/api/deployments?limit=20", (route) =>
    route.fulfill({ json: { deployments } }),
  );
  await page.route(/\/api\/deployments\/dep-confirm-(pending|replacement)$/, (route) => {
    const request = route.request();
    if (request.method() !== "DELETE") return route.fallback();
    deleteTargets.push(new URL(request.url()).pathname.split("/").pop()!);
    return route.fulfill({ status: 404, json: { error: "Deployment not found" } });
  });
  await page.reload();

  const history = page.getByLabel("Deployment history");
  await expect(history.getByRole("button", { name: /pending-preview/ })).toBeVisible();
  await page.getByRole("button", { name: "Delete deployment", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  deployments = [replacement];
  await expect(history.getByRole("button", { name: /pending-preview/ })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Delete deployment", exact: true }).click();
  await expect.poll(() => deleteTargets).toEqual([pending.id]);
});

test("accepted deletion stays visible until cleanup finishes", async ({ page }) => {
  const preview = {
    id: "dep-delete-queued", git_url: "fixtures/queued-deletion-preview", status: "READY",
    live_url: "about:blank", created_at: Date.now(),
  };
  let deployments = [preview];
  await page.route("**/api/deployments?limit=20", route => route.fulfill({ json: { deployments } }));
  await page.route("**/api/deployments/dep-delete-queued", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deployments = [{ ...preview, status: "DELETING" }];
    return route.fulfill({ status: 202, json: { deploymentId: preview.id, status: "DELETING" } });
  });
  await page.reload();
  const history = page.getByLabel("Deployment history");
  const entry = history.getByRole("button", { name: /queued-deletion-preview/ });
  await expect(entry).toBeVisible();
  await page.getByRole("button", { name: "Delete deployment", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete deployment", exact: true }).click();
  await expect(entry).toContainText("Deleting");
  deployments = [];
  await expect(entry).toHaveCount(0);
});

test("runtime metrics distinguish unavailable data from a missing container", async ({ page }) => {
  const deployment = {
    id: "dep-metrics-state", git_url: "fixtures/metrics-preview", status: "READY",
    runtime_type: "dynamic", live_url: "about:blank", created_at: Date.now(),
  };
  let status = "unavailable";
  await page.route("**/api/deployments?limit=20", route => route.fulfill({ json: { deployments: [deployment] } }));
  await page.route("**/api/deployments/dep-metrics-state/stats", route => route.fulfill({ json: {
    metrics: { deploymentId: deployment.id, runtimeType: "dynamic", status, cpuPercent: 2,
      memoryUsageBytes: 1048576, pidsCurrent: 3, pidsLimit: 512, uptimeSeconds: 60 },
  } }));
  await page.reload();
  await expect(page.getByText("Runtime metrics unavailable. Retrying…", { exact: true })).toBeVisible();
  status = "notFound";
  await expect(page.getByText("Runtime container not found.", { exact: true })).toBeVisible({ timeout: 10000 });
  status = "running";
  await expect(page.getByText("2%", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Runtime container not found.", { exact: true })).toHaveCount(0);
});
