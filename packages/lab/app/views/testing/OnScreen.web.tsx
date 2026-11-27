/**
 * What the app had open when a person's message in an in-app conversation was sent (Dev, 2026-11-27, approved
 * artboards `in-app-tests-artboards/`): the open note or sheet `{ workspace, path }`, up to 8 other tabs and an optional
 * selection, checked as the app's own send is (`packages/lab/src/texScreen.cjs`). One shape everywhere: `@ws · path`,
 * then `+N tabs`, then the selection, behind the same window glyph, in the Testing grid, the Inspector, under a sent
 * bubble and in the chip. One editor, the popover here, edits it from a grid row and from the test chat's composer.
 * 1:1 and group conversations show none of it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SCREEN_SELECTION, SCREEN_TABS, screenProblems } from "@context/lab/src/texScreen.cjs";
import type { Conversation, Message, Screen, ScreenNote } from "@context/tex/src/texSets.d.cts";

/** Whether a row shows what was on screen: a person's message in an in-app conversation, never Tex's. */
export const onScreen = (c: Conversation, m: Message) => c.kind === "app" && !m.tex && m.who !== "Tex" && m.via === undefined;

/** The window with a tab line, at the Lab's 1.8 stroke. */
export const ScreenIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9h17" />
  </svg>
);

export const tabsWord = (n: number) => `+${n} tab${n === 1 ? "" : "s"}`;
/** `@supa · plans/q3.md` with the workspace quieter. */
export const NoteName = ({ n }: { n: ScreenNote }) => (
  <>
    <span className="ws">{n.workspace}&nbsp;·&nbsp;</span>
    {n.path}
  </>
);

/**
 * The quiet line under a person's words: `[▭] On screen @supa · plans/q3.md +2 tabs · selection`, or `[▭] Nothing
 * open`. In a grid cell the glyph stands for the words "On screen" (CSS hides `.k`). `full` quotes the selection in
 * the line (under a sent bubble); `noSel` leaves it out (the Inspector quotes it whole beneath).
 */
export function OnScreenLine({ screen, full, noSel }: { screen: Screen | null | undefined; full?: boolean; noSel?: boolean }) {
  if (!screen)
    return (
      <span className="osl none" data-osl="none" title="Nothing was open when this was sent">
        <ScreenIcon />
        <span className="k">Nothing open</span>
      </span>
    );
  const tabs = screen.tabs?.length ?? 0;
  const sel = noSel ? undefined : screen.selection;
  return (
    <span className="osl" data-osl="set" title={`On screen when this was sent${screen.selection ? `: “${screen.selection}”` : ""}`}>
      <ScreenIcon />
      <span className="k">On screen</span>
      {screen.note ? (
        <span className="p">
          <NoteName n={screen.note} />
        </span>
      ) : null}
      {tabs ? <span className="x">{screen.note ? tabsWord(tabs) : `${tabs} tab${tabs === 1 ? "" : "s"}`}</span> : null}
      {sel ? full ? <span className="sel">·&nbsp;“{sel}”</span> : <span className="x">· selection</span> : null}
    </span>
  );
}

