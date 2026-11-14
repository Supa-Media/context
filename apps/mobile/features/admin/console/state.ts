/**
 * The staff console's state and address, ported from the "Staff Console Redesign" artifact's
 * `S`, `parse`, `hashOf`, `go`, `sel`, `setF` and `toast` (Dev2, 2026-11-14: "EXACTLY like the
 * artifact"). One module-level state, as the artifact has: pages read `S` and call these, and the
 * host (`StaffConsole.web.tsx`) redraws on `subscribe`.
 *
 * The place lives in the address hash in the artifact's own form, letters, digits and hyphens only:
 * `#page--sub--key-value--q-<hex>--x-<picked>--d<N>`. Filters at their defaults stay out of it, and
 * each filter belongs to the pages that declare it (`filters` in `pages/registry.ts`), so a filter
 * set on one page never follows you to another.
 */

export type Place = {
  p: string;
  subs: string[];
  x: string | null;
  d: string;
  f: Record<string, string>;
  q: string;
};

export type ConsoleState = Place & {
  sideHidden: boolean;
  sideOpen: boolean;
  sort: [string, 1 | -1];
  sel: Set<string>;
  confirm: string | null;
  adding: boolean;
};

/** What the address knows about pages: their keys, which have a time window, and the filters each owns. */
export type Routes = {
  pages: string[];
  windowed: Set<string>;
  /** filter key → [default, pages it belongs to] */
  filters: Record<string, [string, string[]]>;
  /** Old addresses that still open the page they became, e.g. `waitlist` → People, Waiting. */
  alias?: (parts: string[]) => string[];
};

const HAS_WINDOW = typeof window !== "undefined";

export const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem("sc-" + k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("sc-" + k, JSON.stringify(v));
    } catch {
      /* private window: the choice lasts this visit only */
    }
  },
};

export const phone = () => HAS_WINDOW && window.innerWidth <= 820;

let routes: Routes = { pages: ["home"], windowed: new Set(), filters: {} };
export const FDEF: Record<string, string> = {};

/** Set by the registry once, before the first parse. */
export function setRoutes(r: Routes) {
  routes = r;
  for (const k of Object.keys(FDEF)) delete FDEF[k];
  for (const [k, [d]] of Object.entries(r.filters)) FDEF[k] = d;
}
export const isWindowed = (p: string) => routes.windowed.has(p);

export const S: ConsoleState = {
  p: "home",
  subs: [],
  x: null,
  d: "30",
  f: {},
  q: "",
  sideHidden: false,
  sideOpen: false,
  sort: ["last", 1],
  sel: new Set(),
  confirm: null,
  adding: false,
};

export const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (h: string) => {
  try {
    return new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16))));
  } catch {
    return "";
  }
};

/** The place an address hash names (the artifact's `parse`, pure). */
export function placeOf(hash: string): Place {
  let h = "";
  try {
    h = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    h = "";
  }
  let parts = h ? h.split("--") : [];
  if (routes.alias) parts = routes.alias(parts);
  const out: Place = { p: routes.pages.includes(parts[0]) ? parts[0] : "home", subs: [], x: null, d: "30", f: { ...FDEF }, q: "" };
  for (const t of parts.slice(1)) {
    const m = t.match(/^([a-z]+)-(.+)$/);
    if (/^x-/.test(t)) out.x = t.slice(2);
    else if (/^q-[0-9a-f]+$/.test(t)) out.q = unhex(t.slice(2));
    else if (/^d(1|7|30|90)$/.test(t)) out.d = t.slice(1);
    else if (m && m[1] in FDEF) out.f[m[1]] = m[2];
    else if (t) out.subs.push(t);
  }
  return out;
}

/** The address hash of a place (the artifact's `hashOf`, pure). */
export function hashOf(p: string, subs: string[] = [], x: string | null = null, { d = S.d, f = S.f, q = S.q }: { d?: string; f?: Record<string, string>; q?: string } = {}) {
  let h = p;
  subs.filter(Boolean).forEach((s) => (h += "--" + s));
  for (const k in FDEF) if (routes.filters[k][1].includes(p) && f[k] !== undefined && f[k] !== FDEF[k]) h += "--" + k + "-" + f[k];
  if (q) h += "--q-" + hex(q);
  if (x) h += "--x-" + x;
  if (d !== "30" && routes.windowed.has(p)) h += "--d" + d;
  return "#" + h;
}

