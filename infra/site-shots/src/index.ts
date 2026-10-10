/**
 * context-site-shots — a published website page in, pictures and measurements
 * out, nothing kept.
 *
 * `write_note` `site: { action: "screenshot" }` lets an owner's or editor's
 * agent see the site it built at phone, tablet and desktop widths, instead of
 * asking a person to look. The control plane decides who may, which page, and
 * how often (`apps/convex/functions/lib/websites/siteShots.ts`); the gateway
 * then asks this Worker, through a service binding, to photograph that one
 * public address.
 *
 * - **Only the gateway can reach it.** No `workers_dev`, no route, no custom
 *   domain: a service binding is the one way in, so there is no secret to
 *   hold and no address to find.
 * - **It photographs what any visitor sees.** The browser carries no cookie,
 *   token or session: a members-only page would show a sign-in screen, which
 *   is why the control plane only ever names public pages.
 * - **It keeps nothing.** No KV, R2, D1 or cache. The pictures go back in the
 *   response and nowhere else.
 *
 *   POST /shoot   `{ url, sizes? }` → `{ shots, failures }` (see ./shoot.ts)
 *   POST /read    `{ url }` → `{ page }`: title, visible text and links, for
 *                 the texting assistant. A plain request when the site sends
 *                 Markdown or readable HTML (./fetchText.ts), else a warm
 *                 browser (./read.ts)
 *   POST /browse  `{ session?, steps }` → `{ session, ran, page }`: one
 *                 browser the texting assistant drives across calls in one
 *                 question (./browse.ts). Its session id is held by the
 *                 gateway's turn and nowhere else; the browser closes itself
 *                 when idle, and nothing in it is kept.
 *   POST /browse/close `{ session }` → closes that browser now.
 *   Either with `provider: "browserbase"` drives the person's Browserbase
 *   browser instead (./browserbaseRoute.ts); that path holds the Worker's
 *   one secret, the Browserbase key, which never leaves this Worker.
 *   anything else 404
 */

import puppeteer from "@cloudflare/puppeteer";
import { fetchPage } from "./fetchText";
import { parseReadRequest, read } from "./read";
import type { BrowserbaseEnv } from "./browserbase";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { BROWSE_GOTO_TIMEOUT_MS, parseBrowseRequest, runSteps, type BrowsePage } from "./browse";
import type { Browser, BrowserContext } from "@cloudflare/puppeteer";
import { parseShootRequest, shoot, type BrowserLike, type PageLike } from "./shoot";

interface Env extends BrowserbaseEnv {
  BROWSER: Parameters<typeof puppeteer.launch>[0];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && (url.pathname === "/browse" || url.pathname === "/browse/close")) {
      const body = await request.json().catch(() => null);
      if ((body as { provider?: unknown })?.provider === "browserbase") return await browseOnBrowserbase(env, url.pathname, body);
      return await browse(env, url.pathname, body);
    }
    if (request.method !== "POST" || (url.pathname !== "/shoot" && url.pathname !== "/read")) {
      return new Response(null, { status: 404 });
    }
    const body = await request.json().catch(() => null);
    const shootRequest = url.pathname === "/shoot" ? parseShootRequest(body) : null;
    const readRequest = url.pathname === "/read" ? parseReadRequest(body) : null;
    if (shootRequest === null && readRequest === null) return json({ error: "a public https address is required" }, 400);
    if (readRequest !== null) return await readPage(env, readRequest.url);
    let browser: BrowserLike;
    try {
      browser = (await puppeteer.launch(env.BROWSER)) as unknown as BrowserLike;
    } catch (error) {
      return launchFailed(error);
    }
    return json(await shoot(browser, shootRequest!));
  },
};

/** Out of browsers for the account, or Browser Rendering is not on it. */
function launchFailed(error: unknown): Response {
  console.error(JSON.stringify({ event: "site_shots_launch_failed", reason: String(error).slice(0, 200) }));
  return json({ error: "no browser is free right now; try again in a minute" }, 503);
}

/**
 * How long an idle reading browser stays up for the next read. Starting one
 * is most of a slow read, and one question's reads come seconds apart; idle
 * time is billed as browser time, so this is minutes, not the ten allowed.
 * Not exported: the entry module exports only its handler.
 */
const KEEP_WARM_MS = 180_000;

