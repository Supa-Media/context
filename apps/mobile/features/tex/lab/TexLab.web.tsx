/**
 * tex.lc/lab: the Tex Architecture Lab, where staff change Tex's
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
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { AdminChrome } from "../../admin/AdminPane";
import { StaffFactorGate } from "../../admin/StaffFactorGate";
import { api } from "@context/convex/_generated/api";
import { GROUP_CHATS, PEOPLE } from "./data/areas";
import { allCases, cvDiff, diff } from "./engine/diff";
import { G, go, isMain, lab, newVersion, openVersion, saveVersion, set, fit, emit } from "./engine/state";
import { buildTraces, traceMine } from "./engine/traces";
import { LAB_CSS } from "./labCss";
import { ensureFontsLoaded } from "../../design/fonts.web";
import { promoteVersion, useLab, useLabSync } from "./store";
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
import { MineLoader, readMomentDetail, readTurnTimes, refreshChat, replayEntries } from "./views/mine/useMine";
import { useLabUrl } from "./views/useLabUrl.web";
import { ReplayPanel } from "./views/replay/ReplayPanel";
import { openMoment, ReplaySide } from "./views/replay/ReplaySide";
import { loggedMoments, momentsOf } from "./engine/replay";
import { setLabTheme, THEMES, useLabTheme } from "./theme.web";

/** How often Replay looks for new texts and runs. */
const REFRESH_MS = 10_000;

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

const THEME_ICON = {
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
};

/** Not in the artifact: light, dark or auto (follow the system), kept in this browser (`theme.web.ts`). */
function ThemeToggle() {
  const theme = useLabTheme();
  return (
    <div className="thm" id="themeToggle" role="radiogroup" aria-label="Look">
      {THEMES.map((t) => (
        <button key={t} data-theme-pick={t} role="radio" aria-checked={theme === t} title={t === "auto" ? "Auto (follow the system)" : t === "light" ? "Light" : "Dark"} onClick={() => setLabTheme(t)}>
          <Svg d={THEME_ICON[t]} style={{ width: 15, height: 15 }} />
        </button>
      ))}
    </div>
  );
}

