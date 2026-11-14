import type { ComponentType } from "react";

/**
 * One page of the staff console: the artifact's `P.<page>` and `P.<page>.props`, plus the data
 * behind them. The shell (`StaffConsole.web.tsx`) draws the chrome, calls `useData` for the page
 * that is open, and puts `render`'s HTML in the page slot and `props`'s in the side panel.
 *
 * A click on anything with `data-act="<name>"` calls `acts[name]` with that element, then the
 * shell's own acts (`go`, `sel`, `close`, `cancel`, `pn`, `lg`, `win`, `theme`, `side`, `undo`, `q`).
 * A `<select data-act>` calls it on change. An `<input data-act="q">` is the page's search box: the
 * shell debounces it into `S.q` and keeps the caret where it was.
 */
export type ConsolePage<D = unknown> = {
  key: string;
  /** The URL filters this page owns, and their defaults (the artifact's FDEF and FPAGE). */
  filters?: Record<string, string>;
  /** Whether the time window (24h/7d/30d/90d) shows; a function when only some views have one. */
  windowed?: boolean | (() => boolean);
  /** React hook: Convex queries and mutations for this page. Called only while the page is open. */
  useData?: () => D;
  /** The page's HTML. `d` is undefined while `useData`'s queries load. */
  render?: (d: D | undefined) => string;
  /** The side panel's HTML for the picked thing `x`, or null when there is none. */
  props?: (d: D | undefined, x: string) => string | null;
  acts?: Record<string, (el: HTMLElement, d: D | undefined) => void | Promise<void>>;
  /** Crumb parts after the page's name, e.g. Jobs / Check-in. */
  crumb?: (d: D | undefined) => string;
  /** Until a page is ported: the old console's section, drawn in the page slot. */
  Legacy?: ComponentType;
};

/** A line in Home's "Needs you", which also counts on the sidebar row of the page it opens. */
export type Need = {
  tone: "warn" | "bad";
  /** HTML; values in it went through `esc`. */
  html: string;
  label: string;
  to: { p: string; subs?: string[]; x?: string | null; f?: Record<string, string> };
};
