/**
 * Photographs the live map (`?map=1`) off the built e2e web export — the
 * shipping page, on the invented data `features/e2e/liveMapFixtureData.ts`
 * holds — in each state a reviewer compares against the design's stills.
 *
 * Not part of `pnpm test`. Run by hand, from `apps/mobile`:
 *
 *   pnpm run build:e2e-web
 *   node scripts/capture-live-map-shots.mjs <out-dir>
 *
 * `<out-dir>` defaults to `live-map-shots/` here. `CHROMIUM_PATH` points at a
 * Chromium already on the machine; nothing is downloaded. `SCHEMES=light`
 * skips dark. Each state is reached by pressing the page's own controls —
 * Today, a robot in Working now, All my workspaces — so a shot that cannot
 * reach its state fails instead of photographing the one before it. The
 * browser's clock is pinned to a weekday afternoon (`TODAY_AT`), so Today has
 * a day behind it whenever this is run.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const EXPORT_DIR = resolve(process.env.E2E_WEB_EXPORT_DIR ?? join(APP, "web-build"));
const OUT = resolve(process.argv[2] ?? join(APP, "live-map-shots"));
const PORT = Number(process.env.E2E_PORT ?? 4881);
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");
/** The fixture's "now": its notes, feed and replay are all relative to it. */
const TODAY_AT = process.env.TODAY_AT ?? "2026-10-07T17:40:00";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
];

/** Each step: press a testID, press a control by its label, or wait. */
const BOARDS = [
  { name: "1-live", steps: [] },
  { name: "2-following-an-ai", steps: [{ label: "Follow Seyi's Claude" }, { wait: 2500 }], ready: "map-follow-panel" },
  { name: "3-folders", only: ["desktop"], steps: [{ id: "map-view-folders" }, { wait: 1500 }] },
  { name: "4-all-workspaces", only: ["desktop"], steps: [{ id: "map-scope-all" }, { wait: 1500 }], ready: "map-cross-moves" },
  {
    name: "5-replaying-today",
    steps: [{ id: "map-when-today" }, { wait: 2500 }, { id: "map-replay-play" }, { at: "map-replay-track", x: 0.45 }, { wait: 1500 }],
    ready: "map-replay-clock",
  },
  {
    name: "6-replaying-this-week",
    only: ["desktop"],
    steps: [{ id: "map-when-week" }, { wait: 2500 }, { id: "map-replay-play" }, { at: "map-replay-track", x: 0.7 }, { wait: 1500 }],
    ready: "map-replay-clock",
  },
  { name: "7-sheet-open", only: ["phone"], steps: [{ id: "map-sheet-toggle" }, { wait: 600 }] },
];

if (!existsSync(join(EXPORT_DIR, "index.html"))) {
  console.error(`No export at ${EXPORT_DIR}. Run \`pnpm run build:e2e-web\` first.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [join(APP, "e2e/webkit/static-server.mjs"), EXPORT_DIR, String(PORT)], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ready, fail) => {
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("static export served")) ready();
  });
  server.on("exit", (code) => fail(new Error(`static server exited with ${code}`)));
});

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH === undefined ? {} : { executablePath: process.env.CHROMIUM_PATH },
);
const failed = [];
try {
  for (const scheme of SCHEMES) {
    for (const viewport of VIEWPORTS) {
      for (const board of BOARDS) {
        if (board.only !== undefined && !board.only.includes(viewport.name)) continue;
        const base = `${board.name}-${viewport.name}-${scheme}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.mobile ? 2 : 1,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          colorScheme: scheme,
        });
        // A weekday afternoon, so Today has a day behind it to replay.
        await context.clock.install({ time: new Date(TODAY_AT) });
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${PORT}/e2e-fixture?screen=live-map`);
          await page.getByTestId("map-page").first().waitFor({ state: "visible", timeout: 20_000 });
          await page.evaluate(() => document.fonts.ready);
          // The camera's first flight, and the actors walking to their notes.
          await page.waitForTimeout(2500);
          for (const step of board.steps) {
            if (step.id) await page.getByTestId(step.id).first().click({ timeout: 10_000 });
            if (step.label) await page.getByLabel(step.label, { exact: true }).first().click({ timeout: 10_000 });
            if (step.at) {
              const box = await page.getByTestId(step.at).first().boundingBox();
              if (box === null) throw new Error(`${step.at} is not on screen`);
              await page.mouse.click(box.x + box.width * step.x, box.y + box.height * 0.7);
            }
            if (step.wait) await page.waitForTimeout(step.wait);
          }
          if (board.ready) await page.getByTestId(board.ready).first().waitFor({ state: "visible", timeout: 10_000 });
          await page.screenshot({ path: join(OUT, `${base}.png`) });
          console.log(`wrote ${base}.png`);
        } catch (error) {
          failed.push(`${base}: ${error.message.split("\n")[0]}`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}
if (failed.length > 0) {
  console.error(`\n${failed.length} board(s) failed:\n${failed.join("\n")}`);
  process.exit(1);
}
