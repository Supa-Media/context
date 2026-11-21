#!/usr/bin/env node
/**
 * Signs one of a preview's fictional personas in to the preview's web app and
 * screenshots it at the layouts people really use, so a change to the app can
 * be looked at signed in before it merges (Dev2, 2026-11-21: "Can't you test
 * it on your branch and run the app on your branch and look at things?").
 * Run by `.github/workflows/preview-screenshots.yml`; the pictures are the
 * run's artifact.
 *
 * The persona's code is issued on the preview through the convex CLI and traded
 * for tokens, which go straight into the page's storage; neither is printed or
 * written: this
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
 * MATRIX=1 also walks the panel matrix (uiMatrix.mjs) and fails on its problems.
 *
 * Environment: PREVIEW_ROUTER_ORIGIN, PR, PERSONA, SHOTS (default "/"), MATRIX,
 * CONVEX_DEPLOY_KEY (the preview deploy key), OUT_DIR (default "screenshots").
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { originFrom } from "./smoke.mjs";
import { PERSONAS } from "./sign-in-code.mjs";
import { findConvexPreview } from "./teardown.mjs";
import { runMatrix } from "./uiMatrix.mjs";

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

/**
 * Signs the persona in the way the seed does: a code issued on the preview, traded for tokens through `auth:signIn`.
 * Going through the login page instead asks the preview to send a code first, which a preview cannot mail, replaces
 * the issued one, and trips the "several codes already" limit after a couple of runs.
 */
async function signInForReal(email, { deployment, deployKey }) {
  const [{ issuePersonaCode }, { ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
    import("./seed.mjs"),
    import("convex/browser"),
    import("convex/server"),
  ]);
  const url = convexUrlOf(deployment);
  const code = issuePersonaCode(email, { deployment, deployKey });
  const client = new ConvexHttpClient(url, { logger: false });
  const result = await client.action(makeFunctionReference("auth:signIn"), { provider: "email", params: { email, code } });
  if (!result?.tokens?.token || !result.tokens.refreshToken) throw new Error("Signing the persona in returned no tokens.");
  return { url, token: result.tokens.token, refreshToken: result.tokens.refreshToken };
}

export const convexUrlOf = (deployment) => {
  if (!/^[a-z0-9-]+$/.test(deployment)) throw new Error("Not a preview deployment name.");
  return `https://${deployment}.convex.cloud`;
};

/**
 * The browser storage @convex-dev/auth reads on the web (localStorage, namespaced by the Convex URL with everything
 * but letters and digits dropped), so the app starts signed in. The tokens live only in this process and the page.
 */
export function authStorage({ url, token, refreshToken }) {
  const namespace = url.replace(/[^a-zA-Z0-9]/g, "");
  return { [`__convexAuthJWT_${namespace}`]: token, [`__convexAuthRefreshToken_${namespace}`]: refreshToken };
}

async function runSteps(page, steps) {
  for (const step of steps) {
    if (step.kind === "click") await page.locator(`[data-testid="${step.value}"]`).first().click({ timeout: 15_000 });
    else if (step.kind === "key") await page.keyboard.press(step.value);
    else if (step.kind === "type") await page.keyboard.type(step.value);
    else await page.waitForTimeout(step.ms);
  }
}

export async function main(env = process.env, { log = console.log, signIn = signInForReal, find = findConvexPreview } = {}) {
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
  const matrixProblems = [];
  try {
    // One sign-in, put into every layout's storage before the app's first script runs.
    const storage = authStorage(await signIn(email, { deployment, deployKey: env.CONVEX_DEPLOY_KEY }));
    log(`signed in as ${persona}`);

    const signedIn = async ({ name: _name, width, height, ...rest }, scale = 2) => {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ...rest });
      await context.addInitScript((items) => {
        // Only into an empty slot: this runs on every navigation, and the app rotates the refresh token as it goes.
        for (const [key, value] of Object.entries(items)) if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      }, storage);
      return context;
    };

    for (const layout of LAYOUTS) {
      const { name } = layout;
      const context = await signedIn(layout);
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
    // The panel matrix (uiMatrix.mjs): its problems fail the run, since each is a state a person can reach.
    if (env.MATRIX === "1") matrixProblems.push(...(await runMatrix({ origin, layouts: LAYOUTS, newContext: (layout) => signedIn(layout, 1), out, log })));
  } finally {
    await browser.close();
  }
  // Problems are reported, not fatal: the pictures are the point, and a broken page is what they are for.
  for (const problem of problems) log(`problem: ${problem}`);
  log(`${shots.length * LAYOUTS.length} picture(s) in ${out}, ${problems.length} problem(s).`);
  for (const problem of matrixProblems) log(`matrix problem: ${problem}`);
  return { problems, matrixProblems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { matrixProblems } = await main(process.env);
    if (matrixProblems.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
