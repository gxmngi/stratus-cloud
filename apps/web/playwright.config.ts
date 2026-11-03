import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 30000,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
  webServer: [
    {
      command: "npx tsx scripts/e2e-auth.ts",
      cwd: path.resolve(__dirname, "../../services/api"),
      url: "http://127.0.0.1:4402/api/health",
      env: { DATA_DIR: mkdtempSync(path.join(tmpdir(), "stratus-e2e-")), PORT: "4402", DASHBOARD_ORIGIN: "http://localhost:3100", NODE_ENV: "development" },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "npm run dev -- --port 3100",
      url: "http://localhost:3100/login",
      env: { NEXT_PUBLIC_API_URL: "http://localhost:4402" },
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
});
