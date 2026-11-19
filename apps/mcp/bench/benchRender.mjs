/**
 * THE BENCH PHOTOGRAPHS THE CARDS TEX DRAWS, WHEN IT HAS A BROWSER TO DO IT WITH.
 *
 * Production draws a card by handing its HTML to the browser Worker (`infra/site-shots` `POST /render`), and the
 * picture comes back to Tex as the tool's result: the front door sees the card it drew before it sends it. The bench
 * had no browser, so `/render` answered a white rectangle (`sites.mjs` blankPng). The card check was taught to pass
 * the bench's own pictures (`drawnPictures.mjs`), but the front door still looked at a white rectangle, said "the
 * picture came out blank both times" and sent the whole comparison as text instead (Training, 2026-11-19, build-crew
 * m8, 0/3 on main). Nothing in production was blank: the bench was grading its own stand-in.
 *
 * So the bench photographs the HTML the way the Worker does: a headless Chrome or Chromium on the machine running the
 * bench (every GitHub `ubuntu-latest` runner has Google Chrome; `BENCH_CHROME` names another), with no network: a
 * picture the card names by address is left empty, as one the Worker may not load is. Where no browser is found, or it fails, the white rectangle stands in as before and the run says nothing new.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a browser usually is: Linux packages, macOS, and Playwright's own download folders. */
function candidates(env = process.env) {
  const found = [];
  if (typeof env.BENCH_CHROME === "string" && env.BENCH_CHROME.trim() !== "") found.push(env.BENCH_CHROME.trim());
  found.push(
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  for (const root of [env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(env.HOME ?? "", ".cache/ms-playwright")]) {
    if (typeof root !== "string" || root === "" || !existsSync(root)) continue;
    let dirs = [];
    try {
      dirs = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name));
    } catch {
      continue;
    }
    for (const dir of dirs) found.push(join(root, dir, "chrome-linux64", "chrome"), join(root, dir, "chrome-linux", "chrome"));
  }
  return found;
}

/** The first browser on this machine, or null. */
export function findBrowser(env = process.env) {
  return candidates(env).find((path) => existsSync(path)) ?? null;
}

const run = (file, args, timeout) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error) => resolve(error ?? null));
  });

/** A whole number in range, or the default. */
const size = (value, fallback, min, max) => (Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback);

/**
 * A renderer for `/render` requests: `render({ html, width, height })` answers `{ png, width, height }` with the page
 * photographed, or null when it could not be (no browser, a crash, a timeout). One browser at a time per bench process,
 * so a run of many conversations does not start dozens of browsers at once.
 */
export function benchRenderer({ browser = findBrowser(), timeoutMs = 30_000 } = {}) {
  let queue = Promise.resolve();
  const once = async (request) => {
    if (!browser || typeof request?.html !== "string" || request.html === "") return null;
    const width = size(request.width, 600, 200, 2000);
    const height = size(request.height, 800, 200, 2400);
    const dir = await mkdtemp(join(tmpdir(), "bench-render-"));
    try {
      const page = join(dir, "card.html");
      const out = join(dir, "card.png");
      await writeFile(page, request.html);
      const error = await run(
        browser,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--hide-scrollbars",
          "--no-first-run",
          "--no-default-browser-check",
          "--force-device-scale-factor=1",
          // No network: only what the HTML carries inline is drawn, as the Worker loads only what it may.
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--virtual-time-budget=3000",
          `--user-data-dir=${join(dir, "profile")}`,
          `--window-size=${width},${height}`,
          `--screenshot=${out}`,
          `file://${page}`,
        ],
        timeoutMs,
      );
      if (error && !existsSync(out)) return null;
      const png = (await readFile(out).catch(() => null))?.toString("base64");
      return typeof png === "string" && png.length > 0 ? { png, width, height } : null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  return {
    available: browser !== null,
    render(request) {
      const next = queue.then(() => once(request).catch(() => null));
      queue = next.catch(() => null);
      return next;
    },
  };
}

let shared = null;
/** One renderer per bench process. */
export function sharedRenderer() {
  shared ??= benchRenderer();
  return shared;
}
