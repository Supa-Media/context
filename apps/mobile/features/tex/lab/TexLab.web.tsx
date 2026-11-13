/**
 * tex.lc/admin/lab: the Tex Architecture Lab, where staff change Tex's
 * architecture visually (steps, wires, each step's model and context
 * modules), see what it does to speed and cost, edit the test cases, and hand
 * a version to the replay gate. Built from the "Tex Architecture Lab"
 * artifact at Dev2's ask (2026-11-13): "EXACTLY like the artifact with all the
 * functionality wired up". The markup below is the artifact's own (its lines
 * 353-416), with the same classes and the stylesheet ported verbatim
 * (`labCss.ts`), so the views each thread ports drop into the same slots.
 *
 * Staff only: every query behind it is `requireAdmin` (`functions/texLab.ts`);
 * the page asks `amIAdmin` only to say so kindly, as tex.lc/admin does.
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { GROUP_CHATS, PEOPLE } from "./data/areas";
import { allCases, cvDiff, diff } from "./engine/diff";
import { G, go, isMain, lab, newVersion, openVersion, saveVersion, set, fit, emit } from "./engine/state";
import { buildTraces } from "./engine/traces";
import { LAB_CSS } from "./labCss";
import { ensureFontsLoaded } from "../../design/fonts.web";
import { useLab, useLabSync } from "./store";
import type { View } from "./types";
import { Canvas } from "./views/Canvas.web";
import { Compare } from "./views/Compare.web";
import { Convo } from "./views/Convo.web";
import { Ic } from "./views/ic";
import { Modules } from "./views/Modules.web";
import { Props } from "./views/Props.web";
import { Run } from "./views/Run.web";
import { Sim } from "./views/Sim.web";
import { Tests } from "./views/Tests.web";
import { Tools } from "./views/Tools.web";
import { Viewer } from "./views/Viewer.web";

export const TEX_LAB_TITLE = "Tex Architecture Lab";

const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width:820px)").matches;

const NAV: Array<[View, string, string, "modTag" | "cvTag" | "toolTag" | "runTag" | null]> = [
  ["canvas", "Architecture", '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l3 7M16 8l-3 7M8.2 7h7.6"/>', null],
  ["modules", "Context modules", '<rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="11" width="16" height="4" rx="1.5"/><rect x="4" y="17" width="16" height="3" rx="1.5"/>', "modTag"],
  ["convo", "Conversations", '<path d="M4 5h11v8H8l-4 3z"/><path d="M15 9h5v8l-3-2h-6v-2"/>', "cvTag"],
  ["tools", "Tools", '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8a2 2 0 0 1-2.8-2.8l8-8a3.5 3.5 0 0 0-1.8-1.8z"/>', "toolTag"],
  ["sim", "Speed and cost", '<circle cx="12" cy="13" r="7"/><path d="M12 13l3-3M10 3h4"/>', null],
  ["tests", "Test cases", '<path d="M9 4h6M10 4v5l-5 9a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-9V4"/><path d="M7.5 14h9"/>', null],
  ["run", "Run", '<path d="M7 5l11 7-11 7z"/>', "runTag"],
  ["compare", "Compare versions", '<path d="M5 20V10M12 20V4M19 20v-7"/>', null],
];

/** The pages other than the canvas: the artifact's `.pg > .pgin` slots, with their ids and widths. */
const PAGES: Array<[View, string, React.CSSProperties | undefined, () => React.ReactNode]> = [
  ["modules", "modPg", undefined, () => <Modules />],
  ["tools", "toolPg", { maxWidth: 1180 }, () => <Tools />],
  ["convo", "cvPg", { maxWidth: 1180 }, () => <Convo />],
  ["sim", "simPg", undefined, () => <Sim />],
  ["tests", "testsPg", { paddingTop: 16, maxWidth: 1180 }, () => <Tests />],
  ["run", "runPg", undefined, () => <Run />],
  ["compare", "cmpPg", undefined, () => <Compare />],
];

