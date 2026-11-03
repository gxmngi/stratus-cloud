import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const alice = { email: "alice@example.test", password: "Stratus local Alice demo 2026" };
async function openLogin(page: Page) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
}
async function login(page: Page) {
  await openLogin(page);
  await page.getByLabel("Email address").fill(alice.email);
  await page.getByLabel("Password", { exact: true }).fill(alice.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Deploy your web application" })).toBeVisible();
}

test("private workspace redirects to sign in without showing private content", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByText("Deployment History", { exact: true })).toHaveCount(0);
});

test("real cookie login, reload restoration and logout", async ({ page, context }) => {
  await login(page);
  const cookies = await context.cookies("http://localhost:4402/api");
  const session = cookies.find(cookie => cookie.name === "stratus_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain("stratus_session");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(session!.value);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(alice.email, { exact: true })).toHaveCount(0);
});

test("incorrect credentials show a focused accessible error", async ({ page }) => {
  await openLogin(page);
  await page.getByLabel("Email address").fill(alice.email);
  await page.getByLabel("Password", { exact: true }).fill("incorrect passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const error = page.getByRole("main").getByRole("alert");
  await expect(error).toContainText("email or password isn’t correct");
  await expect(error).toBeFocused();
});

test("keyboard validation, password reveal and password-manager hints", async ({ page }) => {
  await openLogin(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Email address")).toBeFocused();
  await expect(page.getByLabel("Email address")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Email address").fill(alice.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type("a private password");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Show password" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
});

test("registration validates a passphrase, handles duplicates and creates an account", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Start building." })).toBeVisible();
  await page.getByLabel("Email address").fill(alice.email);
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Use at least 15 characters for your password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(alice.password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("may already exist");
  await page.getByLabel("Email address").fill(`new-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your workspace is one sign-in away." })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
});

test("rate limiting shows a waiting period and permits retry", async ({ page }) => {
  await openLogin(page);
  await page.route("**/api/auth/login", route => route.request().method() === "OPTIONS" ? route.continue() : route.fulfill({ status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "2", "Access-Control-Allow-Origin": "http://localhost:3100", "Access-Control-Allow-Credentials": "true", "Access-Control-Expose-Headers": "Retry-After" },
    body: JSON.stringify({ error: "Too many attempts" }) }));
  await page.getByLabel("Email address").fill(alice.email);
  await page.getByLabel("Password", { exact: true }).fill(alice.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Too many attempts");
  await expect(page.getByRole("button", { name: /Try again in/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
});

test("network errors recover and repeated submits send one request", async ({ page }) => {
  await openLogin(page);
  await page.route("**/api/auth/login", route => route.abort());
  await page.getByLabel("Email address").fill(alice.email);
  await page.getByLabel("Password", { exact: true }).fill(alice.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("couldn’t reach Stratus");
  await page.unroute("**/api/auth/login");
  let calls = 0;
  await page.route("**/api/auth/login", async route => {
    if (route.request().method() === "OPTIONS") { await route.continue(); return; }
    calls++;
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await page.getByRole("form", { name: "Sign in", exact: true }).evaluate(form => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  expect(calls).toBe(1);
});

test("expired sessions unmount the workspace and its private data", async ({ page, context }) => {
  await login(page);
  await context.clearCookies();
  // Existing dashboard polling must treat a business-API 401 as session expiry.
  await expect(page).toHaveURL(/\/login$/, { timeout: 10000 });
  await expect(page.getByText("Deployment History", { exact: true })).toHaveCount(0);
});

test("logout propagates to another tab", async ({ page, context }) => {
  await login(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await expect(otherTab.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(otherTab).toHaveURL(/\/login$/);
});

test("switching accounts removes the previous account’s deployment state", async ({ page }) => {
  await login(page);
  await expect(page.getByText("demo-0-ready", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await page.getByLabel("Email address").fill("bob@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Stratus local Bob demo 2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("bob@example.test", { exact: true })).toBeVisible();
  await expect(page.getByText("demo-1-ready", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("demo-0-ready", { exact: true })).toHaveCount(0);
  await expect(page.getByText(alice.email, { exact: true })).toHaveCount(0);
});

test("session service errors offer a retry without a redirect loop", async ({ page }) => {
  await page.route("**/api/auth/me", route => route.abort());
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "We couldn’t connect." })).toBeVisible();
  await page.unroute("**/api/auth/me");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
});

test("login and registration pass automated accessibility checks", async ({ page }) => {
  for (const path of ["/login", "/register"]) {
    await page.goto(path);
    await expect(page.getByRole("textbox", { name: "Email address" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  }
  await page.goto("/login");
  await page.screenshot({ path: "test-results/login-desktop.png", fullPage: true });
});

test("mobile layout has no horizontal overflow and works with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLogin(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: "test-results/login-mobile.png", fullPage: true });
});
