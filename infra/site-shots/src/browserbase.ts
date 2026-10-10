/**
 * Browserbase, the decided browser for Tex (2026-10-10): captcha solving and
 * stealth, and a live view a person can open on their phone to sign in.
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
 * - **It ends itself.** `timeout` caps a session's whole life, so a browser
 *   left for a sign-in is gone within `SESSION_LIFETIME_S` whatever happens.
 *
 * The key and project id are this Worker's secrets (`BROWSERBASE_API_KEY`,
 * `BROWSERBASE_PROJECT_ID`); with either missing, `/browse` answers that
 * Browserbase is not configured and the gateway keeps Cloudflare's browser.
 */

const API = "https://api.browserbase.com/v1";

/** A browser's whole life: long enough to sign in and carry on, then gone. */
export const SESSION_LIFETIME_S = 15 * 60;

export interface BrowserbaseEnv {
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
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

/** The link a person opens to see and use this browser themselves. */
export async function liveViewUrl(env: BrowserbaseEnv, id: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const debug = await api<{ debuggerFullscreenUrl?: unknown }>(env, `/sessions/${encodeURIComponent(id)}/debug`, { method: "GET" }, fetcher);
  const url = typeof debug?.debuggerFullscreenUrl === "string" ? debug.debuggerFullscreenUrl : null;
  return url !== null && url.startsWith("https://") ? url : null;
}

export async function releaseSession(env: BrowserbaseEnv, id: string, fetcher: typeof fetch = fetch): Promise<void> {
  await api(env, `/sessions/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" }),
  }, fetcher);
}
