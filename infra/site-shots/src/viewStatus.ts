/**
 * Is Tex's browser open for this owner, and on what page: the Tex page's
 * "Tex's computer" tile (`apps/mcp/src/http/texPage/serve.js`).
 *
 *   POST /view/status `{ owner }` → `{ running: false }` or `{ running: true, url? }`
 *
 * The tile used to ask `/view/frame`, which connects to the browser and takes
 * a picture of it, 0.6 to 3 s, on every load of the page, only to say "Live";
 * and, like any frame, counted as using the browser, so a person merely
 * opening their page kept it awake (decided by the owner, 2026-11-04: "make
 * the hub page load fast ... a cheap browser check").
 *
 * So this asks Browserbase two questions over HTTP and nothing else:
 *
 * - **Which browsers are running**, matched by the owner tag, as `/view/frame`
 *   matches them (`findSession`): someone else's browser is never reported.
 * - **What page the first one is on**, from the session's debug listing,
 *   best-effort: a failure there still answers `running: true`.
 *
 * It never connects to the browser, never takes a picture, never touches the
 * idle timer (./idle.ts), and never returns a session id, a connect address or
 * a debugger link, which are bearer links to the browser.
 */

import { API, browserbaseConfigured, ownerSessionIds, OWNER_TAG, type BrowserbaseEnv } from "./browserbase";

export interface ViewStatus {
  running: boolean;
  url?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The first page's address from a session's debug listing, http(s) only, or null. */
async function pageUrl(env: BrowserbaseEnv, id: string, fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher(`${API}/sessions/${encodeURIComponent(id)}/debug`, {
    method: "GET",
    headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" },
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { pages?: Array<{ url?: unknown }> } | null;
  const url = Array.isArray(body?.pages) ? body.pages.find((page) => typeof page?.url === "string")?.url : undefined;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url.slice(0, 300) : null;
}

export async function viewStatus(env: BrowserbaseEnv, body: unknown, fetcher: typeof fetch = fetch): Promise<Response> {
  const owner = (body as { owner?: unknown })?.owner;
  if (typeof owner !== "string" || !OWNER_TAG.test(owner)) return json({ error: "an owner is required" }, 400);
  if (!browserbaseConfigured(env)) return json({ running: false } satisfies ViewStatus);
  const started = Date.now();
  const ids = await ownerSessionIds(env, owner, fetcher).catch(() => null);
  if (ids === null || ids.length === 0) return json({ running: false } satisfies ViewStatus);
  const url = await pageUrl(env, ids[0]!, fetcher).catch(() => null);
  // Timing only: never the address or the session.
  console.log(JSON.stringify({ event: "site_shots_view", action: "status", ms: Date.now() - started }));
  return json({ running: true, ...(url !== null ? { url } : {}) } satisfies ViewStatus);
}
