/**
 * POST /browse with `provider: "browserbase"`: the same steps as Cloudflare's
 * browser (./browse.ts), on this person's Browserbase browser.
 *
 *   `{ provider, owner, steps, handoff? }` → `{ session, ran, page, liveUrl? }`
 *   `/browse/close` `{ provider, owner }` → releases their browser now
 *
 * `owner` is the gateway's tag for the person (./browserbase.ts); the browser
 * is found by it, so a question that comes back after a sign-in carries on in
 * the same browser. `handoff` asks for the live-view link, which goes back to
 * the gateway only: it adds the link to the text itself, and the model never
 * holds it.
 */

import { parseBrowseRequest, runSteps } from "./browse";
import {
  OWNER_TAG,
  browserbaseConfigured,
  createSession,
  findSession,
  liveViewUrl,
  releaseSession,
  type BrowserbaseEnv,
} from "./browserbase";
import { cdpPage, connectCdp } from "./cdp";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function browseOnBrowserbase(env: BrowserbaseEnv, path: string, body: unknown, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!browserbaseConfigured(env)) return json({ error: "browserbase is not configured" }, 501);
  const owner = (body as { owner?: unknown })?.owner;
  if (typeof owner !== "string" || !OWNER_TAG.test(owner)) return json({ error: "an owner is required" }, 400);
  if (path === "/browse/close") {
    const running = await findSession(env, owner, fetcher).catch(() => null);
    if (running) await releaseSession(env, running.id, fetcher).catch(() => undefined);
    return json({ closed: true });
  }
  const parsed = parseBrowseRequest({ steps: (body as { steps?: unknown })?.steps });
  if (parsed === null) return json({ error: "those steps could not be read" }, 400);
  const started = Date.now();
  let session;
  try {
    session = (await findSession(env, owner, fetcher)) ?? (await createSession(env, owner, fetcher));
  } catch {
    return json({ error: "no browser is free right now; try again in a minute" }, 503);
  }
  let cdp;
  try {
    cdp = await connectCdp(session.connectUrl, fetcher);
  } catch {
    return json({ session: session.id, error: "that browser has closed" }, 410);
  }
  try {
    const page = await cdpPage(cdp);
    const result = await runSteps(page, parsed.steps);
    const wantsLink = (body as { handoff?: unknown })?.handoff === true;
    const liveUrl = wantsLink ? await liveViewUrl(env, session.id, fetcher).catch(() => null) : null;
    // Step kinds and timing only, as for Cloudflare's browser.
    console.log(JSON.stringify({ event: "site_shots_browse", provider: "browserbase", steps: parsed.steps.map((s) => s.do), ok: result.ran.every((r) => r.ok), ms: Date.now() - started }));
    return json({ session: session.id, ...result, ...(liveUrl ? { liveUrl } : {}) });
  } catch {
    return json({ session: session.id, error: "the browser could not do that" }, 502);
  } finally {
    cdp.close();
  }
}
