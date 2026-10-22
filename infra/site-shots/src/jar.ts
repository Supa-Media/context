/**
 * The person's sign-ins, carried from one Browserbase browser to the next.
 *
 * Tex's browser keeps nothing at Browserbase (no Contexts, ./browserbase.ts),
 * so each new one started signed out. Decided by the owner, 2026-10-20: the
 * sign-ins are kept sealed in the person's own vault instead
 * (`docs/decisions/texting-assistant/vault.md`). This Worker only moves them:
 * the gateway hands a jar in with a question, a new browser is given its
 * cookies and, as each page opens, that site's own saved storage; after the
 * steps the jar is read back out for the gateway to seal. Nothing here keeps
 * a jar, logs one, or puts one where a model or a page of another site reads.
 */

import type { AttachedPage, CdpTransport } from "./cdp";
import { idbRestoreSource, OWN_IDB_SOURCE, parseDatabases, type IdbDatabase } from "./jarIdb";

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Seconds since the epoch; absent for a cookie that lasts the browser's life. */
  expires?: number;
}

export interface Jar {
  cookies: JarCookie[];
  /** One https origin's localStorage, as it was when last read. */
  storage: Record<string, Record<string, string>>;
  /** One https origin's IndexedDB databases, as they were when last read (./jarIdb.ts). */
  idb?: Record<string, IdbDatabase[]>;
}

export const MAX_COOKIES = 1_000;
const MAX_COOKIE_VALUE = 4_096;
export const MAX_ORIGINS = 100;
const MAX_KEYS = 200;
const MAX_ITEM_CHARS = 64 * 1024;
/** The most one origin's saved storage may come to; more is not kept. */
export const MAX_ORIGIN_CHARS = 256 * 1024;
const ORIGIN = /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const SAME_SITE = new Set(["Strict", "Lax", "None"]);

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

function cookieOf(raw: unknown): JarCookie | null {
  const c = raw as Record<string, unknown>;
  if (!c || !isText(c.name, 256) || !isText(c.value, MAX_COOKIE_VALUE) || !isText(c.domain, 253) || !isText(c.path, 1_024)) return null;
  if (c.name.length === 0 || c.domain.length === 0) return null;
  // A partitioned cookie belongs to one embedding site; it is left to that browser.
  if (c.partitionKey !== undefined && c.partitionKey !== null) return null;
  const cookie: JarCookie = { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", secure: c.secure === true, httpOnly: c.httpOnly === true };
  if (typeof c.sameSite === "string" && SAME_SITE.has(c.sameSite)) cookie.sameSite = c.sameSite as JarCookie["sameSite"];
  // CDP says -1 (and `session: true`) for a cookie with no end.
  if (typeof c.expires === "number" && Number.isFinite(c.expires) && c.expires > 0 && c.session !== true) cookie.expires = c.expires;
  return cookie;
}

function itemsOf(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const items: Record<string, string> = {};
  let chars = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (!isText(value, MAX_ITEM_CHARS) || key.length === 0 || key.length > 1_024) continue;
    chars += key.length + value.length;
    if (chars > MAX_ORIGIN_CHARS) return null;
    items[key] = value;
  }
  return items;
}

/** A jar as sent, or null when it is not one. Anything malformed in it is dropped, never guessed at. */
export function parseJar(raw: unknown): Jar | null {
  const j = raw as { cookies?: unknown; storage?: unknown; idb?: unknown };
  if (!j || typeof j !== "object" || !Array.isArray(j.cookies)) return null;
  const cookies = j.cookies.slice(0, MAX_COOKIES).map(cookieOf).filter((c): c is JarCookie => c !== null);
  const storage: Jar["storage"] = {};
  if (j.storage && typeof j.storage === "object" && !Array.isArray(j.storage)) {
    for (const [origin, raw] of Object.entries(j.storage as Record<string, unknown>).slice(0, MAX_ORIGINS)) {
      const items = ORIGIN.test(origin) ? itemsOf(raw) : null;
      if (items !== null) storage[origin] = items;
    }
  }
  const idb: NonNullable<Jar["idb"]> = {};
  if (j.idb && typeof j.idb === "object" && !Array.isArray(j.idb)) {
    for (const [origin, raw] of Object.entries(j.idb as Record<string, unknown>).slice(0, MAX_ORIGINS)) {
      const dbs = ORIGIN.test(origin) ? parseDatabases(raw) : null;
      if (dbs !== null) idb[origin] = dbs;
    }
  }
  return { cookies, storage, ...(Object.keys(idb).length > 0 ? { idb } : {}) };
}

