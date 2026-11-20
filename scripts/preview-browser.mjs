#!/usr/bin/env node
/**
 * Opens a preview's web app in Chromium, the way a person would: the sign-in
 * page at `/login` on the router must render its email box, and nothing on the
 * page may throw. A failed request to the preview's own hosts fails it too, so
 * a web export pointed at the wrong Convex or gateway is caught here.
 *
 * Nothing printed is an origin: the workers.dev subdomain names the account and
 * this repository is public. Only paths and counts are printed.
 *
 * Environment: PREVIEW_ROUTER_ORIGIN (an https origin).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { originFrom } from './preview-smoke.mjs';

export const LOGIN_PATH = '/login';
export const EMAIL_BOX = '[data-testid="login-email"]';
export const RENDER_TIMEOUT_MS = 60_000;

/** The page problems that fail the check: uncaught errors, and failed requests to the preview's own hosts. */
export function problemsFrom({ pageErrors, failedRequests }, ownHosts) {
  const problems = pageErrors.map((message) => `page error: ${String(message).split('\n')[0].slice(0, 200)}`);
  for (const { url, reason } of failedRequests) {
    let host;
    try { host = new URL(url).host; } catch { continue; }
    if (ownHosts.some((own) => host === own)) problems.push(`request failed: ${new URL(url).pathname} (${reason})`);
  }
  return problems;
}

/** The preview's own hosts: the router's, and the gateway's and Convex's when given. */
export function ownHostsFrom(env) {
  return [env.PREVIEW_ROUTER_ORIGIN, env.PREVIEW_MCP_ORIGIN, env.PREVIEW_CONVEX_URL]
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => { try { return new URL(value).host; } catch { return null; } })
    .filter((host) => host !== null);
}

export async function openWebApp(env = process.env, { log = console.log } = {}) {
  const origin = originFrom(env.PREVIEW_ROUTER_ORIGIN, 'PREVIEW_ROUTER_ORIGIN');
  // Playwright is the app's dev dependency; resolve it from there.
  const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
  const { chromium } = require('@playwright/test');
  // The runner's Ubuntu can be newer than Playwright supports; its own Chrome is the fallback.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const pageErrors = [];
  const failedRequests = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error?.message ?? String(error)));
    page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText ?? 'failed' }));
    const start = Date.now();
    const response = await page.goto(`${origin}${LOGIN_PATH}`, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    if (response === null || response.status() !== 200) throw new Error(`${LOGIN_PATH}: HTTP ${response?.status() ?? 'none'}.`);
    try {
      await page.waitForSelector(EMAIL_BOX, { state: 'visible', timeout: RENDER_TIMEOUT_MS });
    } catch {
      throw new Error(`${LOGIN_PATH}: the email box did not render within ${RENDER_TIMEOUT_MS / 1000} seconds.`);
    }
    // Let the page's first requests settle, so a failing call is seen.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    log(`web app: ${LOGIN_PATH} rendered its email box in ${Date.now() - start} ms`);
  } finally {
    await browser.close();
  }
  const problems = problemsFrom({ pageErrors, failedRequests }, ownHostsFrom(env));
  if (problems.length > 0) throw new Error(`${problems.length} problem(s) on ${LOGIN_PATH}: ${problems.slice(0, 5).join('; ')}`);
  log('PASS: the web app opened in a browser with no page errors.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await openWebApp(process.env);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