export function TexLab() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  // Staff whose session has not typed its second-factor code are asked for it here, as the console asks (`AdminPane.tsx`), never told "Staff only".
  const factor = useQuery(api.functions.staffSecondFactor.myStaffFactor, {});
  const theme = useLabTheme();
  useLabSync(isAdmin === true);
  useEffect(() => {
    ensureFontsLoaded();
    if (!lab.scn) buildTraces(allCases());
    emit();
  }, []);
  if (isAdmin === false && factor?.staff === true && factor.standing !== "open") {
    return (
      <AdminChrome>
        <StaffFactorGate factor={factor} />
      </AdminChrome>
    );
  }
  return (
    <div className="tl" data-testid="tex-lab" data-theme={theme === "auto" ? undefined : theme}>
      <style href="tex-lab-css" precedence="default">{LAB_CSS}</style>
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
  useLabUrl();
  const replay = s.mode === "replay";
  // Replay: the picked chat cut into moments, and the one shown (`engine/replay.ts`).
  const entries = replay ? replayEntries() : [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const moments = useMemo(() => (replay ? loggedMoments(momentsOf(s.myLines, entries)) : []), [replay, s.myLines, entries.length]);
  const moment = moments.find((m) => m.id === s.moment) ?? null;
  useEffect(() => {
    if (replay && !moment && moments.length) openMoment(moments[moments.length - 1]);
    // A moment opened from the address (`useLabUrl`) reads its day's details as a click would; read once per day.
    else if (replay && moment) void readMomentDetail(moment.at);
  }, [replay, moment, moments]);
  // Replay looks for new texts and runs every 10 s while the tab is in front (`refreshChat`).
  useEffect(() => {
    if (!replay) return;
    const look = setInterval(() => {
      if (document.visibilityState === "visible") void refreshChat();
    }, REFRESH_MS);
    return () => clearInterval(look);
  }, [replay]);
  // Replay's right panel folds away to the canvas's right edge (Dev2, 2026-11-14: "no way to collapse this panel").
  const [panelHidden, setPanelHidden] = useState(false);
  const propsOn = s.view === "canvas" && (s.sel !== null || replay) && !(replay && panelHidden && !phone());
  const wide = propsOn && !!s.cfocus && s.sel?.t === "node" && s.sel.id === s.cfocus;
  const unsaved = !isMain() && !s.versions.some((v) => v.id === s.cur.id);
  const me = s.tester === "me";
  // You or the bench's Maya; as You, Test cases opens on your own texts.
  const swapTester = () => {
    const toMe = s.tester !== "me";
    // The canvas traces your newest text as You (once read, `useMine`), and a bench test again as Maya.
    if (toMe && Array.isArray(lab.myTexts) && lab.myTexts[0]) {
      traceMine(lab.myTexts[0].text);
      void readTurnTimes(lab.myTexts[0]);
    }
    if (!toMe) {
      if (lab.scn === "own") {
        lab.scn = "";
        lab.ownText = "";
      }
      lab.real = null;
      buildTraces(allCases());
    }
    set({ tester: toMe ? "me" : "bench", tArea: toMe ? "mine" : "core", tQ: "" });
    if (toMe) go("tests");
    closeSide();
  };

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

  // Lab or Replay (Dev2, 2026-11-14: "there should be some type of toggle for replays versus the lab"). Replay reads your own chats, read only.
  const setMode = (mode: "lab" | "replay") => {
    if (mode === s.mode) return;
    set({ mode, sel: null, cfocus: null, view: "canvas", ...(mode === "lab" ? { real: null } : {}) });
    if (mode === "lab" && lab.scn === "own" && lab.tester !== "me") {
      lab.scn = "";
      lab.ownText = "";
      buildTraces(allCases());
    }
    closeSide();
    setTimeout(fit, 0);
  };

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
          <div className="modes" role="group" aria-label="Mode">
            <button id="modeLab" aria-pressed={!replay} onClick={() => setMode("lab")}>
              Lab
            </button>
            <button id="modeReplay" aria-pressed={replay} onClick={() => setMode("replay")}>
              Replay
            </button>
          </div>
          {replay ? (
            <span className="hint" id="replayNote">Read only</span>
          ) : (
            <>
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
          {/* Not in the artifact: a saved version becomes Tex's config through a pull request (texLabPromote.ts). */}
          <button
            id="promoteBtn"
            hidden={isMain()}
            disabled={s.dirty || s.cur.promote?.state === "asked"}
            title={s.cur.promote?.state === "refused" ? "Refused: " + (s.cur.promote.why ?? "") : s.dirty ? "Save first" : "Open the pull request that makes this version Tex's config"}
            onClick={() => void promoteVersion()}
          >
            {s.cur.promote?.state === "asked" ? "Promote asked" : "Promote"}
          </button>
          {s.cur.promote?.state === "opened" && s.cur.promote.pr ? (
            <a id="promotePr" href={s.cur.promote.pr} target="_blank" rel="noreferrer">
              Its pull request
            </a>
          ) : null}
            </>
          )}
          <span className="spacer" />
          <span className="sync" id="syncState">
            {s.sync}
          </span>
          <ThemeToggle />
        </div>
        <div className={"body" + (propsOn ? " props" : "") + (wide ? " wide" : "")} id="body" style={gridCols ? { gridTemplateColumns: gridCols } : undefined}>
          <nav className="side" id="side" aria-label={replay ? "Your chats" : "Lab"} hidden={s.sideHidden && !phone()}>
            {replay ? <ReplaySide moments={moments} onHide={toggleSide} /> : <>
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
              <button id="tuserSwap" aria-label={me ? "Run as Maya" : "Run as you"} onClick={swapTester}>
                <Svg className="i" style={{ width: 16, height: 16 }} d='<path d="M7 7h11l-3-3M17 17H6l3 3"/>' />
              </button>
            </div>
            <div className="tuser" id="tuser">
              <span className="av">{me ? (s.me?.name || "Y").slice(0, 1).toUpperCase() : "M"}</span>
              <div>
                <b>{me ? s.me?.name || "You" : "Maya"}</b>
                <div className="hint">{me ? "your texts replay read only" : "core and jobs run as her"}</div>
              </div>
            </div>
            <div className="sub">Workspaces</div>
            <div id="wsList">
              {me
                ? (s.me?.workspaces ?? []).map((w) => (
                    <a key={w.n} className="rowi" data-myws={w.n} href={"/console/" + encodeURIComponent(w.n)} target="_blank" rel="noopener" title={"Open " + w.n + " in a new tab"}>
                      <Ic k={w.kind === "personal" ? "door" : "thread"} style={{ color: "var(--muted)" }} />
                      <span className="nm">{w.n}</span>
                      <span className="meta">{w.role}</span>
                    </a>
                  ))
                : PEOPLE.Maya.ws.map((w) => (
                    <button key={w.n} className="rowi" data-sws={w.n} onClick={() => (closeSide(), set({ viewer: { kind: "ws", ws: w.n } }))}>
                      <Ic k={w.kind === "personal" ? "door" : "thread"} style={{ color: "var(--muted)" }} />
                      <span className="nm">{w.n}</span>
                      <span className="meta">{w.role}</span>
                    </button>
                  ))}
            </div>
            {me ? null : (
              <>
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
              </>
            )}
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
            </>}
          </nav>
          <div className="scrim" id="scrim" onClick={closeSide} />
          <main className="main" id="main">
            <div id="v-canvas" hidden={s.view !== "canvas"}>
              {/* Replay's chats, hidden, come back from a tab at the canvas's left edge, where they went (Dev2, 2026-11-14). */}
              {replay && s.sideHidden && !phone() ? (
                <button className="float rexpand" id="rExpand" aria-label="Show your chats" title="Show your chats" onClick={toggleSide}>
                  <Svg className="i" d='<path d="M9 6l6 6-6 6"/>' />
                </button>
              ) : null}
              {replay && panelHidden && !phone() ? (
                <button className="float rexpand right" id="pExpand" aria-label="Show the panel" title="Show the panel" onClick={() => setPanelHidden(false)}>
                  <Svg className="i" d='<path d="M15 6l-6 6 6 6"/>' />
                </button>
              ) : null}
              {s.view === "canvas" ? <Canvas replay={replay ? { m: moment, entries } : null} /> : null}
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
            {propsOn && replay && !phone() ? (
              <button className="ib pcollapse" id="pCollapse" aria-label="Hide the panel" title="Hide the panel" onClick={() => setPanelHidden(true)}>
                <Svg className="i" d='<path d="M9 6l6 6-6 6"/>' />
              </button>
            ) : null}
            {propsOn ? replay ? <ReplayPanel m={moment} /> : <Props /> : null}
          </aside>
        </div>
      </div>
      {me || replay ? <MineLoader /> : null}
      <div className="toast" id="toast" hidden={!s.toastText}>
        {s.toastText}
      </div>
      <div className="viewer" id="viewer" hidden={!s.viewer} role="dialog" aria-modal="true" aria-label="Module">
        {s.viewer ? <Viewer /> : null}
      </div>
    </>
  );
}
