/**
 * READ A PAGE ONCE IT HAS LOADED (the owner, 2026-11-16: "We should just make
 * sure that we are reading a sufficient amount, especially for old websites.
 * Might need to wait, even minutes sometimes... it's not about speed for
 * jobs"). A job on an old ASP.NET vendor portal read "(no text)" and nothing
 * to press on a page whose menus were all there when it was read again later,
 * and wandered the menus for it: the steps had waited only for the network to
 * go quiet for 400 ms, at most 3 seconds (./browse.ts `settle`).
 *
 * So the reading a call hands back is taken once the page has something on
 * it: a page that reads blank (no words and nothing to press, its frames
 * included) is read again about once a second until it fills or the call's
 * wait runs out, and a page with words that the browser still calls loading
 * is given a little longer to finish. How long is the gateway's to say,
 * `waitMs` on the request (`packages/tex/gateway/agent/browse.js`): a background job
 * waits long, a chat turn briefly, and a page still blank after it says so
 * (`loading`) rather than reading as empty.
 *
 * A `wait` step (at most `MAX_WAIT_STEP_SECONDS`) is a job's own longer wait
 * on a slow site, taken from the same allowance, so one call's waiting never
 * outgrows what the gateway gave it.
 */

import type { BrowsePage, Reading } from "./browse";
import { snapshot } from "./reading";

/** A chat turn's wait for a blank page, and what a request that names none gets. */
export const CHAT_CONTENT_WAIT_MS = 8_000;
/** The most any call waits for a page, well inside the gateway's 160 s for one browse call. */
export const MAX_CONTENT_WAIT_MS = 90_000;
/** The longest one wait step may ask for. */
export const MAX_WAIT_STEP_SECONDS = 60;
/** How often a blank page is read again. */
export const POLL_MS = 1_000;
/** A page with words on it that the browser still calls loading gets at most this long to finish. */
export const LOADING_GRACE_MS = 10_000;
/**
 * Whether the browser has finished loading the document, and whether the page
 * is drawn rather than written: a file shown whole (a PDF's viewer), a canvas
 * app, an embedded object. Those have no words to wait for.
 */
export const LOAD_STATE_SOURCE = `({
  state: document.readyState,
  drawn: !/html|xml/i.test(document.contentType || "text/html") || !!document.querySelector("canvas, embed, object, flt-glass-pane"),
})`;

/** How long this call may wait for a page, from the request's `waitMs`. */
export function contentWaitOf(body: unknown): number {
  const asked = (body as { waitMs?: unknown } | null)?.waitMs;
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked < 0) return CHAT_CONTENT_WAIT_MS;
  return Math.min(Math.round(asked), MAX_CONTENT_WAIT_MS);
}

/** A wait step's seconds, whole, or null when they are not 1 to the most. */
export function waitSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const seconds = Math.floor(value);
  return seconds >= 1 && seconds <= MAX_WAIT_STEP_SECONDS ? seconds : null;
}

/** For a run's log line: how long it waited for a page, and whether one stayed blank. Seconds only, never the page. */
export function waitLog(reading: Pick<Reading, "waited" | "loading">): { waited?: number; loading?: number } {
  return {
    ...(typeof reading.waited === "number" ? { waited: reading.waited } : {}),
    ...(typeof reading.loading === "number" ? { loading: reading.loading } : {}),
  };
}

/** Nothing to read and nothing to press, frames included. */
export const isBlank = (reading: Pick<Reading, "text" | "elements">) => reading.text.trim() === "" && reading.elements.length === 0;

interface Clock {
  now: () => number;
  pause: (ms: number) => Promise<unknown>;
}

/**
 * The page's reading, once it has loaded or `limitMs` has passed. Says
 * `waited` (seconds) when it waited and the page filled, `loading` (seconds)
 * when it is still blank after the wait, and `drawn` when it has no words
 * because it is a picture, a canvas or a file (a PDF), which no wait fills.
 */
export async function readWhenLoaded(page: BrowsePage, limitMs: number, { now, pause }: Clock): Promise<Reading> {
  const started = now();
  let reading = await snapshot(page);
  // Before any page is opened there is nothing to wait for.
  if (limitMs <= 0 || !/^https?:/i.test(reading.url)) return reading;
  for (;;) {
    const blank = isBlank(reading);
    const probe = await page.evaluate<{ state?: unknown; drawn?: unknown } | null>(LOAD_STATE_SOURCE).catch(() => null);
    if (blank && probe?.drawn === true) return { ...reading, drawn: true };
    // "interactive" is the whole document read in, with only pictures and the like still coming: words that are there are read.
    const ready = probe?.state !== "loading";
    if (!blank && ready) break;
    const spent = now() - started;
    const most = blank ? limitMs : Math.min(limitMs, LOADING_GRACE_MS);
    if (spent >= most) break;
    await pause(Math.min(POLL_MS, most - spent));
    reading = await snapshot(page);
  }
  const seconds = Math.round((now() - started) / 1_000);
  if (isBlank(reading)) return { ...reading, loading: seconds };
  return seconds > 0 ? { ...reading, waited: seconds } : reading;
}
