/**
 * The website answers this tab already has, so moving between a site's pages
 * draws the next one at once instead of waiting on the network.
 *
 * Without this every click asked from scratch: the router asks Convex for the
 * site's revision before it can look for its copy, and a signed-in visitor's
 * page is resolved from the bucket each time, so a click cost one or two round
 * trips and drew a blank page meanwhile. Static hosts feel instant because a
 * browser keeps what it fetched and the next page is one small file away.
 *
 * So, per tab:
 * - an answer, once fetched, is kept and drawn straight away when its address
 *   is opened again, and asked for again behind it once it is older than
 *   `FRESH_MS`;
 * - every page the open page links to, its menu and the links in its words,
 *   is fetched as soon as it lands, so even the first click on one is
 *   already answered (a designed site's own links are fetched where they
 *   are drawn, `DesignedSite.web.tsx`);
 * - a page not fetched yet keeps the last page of the same site on screen
 *   until its answer lands, as a browser does, rather than a blank.
 *
 * Nothing here widens who sees what. Every answer was given to this visitor,
 * as they are signed in now (the key carries it), and a move of the site's
 * revision (a Publish or a restriction) drops every answer kept for it.
 */

import { SHARE_ROUTE, type ResolvedWebsiteAddress } from "@context/shared";
import { parseNote } from "../share/markdown";

