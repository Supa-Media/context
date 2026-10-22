/**
 * Browserbase, the decided browser for Tex (2026-10-10): captcha solving and
 * stealth, in a browser that outlives a question so a person can sign in.
 *
 * Kept to what the decision allows (`docs/decisions/texting-assistant.md`):
 *
 * - **Stateless.** No Browserbase Contexts (saved profiles), so no login
 *   outlives the session at the vendor, and `recordSession: false`.
 * - **One running browser per person, found by a tag, not stored.** The
 *   gateway passes `owner`, an HMAC of the person's id under its own secret;
 *   it goes on the session as `userMetadata`, and the next question finds the
 *   browser by it. Nothing of ours holds a session id between questions, and
 *   a tag cannot be guessed from the id it was made from.
 * - **No live-view link.** Browserbase's debugger URL drives the browser for
 *   whoever holds it; the person watches and takes over through ./view.ts.
 * - **It ends itself.** A browser is released five minutes after its last
 *   use (./idle.ts), and `timeout` caps a session's whole life, so even a busy
 *   one is gone within `SESSION_LIFETIME_S` whatever happens.
 *
 * The key and project id are this Worker's secrets (`BROWSERBASE_API_KEY`,
 * `BROWSERBASE_PROJECT_ID`); with either missing, `/browse` answers that
 * Browserbase is not configured and the gateway keeps Cloudflare's browser.
 */

import type { IdleNamespace } from "./idle";

const API = "https://api.browserbase.com/v1";

/**
 * A browser's longest life, however busy. It ends sooner: five minutes after
 * its last use (./idle.ts), which Browserbase cannot do on its own.
 */
export const SESSION_LIFETIME_S = 30 * 60;

export interface BrowserbaseEnv {
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  /** Ends a browser five minutes after its last use (./idle.ts). */
  BROWSER_IDLE?: IdleNamespace;
}

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

export const OWNER_TAG = /^[a-f0-9]{32,64}$/;

export function browserbaseConfigured(env: BrowserbaseEnv): boolean {
  return typeof env.BROWSERBASE_API_KEY === "string" && env.BROWSERBASE_API_KEY.length > 0 &&
    typeof env.BROWSERBASE_PROJECT_ID === "string" && env.BROWSERBASE_PROJECT_ID.length > 0;
}

async function api<T>(env: BrowserbaseEnv, path: string, init: RequestInit, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" },
  });
  // The vendor's error body is not relayed: the gateway needs only that it failed.
  if (!response.ok) throw new Error(`browserbase ${response.status}`);
  return (await response.json()) as T;
}

type RawSession = { id?: unknown; connectUrl?: unknown; status?: unknown; userMetadata?: { owner?: unknown } | null };

function asSession(raw: RawSession): BrowserbaseSession | null {
  return typeof raw?.id === "string" && typeof raw.connectUrl === "string" ? { id: raw.id, connectUrl: raw.connectUrl } : null;
}

/** This person's running browser, if they have one. */
export async function findSession(env: BrowserbaseEnv, owner: string, fetcher: typeof fetch = fetch): Promise<BrowserbaseSession | null> {
  const running = await api<RawSession[]>(env, "/sessions?status=RUNNING", { method: "GET" }, fetcher);
  for (const raw of Array.isArray(running) ? running : []) {
    if (raw?.userMetadata?.owner !== owner) continue;
    // The list may leave out how to connect; the session itself has it.
    const full = asSession(raw) ?? asSession(await api<RawSession>(env, `/sessions/${encodeURIComponent(String(raw.id))}`, { method: "GET" }, fetcher));
    if (full) return full;
  }
  return null;
}

/**
 * Every running browser of this person's, by id. Two first questions at once
 * can each start one; the idle release (./idle.ts) ends them all.
 */
export async function ownerSessionIds(env: BrowserbaseEnv, owner: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const running = await api<RawSession[]>(env, "/sessions?status=RUNNING", { method: "GET" }, fetcher);
  return (Array.isArray(running) ? running : [])
    .filter((raw) => raw?.userMetadata?.owner === owner && typeof raw.id === "string")
    .map((raw) => String(raw.id));
}

export async function createSession(env: BrowserbaseEnv, owner: string, fetcher: typeof fetch = fetch): Promise<BrowserbaseSession> {
  const raw = await api<RawSession>(
    env,
    "/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        projectId: env.BROWSERBASE_PROJECT_ID,
        keepAlive: true,
        timeout: SESSION_LIFETIME_S,
        userMetadata: { owner },
        browserSettings: { recordSession: false, viewport: { width: 1280, height: 860 } },
      }),
    },
    fetcher,
  );
  const session = asSession(raw);
  if (!session) throw new Error("browserbase gave no session");
  return session;
}

export async function releaseSession(env: BrowserbaseEnv, id: string, fetcher: typeof fetch = fetch): Promise<void> {
  await api(env, `/sessions/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
  }, fetcher);
}

type RawDownload = { id?: unknown; filename?: unknown; mimeType?: unknown; size?: unknown; createdAt?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The newest file this browser downloaded at or after `since`, waiting up to
 * `waitMs` for it to arrive (Browserbase syncs each download to its storage
 * as it lands), then removed from Browserbase: the gateway keeps it in the
 * person's own bucket, and nothing of theirs stays with the vendor. Null when
 * none came; `{ refused }` for one over `maxBytes`, which is never fetched.
 */
export async function takeDownload(
  env: BrowserbaseEnv,
  sessionId: string,
  since: number,
  waitMs: number,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
  pauseMs = 1_000,
): Promise<{ name: string; type: string; size: number; data: string } | { refused: string } | null> {
  const until = Date.now() + waitMs;
  const query = new URLSearchParams({ sessionId, createdAfter: new Date(since).toISOString(), limit: "20" });
  for (;;) {
    const listed = await api<{ downloads?: RawDownload[] }>(env, `/downloads?${query}`, { method: "GET" }, fetcher).catch(() => null);
    const newest = (Array.isArray(listed?.downloads) ? listed.downloads : [])
      .filter((d) => typeof d?.id === "string" && Date.parse(String(d.createdAt)) >= since - 1_000)
      .sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)))[0];
    if (newest) {
      const id = encodeURIComponent(String(newest.id));
      const forget = () => fetcher(`${API}/downloads/${id}`, { method: "DELETE", headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" } }).catch(() => undefined);
      if (Number(newest.size) > maxBytes) {
        await forget();
        return { refused: `that file is over the ${maxBytes / 1024 / 1024} MB a file can be` };
      }
      const response = await fetcher(`${API}/downloads/${id}`, {
        method: "GET",
        headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "", Accept: "application/octet-stream" },
      });
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      await forget();
      if (bytes.length > maxBytes) return { refused: `that file is over the ${maxBytes / 1024 / 1024} MB a file can be` };
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return {
        name: typeof newest.filename === "string" ? newest.filename : "",
        type: typeof newest.mimeType === "string" ? newest.mimeType : "",
        size: bytes.length,
        data: btoa(binary),
      };
    }
    if (Date.now() + pauseMs > until) return null;
    await sleep(pauseMs);
  }
}
