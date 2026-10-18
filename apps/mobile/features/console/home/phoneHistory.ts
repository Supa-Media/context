import { useEffect, useState } from "react";

/**
 * THE PAGES A PHONE HAS SHOWN, SO ‹ CAN GO BACK TO THE LAST ONE.
 *
 * Dev2 (2026-10-18): *"when I click the back button it should take me to the
 * previous page, regardless of how nested the note i clicked was"*. Notes now
 * lists hand-written notes from every folder, so a note three folders deep is
 * one press from the first page, and ‹ going *up* from it (to its folder,
 * then the folder above) was a walk through pages the person never opened.
 * ‹ goes back to the page before this one; only a page with nothing before it
 * (the app opened straight onto a note by its link) falls back to going up a
 * level (`phoneBackLevels`).
 *
 * The keys are the page keys `PageSlide` already slides between: a path, `""`
 * for Notes and `FOLDERS_PAGE` for Folders. A module value like `homeView.ts`,
 * because the page that records a visit (`BrowsePane`) and the button that
 * reads it (`consoleAccountSlot`) are far apart.
 */

const MAX_PAGES = 50;

let pages: string[] = [];
let scope: string | null = null;
/** The next visit takes the current page's place rather than going on top (`leavePage`). */
let replacing = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * The page now showing is `key`. Arriving at the page before the current one
 * is going back, so the current one is dropped; anything else is a new page on
 * top. A new workspace starts a new history: the old one's paths mean nothing
 * here.
 */
export function visitPage(key: string, workspace: string | null): void {
  if (workspace !== scope) {
    scope = workspace;
    pages = [];
  }
  const count = pages.length;
  if (pages[count - 1] === key) return;
  if (replacing) {
    replacing = false;
    pages = [...pages.slice(0, -1), key];
  } else if (pages[count - 2] === key) pages = pages.slice(0, -1);
  else pages = [...pages, key].slice(-MAX_PAGES);
  notify();
}

/** The page before the one showing, or `null` when there is none. */
export function previousPage(): string | null {
  return pages.length >= 2 ? pages[pages.length - 2]! : null;
}

/**
 * ‹ is about to go somewhere other than the page before: up a level from a
 * page with nothing before it, or straight to Notes. Up from the first page
 * takes its place, or the next ‹ would come back down to it; Notes starts the
 * history again, as the page everything else is opened from.
 */
export function leavePage(toNotes: boolean): void {
  if (toNotes) pages = [];
  else replacing = pages.length > 0;
}

/** Forget every page: a new console, or a test. */
export function resetPhoneHistory(): void {
  pages = [];
  scope = null;
  replacing = false;
  notify();
}

/**
 * Record `key` whenever it changes; `null` records nothing (a pointer layout,
 * the map). The history is the mounted page's: it starts empty and is
 * forgotten when the page goes, so one console never inherits another's.
 */
export function usePhoneHistory(key: string | null, workspace: string | null): void {
  useEffect(() => {
    resetPhoneHistory();
    return resetPhoneHistory;
  }, []);
  useEffect(() => {
    if (key !== null) visitPage(key, workspace);
  }, [key, workspace]);
}

/** `previousPage()`, re-read whenever the history moves. */
export function usePreviousPage(): string | null {
  const [previous, setPrevious] = useState(previousPage);
  useEffect(() => {
    const listener = () => setPrevious(previousPage());
    listener();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return previous;
}
