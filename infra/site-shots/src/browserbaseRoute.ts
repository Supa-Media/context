/**
 * POST /browse with `provider: "browserbase"`: the same steps as Cloudflare's
 * browser (./browse.ts), on this person's Browserbase browser.
 *
 *   `{ provider, owner, steps, handoff? }` → `{ session, ran, page }` (`handoff`
 *   says the person is being handed this browser, and asks for nothing)
 *   `/browse/close` `{ provider, owner }` → releases their browser now
 *
 * `owner` is the gateway's tag for the person (./browserbase.ts); the browser
 * is found by it, so a question that comes back after a sign-in carries on in
 * the same browser. Browserbase's own live-view link is never asked for: it
 * is a bearer link to the browser, and a person hands it on by forwarding a
 * text. They take over at `context.lc/tex/<handle>` instead, signed in, which
 * looks through ./view.ts.
 */

import { parseBrowseRequest, runSteps } from "./browse";
import {
  OWNER_TAG,
  browserbaseConfigured,
  createSession,
  findSession,
  releaseSession,
  type BrowserbaseEnv,
} from "./browserbase";
import { cdpPage, connectCdp } from "./cdp";
import { touchIdle } from "./idle";

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
  } catch (error) {
    const status = /^browserbase (\d{3})$/.exec(error instanceof Error ? error.message : "")?.[1] ?? null;
    // The status only: never the vendor's body, which can name the account.
    console.log(JSON.stringify({ event: "site_shots_browserbase_refused", status }));
    // 402: Browserbase will not start a browser until its bill is paid. The
    // gateway takes Cloudflare's browser for this question rather than failing.
    if (status === "402") return json({ error: "browserbase refused: payment required" }, 402);
    return json({ error: "no browser is free right now; try again in a minute" }, 503);
  }
  // In use: it lives five more minutes from now.
  await touchIdle(env.BROWSER_IDLE, owner);
  let cdp;
  try {
    cdp = await connectCdp(session.connectUrl, fetcher);
  } catch {
    return json({ session: session.id, error: "that browser has closed" }, 410);
  }
  try {
    const page = await cdpPage(cdp);
    const result = await runSteps(page, parsed.steps);
    // Step kinds and timing only, as for Cloudflare's browser.
    console.log(JSON.stringify({ event: "site_shots_browse", provider: "browserbase", steps: parsed.steps.map((s) => s.do), ok: result.ran.every((r) => r.ok), ms: Date.now() - started }));
    return json({ session: session.id, ...result });
  } catch {
    return json({ session: session.id, error: "the browser could not do that" }, 502);
  } finally {
    cdp.close();
  }
}
