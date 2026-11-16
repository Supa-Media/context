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
import { allCases, cvDiff, diff } from "./engine/diff";
import { G, go, isMain, lab, openVersion, set, fit, emit } from "./engine/state";
import { buildTraces } from "./engine/traces";
import { LAB_CSS } from "./labCss";
import { ensureFontsLoaded } from "../../design/fonts.web";
import { useLab, useLabSync, useLiveFeed, useRevBase } from "./store";
import { saveNow } from "./engine/live";
import type { View } from "./types";
import { Canvas } from "./views/Canvas.web";
import { Compare } from "./views/Compare.web";
import { LiveChips } from "./views/LiveChanges.web";
import { MoreMenu, RunSplit, SpeedMenu, VersionMenu } from "./views/bar/TopBar.web";
import { Modules } from "./views/Modules.web";
import { Props } from "./views/Props.web";
import { Run } from "./views/Run.web";
import { Sim } from "./views/Sim.web";
import { Tests } from "./views/Tests.web";
import { Tools } from "./views/Tools.web";
import { Viewer } from "./views/Viewer.web";
import { MineLoader, readMomentDetail, refreshChat, replayEntries } from "./views/mine/useMine";
import { useLabUrl } from "./views/useLabUrl.web";
import { ReplayPanel } from "./views/replay/ReplayPanel";
import { ArchCanvas } from "./views/canvas/ArchCanvas.web";
import { openMoment, ReplaySide } from "./views/replay/ReplaySide";
import { loggedMoments, momentsOf } from "./engine/replay";
import { useLabTheme } from "./theme.web";
import { Testing } from "./views/testing/Testing.web";

/** How often Replay looks for new texts and runs. */
const REFRESH_MS = 10_000;

export const TEX_LAB_TITLE = "Tex Architecture Lab";

const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width:820px)").matches;

const NAV: Array<[View, string, string, "modTag" | "toolTag" | "runTag" | null]> = [
  ["canvas", "Architecture", '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l3 7M16 8l-3 7M8.2 7h7.6"/>', null],
  ["modules", "Context modules", '<rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="11" width="16" height="4" rx="1.5"/><rect x="4" y="17" width="16" height="3" rx="1.5"/>', "modTag"],
  ["tools", "Tools", '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8a2 2 0 0 1-2.8-2.8l8-8a3.5 3.5 0 0 0-1.8-1.8z"/>', "toolTag"],
  ["sim", "Speed and cost", '<circle cx="12" cy="13" r="7"/><path d="M12 13l3-3M10 3h4"/>', null],
  ["compare", "Compare versions", '<path d="M5 20V10M12 20V4M19 20v-7"/>', null],
];

/** The pages other than the canvas: the artifact's `.pg > .pgin` slots, with their ids and widths. */
const PAGES: Array<[View, string, React.CSSProperties | undefined, () => React.ReactNode]> = [
  ["modules", "modPg", undefined, () => <Modules />],
  ["tools", "toolPg", { maxWidth: 1180 }, () => <Tools />],
  ["sim", "simPg", undefined, () => <Sim />],
  ["tests", "testsPg", { paddingTop: 16, maxWidth: 1180 }, () => <Tests />],
  ["run", "runPg", undefined, () => <Run />],
  ["compare", "cmpPg", undefined, () => <Compare />],
];

function Svg({ d, className = "i ic", style }: { d: string; className?: string; style?: React.CSSProperties }) {
  return <svg className={className} viewBox="0 0 24 24" style={style} dangerouslySetInnerHTML={{ __html: d }} />;
}

/**
 * `/lab?v=<draft>`, the link the MCP's `tex_dev` hands out (`apps/mcp/src/texDev/tool.js` `link`): open that draft
 * once the shared list has it, live.
 */
function useOpenFromLink() {
  const s = useLab();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("v");
    if (!id) return setOpened(true);
    if (s.versions.some((v) => v.id === id)) {
      openVersion(id);
      setOpened(true);
    }
  }, [s.versions, opened]);
}

