/**
 * POST /browse with `provider: "browser-use"`.
 *
 * The gateway sends this only after a site block, and only when
 * `browsers.browserUseFallback` is on. This Worker does not decide that.
 * It does enforce the caps, and it stops the session itself: closing the
 * CDP socket is not a stop.
 *
 * The sealed jar is restored onto the new browser. A Browserbase profile id
 * is never sent. A Google sign-in bound to the device that created it will
 * not transfer with the jar; the person signs in to Google again.
 *
 * Browserbase's upload and download storage is not used here. A download or
 * upload step runs on the page alone, and fails honestly when that is not enough.
 *
 * The vendor live-view URL is never read and never returned. The person's
 * own view (`./view.ts`) attaches to the CDP url kept in the ledger.
 */

import { parseBrowseRequest, runSteps } from "./browse";
import { contentWaitOf } from "./patience";
import { attachPage, cdpPage, connectCdp } from "./cdp";
import { captureJar, parseJar, restoreCookies, restoreStorage } from "./jar";
import { invisibleCaptcha, captchaKind, settleCaptcha } from "./captcha";
import { pastGooglePasskey } from "./googleChallenge";
import { HOLD_MS, IDLE_MS, touchIdle } from "./idle";
import { OWNER_TAG } from "./browserbase";
import { capRefusal, effectiveCaps, hostFromSteps, type BrowseOutcome, type BlockReason } from "./browserUsePolicy";
import { browserUseConfigured, createBrowser, creditBalanceUsd, sessionCost, stopBrowser, type BrowserUseKey, type BrowserUseSession } from "./browserUse";
import { ledgerStub, safeRecord, UNKNOWN_SESSION_USD, type LedgerEnv, type OwnedSession } from "./browserUseLedger";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface BrowserUseEnv extends BrowserUseKey, LedgerEnv {
  BROWSER_IDLE?: Parameters<typeof touchIdle>[0];
}

export interface DriveResult {
  ran: Array<{ do: string; ok: boolean; reason?: string }>;
  page: { url?: string } | null;
  captcha: "solved" | "unsolved" | null;
  captchaKind: "wall" | "widget" | null;
  invisibleCaptcha: boolean;
  jar: unknown;
}

/** Drive one session over CDP. Tests replace this; production uses `driveOnCdp`. */
export type Drive = (session: BrowserUseSession, body: unknown, fetcher: typeof fetch) => Promise<DriveResult>;

async function driveOnCdp(session: BrowserUseSession, body: unknown, fetcher: typeof fetch): Promise<DriveResult> {
  const parsed = parseBrowseRequest({ steps: (body as { steps?: unknown })?.steps });
  if (parsed === null) throw new Error("steps");
  const cdp = await connectCdp(session.cdpUrl, fetcher);
  try {
    const attached = await attachPage(cdp);
    const held = (body as { keep?: unknown })?.keep === true ? parseJar((body as { jar?: unknown })?.jar) : null;
    // Cookies and IndexedDB from the sealed jar. Not a Browserbase Context.
    // A Google sign-in bound to the device that created it will not transfer.
    let restored = true;
    if (held !== null) {
      try {
        await restoreCookies(cdp, held);
        await restoreStorage(attached, held);
      } catch {
        restored = false;
      }
    }
    const page = await cdpPage(cdp, attached);
    const handingOver = (body as { handoff?: unknown })?.handoff === true;
    let result = await runSteps(page, parsed.steps, { waitMs: contentWaitOf(body) });
    const captcha = handingOver ? null : await settleCaptcha(attached.evaluate, { solver: attached.solver ?? null });
    if (captcha === "solved") result = { ...result, page: (await runSteps(page, [{ do: "read" }])).page };
    const kind = captcha === "unsolved" ? await captchaKind(attached.evaluate) : null;
    const hidden = handingOver || captcha !== null ? false : await invisibleCaptcha(attached.evaluate);
    const google = handingOver ? null : await pastGooglePasskey(attached);
    if (google !== null && google.pressed.length > 0) {
      const again = parsed.steps.at(-1)?.do === "look" ? "look" : "read";
      result = { ...result, page: (await runSteps(page, [{ do: again }])).page };
    }
    const jar = (body as { keep?: unknown })?.keep === true && restored ? await captureJar(cdp, attached).catch(() => null) : null;
    return { ran: result.ran, page: result.page, captcha, captchaKind: kind, invisibleCaptcha: hidden, jar };
  } finally {
    // The socket closing is not the cloud stop. The caller stops the session.
    cdp.close();
  }
}

