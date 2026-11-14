/**
 * context.lc/admin: the staff console, built from the "Staff Console Redesign" artifact at Dev2's
 * ask (2026-11-14: "EXACTLY like the artifact with all the functionality wired up"). The chrome
 * below is the artifact's markup (its `.app`: bar, sidebar, page, side panel, toast) and its
 * `render()`, with the stylesheet ported verbatim and scoped under `.sc` (`consoleCss.ts`). Each
 * page is a module (`pages/registry.ts`, `types.ts`) whose HTML goes in the page slot.
 *
 * Clicks work as the artifact's do: one listener on the root finds the nearest `data-act` and calls
 * the open page's act of that name, else the shell's own (`SHELL`).
 *
 * Staff only: every query behind a page is `requireAdmin` on the server; `amIAdmin` here only
 * decides what to say, as the old console did.
 */
import { Component, memo, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { AdminChrome } from "../AdminPane";
import { StaffFactorGate } from "../StaffFactorGate";
import { isTexHost } from "../../site/host";
import { ensureFontsLoaded } from "../../design/fonts.web";
import { CONSOLE_CSS } from "./consoleCss";
import { esc, fitCharts, ic, lgOpen, seg, shut } from "./kit";
import { ROW, SECTIONS, hashForOldPath, windowedNow } from "./pages/registry";
import { useNeeds } from "./pages/needs.web";
import { FDEF, S, closeProps, focus, focusKey, getVersion, go, onScrollTop, parse, phone, render, runUndo, sel, setD, setQ, store, subscribe, toastState } from "./state";
import type { ConsolePage, Need } from "./types";

export const STAFF_CONSOLE_TITLE = "Staff console";

type Theme = "auto" | "light" | "dark";
const THEMES: Array<[Theme, string, string]> = [
  ["auto", "auto", "Match the system"],
  ["light", "sun", "Light"],
  ["dark", "moon", "Dark"],
];

export function StaffConsole() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  // Staff whose session has not typed its second-factor code are asked for it here, as the old console asked.
  const factor = useQuery(api.functions.staffSecondFactor.myStaffFactor, {});
  useEffect(() => {
    ensureFontsLoaded();
  }, []);
  if (isAdmin === false && factor?.staff === true && factor.standing !== "open") {
    return (
      <AdminChrome>
        <StaffFactorGate factor={factor} />
      </AdminChrome>
    );
  }
  return (
    <div className="sc" data-testid="staff-console" data-theme={store.get<Theme>("theme", "auto") === "auto" ? undefined : store.get<Theme>("theme", "auto")}>
      <style href="staff-console-css" precedence="default">
        {CONSOLE_CSS}
      </style>
      <title>{STAFF_CONSOLE_TITLE}</title>
      {isAdmin === false ? (
        <div className="pgin" data-testid="staff-console-staff-only" style={{ paddingTop: 60 }}>
          <h1>Staff only</h1>
          <p className="sub">This page is for the people who run Context. If that is you, sign in with your staff account.</p>
        </div>
      ) : isAdmin === true ? (
        <Console offerFactor={factor?.staff === true && !factor.enrolled ? factor : null} />
      ) : null}
    </div>
  );
}

/**
 * Calls the open page's `useData` and hands the result up; keyed by page, so hooks never change
 * order. Memoized: it redraws when its own queries change or the console's state does (`v`, so a
 * `useData` that reads `S.d` or a filter asks again), never because the data it handed up redrew
 * the console, so a `useData` that builds a fresh object each call cannot loop.
 */
const PageData = memo(function PageData({ page, onData }: { page: ConsolePage; onData: (d: unknown) => void; v: number }) {
  const d = page.useData ? page.useData() : undefined;
  useLayoutEffect(() => onData(d), [d, onData]);
  return null;
});

/** Hands up the "Needs you" lines (every page's sidebar badges), the same way `PageData` does. */
const NeedsData = memo(function NeedsData({ onNeeds }: { onNeeds: (n: Need[]) => void; v: number }) {
  const needs = useNeeds();
  useLayoutEffect(() => onNeeds(needs), [needs, onNeeds]);
  return null;
});

/**
 * One failing query must not take the console down with it: a page's data, its old section, or a
 * "Needs you" source that throws (a read limit, a timeout) is caught here and named, and the rest
 * of the console keeps working. Keyed by what it guards, so moving on tries again.
 */
