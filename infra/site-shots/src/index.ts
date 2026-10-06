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
 *                 the texting assistant (see ./read.ts)
 *   anything else 404
 */

import puppeteer from "@cloudflare/puppeteer";
import { parseReadRequest, read } from "./read";
import { parseShootRequest, shoot, type BrowserLike } from "./shoot";

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
    let browser: BrowserLike;
    try {
      browser = (await puppeteer.launch(env.BROWSER)) as unknown as BrowserLike;
    } catch (error) {
      // Out of browsers for the account, or Browser Rendering is not on it.
      console.error(JSON.stringify({ event: "site_shots_launch_failed", reason: String(error).slice(0, 200) }));
      return json({ error: "no browser is free right now; try again in a minute" }, 503);
    }
    if (shootRequest !== null) return json(await shoot(browser, shootRequest));
    try {
      return json({ page: await read(browser, readRequest!.url) });
    } catch {
      // The reason can quote the page; the gateway only needs to know it failed.
      return json({ error: "that page could not be read" }, 502);
    }
  },
};