/** Give a new browser the jar's cookies. Browser-wide, so on no page's session. */
export async function restoreCookies(cdp: CdpTransport, jar: Jar): Promise<void> {
  if (jar.cookies.length === 0) return;
  await cdp.send("Storage.setCookies", { cookies: jar.cookies });
}

/**
 * Page code that, as a page of a saved origin opens, puts back that origin's
 * saved storage where it is missing (a sign-in kept in localStorage, as many
 * apps keep theirs). It runs in a world of its own, which shares the page's
 * storage but not its scripts, so no site's code reads the jar it carries,
 * and it writes only the origin the page is on.
 */
export function storageSource(storage: Jar["storage"]): string {
  return `(() => {
  const saved = ${JSON.stringify(storage)};
  let origin;
  try { origin = location.origin; } catch { return; }
  const items = Object.prototype.hasOwnProperty.call(saved, origin) ? saved[origin] : null;
  if (!items) return;
  try {
    for (const key of Object.keys(items)) if (localStorage.getItem(key) === null) localStorage.setItem(key, items[key]);
  } catch {}
})()`;
}

export const STORAGE_WORLD = "tex-signins";

/** Put back each saved origin's storage as its pages open, for as long as this connection lasts. */
export async function restoreStorage(page: AttachedPage, jar: Jar): Promise<void> {
  const idb = jar.idb ?? {};
  if (Object.keys(jar.storage).length === 0 && Object.keys(idb).length === 0) return;
  await page.send("Page.enable");
  if (Object.keys(jar.storage).length > 0) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: storageSource(jar.storage), worldName: STORAGE_WORLD });
  }
  if (Object.keys(idb).length > 0) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: idbRestoreSource(idb), worldName: STORAGE_WORLD });
  }
}

/** What the page's own origin keeps in localStorage, when it is an https one. */
export const OWN_STORAGE_SOURCE = `(() => {
  try {
    if (location.protocol !== "https:") return null;
    const items = {};
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); items[key] = localStorage.getItem(key); }
    return { origin: location.origin, items };
  } catch { return null; }
})()`;

export const READ_WORLD = "tex-signins-read";

/**
 * Run page code in a fresh isolated world of the page's main frame. The jar is
 * read there, not in the page's own world, because a page's scripts can
 * replace `Promise` or `JSON` and answer with any origin they like; an
 * isolated world shares the page's storage but none of its scripts.
 */
async function evaluateApart<T>(page: AttachedPage, source: string): Promise<T> {
  const tree = await page.send<{ frameTree?: { frame?: { id?: unknown } } }>("Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== "string") throw new Error("no main frame");
  const world = await page.send<{ executionContextId?: unknown }>("Page.createIsolatedWorld", { frameId, worldName: READ_WORLD });
  if (typeof world?.executionContextId !== "number") throw new Error("no isolated world");
  const result = await page.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression: source,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("the read threw");
  return result.result?.value as T;
}

/**
 * Read the jar back out: every cookie the browser holds, and the storage and
 * IndexedDB of the origin it is on (an empty one included, so a sign-out is
 * kept too). IndexedDB that could not be read is left out, not read as empty.
 */
export async function captureJar(cdp: CdpTransport, page: AttachedPage): Promise<Jar> {
  const got = await cdp.send<{ cookies?: unknown[] }>("Storage.getCookies");
  const cookies = (Array.isArray(got?.cookies) ? got.cookies : []).slice(0, MAX_COOKIES).map(cookieOf).filter((c): c is JarCookie => c !== null);
  const storage: Jar["storage"] = {};
  const own = await evaluateApart<{ origin?: unknown; items?: unknown } | null>(page, OWN_STORAGE_SOURCE).catch(() => null);
  if (own && typeof own.origin === "string" && ORIGIN.test(own.origin)) {
    const items = itemsOf(own.items);
    if (items !== null) storage[own.origin] = items;
  }
  const idb: NonNullable<Jar["idb"]> = {};
  const ownIdb = await evaluateApart<{ origin?: unknown; dbs?: unknown } | null>(page, OWN_IDB_SOURCE).catch(() => null);
  if (ownIdb && typeof ownIdb.origin === "string" && ORIGIN.test(ownIdb.origin)) {
    const dbs = parseDatabases(ownIdb.dbs);
    if (dbs !== null) idb[ownIdb.origin] = dbs;
  }
  return { cookies, storage, ...(Object.keys(idb).length > 0 ? { idb } : {}) };
}