class Guard extends Component<{ onError?: (message: string) => void; children: React.ReactNode; fallback?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** What a page that could not load says in its slot. */
const failedHtml = (name: string, why: string) =>
  `<div class="banner" role="alert"><b>${esc(name)} could not load.</b> ${esc(why)}</div>`;

type Factor = React.ComponentProps<typeof StaffFactorGate>["factor"];

/** The console once the staff check passed; exported for the visual check harness. */
export function Console({ offerFactor }: { offerFactor: Factor | null }) {
  const root = useRef<HTMLDivElement>(null);
  const pg = useRef<HTMLDivElement>(null);
  const fk = useRef<string | null>(null);
  const caret = useRef<number | null>(null);
  const dataRef = useRef<{ p: string; d: unknown } | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Before each redraw, note what had focus, so the redrawn page puts it back (the artifact's `focusKey`).
  const version = useSyncExternalStore(
    (fn) =>
      subscribe(() => {
        fk.current = focusKey(document.activeElement);
        fn();
      }),
    getVersion,
    getVersion,
  );
  // The data is kept with the page it belongs to, so a page's first draw never gets the last page's data.
  const [onData] = useState(() => (d: unknown) => {
    dataRef.current = { p: S.p, d };
    if (failed.current?.p === S.p) failed.current = null;
    bump();
  });
  const needsRef = useRef<Need[]>([]);
  const [onNeeds] = useState(() => (n: Need[]) => {
    needsRef.current = n;
    bump();
  });
  const needs = needsRef.current;
  // Why the open page's data failed, for the page it failed on.
  const failed = useRef<{ p: string; why: string } | null>(null);
  const [onPageError] = useState(() => (why: string) => {
    failed.current = { p: S.p, why };
    bump();
  });

  // The place comes from the address; an old `/admin/<tab>` bookmark becomes the page it turned into.
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!location.hash) {
      const h = hashForOldPath(location.pathname);
      // On tex.lc `/admin` is the Tex dashboard, so the console keeps the path it was opened at there.
      history.replaceState(history.state, "", (isTexHost() ? location.pathname : "/admin") + location.search + (h ?? ""));
    }
    S.sideHidden = store.get("sidehidden", false);
    parse();
    onScrollTop(() => pg.current?.scrollTo({ top: 0 }));
    setReady(true);
    const onPop = () => {
      parse();
      if (S.x == null) focus.pushedX = false;
      render();
    };
    let rz: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(render, 120);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const row = ROW[S.p] ?? ROW.home;
  const page = row.page;
  const data = dataRef.current?.p === S.p ? dataRef.current.d : undefined;

  // Clicks, changes, keys and the search box, delegated as the artifact's are.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const act = (name: string, e: HTMLElement, ev?: Event) => {
      const pageAct = ROW[S.p]?.page.acts?.[name];
      const shellAct = SHELL[name];
      if (!pageAct && !shellAct) return false;
      if (ev && (e as HTMLInputElement).type !== "checkbox") ev.preventDefault();
      if (pageAct) void pageAct(e, dataRef.current?.p === S.p ? dataRef.current.d : undefined);
      else shellAct(e, { root: el, needs: needsRef.current });
      return true;
    };
    const onClick = (ev: MouseEvent) => {
      const e = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!e || !el.contains(e)) return;
      if ((e.tagName === "INPUT" && (e as HTMLInputElement).type !== "checkbox") || e.tagName === "SELECT") return;
      if ((ev.target as HTMLElement).closest("[data-stop]") && e.dataset.act === "sel") return;
      if (e.tagName === "A") return;
      act(e.dataset.act!, e, ev);
    };
    const onChange = (ev: Event) => {
      const e = ev.target as HTMLElement;
      if (e.tagName === "SELECT" && e.dataset.act) act(e.dataset.act, e);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        if (S.confirm) {
          S.confirm = null;
          render();
        } else if (S.x) closeProps(el);
        else if (S.sideOpen) {
          S.sideOpen = false;
          render();
        }
        return;
      }
      const e = ev.target as HTMLElement;
      if ((ev.key === "Enter" || ev.key === " ") && e.matches("tr[data-act]")) {
        ev.preventDefault();
        e.click();
      }
      if (ev.key === "Enter" && e.matches("input.search:not([data-act])")) {
        const b = e.parentElement?.querySelector<HTMLElement>("button.ghost,button.primary");
        b?.click();
      }
    };
    let qT: ReturnType<typeof setTimeout> | undefined;
    const onInput = (ev: Event) => {
      const e = ev.target as HTMLInputElement;
      if (e.dataset.act !== "q") return;
      clearTimeout(qT);
      const v = e.value;
      qT = setTimeout(() => {
        caret.current = e.selectionStart;
        setQ(v);
      }, 220);
    };
    el.addEventListener("click", onClick);
    el.addEventListener("change", onChange);
    el.addEventListener("keydown", onKey);
    el.addEventListener("input", onInput);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("change", onChange);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("input", onInput);
    };
  }, [ready]);

  // After each redraw: chart text at 11px, focus back where it was, or on the side panel's title when it opened.
  const hasProps = !!(S.x && page.props && page.props(data, S.x));
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    fitCharts(el);
    if (caret.current != null) {
      const q = el.querySelector<HTMLInputElement>("#q");
      if (q) {
        q.focus();
        q.setSelectionRange(caret.current, caret.current);
      }
      caret.current = null;
    } else if (hasProps && S.x !== focus.lastX) el.querySelector<HTMLElement>("#props h3")?.focus({ preventScroll: true });
    else if (fk.current) {
      const m = [...el.querySelectorAll("[data-act],[id]")].find((e) => focusKey(e) === fk.current) as HTMLElement | undefined;
      if (m && m !== document.activeElement) m.focus({ preventScroll: true });
    }
    focus.lastX = hasProps ? S.x : null;
  });

  if (!ready) return null;
  const win = windowedNow(S.p);
  const wseg = seg(
    "Window",
    [
      ["1", "24h"],
      ["7", "7d"],
      ["30", "30d"],
      ["90", "90d"],
    ],
    S.d,
    "win",
  );
  const side = SECTIONS.map(
    ([sec, rows]) =>
      (sec ? `<div class="sec">${sec}</div>` : "") +
      rows
        .map((r) => {
          const nd = needs.filter((n) => n.to.p === r.key).length;
          return `<button class="rowi" aria-current="${S.p === r.key}" data-act="go" data-p="${r.key}">${ic(r.icon)}<span class="nm">${r.name}</span>${nd ? `<span class="ct hot">${nd}</span>` : ""}</button>`;
        })
        .join(""),
  ).join("");
  const crumb = `<button data-act="go" data-p="${S.p}">${row.name}</button>` + (page.crumb ? page.crumb(data) : "");
  const pageFailed = failed.current?.p === S.p ? failed.current.why : null;
  let body: string | null = null;
  if (page.render) {
    try {
      body = pageFailed != null ? failedHtml(row.name, pageFailed) : page.render(data);
    } catch (error) {
      body = failedHtml(row.name, error instanceof Error ? error.message : String(error));
    }
  }
  const html = body != null ? (win ? `<div class="winrow tools">${wseg}</div>` : "") + body : null;
  const pr = S.x && page.props ? page.props(data, S.x) : null;
  const theme = store.get<Theme>("theme", "auto");
  const sideHidden = S.sideHidden && !phone();

  return (
    <div className={"app" + (S.sideOpen ? " sideopen" : "")} id="app" ref={root} data-v={version}>
      <Guard key={"p-" + S.p + "-" + S.d} onError={onPageError}>
        <PageData page={page} onData={onData} v={version} />
      </Guard>
      <Guard key={"n-" + S.d}>
        <NeedsData onNeeds={onNeeds} v={version} />
      </Guard>
      <div className="bar">
        <button className="ib" id="sideBtn" aria-label="Show or hide the sidebar" data-act="side">
          <svg className="i" viewBox="0 0 24 24">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
            <path d="M9 4.5v15" />
          </svg>
        </button>
        <nav className="modes" aria-label="Staff tools">
          <button aria-current="true">Console</button>
          <a href="/lab" target="_blank" rel="noopener" title="Opens the live Lab">
            Lab<span className="lbl"> ↗</span>
          </a>
        </nav>
        <div className="crumb" id="crumb" dangerouslySetInnerHTML={{ __html: crumb }} />
        <span className="spacer" />
        <div className="seg winseg" id="winTop" role="group" aria-label="Window" hidden={!win} dangerouslySetInnerHTML={{ __html: win ? wseg.replace(/^<div class="seg"[^>]*>|<\/div>$/g, "") : "" }} />
        <div
          className="thm"
          role="radiogroup"
          aria-label="Theme"
          id="thm"
          dangerouslySetInnerHTML={{
            __html: THEMES.map(([v, i, l]) => `<button role="radio" aria-checked="${theme === v}" aria-label="${l}" title="${l}" data-act="theme" data-v="${v}">${ic(i)}</button>`).join(""),
          }}
        />
      </div>
      <div className={"body" + (pr ? " props" : "") + (sideHidden ? " noside" : "")} id="body">
        <nav className="side" id="side" aria-label="Pages" hidden={sideHidden} dangerouslySetInnerHTML={{ __html: side }} />
        <main className="main">
          <div className="pg" id="pg" ref={pg}>
            {offerFactor ? (
              <div className="pgin" style={{ paddingBottom: 0 }}>
                <StaffFactorGate factor={offerFactor} offer />
              </div>
            ) : null}
            {html != null ? (
              <div className="pgin" id="pgin" key={"h-" + S.p} dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <div className="pgin" id="pgin" key={"l-" + S.p}>
                {win ? <div className="winrow tools" dangerouslySetInnerHTML={{ __html: wseg }} /> : null}
                {page.Legacy ? (
                  <Guard key={S.d} fallback={<div className="banner" role="alert"><b>{row.name} could not load.</b></div>}>
                    <page.Legacy />
                  </Guard>
                ) : null}
              </div>
            )}
          </div>
        </main>
        <aside className="props-pane" id="props" hidden={!pr} dangerouslySetInnerHTML={{ __html: pr ? `<button class="handle" data-act="close" aria-label="Close"></button><div class="pp">${pr}</div>` : "" }} />
      </div>
      <div className="scrim" data-act="side" />
      <div className={"pscrim" + (pr && phone() ? " on" : "")} id="pscrim" data-act="close" />
      <div className="toast" id="toast" hidden={!toastState.shown}>
        {toastState.text}
        {toastState.undo ? <button data-act="undo">Undo</button> : null}
      </div>
    </div>
  );
}

