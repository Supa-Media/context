/**
 * POST /browse with `provider: "browserbase"`: the same steps as Cloudflare's
 * browser (./browse.ts), on this person's Browserbase browser.
 *
 *   `{ provider, owner, steps, handoff? }` → `{ session, ran, page }` (`handoff`
 *   says the person is being handed this browser, and asks for nothing)
 *   `/browse/close` `{ provider, owner }` → releases their browser now
 *
 * With `keep: true` the answer also carries `jar`, the person's sign-ins read
 * back out of the browser, for the gateway to seal in their vault; a `jar`
 * sent in is put into a browser this request had to start (./jar.ts). An
 * answer carries none when a jar sent in could not be put back, so a failed
 * restore never reads as a sign-out.
 *
 * Downloads are allowed into Browserbase's storage on every call, and a
 * `download` step takes its file from there (./download.ts).
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
  takeDownload,
  type BrowserbaseEnv,
} from "./browserbase";
import { MAX_DOWNLOAD_BYTES, asFile, type Downloads } from "./download";
import { attachPage, cdpPage, connectCdp } from "./cdp";
import { touchIdle } from "./idle";
import { captureJar, parseJar, restoreCookies, restoreStorage, type Jar } from "./jar";

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
  const keep = (body as { keep?: unknown })?.keep === true;
  const held: Jar | null = keep ? parseJar((body as { jar?: unknown })?.jar) : null;
  const started = Date.now();
  // In use: it lives five more minutes from now. Before the lookup, so a
  // release already under way finishes first and this finds no browser,
  // rather than one being released under it (./idle.ts).
  await touchIdle(env.BROWSER_IDLE, owner);
  let session;
  let fresh = false;
  try {
    session = await findSession(env, owner, fetcher);
    if (session === null) {
      session = await createSession(env, owner, fetcher);
      fresh = true;
    }
  } catch (error) {
    const status = /^browserbase (\d{3})$/.exec(error instanceof Error ? error.message : "")?.[1] ?? null;
    // The status only: never the vendor's body, which can name the account.
    console.log(JSON.stringify({ event: "site_shots_browserbase_refused", status }));
    // 402: Browserbase will not start a browser until its bill is paid. The
    // gateway takes Cloudflare's browser for this question rather than failing.
    if (status === "402") return json({ error: "browserbase refused: payment required" }, 402);
    return json({ error: "no browser is free right now; try again in a minute" }, 503);
  }
  let cdp;
  try {
    cdp = await connectCdp(session.connectUrl, fetcher);
  } catch {
    return json({ session: session.id, error: "that browser has closed" }, 410);
  }
  try {
    const attached = await attachPage(cdp);
    // Whether the jar may be read back out: not after a restore that failed.
    let restored = true;
    if (held !== null) {
      try {
        // A browser already running holds newer cookies than the jar; only a new one is given them.
        if (fresh) await restoreCookies(cdp, held);
        await restoreStorage(attached, held);
      } catch {
        restored = false;
      }
    }
    // Every file the browser downloads goes to Browserbase's storage for this
    // session, where a download step takes it (./download.ts). Only "downloads"
    // syncs there, the vendor's own folder name.
    let begun = 0;
    cdp.on?.("Browser.downloadWillBegin", () => {
      begun += 1;
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "downloads", eventsEnabled: true }).catch(() => undefined);
    const downloads: Downloads = {
      began: () => begun,
      async take(since, waitMs) {
        const got = await takeDownload(env, session.id, since, waitMs, MAX_DOWNLOAD_BYTES, fetcher);
        return got === null || "refused" in got ? got : asFile(got);
      },
    };
    const page = await cdpPage(cdp, attached);
    const result = await runSteps(page, parsed.steps, { downloads });
    const jar = keep && restored ? await captureJar(cdp, attached).catch(() => null) : null;
    // Step kinds and timing only, as for Cloudflare's browser.
    console.log(JSON.stringify({ event: "site_shots_browse", provider: "browserbase", steps: parsed.steps.map((s) => s.do), ok: result.ran.every((r) => r.ok), ms: Date.now() - started }));
    return json({ session: session.id, ...result, ...(jar !== null ? { jar } : {}) });
  } catch {
    return json({ session: session.id, error: "the browser could not do that" }, 502);
  } finally {
    cdp.close();
  }
}
