/**
 * Where somebody is in the staff console, as an address.
 *
 * The tabs and the views inside them were component state, so a refresh put
 * everybody back on Growth and the browser's Back button left the console
 * instead of returning to the tab before (the owner, 2026-10-08: "the sub tabs
 * do not update the url so refreshing and clicking the back button doesnt
 * work"). Every place now has a path:
 *
 *   /admin/growth                      the default; bare `/admin` lands here
 *   /admin/estate · /activity · /credentials
 *   /admin/agent[/<turn id>]           one answer opened, step by step
 *   /admin/ai-costs[/<account id>]     one account's drawer
 *   /admin/search[/indexes|/speed]     bare = indexes
 *   /admin/waitlist[/waiting|/let-in|/removed|/friends]   bare = waiting
 *   /admin/people
 *
 * plus `?days=` for the window Growth, Activity and AI costs read over, which
 * is a filter rather than a place: changing it replaces the address instead
 * of adding a Back step.
 *
 * A place's `sub` is the segment after the tab, already checked against what
 * that tab accepts — so a section never sees a view it does not have, and an
 * address that names one is not a place at all (the route sends it to the
 * tab's own default rather than drawing a half-chosen tab).
 */

import { DEFAULT_WINDOW, WINDOW_CHOICES, isAdminTab, type AdminTab } from "./report";

export type AdminPlace = {
  tab: AdminTab;
  /** The view or the opened record inside the tab; `null` for the tab's default. */
  sub: string | null;
};

export const DEFAULT_PLACE: AdminPlace = { tab: "growth", sub: null };

/** The tab's segment. The key stays `aiCosts` in code; the address reads like one. */
const SLUGS: Partial<Record<AdminTab, string>> = { aiCosts: "ai-costs" };

/** Views a tab names with a fixed word. Tabs absent here take an id, or nothing. */
export const SEARCH_PLACES = ["indexes", "speed"] as const;
export const WAITLIST_PLACES = ["waiting", "let-in", "removed", "friends"] as const;

const FIXED: Partial<Record<AdminTab, readonly string[]>> = {
  search: SEARCH_PLACES,
  waitlist: WAITLIST_PLACES,
};

/** Tabs whose second segment is a record's id (an answer, an account). */
const BY_ID: ReadonlySet<AdminTab> = new Set<AdminTab>(["agent", "aiCosts"]);

/** Convex ids and turn ids are letters, digits, `_` and `-`; nothing else is let through. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function tabFromSlug(slug: string): AdminTab | null {
  const renamed = Object.entries(SLUGS).find(([, value]) => value === slug);
  if (renamed) return renamed[0] as AdminTab;
  // The code key is not an address: `/admin/aiCosts` is not a second spelling.
  return isAdminTab(slug) && SLUGS[slug] === undefined ? slug : null;
}

export function tabSlug(tab: AdminTab): string {
  return SLUGS[tab] ?? tab;
}

/**
 * The place a path names, from the segments after `/admin`. `null` when they
 * name nothing — an unknown tab, a view the tab does not have, or a segment
 * too many.
 */
export function parseAdminPlace(segments: readonly string[]): AdminPlace | null {
  if (segments.length === 0) return DEFAULT_PLACE;
  if (segments.length > 2) return null;
  const tab = tabFromSlug(segments[0]!);
  if (tab === null) return null;
  const sub = segments[1];
  if (sub === undefined || sub === "") return { tab, sub: null };
  const fixed = FIXED[tab];
  if (fixed) return fixed.includes(sub) ? { tab, sub } : null;
  if (BY_ID.has(tab)) return ID.test(sub) ? { tab, sub } : null;
  return null;
}

/** The path for a place: the inverse of `parseAdminPlace`. */
export function adminPath(place: AdminPlace): string {
  const base = `/admin/${tabSlug(place.tab)}`;
  return place.sub === null ? base : `${base}/${encodeURIComponent(place.sub)}`;
}

/** The window an address asks for, or the default for one that names none or nonsense. */
export function parseWindow(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const days = Number(raw);
  return (WINDOW_CHOICES as readonly number[]).includes(days) ? days : DEFAULT_WINDOW;
}

/** The route's `section` param, which expo-router hands over as an array or a string. */
export function sectionSegments(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value.split("/").filter((part) => part !== "");
}