function outcomeOf(result: DriveResult): { outcome: BrowseOutcome; reason?: BlockReason } {
  if (result.captcha === "unsolved" && result.captchaKind === "wall") return { outcome: "site_blocked", reason: "interstitial" };
  if (result.captcha === "unsolved") return { outcome: "site_blocked", reason: "captcha" };
  if (result.ran.some((step) => !step.ok)) return { outcome: "error" };
  return { outcome: "ok" };
}

/**
 * Stop the session, charge what it cost, and write the call row. Returns
 * false when the stop itself failed, so the caller keeps the session for
 * the idle alarm to try again. A missing cost charges a full day of the
 * cap, which refuses the next fallback that day.
 */
export async function endBrowserUseSession(env: BrowserUseEnv, session: OwnedSession, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (session.charged) return true;
  try {
    await stopBrowser(env, session.id, fetcher);
  } catch {
    console.log(JSON.stringify({ event: "site_shots_browser_use_stop_failed" }));
    return false;
  }
  const cost = await sessionCost(env, session.id, fetcher);
  const usd = cost?.totalUsd ?? UNKNOWN_SESSION_USD;
  const stub = ledgerStub(env);
  try {
    await stub?.addSpend(usd);
  } catch {
    console.log(JSON.stringify({ event: "site_shots_browser_use_spend_failed" }));
  }
  await safeRecord(env, {
    kind: "call",
    provider: "browser-use",
    host: session.host,
    outcome: session.outcome,
    ...(session.reason ? { reason: session.reason } : {}),
    durationMs: Math.max(0, Date.now() - session.started),
    ...(cost ? { costUsd: cost.totalUsd, proxyMb: cost.proxyMb, bytes: cost.bytes } : { costUsd: usd }),
  });
  return true;
}

async function releaseOwned(env: BrowserUseEnv, owner: string, fetcher: typeof fetch): Promise<boolean> {
  const stub = ledgerStub(env);
  if (!stub) return true;
  const session = await stub.recall(owner).catch(() => null);
  if (!session) return true;
  const ended = await endBrowserUseSession(env, session, fetcher);
  if (!ended) return false;
  await stub.forget(owner).catch(() => undefined);
  return true;
}

/** Idle and sign-out call this. A missing session is not an error. */
export async function releaseOwnedBrowserUse(env: BrowserUseEnv, owner: string, fetcher: typeof fetch = fetch): Promise<void> {
  await releaseOwned(env, owner, fetcher);
}

/** The CDP url of the owner's Browser Use browser, for the person's own view. Never leaves this Worker. */
export async function browserUseCdp(env: BrowserUseEnv, owner: string): Promise<string | null> {
  const session = await ledgerStub(env)?.recall(owner).catch(() => null);
  return session && !session.charged ? session.cdpUrl : null;
}