const listeners = new Set<() => void>();
let version = 0;
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getVersion = () => version;
/** Redraw: the artifact's `render()`. */
export function render() {
  version++;
  listeners.forEach((l) => l());
}

export function parse() {
  const pl = placeOf(HAS_WINDOW ? location.hash : "");
  Object.assign(S, pl);
  const sm = (S.f.sort ?? "").match(/^(.+?)(up|down)$/);
  S.sort = sm ? [sm[1], sm[2] === "up" ? 1 : -1] : ["last", 1];
  S.sideOpen = false;
}

/** The address the console writes: the path it lives at, and the place in the hash. */
const base = () => (HAS_WINDOW ? location.pathname + location.search : "");
function nav(h: string, replace: boolean) {
  if (!HAS_WINDOW || location.hash === h) return;
  if (replace) history.replaceState(history.state, "", base() + h);
  else history.pushState(history.state, "", base() + h);
}

export function setF(k: string, v: string, { push = false }: { push?: boolean } = {}) {
  S.f[k] = v;
  S.confirm = null;
  nav(hashOf(S.p, S.subs, S.x), !push);
  render();
}

/** Set the search box's words, kept in the address without adding a Back step. */
export function setQ(v: string) {
  S.q = v;
  nav(hashOf(S.p, S.subs, S.x), true);
  render();
}

/** Set the time window. */
export function setD(v: string) {
  S.d = v;
  nav(hashOf(S.p, S.subs, S.x), false);
  render();
}

let scrollTop: (() => void) | null = null;
export const onScrollTop = (fn: () => void) => (scrollTop = fn);

export function go(p: string, subs: string[] = [], x: string | null = null, { replace = false, f = null, q = null }: { replace?: boolean; f?: Record<string, string> | null; q?: string | null } = {}) {
  const same = p === S.p;
  const h = hashOf(p, subs, x, { f: f || (same ? S.f : FDEF), q: q != null ? q : same && subs.join() === S.subs.join() ? S.q : "" });
  S.confirm = null;
  S.adding = false;
  if (!same) S.sel.clear();
  nav(h, replace);
  // Outside a browser (tests) the address cannot hold the place, so take it from the hash itself.
  if (HAS_WINDOW) parse();
  else Object.assign(S, placeOf(h));
  render();
  if (!replace && !same) scrollTop?.();
}

/** Where focus was when the side panel opened, so closing it puts focus back; and whether opening it added a Back step. */
export const focus = { opener: null as string | null, pushedX: false, lastX: null as string | null };
export function focusKey(el: Element | null) {
  if (!el || (HAS_WINDOW && el === document.body)) return null;
  return ["data-act", "data-id", "data-v", "data-p", "data-k", "id"].map((a) => el.getAttribute(a) || "").join("|");
}

/** Open (or close, with null) the side panel on one thing. */
export function sel(x: string | null) {
  if (x != null && S.x == null) {
    focus.opener = focusKey(HAS_WINDOW ? document.activeElement : null);
    focus.pushedX = true;
  }
  go(S.p, S.subs, x, { replace: S.x != null && x != null });
}

/** Close the side panel, stepping Back when opening it added the step. */
export function closeProps(root: ParentNode | null) {
  S.confirm = null;
  const o = focus.opener;
  focus.opener = null;
  if (focus.pushedX) {
    focus.pushedX = false;
    history.back();
  } else go(S.p, S.subs, null, { replace: true });
  if (o && root)
    setTimeout(() => {
      const m = [...root.querySelectorAll("[data-act],[id]")].find((e) => focusKey(e) === o) as HTMLElement | undefined;
      m?.focus({ preventScroll: true });
    }, 30);
}

/** The toast: a line, and Undo for five seconds when there is something to undo. */
export const toastState = { text: "", undo: null as null | (() => void), shown: false, seq: 0 };
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(t: string, undo?: () => void) {
  toastState.text = t;
  toastState.undo = undo ?? null;
  toastState.shown = true;
  toastState.seq++;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toastState.shown = false;
      render();
    },
    undo ? 5000 : 2600,
  );
  render();
}
export function runUndo() {
  toastState.shown = false;
  const u = toastState.undo;
  toastState.undo = null;
  if (u) u();
  render();
}

/** The window's days as indexes, 24 hours for the 24h window (the artifact's `days`). */
export function days() {
  const d = +S.d;
  return Array.from({ length: d === 1 ? 24 : d }, (_, i) => i);
}
export const WIN: Record<string, string> = { "1": "24 hours", "7": "7 days", "30": "30 days", "90": "90 days" };