function Svg({ d, className = "i ic", style }: { d: string; className?: string; style?: React.CSSProperties }) {
  return <svg className={className} viewBox="0 0 24 24" style={style} dangerouslySetInnerHTML={{ __html: d }} />;
}

export function TexLab() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  useLabSync(isAdmin === true);
  useEffect(() => {
    ensureFontsLoaded();
    if (!lab.scn) buildTraces(allCases());
    emit();
  }, []);
  return (
    <div className="tl" data-testid="tex-lab">
      <style>{LAB_CSS}</style>
      <title>{TEX_LAB_TITLE}</title>
      {isAdmin === false ? (
        <div className="pgin" data-testid="tex-lab-staff-only" style={{ paddingTop: 60 }}>
          <h1>Staff only</h1>
          <p className="lede">This page is for the people who run Tex. If that is you, sign in with your staff account.</p>
        </div>
      ) : isAdmin === true ? (
        <Lab />
      ) : null}
    </div>
  );
}

function Lab() {
  const s = useLab();
  const closeSide = () => set({ sideOpen: false });
  const d = diff();
  const cvn = cvDiff().length;
  const nm = Object.keys(G().modules || {}).length;
  const tags = { modTag: nm ? nm + " edited" : "", cvTag: cvn ? cvn + " changed" : "", toolTag: "", runTag: d.length ? d.length + " change" + (d.length > 1 ? "s" : "") : "" };
  const propsOn = s.view === "canvas" && s.sel !== null;
  const wide = propsOn && !!s.cfocus && s.sel?.t === "node" && s.sel.id === s.cfocus;
  const unsaved = !isMain() && !s.versions.some((v) => v.id === s.cur.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!isMain()) void saveVersion();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSide = () => {
    if (phone()) {
      set({ sideOpen: !s.sideOpen });
      return;
    }
    set({ sideHidden: !s.sideHidden });
    setTimeout(fit, 0);
  };
  const showVersions = () => {
    if (phone()) set({ sideOpen: true });
    else {
      set({ sideHidden: false });
      document.getElementById("verList")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
  const gridCols = s.sideHidden && !phone() ? (propsOn ? `minmax(0,1fr) ${wide ? 420 : 320}px` : "minmax(0,1fr)") : undefined;

  return (
    <>
      <div className={"app" + (s.sideOpen ? " sideopen" : "")} id="app">
        <div className="bar">
          <button className="ib" id="sideBtn" aria-label="Show or hide the sidebar" onClick={toggleSide}>
            <Svg className="i" d='<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9 4.5v15"/>' />
          </button>
          <button className="chipbtn" id="verBtn" onClick={showVersions}>
            <Svg className="i" d='<path d="M6 4v10a4 4 0 0 0 4 4h8"/><circle cx="18" cy="18" r="1.6"/>' />
            <span id="verName" hidden={!isMain()}>{s.cur.name}</span>
          </button>
          <input
            id="verRename"
            className="vren"
            aria-label="Version name"
            spellCheck={false}
            hidden={isMain()}
            key={s.cur.id}
            defaultValue={s.cur.name}
            onChange={(e) => {
              s.cur.name = e.target.value.trim() || s.cur.name;
              set({ dirty: true });
            }}
          />
          <span className="dot" id="dirtyDot" title="Unsaved changes" hidden={!s.dirty} />
          <button className="primary" id="saveBtn" disabled={isMain() || !s.dirty} onClick={() => void saveVersion()}>
            Save
          </button>
          <span className="spacer" />
          <span className="sync" id="syncState">
            {s.sync}
          </span>
        </div>
        <div className={"body" + (propsOn ? " props" : "") + (wide ? " wide" : "")} id="body" style={gridCols ? { gridTemplateColumns: gridCols } : undefined}>
          <nav className="side" id="side" aria-label="Lab" hidden={s.sideHidden && !phone()}>
            {NAV.map(([v, name, icon, tag]) => (
              <button key={v} className="rowi" data-view={v} aria-current={s.view === v} onClick={() => (closeSide(), go(v))}>
                <Svg d={icon} />
                <span className="nm">{name}</span>
                {tag ? (
                  <span className="tag" id={tag}>
                    {tags[tag]}
                  </span>
                ) : null}
              </button>
            ))}
            <div className="sec">
              <span>Test user</span>
            </div>
            <div className="tuser">
              <span className="av">M</span>
              <div>
                <b>Maya</b>
                <div className="hint">core and jobs run as her</div>
              </div>
            </div>
            <div className="sub">Workspaces</div>
            <div id="wsList">
              {PEOPLE.Maya.ws.map((w) => (
                <button key={w.n} className="rowi" data-sws={w.n} onClick={() => (closeSide(), set({ viewer: { kind: "ws", ws: w.n } }))}>
                  <Ic k={w.kind === "personal" ? "door" : "thread"} style={{ color: "var(--muted)" }} />
                  <span className="nm">{w.n}</span>
                  <span className="meta">{w.role}</span>
                </button>
              ))}
            </div>
            <div className="sub">Group chats</div>
            <div id="gcList">
              {GROUP_CHATS.map((c) => (
                <button key={c.name} className="rowi" data-sws={c.ws} title={c.note} onClick={() => (closeSide(), set({ viewer: { kind: "ws", ws: c.ws } }))}>
                  <Ic k="text" style={{ color: "var(--muted)" }} />
                  <span className="nm">{c.name}</span>
                  <span className="meta">{c.with}</span>
                </button>
              ))}
            </div>
            <div className="sec">
              <span>Versions</span>
              <button id="sideNewVer" aria-label="New version from main" onClick={newVersion}>
                <Svg className="i" style={{ width: 16, height: 16 }} d='<path d="M12 5v14M5 12h14"/>' />
              </button>
            </div>
            <div id="verList">
              {s.versions.map((v) => (
                <button key={v.id} className="rowi" data-ver={v.id} aria-current={v.id === s.cur.id} onClick={() => (openVersion(v.id), closeSide())}>
                  <Ic k={v.id === "main" ? "send" : "router"} style={{ color: "var(--accent)" }} />
                  <span className="nm">{v.id === s.cur.id ? s.cur.name : v.name}</span>
                  {v.id === "main" ? <span className="tag">live</span> : v.results?.length ? <span className="tag">{v.results.length + " run" + (v.results.length > 1 ? "s" : "")}</span> : null}
                </button>
              ))}
              {unsaved ? (
                <button className="rowi" aria-current="true">
                  <Ic k="router" style={{ color: "var(--accent)" }} />
                  <span className="nm">{s.cur.name}</span>
                  <span className="tag">not saved</span>
                </button>
              ) : null}
            </div>
          </nav>
          <div className="scrim" id="scrim" onClick={closeSide} />
          <main className="main" id="main">
            <div id="v-canvas" hidden={s.view !== "canvas"}>
              {s.view === "canvas" ? <Canvas /> : null}
            </div>
            {PAGES.map(([v, id, style, render]) => (
              <div key={v} className="pg" id={"v-" + v} hidden={s.view !== v}>
                <div className="pgin" id={id} style={style}>
                  {s.view === v ? render() : null}
                </div>
              </div>
            ))}
          </main>
          <aside className="props-pane" id="props" aria-label="Properties" hidden={!propsOn}>
            {propsOn ? <Props /> : null}
          </aside>
        </div>
      </div>
      <div className="toast" id="toast" hidden={!s.toastText}>
        {s.toastText}
      </div>
      <div className="viewer" id="viewer" hidden={!s.viewer} role="dialog" aria-modal="true" aria-label="Module">
        {s.viewer ? <Viewer /> : null}
      </div>
    </>
  );
}