export interface SiteAsk {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

export type AskAddress = (ask: SiteAsk) => Promise<ResolvedWebsiteAddress>;

/** Past this, a kept answer is still drawn, and asked for again behind it. */
export const FRESH_MS = 30_000;
/**
 * How many linked pages one landing fetches ahead. Only pages the open page
 * names: a visitor can already see those, so nothing is enumerated that the
 * site did not show them.
 */
export const PREFETCH_LIMIT = 24;
const MAX_ENTRIES = 200;

interface Entry {
  at: number;
  view: ResolvedWebsiteAddress;
}

const kept = new Map<string, Entry>();
const pending = new Map<string, Promise<ResolvedWebsiteAddress>>();
const revisions = new Map<string, string | null>();
const lastShown = new Map<string, ResolvedWebsiteAddress>();
/** Bumped by every drop, so an answer asked before one is never kept after it. */
let generation = 0;
let lastSignedIn: boolean | undefined;
/**
 * Whether the sign-in state has been watched without a gap since the answers
 * below were fetched. `noteSignedIn` is called only while a site page is
 * mounted, so "signing in or out always passes through signed out" is true of
 * the auth state and **not** of the observed one: a visitor who leaves the
 * site, signs out, signs in as somebody else and comes back is signed in both
 * times it is asked, and the signed-out moment between them was never seen.
 *
 * A signed-in answer kept across such a gap is therefore not known to be this
 * account's, and is dropped rather than drawn. A signed-out answer is nobody's
 * in particular — the server resolves it the same way for every visitor — so
 * it survives the gap, which is the case this cache exists for.
 */
let watched = false;

export function answerKey(ask: SiteAsk, signedIn: boolean): string {
  return JSON.stringify([ask.handle, ask.routePath, ask.legacySlug ?? null, signedIn]);
}

function siteKey(handle: string, signedIn: boolean): string {
  return JSON.stringify([handle, signedIn]);
}

/** The answer kept for an address, and whether it is still fresh. */
export function keptAnswer(
  ask: SiteAsk,
  signedIn: boolean,
  now: number = Date.now(),
): { view: ResolvedWebsiteAddress; fresh: boolean } | undefined {
  const entry = kept.get(answerKey(ask, signedIn));
  return entry === undefined ? undefined : { view: entry.view, fresh: now - entry.at < FRESH_MS };
}

/** The page last drawn for this site, to hold on screen while the next loads. */
export function heldAnswer(handle: string, signedIn: boolean): ResolvedWebsiteAddress | undefined {
  return lastShown.get(siteKey(handle, signedIn));
}

export function noteShown(ask: SiteAsk, signedIn: boolean, view: ResolvedWebsiteAddress): void {
  lastShown.set(siteKey(ask.handle, signedIn), view);
}

/**
 * Record the site's revision as Convex reports it. A move drops everything
 * kept for the site and says so (`true`); the first sighting in this tab
 * drops nothing, since answers fetched before it were fetched just now.
 */
export function noteRevision(handle: string, revision: string | null): boolean {
  const known = revisions.has(handle);
  const before = revisions.get(handle);
  revisions.set(handle, revision);
  if (!known || before === revision) return false;
  dropSite(handle);
  return true;
}

function dropSite(handle: string): void {
  generation += 1;
  for (const key of [...kept.keys()]) {
    if ((JSON.parse(key) as unknown[])[0] === handle) kept.delete(key);
  }
  for (const key of [...pending.keys()]) {
    if ((JSON.parse(key) as unknown[])[0] === handle) pending.delete(key);
  }
}

/**
 * Ask for an address once, however many callers want it at the same moment,
 * and keep what comes back. A failure is not kept: the next visit asks again.
 */
export function loadAnswer(
  ask: SiteAsk,
  signedIn: boolean,
  askAddress: AskAddress,
  now: () => number = Date.now,
): Promise<ResolvedWebsiteAddress> {
  const key = answerKey(ask, signedIn);
  const inFlight = pending.get(key);
  if (inFlight !== undefined) return inFlight;
  const asked = generation;
  const request = askAddress(ask).then(
    (view) => {
      if (pending.get(key) === request) pending.delete(key);
      if (asked === generation) {
        kept.delete(key);
        kept.set(key, { at: now(), view });
        while (kept.size > MAX_ENTRIES) kept.delete(kept.keys().next().value!);
      }
      return view;
    },
    (error: unknown) => {
      if (pending.get(key) === request) pending.delete(key);
      throw error;
    },
  );
  pending.set(key, request);
  return request;
}

/**
 * The site pages a page's words link to, as a click on each would ask for
 * them: rooted links only (the rest leave the site), without their `#part`,
 * and never an unlisted share (`/s/…`), which is a different app.
 */
export function bodyLinks(markdown: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if ((node.kind === "link" || node.kind === "button") && typeof node.href === "string") {
      const path = node.href.split("#")[0]!;
      if (path.startsWith("/") && !path.startsWith("//") && path !== SHARE_ROUTE && !path.startsWith(`${SHARE_ROUTE}/`)) {
        try {
          found.push(decodeURIComponent(path));
        } catch {
          // A malformed escape names no page.
        }
      }
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseNote(markdown).blocks);
  return found;
}

/**
 * The pages a landed answer links to, its menu first and then its words,
 * fetched ahead unless already kept. `askFor` builds each one's ask exactly as a click on it would, so the
 * answer is kept under the key the click looks for.
 */
export function prefetchLinked(
  from: SiteAsk,
  view: ResolvedWebsiteAddress,
  askFor: (routePath: string) => SiteAsk,
  signedIn: boolean,
  askAddress: AskAddress,
  now: () => number = Date.now,
): void {
  if (view.kind === "legacy_short_link") return;
  const paths = [
    ...view.navigation.map((item) => item.routePath),
    ...(view.kind === "page" ? bodyLinks(view.markdown) : []),
  ]
    .filter((path, index, all) => path !== from.routePath && all.indexOf(path) === index)
    .slice(0, PREFETCH_LIMIT);
  for (const routePath of paths) prefetchPage(askFor(routePath), signedIn, askAddress, now);
}

/**
 * One page fetched ahead, for a link the visitor is about to follow. A page
 * kept at all is not fetched again: it draws at once either way, and opening
 * it asks behind it once it is stale, so fetching ahead costs each page once
 * per tab rather than once per landing.
 */
export function prefetchPage(
  ask: SiteAsk,
  signedIn: boolean,
  askAddress: AskAddress,
  now: () => number = Date.now,
): void {
  if (keptAnswer(ask, signedIn, now()) !== undefined) return;
  loadAnswer(ask, signedIn, askAddress, now).catch(() => undefined);
}

/**
 * Record who is asking. Signing in or out drops everything this tab kept, so
 * one account's members-only answers are never drawn for the next account to
 * sign in here, which always passes through signed out.
 */
export function noteSignedIn(signedIn: boolean): void {
  if (lastSignedIn !== undefined && lastSignedIn !== signedIn) {
    kept.clear();
    pending.clear();
    lastShown.clear();
    generation += 1;
  } else if (signedIn && !watched) {
    // Watching stopped and the visitor is signed in again: possibly as
    // somebody else (see `watched`), so the last account's answers go.
    dropSignedIn();
  }
  lastSignedIn = signedIn;
  watched = true;
}

/**
 * No site page is mounted any more, so the sign-in state stops being watched.
 * Called from the cleanup of `useWebsiteAddress`'s mount effect.
 */
export function noteSiteClosed(): void {
  watched = false;
}

/** Every answer given to a signed-in visitor, whoever they were. */
function dropSignedIn(): void {
  generation += 1;
  // `answerKey` is [handle, routePath, legacySlug, signedIn]; `siteKey` is
  // [handle, signedIn].
  for (const key of [...kept.keys()]) if ((JSON.parse(key) as unknown[])[3] === true) kept.delete(key);
  for (const key of [...pending.keys()]) if ((JSON.parse(key) as unknown[])[3] === true) pending.delete(key);
  for (const key of [...lastShown.keys()]) if ((JSON.parse(key) as unknown[])[1] === true) lastShown.delete(key);
}

/** Tests only: forget everything this tab kept. */
export function resetSiteAnswers(): void {
  kept.clear();
  pending.clear();
  revisions.clear();
  lastShown.clear();
  lastSignedIn = undefined;
  watched = false;
  generation += 1;
}