export async function browseOnBrowserUse(
  env: BrowserUseEnv,
  path: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
  drive: Drive = driveOnCdp,
): Promise<Response> {
  if (!browserUseConfigured(env)) return json({ error: "browser-use is not configured" }, 501);
  const owner = (body as { owner?: unknown })?.owner;
  if (typeof owner !== "string" || !OWNER_TAG.test(owner)) return json({ error: "an owner is required" }, 400);
  if (path === "/browse/close") {
    await releaseOwned(env, owner, fetcher);
    return json({ closed: true });
  }
  if (path === "/browse/hold") {
    const running = await ledgerStub(env)?.recall(owner).catch(() => null);
    if (!running || running.charged) return json({ held: false });
    await touchIdle(env.BROWSER_IDLE, owner, HOLD_MS);
    return json({ held: true });
  }
  if (path !== "/browse") return new Response(null, { status: 404 });
  const parsed = parseBrowseRequest({ steps: (body as { steps?: unknown })?.steps });
  if (parsed === null) return json({ error: "those steps could not be read" }, 400);
  const caps = effectiveCaps((body as { caps?: unknown })?.caps);
  const started = Date.now();
  const host = hostFromSteps(parsed.steps);
  const stub = ledgerStub(env);
  let spent = { dayUsd: Number.NaN, monthUsd: Number.NaN };
  if (stub) {
    try {
      spent = await stub.spent();
    } catch {
      spent = { dayUsd: Number.NaN, monthUsd: Number.NaN };
    }
  }
  // Our books first. A day or month already at the cap never asks the vendor.
  const books = capRefusal(spent, caps.minBalanceUsd, false, caps);
  if (books) return json({ fallbackRefused: true, reason: books, provider: "browser-use" });
  let balance: number | null = null;
  let balanceFailed = false;
  try {
    balance = await creditBalanceUsd(env, fetcher);
  } catch {
    balanceFailed = true;
  }
  const reason = capRefusal(spent, balance, balanceFailed, caps);
  if (reason) return json({ fallbackRefused: true, reason, provider: "browser-use" });

  const fresh = (body as { fresh?: unknown })?.fresh === true;
  if (fresh) await releaseOwned(env, owner, fetcher).catch(() => undefined);
  const handingOver = (body as { handoff?: unknown })?.handoff === true;
  await touchIdle(env.BROWSER_IDLE, owner, handingOver ? HOLD_MS : IDLE_MS);

  let created: BrowserUseSession | null = null;
  let createdNew = false;
  let remembered = false;
  let settled: OwnedSession | null = null;
  const keep = (body as { keep?: unknown })?.keep !== false;
  try {
    const existing = fresh ? null : await stub?.recall(owner).catch(() => null);
    if (existing && !existing.charged) {
      created = { id: existing.id, cdpUrl: existing.cdpUrl };
    } else {
      created = await createBrowser(env, caps.jobMinutes, owner, fetcher);
      createdNew = true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: DriveResult;
    try {
      result = await Promise.race([
        drive(created, body, fetcher),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("browser-use job minute cap")), caps.jobMinutes * 60_000);
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "browser-use job minute cap") {
        console.log(JSON.stringify({ event: "site_shots_browser_use_job_cap" }));
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const classified = outcomeOf(result);
    const owned: OwnedSession = {
      id: created.id,
      cdpUrl: created.cdpUrl,
      host,
      started,
      outcome: classified.outcome,
      ...(classified.reason ? { reason: classified.reason } : {}),
      charged: false,
    };
    if (keep && stub) {
      await stub.remember(owner, owned);
      remembered = true;
    } else settled = owned;
    const page = result.page;
    return json({
      provider: "browser-use",
      session: created.id,
      ran: result.ran,
      page,
      ms: Date.now() - started,
      ...(result.captcha !== null ? { captcha: result.captcha } : {}),
      ...(result.captchaKind !== null ? { captchaKind: result.captchaKind } : {}),
      ...(result.invisibleCaptcha ? { invisibleCaptcha: true } : {}),
      ...(result.jar ? { jar: result.jar } : {}),
    });
  } catch {
    return json({ provider: "browser-use", session: created?.id, fallbackRefused: false, error: "the browser could not do that" }, created ? 502 : 503);
  } finally {
    // A session this call created is stopped unless it was kept for the next
    // step. A reused session stays up for its own idle stop.
    if (created && createdNew && !remembered) {
      const owned: OwnedSession = settled ?? { id: created.id, cdpUrl: created.cdpUrl, host, started, outcome: "error", charged: false };
      const ended = await endBrowserUseSession(env, owned, fetcher);
      if (!ended && stub) await stub.remember(owner, owned).catch(() => undefined);
    }
  }
}
