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
 *   anything else 404
 */

import puppeteer from "@cloudflare/puppeteer";
import { fetchPage } from "./fetchText";
import { parseReadRequest, read } from "./read";
import type { Browser, BrowserContext } from "@cloudflare/puppeteer";
import { parseShootRequest, shoot, type BrowserLike, type PageLike } from "./shoot";

interface Env {
  BROWSER: Parameters<typeof puppeteer.launch>[0];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
      try {
        browser = await puppeteer.connect(env.BROWSER, session.sessionId);
        break;
      } catch {
        // Taken by another read a moment ago; try the next.
      }
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