type ShellCtx = { root: HTMLElement; needs: Need[] };

/** The shell's own acts (the artifact's `A.side`, `go`, `need`, `sel`, `close`, `cancel`, `addppl`, `addcancel`, `pn`, `lg`, `win`, `theme`, `undo`). */
const SHELL: Record<string, (e: HTMLElement, c: ShellCtx) => void> = {
  side() {
    if (phone()) S.sideOpen = !S.sideOpen;
    else {
      S.sideHidden = !S.sideHidden;
      store.set("sidehidden", S.sideHidden);
    }
    render();
  },
  go(e) {
    S.sideOpen = false;
    go(e.dataset.p!, (e.dataset.subs || "").split(",").filter(Boolean));
  },
  need(e, c) {
    const n = c.needs[+e.dataset.i!];
    if (!n) return;
    go(n.to.p, n.to.subs ?? [], n.to.x ?? null, { f: n.to.f ? { ...FDEF, ...n.to.f } : FDEF });
  },
  sel(e) {
    const id = e.dataset.id!;
    S.confirm = null;
    sel(S.x === id && !id.startsWith("set-") ? null : id);
  },
  close(_e, c) {
    closeProps(c.root);
  },
  cancel() {
    S.confirm = null;
    render();
  },
  // The artifact's shared add form: People, Flags and Settings open it, and its Cancel closes it.
  addppl(_e, c) {
    S.adding = true;
    render();
    setTimeout(() => c.root.querySelector<HTMLElement>("#addbox,#ll,#gname")?.focus(), 0);
  },
  addcancel() {
    S.adding = false;
    render();
  },
  undo() {
    runUndo();
  },
  pn(e, c) {
    const k = e.dataset.k!;
    if (shut.has(k)) shut.delete(k);
    else shut.add(k);
    store.set("shut", [...shut]);
    e.closest(".pn")?.classList.toggle("shut");
    e.setAttribute("aria-expanded", String(!shut.has(k)));
    fitCharts(c.root);
  },
  lg(e) {
    const k = e.dataset.k!;
    lgOpen[k] = lgOpen[k] === false;
    store.set("lg", lgOpen);
    render();
  },
  win(e) {
    setD(e.dataset.v!);
  },
  theme(e) {
    let v = e.dataset.v as Theme;
    if (phone() && e.getAttribute("aria-checked") === "true") v = ({ auto: "light", light: "dark", dark: "auto" } as const)[v];
    store.set("theme", v);
    const sc = e.closest(".sc");
    if (v === "auto") sc?.removeAttribute("data-theme");
    else sc?.setAttribute("data-theme", v);
    render();
  },
};