/** The editor's working copy: inputs as typed, so a half-typed path is never lost or sent. */
type Draft = { ws: string; path: string; tabs: ScreenNote[]; sel: string };
const draftOf = (s: Screen | null): Draft => ({ ws: s?.note?.workspace ?? "", path: s?.note?.path ?? "", tabs: s?.tabs ?? [], sel: s?.selection ?? "" });
/** The screen a draft says, null for Nothing open, or "bad" while a field is not one the app could send. */
export function screenFrom(d: Draft): Screen | null | "bad" {
  const ws = d.ws.trim();
  const path = d.path.trim();
  const hasNote = !!path || (ws !== "" && ws !== "@");
  const out: Screen = {};
  if (hasNote) out.note = { workspace: ws, path };
  if (d.tabs.length) out.tabs = d.tabs;
  if (d.sel.trim()) out.selection = d.sel;
  if (!out.note && !out.tabs && !out.selection) return null;
  if (hasNote && !ws.startsWith("@")) return "bad";
  return screenProblems(out).length ? "bad" : out;
}
/** Each field checked on its own, for `aria-invalid`: a workspace without @, a path that is not .md or .csv. */
const wsBad = (ws: string) => !!ws.trim() && ws.trim() !== "@" && (!ws.trim().startsWith("@") || screenProblems({ note: { workspace: ws.trim(), path: "a.md" } }).length > 0);
const pathBad = (p: string) => !!p.trim() && screenProblems({ note: { workspace: "@a", path: p.trim() } }).length > 0;
const same = (a: Screen | null, b: Screen | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The On screen popover (artboard 03): Open (workspace and path), Tabs (each removable, `+ Add a tab` up to 8), Selected
 * (with a live count), Clear and Done. Each kept change is one `onChange`; Esc, a click outside and Done keep the
 * changes, and a field the app could not send is marked and never sent.
 */
export function OnScreenPop({ value, onChange, onClose, anchor, sub, up }: { value: Screen | null; onChange: (s: Screen | null) => void; onClose: () => void; anchor: HTMLElement; sub: string; up?: boolean }) {
  const [d, setD] = useState<Draft>(() => draftOf(value));
  const [adding, setAdding] = useState<{ ws: string; path: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: "hidden" });
  const kept = useRef(value);
  kept.current = value;
  /** Keep a draft: sent once, and only when the app could send it. */
  const keep = (next: Draft) => {
    const s = screenFrom(next);
    if (s !== "bad" && !same(s, kept.current)) {
      kept.current = s;
      onChange(s);
    }
  };
  const latest = useRef({ d, keep, onClose });
  latest.current = { d, keep, onClose };
  const close = () => {
    latest.current.keep(latest.current.d);
    latest.current.onClose();
  };
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 380;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    setPos(up ? { left, bottom: innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [anchor, up]);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", out);
      document.removeEventListener("keydown", esc, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  const set = (patch: Partial<Draft>, now = false) => {
    const next = { ...d, ...patch };
    setD(next);
    if (now) keep(next);
  };
  const enter = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") (e.currentTarget as HTMLElement).blur();
  };
  const addTab = () => {
    if (!adding) return;
    const tab = { workspace: adding.ws.trim(), path: adding.path.trim() };
    if (!tab.path || wsBad(tab.workspace) || !tab.workspace.startsWith("@") || pathBad(tab.path)) return;
    setAdding(null);
    set({ tabs: [...d.tabs, tab].slice(0, SCREEN_TABS) }, true);
  };
  return (
    <div className="popm osp" id="osPop" role="dialog" aria-label="On screen" ref={ref} style={pos} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="oh">
        <b>On screen</b>
        <span>{sub}</span>
      </div>
      <div className="of">
        <label htmlFor="osWs">Open</label>
        <div className="pair">
          <input className="ws" id="osWs" aria-label="Workspace" placeholder="@supa" value={d.ws} aria-invalid={wsBad(d.ws) || (!!d.path.trim() && !d.ws.replace("@", "").trim()) || undefined} onChange={(e) => set({ ws: e.target.value })} onBlur={() => keep(d)} onKeyDown={enter} />
          <input className="pt" id="osPath" aria-label="Path of the open note or sheet" placeholder="plans/q3.md" autoFocus value={d.path} aria-invalid={pathBad(d.path) || undefined} onChange={(e) => set({ path: e.target.value })} onBlur={() => keep(d)} onKeyDown={enter} />
        </div>
        <label>Tabs</label>
        <div className="tabs" id="osTabs">
          {d.tabs.map((t, k) => (
            <span className="tab" key={k}>
              <span className="t">
                <NoteName n={t} />
              </span>
              <button type="button" aria-label="Remove tab" data-untab={k} onClick={() => set({ tabs: d.tabs.filter((_, j) => j !== k) }, true)}>
                ✕
              </button>
            </span>
          ))}
          {adding ? (
            <div className="pair">
              <input className="ws" aria-label="Tab's workspace" value={adding.ws} aria-invalid={wsBad(adding.ws) || undefined} onChange={(e) => setAdding({ ...adding, ws: e.target.value })} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && addTab())} />
              <input className="pt" id="osTabPath" aria-label="Tab's path" placeholder="plans/q2.md" autoFocus value={adding.path} aria-invalid={pathBad(adding.path) || undefined} onChange={(e) => setAdding({ ...adding, path: e.target.value })} onBlur={addTab} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && addTab())} />
            </div>
          ) : d.tabs.length < SCREEN_TABS ? (
            <button type="button" className="add" id="osAddTab" onClick={() => setAdding({ ws: d.ws.trim().startsWith("@") ? d.ws.trim() : "@", path: "" })}>
              + Add a tab<span className="n">{d.tabs.length} of {SCREEN_TABS}</span>
            </button>
          ) : (
            <span className="add" style={{ color: "var(--dim)" }}>
              {SCREEN_TABS} of {SCREEN_TABS}
            </span>
          )}
        </div>
        <label htmlFor="osSel">Selected</label>
        <div>
          <textarea id="osSel" rows={2} maxLength={SCREEN_SELECTION} placeholder="Text picked in the note (optional)" value={d.sel} onChange={(e) => set({ sel: e.target.value })} onBlur={() => keep(d)} onKeyDown={(e) => e.stopPropagation()} />
          <span className="cnt">
            {d.sel.length} / {SCREEN_SELECTION}
          </span>
        </div>
      </div>
      <div className="ft">
        <button type="button" className="ghost" id="osClear" title="Set to Nothing open" onClick={() => (setD(draftOf(null)), setAdding(null), keep(draftOf(null)))}>
          Clear
        </button>
        <span className="sp" />
        <button type="button" className="primary" id="osDone" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Which chip has the popover open: a tap opens it there, a second tap closes it. */
export function useOnScreenPop() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      const el = e.currentTarget;
      setAnchor((a) => (a ? null : el));
    },
    close: () => setAnchor(null),
  };
}

/** The chip's words: `On screen: @supa · plans/q3.md +2 ▾`, or `On screen: Nothing open ▾`. */
export function ChipFace({ screen, caret = true, tabs }: { screen: Screen | null; caret?: boolean; tabs?: (n: number) => string }): ReactNode {
  const n = screen?.tabs?.length ?? 0;
  return (
    <>
      <ScreenIcon />
      <span className="k">On screen:</span>
      <span className="p">{screen?.note ? `${screen.note.workspace} · ${screen.note.path}` : screen ? "no note open" : "Nothing open"}</span>
      {n ? <span className="k x2">{tabs ? tabs(n) : `+${n}`}</span> : null}
      {caret ? <span className="car">▾</span> : null}
    </>
  );
}