async function readPage(env: Env, url: string): Promise<Response> {
  const started = Date.now();
  // The person's address and the page's text stay out of the log.
  const log = (via: string) => console.log(JSON.stringify({ event: "site_shots_read", via, ms: Date.now() - started }));
  const fast = await fetchPage(url);
  if (fast !== null) {
    log(fast.via);
    return json({ page: fast });
  }
  let browser: BrowserLike;
  try {
    browser = await warmContext(env);
  } catch (error) {
    return launchFailed(error);
  }
  try {
    const page = await read(browser, url);
    log("browser");
    return json({ page });
  } catch {
    // The reason can quote the page; the gateway only needs to know it failed.
    return json({ error: "that page could not be read" }, 502);
  }
}

/**
 * A fresh browser context in a warm browser: an idle reading browser if one is
 * up, else a new one kept alive for the next read. The context is the
 * isolation: it starts with no cookie, storage or cache from any earlier read,
 * and closing it leaves the browser up for the next one. Two reads that race
 * for the same idle browser cannot both connect; the loser launches its own.
 */
async function warmContext(env: Env): Promise<BrowserLike> {
  let browser: Browser | null = null;
  try {
    for (const session of await puppeteer.sessions(env.BROWSER)) {
      if (session.connectionId) continue;
      let candidate: Browser;
      try {
        candidate = await puppeteer.connect(env.BROWSER, session.sessionId);
      } catch {
        // Taken by another read a moment ago; try the next.
        continue;
      }
      // A browser someone is driving (`/browse`) has a page open on a site;
      // a reading browser's own pages are blank between reads. Leave it be.
      const pages = await candidate.pages().catch(() => []);
      if (pages.some((page) => page.url() !== "about:blank")) {
        await candidate.disconnect().catch(() => undefined);
        continue;
      }
      browser = candidate;
      break;
    }
  } catch {
    // Listing sessions failed: launch instead.
  }
  browser ??= await puppeteer.launch(env.BROWSER, { keep_alive: KEEP_WARM_MS });
  const warm = browser;
  let context: BrowserContext;
  try {
    context = await warm.createBrowserContext();
  } catch (error) {
    await warm.close().catch(() => undefined);
    throw error;
  }
  return {
    newPage: async () => (await context.newPage()) as unknown as PageLike,
    async close() {
      await context.close().catch(() => undefined);
      await warm.disconnect().catch(() => undefined);
    },
  };
}

/**
 * How long a driven browser waits, idle, for the assistant's next call. The
 * most Browser Rendering allows; a question's calls come seconds apart, and
 * the gateway closes it when the question is answered.
 */
const BROWSE_KEEP_ALIVE_MS = 600_000;

async function browse(env: Env, path: string, body: unknown): Promise<Response> {
  const session = typeof (body as { session?: unknown })?.session === "string" ? (body as { session: string }).session : null;
  if (path === "/browse/close") {
    if (session === null || !/^[A-Za-z0-9-]{8,80}$/.test(session)) return json({ error: "a session is required" }, 400);
    const browser = await puppeteer.connect(env.BROWSER, session).catch(() => null);
    await browser?.close().catch(() => undefined);
    return json({ closed: true });
  }
  const parsed = parseBrowseRequest(body);
  if (parsed === null) return json({ error: "those steps could not be read" }, 400);
  let browser: Browser;
  if (parsed.session !== null) {
    const connected = await connectWithRetry(env, parsed.session);
    if (connected === null) return json({ error: "that browser has closed" }, 410);
    browser = connected;
  } else {
    try {
      browser = await puppeteer.launch(env.BROWSER, { keep_alive: BROWSE_KEEP_ALIVE_MS });
    } catch (error) {
      return launchFailed(error);
    }
  }
  const started = Date.now();
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    if (parsed.session === null) await page.setViewport({ width: 1280, height: 860 });
    page.setDefaultTimeout(BROWSE_GOTO_TIMEOUT_MS);
    const result = await runSteps(page as unknown as BrowsePage, parsed.steps);
    // Step kinds and timing only: never an address, a word typed or the page.
    console.log(JSON.stringify({ event: "site_shots_browse", steps: parsed.steps.map((s) => s.do), ok: result.ran.every((r) => r.ok), ms: Date.now() - started }));
    return json({ session: browser.sessionId(), ...result });
  } catch {
    return json({ session: browser.sessionId(), error: "the browser could not do that" }, 502);
  } finally {
    await browser.disconnect().catch(() => undefined);
  }
}

/** A browser takes one connection at a time; a read may hold it for a moment. */
async function connectWithRetry(env: Env, session: string): Promise<Browser | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await puppeteer.connect(env.BROWSER, session);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  return null;
}