export function TexLab() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  // Staff whose session has not typed its second-factor code are asked for it here, as the console asks (`AdminPane.tsx`), never told "Staff only".
  const factor = useQuery(api.functions.staffSecondFactor.myStaffFactor, {});
  const theme = useLabTheme();
  useLabSync(isAdmin === true);
  useOpenFromLink();
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
  useLiveFeed();
  useRevBase();
  const closeSide = () => set({ sideOpen: false });
  const d = diff();
  const cvn = cvDiff().length;
  const nm = Object.keys(G().modules || {}).length;
  const tags = { modTag: nm + cvn ? nm + cvn + " edited" : "", toolTag: "", runTag: d.length ? d.length + " change" + (d.length > 1 ? "s" : "") : "" };
  useLabUrl();
  const replay = s.mode === "replay";
  const testing = s.mode === "testing";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!isMain()) void saveNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lab or Replay (Dev2, 2026-11-14: "there should be some type of toggle for replays versus the lab"). Replay reads your own chats, read only.
  // Testing (Dev2, 2026-11-15): the Training, Dev and Test sets as conversations, labelled per message and node.
  const setMode = (mode: "lab" | "replay" | "testing") => {
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
  const gridCols = s.sideHidden && !phone() ? (propsOn ? `minmax(0,1fr) ${wide ? 420 : 320}px` : "minmax(0,1fr)") : undefined;

  return (
    <>
      <div className={"app" + (s.sideOpen ? " sideopen" : "")} id="app">
        <div className="bar">
          {/* Testing has no Lab sidebar: its sets have their own hide button. */}
          {testing ? null : (
            <button className="ib" id="sideBtn" aria-label="Show or hide the sidebar" onClick={toggleSide}>
              <Svg className="i" d='<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9 4.5v15"/>' />
            </button>
          )}
          <div className="modes" role="group" aria-label="Mode">
            <button id="modeLab" aria-pressed={!replay && !testing} onClick={() => setMode("lab")}>
              Lab
            </button>
            <button id="modeReplay" aria-pressed={replay} onClick={() => setMode("replay")}>
              Replay
            </button>
            <button id="modeTesting" aria-pressed={testing} onClick={() => setMode("testing")}>
              Testing
            </button>
          </div>
          {testing ? (
            // Testing's bar is the Lab's (approved mockup https://claude.ai/artifact/PUjJ7Vd6tX6BJj7vkEir1T): the
            // version that runs, then its Dev set score and ▶ Run Dev set with the models in its menu.
            <>
              <VersionMenu />
              <span className="spacer" />
              <RunSplit />
            </>
          ) : replay ? (
            <span className="spacer" />
          ) : (
            <>
              <VersionMenu />
              <span className="dot" id="dirtyDot" title="Unsaved changes" hidden={!s.dirty} />
              {/* A saved version saves each edit as it happens, so Save shows only for what isn't saved yet (`engine/live.ts`). */}
              {s.dirty && !isMain() ? (
                <button className="primary" id="saveBtn" onClick={() => void saveNow()}>
                  Save
                </button>
              ) : null}
              <LiveChips />
              <span className="spacer" />
              <SpeedMenu />
              <RunSplit />
            </>
          )}
          <MoreMenu />
        </div>
        {testing ? (
          <div className="body testing" id="body">
            <Testing />
          </div>
        ) : (
        <div className={"body" + (replay ? "" : " labnav" + (s.navMin ? " navmin" : "")) + (propsOn ? " props" : "") + (wide ? " wide" : "")} id="body" style={gridCols ? { gridTemplateColumns: gridCols } : undefined}>
          <nav className="side" id="side" aria-label={replay ? "Your chats" : "Lab"} hidden={s.sideHidden && !phone()}>
            {replay ? <ReplaySide moments={moments} onHide={toggleSide} /> : <>
            {NAV.map(([v, name, icon, tag]) => (
              <button key={v} className="rowi" data-view={v} aria-current={s.view === v} title={name} onClick={() => (closeSide(), go(v))}>
                <Svg d={icon} />
                <span className="nm">{name}</span>
                {tag ? (
                  <span className="tag" id={tag}>
                    {tags[tag]}
                  </span>
                ) : null}
              </button>
            ))}
            <div className="sidefoot">
              <button className="rowi" id="navMin" title={s.navMin ? "Show names" : "Fold the sidebar to icons"} onClick={() => set({ navMin: !s.navMin })}>
                <Svg d={s.navMin ? '<path d="M9 6l6 6-6 6"/>' : '<path d="M15 6l-6 6 6 6"/>'} />
                <span className="nm">Collapse</span>
              </button>
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
              {s.view === "canvas" ? replay ? <Canvas replay={{ m: moment, entries }} /> : <ArchCanvas /> : null}
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
        )}
      </div>
      {replay ? <MineLoader /> : null}
      <div className="toast" id="toast" hidden={!s.toastText}>
        {s.toastText}
      </div>
      <div className="viewer" id="viewer" hidden={!s.viewer} role="dialog" aria-modal="true" aria-label="Module">
        {s.viewer ? <Viewer /> : null}
      </div>
    </>
  );
}
