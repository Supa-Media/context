import { splitWebsiteCast } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { parseHomeSnapshot, type HomeSnapshot } from "./homeSnapshot";

/**
 * "Preview demo": an owner's page, as the homepage would play it, before it
 * is published.
 *
 * The console cannot play a cast in its own editor: that editor is bound to
 * the real note, and a cast types into whatever it is bound to, so the show
 * would be saved into the owner's bucket. So the draft is handed to the
 * homepage instead, in a new tab, where it is the only page and the homepage's
 * own player types into a copy that lives in that tab. One player, one shell:
 * what the preview shows is what visitors get once the page is published.
 *
 * The handoff is this browser's storage under a one-time key named in the
 * address (`/?cast-preview=<key>`). The homepage reads it once and deletes it,
 * so a reload or a shared link is the real site again, and nothing about the
 * draft reaches a server or another person.
 */

export const CAST_PREVIEW_PARAM = "cast-preview";
const KEY_PREFIX = "context-cast-preview:";
/** A handoff older than this is a tab that never opened; it is ignored. */
const MAX_AGE_MS = 10 * 60 * 1000;

let lastStashed: string | null = null;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Whether a note has a cast block worth previewing. */
export function hasCast(source: string): boolean {
  // Cheap first: this runs as the owner types.
  if (!/^ {0,3}`{3,}\s*cast\s*$/im.test(source)) return false;
  return splitWebsiteCast(stripFrontmatter(source)).steps.length > 0;
}

/** The draft as a one-page site whose front page it is. */
export function castPreviewSnapshot(source: string, title: string, siteName: string): HomeSnapshot {
  return {
    siteName,
    revision: null,
    pages: [{ path: "index.md", routePath: "/", title, markdown: stripFrontmatter(source) }],
    emoji: {},
  };
}

/** Leave the snapshot for the new tab; the key it is under, or `null`. */
export function stashCastPreview(
  store: Store | undefined,
  snapshot: HomeSnapshot,
  now: number = Date.now(),
  nonce: string = randomNonce(),
): string | null {
  if (store === undefined) return null;
  try {
    // A tab that never opened (a blocked popup) leaves its draft behind; the
    // next press clears it, so at most one draft sits in storage.
    if (lastStashed !== null) store.removeItem(KEY_PREFIX + lastStashed);
    store.setItem(KEY_PREFIX + nonce, JSON.stringify({ at: now, snapshot }));
    lastStashed = nonce;
    return nonce;
  } catch {
    // Storage full or blocked: there is no preview, and nothing else breaks.
    return null;
  }
}

/** The address that plays it. */
export function castPreviewHref(nonce: string): string {
  return `/?${CAST_PREVIEW_PARAM}=${encodeURIComponent(nonce)}`;
}

/**
 * The snapshot this address was opened for, taken (read and deleted), or
 * `null` for an ordinary visit, an unknown key, or a stale one.
 */
export function takeCastPreview(
  store: Store | undefined,
  search: string | undefined,
  now: number = Date.now(),
): HomeSnapshot | null {
  if (store === undefined || search === undefined) return null;
  const nonce = new URLSearchParams(search).get(CAST_PREVIEW_PARAM);
  if (nonce === null || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return null;
  try {
    const text = store.getItem(KEY_PREFIX + nonce);
    store.removeItem(KEY_PREFIX + nonce);
    if (text === null) return null;
    const body = JSON.parse(text) as { at?: unknown; snapshot?: unknown };
    if (typeof body.at !== "number" || now - body.at > MAX_AGE_MS || body.at > now + 60_000) return null;
    return parseHomeSnapshot(body.snapshot);
  } catch {
    return null;
  }
}

/** This browser's storage, where there is one and it may be touched. */
export function browserStorage(): Store | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
