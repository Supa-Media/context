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
 * `download` step takes its file from there (./download.ts). An `upload`
 * step's file goes the other way, into the session's storage, and the browser
 * sets it on the page's box itself (./upload.ts).
 *
 * A captcha left on the page after the steps is given time to clear on its
 * own, Browserbase's solver being on in every browser; the answer's
 * `captcha` says `solved` or `unsolved` (./captcha.ts). `fresh: true` drops
 * the person's running browser and starts another, a new address and
 * fingerprint, which is the gateway's last try before a captcha is handed
 * over (apps/mcp/src/agent/captchaLadder.js).
 *
 * A run that fails is logged with a digest of the session's own Browserbase
 * log (./sessionLogs.ts), after the answer has gone (`later`): hosts, status
 * codes and counts, never the page, an address's path or what was typed.
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
import { browserbaseUploads } from "./upload";
import { HOLD_MS, IDLE_MS, touchIdle } from "./idle";
import { captureJar, parseJar, restoreCookies, restoreStorage, type Jar } from "./jar";
import { reportFailedRun, type FailedRun } from "./sessionLogs";
import { invisibleCaptcha, settleCaptcha } from "./captcha";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Runs work after the answer has gone: the Worker's `ctx.waitUntil`. */
export type Later = (work: Promise<unknown>) => void;

export async function browseOnBrowserbase(
  env: BrowserbaseEnv,
  path: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
  later: Later = (work) => void work,
): Promise<Response> {
  if (!browserbaseConfigured(env)) return json({ error: "browserbase is not configured" }, 501);
  const owner = (body as { owner?: unknown })?.owner;
  if (typeof owner !== "string" || !OWNER_TAG.test(owner)) return json({ error: "an owner is required" }, 400);
  if (path === "/browse/close") {
    const running = await findSession(env, owner, fetcher).catch(() => null);
    if (running) await releaseSession(env, running.id, fetcher).catch(() => undefined);
    return json({ closed: true });
  }
  if (path === "/browse/hold") {
    // Tex is waiting on the person: their running browser, if any, stays up
    // fifteen minutes so their reply lands on the same page (./idle.ts).
    const running = await findSession(env, owner, fetcher).catch(() => null);
    if (running === null) return json({ held: false });
    await touchIdle(env.BROWSER_IDLE, owner, HOLD_MS);
    return json({ held: true });
  }
  const parsed = parseBrowseRequest({ steps: (body as { steps?: unknown })?.steps });
  if (parsed === null) return json({ error: "those steps could not be read" }, 400);
  const keep = (body as { keep?: unknown })?.keep === true;
  const startOver = (body as { fresh?: unknown })?.fresh === true;
  const handingOver = (body as { handoff?: unknown })?.handoff === true;
  const held: Jar | null = keep ? parseJar((body as { jar?: unknown })?.jar) : null;
  const started = Date.now();
  const steps = parsed.steps.map((s) => s.do);
  const failed = (session: string, stage: FailedRun["stage"], ran?: FailedRun["ran"]) =>
    later(reportFailedRun(env, { session, stage, steps, ...(ran ? { ran } : {}), ms: Date.now() - started }, fetcher).catch(() => undefined));
  // In use: it lives five more minutes from now, or fifteen when it is being
  // handed to the person. Before the lookup, so a release already under way
  // finishes first and this finds no browser, rather than one being released
  // under it (./idle.ts).
  await touchIdle(env.BROWSER_IDLE, owner, handingOver ? HOLD_MS : IDLE_MS);
  let session;
  let fresh = false;
  try {
    session = await findSession(env, owner, fetcher);
    // A fresh browser: the running one is let go first, so the new one is
    // the only one this person has and the next question finds it.
    if (session !== null && startOver) {
      await releaseSession(env, session.id, fetcher).catch(() => undefined);
      session = null;
    }
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
    failed(session.id, "connect");
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
    // A file goes in as the browser's own, through Browserbase's uploads (./upload.ts).
    const uploads = browserbaseUploads(env, session.id, fetcher);
    let result = await runSteps(page, parsed.steps, { downloads, uploads });
    // Not while the person is being handed the browser: it is theirs then.
    const captcha = handingOver ? null : await settleCaptcha(attached.evaluate);
    if (captcha === "solved") result = { ...result, page: (await runSteps(page, [{ do: "read" }])).page };
    // A captcha that shows nothing can still turn a Register press away: the gateway is told it is there.
    const hidden = handingOver || captcha !== null ? false : await invisibleCaptcha(attached.evaluate);
    const jar = keep && restored ? await captureJar(cdp, attached).catch(() => null) : null;
    const ok = result.ran.every((r) => r.ok);
    // Step kinds and timing only, as for Cloudflare's browser.
    console.log(JSON.stringify({ event: "site_shots_browse", provider: "browserbase", steps, ok, ms: Date.now() - started }));
    if (!ok) failed(session.id, "steps", result.ran.map((r) => ({ do: r.do, ok: r.ok, ...(r.reason && !r.ok ? { reason: r.reason.slice(0, 200) } : {}) })));
    return json({ session: session.id, ...result, ...(captcha !== null ? { captcha } : {}), ...(hidden ? { invisibleCaptcha: true } : {}), ...(jar !== null ? { jar } : {}) });
  } catch {
    failed(session.id, "run");
    return json({ session: session.id, error: "the browser could not do that" }, 502);
  } finally {
    cdp.close();
  }
}
