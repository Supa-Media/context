/**
 * Browser Use's browser-session API, and nothing else.
 *
 * Tex drives the browser over CDP. The V4 agent and task APIs are not called:
 * those add a model charge on top of browser time. Buying credits and turning
 * on auto-recharge are not called either; auto-recharge stays off.
 *
 * Disconnecting CDP does not stop a session. `stopBrowser` is the stop
 * (`PATCH /api/v4/browsers/{id}` with `{ action: "stop" }`). The live-view
 * URL on the create response is never read out of this file.
 */

export interface BrowserUseKey {
  BROWSER_USE_API_KEY?: string;
}

const ORIGIN = "https://api.browser-use.com";
const ID = /^[A-Za-z0-9-]{8,80}$/;

/** The only vendor calls this Worker makes. Anything else, including a credit purchase, is refused before `fetch`. */
export function browserUseAllowed(method: string, path: string): boolean {
  if (method === "GET" && path === "/api/v2/billing/account") return true;
  if (method === "POST" && path === "/api/v4/browsers") return true;
  if (method === "PATCH" && /^\/api\/v4\/browsers\/[A-Za-z0-9-]{8,80}$/.test(path)) return true;
  if (method === "GET" && /^\/api\/v4\/sessions\/[A-Za-z0-9-]{8,80}\/cost$/.test(path)) return true;
  return false;
}

export function browserUseConfigured(env: BrowserUseKey): boolean {
  return typeof env.BROWSER_USE_API_KEY === "string" && env.BROWSER_USE_API_KEY.length > 0;
}

async function call(env: BrowserUseKey, method: string, path: string, body: unknown, fetcher: typeof fetch): Promise<Response> {
  if (!browserUseAllowed(method, path)) throw new Error("browser-use call refused");
  const headers: Record<string, string> = { "X-Browser-Use-API-Key": env.BROWSER_USE_API_KEY ?? "" };
  if (body !== undefined) headers["content-type"] = "application/json";
  return await fetcher(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
}

export interface BrowserUseSession {
  id: string;
  /** Kept inside this Worker. Never returned to the gateway or a person. */
  cdpUrl: string;
}

/**
 * A new browser. `minutes` is the vendor timeout (1–15 here). No profile id:
 * a Browserbase profile is not a Browser Use profile, and a Google sign-in
 * bound to the browser that created it will not transfer. The sealed jar is
 * what moves, applied over CDP by the caller.
 */
export async function createBrowser(env: BrowserUseKey, minutes: number, owner: string, fetcher: typeof fetch = fetch): Promise<BrowserUseSession> {
  const timeout = Math.min(15, Math.max(1, Math.round(minutes)));
  const response = await call(env, "POST", "/api/v4/browsers", { timeout, proxyCountryCode: "us", metadata: { owner } }, fetcher);
  if (!response.ok) throw new Error(`browser-use ${response.status}`);
  const body = (await response.json().catch(() => null)) as { id?: unknown; cdpUrl?: unknown } | null;
  const id = typeof body?.id === "string" && ID.test(body.id) ? body.id : "";
  const cdpUrl = typeof body?.cdpUrl === "string" && /^wss:\/\//.test(body.cdpUrl) ? body.cdpUrl : "";
  if (!id || !cdpUrl) throw new Error("browser-use gave no session");
  return { id, cdpUrl };
}

/** Stop the cloud browser. A 404 means it has already ended. Closing the CDP socket is not this. */
export async function stopBrowser(env: BrowserUseKey, id: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!ID.test(id)) throw new Error("browser-use call refused");
  const response = await call(env, "PATCH", `/api/v4/browsers/${id}`, { action: "stop" }, fetcher);
  if (response.ok || response.status === 404) return;
  throw new Error(`browser-use stop ${response.status}`);
}

/** `totalCreditsBalanceUsd` from `GET /api/v2/billing/account`. Throws when the call fails or the field is missing. */
export async function creditBalanceUsd(env: BrowserUseKey, fetcher: typeof fetch = fetch): Promise<number> {
  const response = await call(env, "GET", "/api/v2/billing/account", undefined, fetcher);
  if (!response.ok) throw new Error(`browser-use balance ${response.status}`);
  const body = (await response.json().catch(() => null)) as { totalCreditsBalanceUsd?: unknown } | null;
  const raw = body?.totalCreditsBalanceUsd;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("browser-use balance missing");
  return n;
}

export interface SessionCost {
  totalUsd: number;
  proxyMb: number;
  bytes: number;
}

/** What the session cost after it stopped. Null when the vendor does not say: the caller then fails closed. */
export async function sessionCost(env: BrowserUseKey, id: string, fetcher: typeof fetch = fetch): Promise<SessionCost | null> {
  if (!ID.test(id)) return null;
  try {
    const response = await call(env, "GET", `/api/v4/sessions/${id}/cost`, undefined, fetcher);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { totalCostUsd?: unknown; proxyUsedMb?: unknown } | null;
    const totalUsd = typeof body?.totalCostUsd === "number" ? body.totalCostUsd : Number(body?.totalCostUsd);
    const proxyMb = typeof body?.proxyUsedMb === "number" ? body.proxyUsedMb : Number(body?.proxyUsedMb);
    if (!Number.isFinite(totalUsd) || totalUsd < 0) return null;
    const mb = Number.isFinite(proxyMb) && proxyMb >= 0 ? proxyMb : 0;
    return { totalUsd, proxyMb: mb, bytes: Math.round(mb * 1024 * 1024) };
  } catch {
    return null;
  }
}
