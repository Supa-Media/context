#!/usr/bin/env node
/**
 * Signs one of a preview's fictional personas in to the preview's web app and
 * screenshots it at the layouts people really use, so a change to the app can
 * be looked at signed in before it merges (Dev2, 2026-11-21: "Can't you test
 * it on your branch and run the app on your branch and look at things?").
 * Run by `.github/workflows/preview-screenshots.yml`; the pictures are the
 * run's artifact.
 *
 * The sign-in code is issued on the preview through the convex CLI once the
 * page asks for it, typed into the page, and never printed or written: this
 * repository's Actions logs are public. Nothing printed is an origin either,
 * because the workers.dev subdomain names the account. The pictures hold only
 * the preview's seeded fictional data.
 *
 *   PREVIEW_ROUTER_ORIGIN=https://… PR=<N> PERSONA=alpha SHOTS="/;/?tex=1" \
 *     node packages/sandbox/src/screenshots.mjs
 *
 * SHOTS is a `;`-separated list of shots. Each is a path, optionally followed
 * by `|`-separated steps run in order before the picture:
 *   click:<testID>   press the element with that testID
 *   key:<keys>       press keys, as Playwright names them (key:Control+L)
 *   wait:<ms>        wait, at most 10 seconds
 *   type:<text>      type into whatever has focus
 * e.g. `/|click:frame-aside-toggle|wait:800`. Every shot is taken at every layout.
 *
 * Environment: PREVIEW_ROUTER_ORIGIN, PR, PERSONA, SHOTS (default "/"),
 * CONVEX_DEPLOY_KEY (the preview deploy key), OUT_DIR (default "screenshots").
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { originFrom } from "./smoke.mjs";
import { PERSONAS } from "./sign-in-code.mjs";
import { findConvexPreview } from "./teardown.mjs";

/** Dev2's layouts: the desktop app with the tree and the Tex panel, a narrowed window, and a phone. */
export const LAYOUTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "medium", width: 1100, height: 820 },
  { name: "phone", width: 390, height: 844, isMobile: true, hasTouch: true },
];

const MAX_SHOTS = 20;
const MAX_WAIT_MS = 10_000;
const STEP = /^(click|key|wait|type):(.+)$/;

/** Parses SHOTS into `{ path, steps, name }`, refusing anything that is not a same-origin path. */
export function parseShots(spec) {
  const items = String(spec ?? "/").split(";").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) items.push("/");
  if (items.length > MAX_SHOTS) throw new Error(`At most ${MAX_SHOTS} shots.`);
  return items.map((item, index) => {
    const [path, ...rest] = item.split("|").map((part) => part.trim());
    // A path, never a URL: the preview's own origin is the only one a persona is signed in to.
    if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]/.test(path)) throw new Error(`Shot ${index + 1}: "${path}" is not a path.`);
    const steps = rest.map((step) => {
      const match = STEP.exec(step);
      if (match === null) throw new Error(`Shot ${index + 1}: "${step}" is not a step (click:, key:, wait:, type:).`);
      const [, kind, value] = match;
      if (kind === "wait") {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) throw new Error(`Shot ${index + 1}: wait is 0 to ${MAX_WAIT_MS} ms.`);
        return { kind, ms };
      }
      if (kind === "click" && !/^[\w.:-]+$/.test(value)) throw new Error(`Shot ${index + 1}: "${value}" is not a testID.`);
      return { kind, value };
    });
    return { path, steps, name: `${String(index + 1).padStart(2, "0")}-${slug(path, steps)}` };
  });
}

function slug(path, steps) {
  const words = [path, ...steps.map((step) => step.value ?? "")].join("-").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (words || "home").slice(0, 60);
}

/** The code issuer, loaded only when a code is really issued (it imports the convex client). */
async function issueForReal(email, options) {
  const { issuePersonaCode } = await import("./seed.mjs");
  return issuePersonaCode(email, options);
}

/** Types the persona's address, waits for the code box, then issues a code and types it, so nothing replaces it. */
export async function signIn(page, origin, { email, issueCode }) {
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('[data-testid="login-email"]').fill(email, { timeout: 60_000 });
  await page.locator('[data-testid="login-submit"]').first().click();
  await page.locator('[data-testid="login-code"]').waitFor({ state: "visible", timeout: 60_000 });
  const code = await issueCode();
  await page.locator('[data-testid="login-code"]').fill(code);
  await page.locator('[data-testid="login-submit"]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

async function runSteps(page, steps) {
  for (const step of steps) {
    if (step.kind === "click") await page.locator(`[data-testid="${step.value}"]`).first().click({ timeout: 15_000 });
    else if (step.kind === "key") await page.keyboard.press(step.value);
    else if (step.kind === "type") await page.keyboard.type(step.value);
    else await page.waitForTimeout(step.ms);
  }
}

export async function main(env = process.env, { log = console.log, issue = issueForReal, find = findConvexPreview } = {}) {
  const origin = originFrom(env.PREVIEW_ROUTER_ORIGIN, "PREVIEW_ROUTER_ORIGIN");
  const pr = String(env.PR ?? "");
  if (!/^[1-9][0-9]{0,6}$/.test(pr)) throw new Error("PR must be a pull request number.");
  const persona = String(env.PERSONA ?? "alpha");
  if (!PERSONAS.includes(persona)) throw new Error(`PERSONA must be one of ${PERSONAS.join(", ")}.`);
  const shots = parseShots(env.SHOTS);
  const out = env.OUT_DIR || "screenshots";
  mkdirSync(out, { recursive: true });

  const deployment = await find(env.CONVEX_DEPLOY_KEY, `pr${pr}`);
  if (deployment === null) throw new Error(`Pull request #${pr} has no preview deployment.`);
  const email = `${persona}@supa.media`;

  const require = createRequire(new URL("../../../apps/mobile/package.json", import.meta.url));
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  const problems = [];
  try {
    // One sign-in, carried to every layout as the signed-in browser state.
    const first = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await first.newPage();
    await signIn(page, origin, { email, issueCode: () => issue(email, { deployment, deployKey: env.CONVEX_DEPLOY_KEY }) });
    const state = await first.storageState();
    await first.close();
    log(`signed in as ${persona}`);

    for (const layout of LAYOUTS) {
      const { name, width, height, ...rest } = layout;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, storageState: state, ...rest });
      for (const shot of shots) {
        const tab = await context.newPage();
        tab.on("pageerror", (error) => problems.push(`${name} ${shot.path}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`));
        try {
          await tab.goto(`${origin}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await tab.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
          await tab.waitForTimeout(1500);
          await runSteps(tab, shot.steps);
          await tab.waitForTimeout(600);
          await tab.screenshot({ path: join(out, `${shot.name}-${name}.png`) });
          log(`shot ${shot.name} at ${name}`);
        } catch (error) {
          problems.push(`${name} ${shot.path}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
          await tab.screenshot({ path: join(out, `${shot.name}-${name}-FAILED.png`) }).catch(() => {});
        } finally {
          await tab.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  // Problems are reported, not fatal: the pictures are the point, and a broken page is what they are for.
  for (const problem of problems) log(`problem: ${problem}`);
  log(`${shots.length * LAYOUTS.length} picture(s) in ${out}, ${problems.length} problem(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.env);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
