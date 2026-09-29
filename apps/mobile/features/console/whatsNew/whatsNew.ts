import { latestDevlogWeek, parseDevlog, type DevlogWeek } from "@context/shared";

/**
 * What's new: the newest week of the pinned site's devlog, drawn in the app.
 *
 * The page is the one copy (`docs/decisions/release-communication.md`); this
 * reads its published text from the same site snapshot the homepage draws,
 * through the same parser the Publish check uses, so the panel can never say
 * something the page does not.
 *
 * Only a week written in the four sections counts. Until the first one is
 * published there is no row at all, rather than a panel of old single lists.
 */

/** The site page the devlog is published at. */
export const DEVLOG_ROUTE = "/devlog";

/** A site snapshot page, as `websites.siteSnapshot` returns it. */
export interface SnapshotPage {
  path: string;
  routePath: string;
  markdown: string;
}

export type WhatsNewState =
  | { kind: "loading" }
  /** The site answered and has no four-section week yet: no row at all. */
  | { kind: "none" }
  | { kind: "ready"; week: DevlogWeek }
  /** The site did not answer; this device's last copy, and when it was saved. */
  | { kind: "offline"; week: DevlogWeek; savedAt: number }
  /** The site did not answer and there is no copy. */
  | { kind: "error" };

export function weekFromPages(pages: readonly SnapshotPage[] | null | undefined): DevlogWeek | null {
  const page = pages?.find((candidate) => candidate.routePath === DEVLOG_ROUTE);
  if (page === undefined) return null;
  return latestDevlogWeek(parseDevlog(page.markdown).filter((week) => week.sectioned));
}

/** The week the state shows, if any. */
export function shownWeek(state: WhatsNewState): DevlogWeek | null {
  return state.kind === "ready" || state.kind === "offline" ? state.week : null;
}

/** A dot: a week this person has not opened. Never while it is still loading. */
export function isUnread(state: WhatsNewState, seenWeek: number | null | undefined): boolean {
  const week = shownWeek(state);
  if (week === null || seenWeek === undefined) return false;
  return seenWeek === null || week.number > seenWeek;
}

/** How many shipped lines show before "N more". The Discord post shows five too. */
export const SHIPPED_SHOWN = 5;

export function shippedLines(week: DevlogWeek, expanded: boolean): { lines: string[]; more: number } {
  const all = week.sections.shipped;
  if (expanded || all.length <= SHIPPED_SHOWN) return { lines: all, more: 0 };
  return { lines: all.slice(0, SHIPPED_SHOWN), more: all.length - SHIPPED_SHOWN };
}

/** "sept 27", for the offline line. Lowercase, the page's own voice. */
export function savedOn(savedAt: number): string {
  const date = new Date(savedAt);
  const months = ["jan", "feb", "mar", "apr", "may", "june", "july", "aug", "sept", "oct", "nov", "dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/*
  The device's last copy, so a person offline still sees the week they last
  saw. Web only and best effort: storage can be full, blocked or absent, and
  none of that may break the menu. The week is public text from a public page.
*/
const CACHE_KEY = "context.whatsNew.v1";

interface Cached {
  week: DevlogWeek;
  savedAt: number;
}

export function readCachedWeek(storage: Pick<Storage, "getItem"> | null): Cached | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cached>;
    if (typeof parsed.savedAt !== "number" || typeof parsed.week?.number !== "number") return null;
    return parsed as Cached;
  } catch {
    return null;
  }
}

export function writeCachedWeek(storage: Pick<Storage, "setItem"> | null, week: DevlogWeek, now: number): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ week, savedAt: now } satisfies Cached));
  } catch {
    // A full or blocked store only costs the offline copy.
  }
}

export function deviceStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
