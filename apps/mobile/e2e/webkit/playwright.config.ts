import { defineConfig } from "@playwright/test";
import { join } from "node:path";

/*
  `__dirname`, not `import.meta.url` — this repo does not set `"type":
  "module"`, so Playwright's own loader compiles a `.ts` config as CommonJS,
  where `import.meta` does not exist.
*/
const HERE = __dirname;

/**
 * The one Playwright suite in this repo that runs against a real browser
 * engine rather than jsdom, and the reason it exists: every iOS-only editor
 * bug this week (the long-press `touchcancel`, the caret/touch trap) was
 * reproduced by *simulating* WebKit's event sequence in Chromium — enough to
 * fix, not enough to prove. See `docs/decisions/testing.md`.
 *
 * ## What this runs against
 *
 * The **built web export** (`expo export --platform web`), served statically
 * by `static-server.mjs` — not `expo start`'s dev server, which bundles
 * differently and is not what ships. The CI job that drives this
 * (`.github/workflows/ci.yml`, "Editor in WebKit") exports with
 * `EXPO_PUBLIC_E2E_FIXTURE=1` and points `E2E_WEB_EXPORT_DIR` at the result;
 * `E2E_WEB_EXPORT_DIR` defaults to `web-build` so a local `pnpm build:e2e-web`
 * (see `package.json`) followed by `pnpm test:e2e:webkit` works with no flags.
 *
 * ## Two projects, one suite
 *
 * `webkit` is what CI runs and what this exists for. `chromium` is for a
 * sandbox with no WebKit binary and a policy against installing one — this
 * repository's own agent environment among them: it validates the *tests*
 * (the fixture loads, the selectors resolve, the assertions are shaped
 * right) without claiming anything about WebKit's touch handling, which is
 * the whole point of the suite. A chromium pass is never reported as a
 * WebKit result; say which project a run used.
 *
 * Both projects share the same phone viewport rather than pulling one from
 * `devices["iPhone …"]`: that preset also sets its own `userAgent` and
 * `deviceScaleFactor`, and the task this suite exists for names exactly
 * three properties (390×844, touch, `isMobile`) — a preset that drifts to a
 * new default phone in a future Playwright release should not silently
 * change what "the phone viewport" means here.
 */
const PORT = Number(process.env.E2E_PORT ?? 4873);
const EXPORT_DIR = process.env.E2E_WEB_EXPORT_DIR ?? join(HERE, "..", "..", "web-build");

export default defineConfig({
  testDir: HERE,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A flaky run gets one retry so a genuine one-off (a slow CI runner) does
  // not read as a failure this suite exists to report; three retries would
  // start hiding the exact flake `docs/decisions/testing.md` asks CI to name.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]] : [["list"]],
  outputDir: join(HERE, "test-results"),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Fail loudly with an artifact, per the task: a screenshot on every
    // failure and a trace to replay it, uploaded by the CI job on failure.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    command: `node ${JSON.stringify(join(HERE, "static-server.mjs"))} ${JSON.stringify(EXPORT_DIR)} ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
