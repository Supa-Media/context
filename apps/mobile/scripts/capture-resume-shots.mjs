/**
 * Photographs every surface that offers a stopped meeting back (Resume, #849),
 * off the built e2e web export — the shipping components, not a mock.
 *
 * Not part of `pnpm test`. Run by hand, from `apps/mobile`:
 *
 *   pnpm run build:e2e-web
 *   node scripts/capture-resume-shots.mjs <out-dir>
 *
 * `<out-dir>` defaults to `resume-shots/` here, which git ignores. Point it
 * somewhere else to keep a "before" and an "after" set side by side. `E2E_WEB_EXPORT_DIR` overrides the export
 * directory, as it does for the WebKit suite; `SCHEMES=light` skips dark.
 *
 * What is drawn, and where the state comes from, is `ResumeFixture`'s header
 * (`features/e2e/ResumeFixture.tsx`). This script only opens
 * `/e2e-fixture?screen=resume&surface=…` at a desktop and a phone width, waits
 * for the surface's own testID — so a shot that would quietly photograph an
 * empty state fails instead — and writes a PNG.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const EXPORT_DIR = resolve(process.env.E2E_WEB_EXPORT_DIR ?? join(APP, "web-build"));
const OUT = resolve(process.argv[2] ?? join(APP, "resume-shots"));
const PORT = Number(process.env.E2E_PORT ?? 4879);
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
];

/**
 * One entry per board. `ready` is the testID the surface under review draws,
 * `steps` presses whatever the product needs pressed to reach it, and `clip`
 * is an optional close-up of that element beside the full-page shot.
 */
const BOARDS = [
  {
    name: "plus-menu-note",
    query: "surface=menu",
    // A pointer's `+` is pressed; a phone's sheet is drawn open.
    steps: { desktop: ["console-create"] },
    ready: { desktop: "menu-item-resume-meeting", phone: "create-row-resume-meeting" },
    closeUp: { desktop: "menu-sheet" },
  },
  {
    name: "plus-menu-recent",
    query: "surface=menu&note=0",
    steps: { desktop: ["console-create"] },
    ready: { desktop: "menu-item-resume-meeting", phone: "create-row-resume-meeting" },
    closeUp: { desktop: "menu-sheet" },
  },
  {
    name: "aside-panel",
    query: "surface=aside",
    // The panel only exists at a pointer width; a phone has no right panel.
    only: ["desktop"],
    steps: [`aside-tab-meetings`, `aside-meeting-row-mtg_7k2m9p4q8r3s6t1v5wxy`],
    ready: "aside-meeting-resume",
    closeUp: "aside-meetings",
  },
  {
    name: "meeting-page",
    query: "surface=page",
    ready: "meeting-resume",
  },
  {
    name: "live-continues",
    query: "surface=live",
    ready: "meeting-clock",
  },
];

/** A board value, or its value for this viewport when it differs by density. */
function forViewport(value, viewport) {
  if (value === undefined || typeof value === "string" || Array.isArray(value)) return value;
  return value[viewport.name];
}

if (!existsSync(join(EXPORT_DIR, "index.html"))) {
  console.error(`No export at ${EXPORT_DIR}. Run \`pnpm run build:e2e-web\` first.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn(
  process.execPath,
  [join(APP, "e2e/webkit/static-server.mjs"), EXPORT_DIR, String(PORT)],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((ready, fail) => {
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("static export served")) ready();
  });
  server.on("exit", (code) => fail(new Error(`static server exited with ${code}`)));
});

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH === undefined ? {} : { executablePath: process.env.CHROMIUM_PATH },
);
const written = [];
const failed = [];

try {
  for (const scheme of SCHEMES) {
    for (const viewport of VIEWPORTS) {
      for (const board of BOARDS) {
        if (board.only !== undefined && !board.only.includes(viewport.name)) continue;
        const base = `${board.name}-${viewport.name}-${scheme}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          colorScheme: scheme,
        });
        const page = await context.newPage();
        try {
          await page.goto(`http://127.0.0.1:${PORT}/e2e-fixture?screen=resume&${board.query}`);
          for (const id of forViewport(board.steps, viewport) ?? []) {
            await page.getByTestId(id).first().click({ timeout: 10_000 });
          }
          const target = page.getByTestId(forViewport(board.ready, viewport)).first();
          await target.waitFor({ state: "visible", timeout: 15_000 });
          // Fonts and the frame's first layout pass.
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(600);
          const full = join(OUT, `${base}.png`);
          await page.screenshot({ path: full });
          written.push(full);
          const closeUp = forViewport(board.closeUp, viewport);
          if (closeUp !== undefined) {
            const close = join(OUT, `${base}-closeup.png`);
            const box = await page.getByTestId(closeUp).first().boundingBox();
            if (box !== null) {
              const pad = 24;
              const x = Math.max(0, box.x - pad);
              const y = Math.max(0, box.y - pad);
              await page.screenshot({
                path: close,
                clip: {
                  x,
                  y,
                  width: Math.min(viewport.width - x, box.width + pad * 2),
                  height: Math.min(viewport.height - y, box.height + pad * 2),
                },
              });
              written.push(close);
            }
          }
          console.log(`wrote ${base}`);
        } catch (error) {
          const miss = join(OUT, `${base}-FAILED.png`);
          await page.screenshot({ path: miss }).catch(() => {});
          failed.push(`${base}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
          console.error(`FAILED ${base}`);
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

console.log(`\n${written.length} shots in ${OUT}`);
if (failed.length > 0) {
  console.error(`${failed.length} failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
