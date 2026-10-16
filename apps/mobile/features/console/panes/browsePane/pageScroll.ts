import { useRef } from "react";
import { slideDirection } from "../../home/phoneBack";

/**
 * Where each phone page was scrolled to, so going back lands where it was
 * left — and going forward always starts at the top.
 *
 * In memory only, per page path, for the session: the same thing Apple Notes
 * does between a folder and a note.
 */
const offsets = new Map<string, number>();

/** Pages remembered, at most; the oldest is forgotten first. */
const MAX_PAGES = 200;

export function rememberScroll(page: string, y: number): void {
  offsets.delete(page);
  offsets.set(page, Math.max(0, y));
  if (offsets.size > MAX_PAGES) offsets.delete(offsets.keys().next().value as string);
}

/** Where a page opens: where it was left when going back up to it, else the top. */
export function scrollFor(from: string | null, to: string): number {
  if (from === null || slideDirection(from, to) !== "back") return 0;
  return offsets.get(to) ?? 0;
}

/** `scrollFor`, decided once per page change, so a re-render never moves a page under somebody's thumb. */
export function usePageScroll(page: string): number {
  const last = useRef<{ page: string; y: number } | null>(null);
  if (last.current === null || last.current.page !== page) {
    last.current = { page, y: scrollFor(last.current?.page ?? null, page) };
  }
  return last.current.y;
}
