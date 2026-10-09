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
 * - the pages the site's menu names are fetched as soon as a page lands, so
 *   the first click on them is already answered;
 * - a page not fetched yet keeps the last page of the same site on screen
 *   until its answer lands, as a browser does, rather than a blank.
 *
 * Nothing here widens who sees what. Every answer was given to this visitor,
 * as they are signed in now (the key carries it), and a move of the site's
 * revision (a Publish or a restriction) drops every answer kept for it.
 */

import type { ResolvedWebsiteAddress } from "@context/shared";

export interface SiteAsk {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

export type AskAddress = (ask: SiteAsk) => Promise<ResolvedWebsiteAddress>;

/** Past this, a kept answer is still drawn, and asked for again behind it. */
export const FRESH_MS = 30_000;
/** How many of a menu's pages one landing fetches ahead. */
export const PREFETCH_LIMIT = 8;
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
 * The menu pages a landed answer names, fetched ahead unless already kept. `askFor` builds each one's ask exactly as a click on it would, so the
 * answer is kept under the key the click looks for.
 */
export function prefetchMenu(
  from: SiteAsk,
  view: ResolvedWebsiteAddress,
  askFor: (routePath: string) => SiteAsk,
  signedIn: boolean,
  askAddress: AskAddress,
  now: () => number = Date.now,
): void {
  if (view.kind === "legacy_short_link") return;
  const paths = view.navigation
    .map((item) => item.routePath)
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
  }
  lastSignedIn = signedIn;
}

/** Tests only: forget everything this tab kept. */
export function resetSiteAnswers(): void {
  kept.clear();
  pending.clear();
  revisions.clear();
  lastShown.clear();
  lastSignedIn = undefined;
  generation += 1;
}
