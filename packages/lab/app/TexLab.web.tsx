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
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { AdminChrome } from "./fromApp/AdminPane";
import { StaffOnly } from "./fromApp/StaffOnly.web";
import { StaffFactorGate } from "./fromApp/StaffFactorGate";
import { api } from "@context/convex/_generated/api";
import { allCases, cvDiff, diff } from "./engine/diff";
import { G, go, isMain, lab, openVersion, set, fit, emit } from "./engine/state";
import { buildTraces } from "./engine/traces";
import { LAB_CSS } from "./labCss";
import { ensureFontsLoaded } from "./fromApp/fonts.web";
import { useLab, useLabSync, useLiveFeed, useRevBase } from "./store";
import { saveNow } from "./engine/live";
import type { View } from "./types";
import { Compare } from "./views/Compare.web";
import { Evals } from "./views/Evals.web";
import { LiveChips } from "./views/LiveChanges.web";
import { MoreMenu, RunNightly, RunSplit, SpeedMenu, VersionMenu } from "./views/bar/TopBar.web";
import { GRAPH_PAGES, stepCountsByPage, type GraphPage } from "./engine/pages";
import { Modules } from "./views/Modules.web";
import { Run } from "./views/Run.web";
import { Sim } from "./views/Sim.web";
import { Tests } from "./views/Tests.web";
import { Tools } from "./views/Tools.web";
import { Viewer } from "./views/Viewer.web";
import { MineLoader } from "./views/mine/useMine";
import { useSandbox } from "./engine/sandbox";
import { useLabUrl } from "./views/useLabUrl.web";
import { ArchCanvas } from "./views/canvas/ArchCanvas.web";
import { useLabTheme } from "./theme.web";
import { Testing } from "./views/testing/Testing.web";

export const TEX_LAB_TITLE = "Tex Architecture Lab";

const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width:820px)").matches;

const NAV: Array<[View, string, string, "modTag" | "toolTag" | "runTag" | null]> = [
  ["canvas", "Architecture", '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8 8l3 7M16 8l-3 7M8.2 7h7.6"/>', null],
  ["modules", "Context modules", '<rect x="4" y="4" width="16" height="5" rx="1.5"/><rect x="4" y="11" width="16" height="4" rx="1.5"/><rect x="4" y="17" width="16" height="3" rx="1.5"/>', "modTag"],
  ["tools", "Tools", '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-8 8a2 2 0 0 1-2.8-2.8l8-8a3.5 3.5 0 0 0-1.8-1.8z"/>', "toolTag"],
  ["sim", "Speed and cost", '<circle cx="12" cy="13" r="7"/><path d="M12 13l3-3M10 3h4"/>', null],
  ["compare", "Compare versions", '<path d="M5 20V10M12 20V4M19 20v-7"/>', null],
  ["evals", "Evals", '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>', null],
];

/** The pages other than the canvas: the artifact's `.pg > .pgin` slots, with their ids and widths. */
const PAGES: Array<[View, string, React.CSSProperties | undefined, () => React.ReactNode]> = [
  ["modules", "modPg", undefined, () => <Modules />],
  ["tools", "toolPg", { maxWidth: 1180 }, () => <Tools />],
  ["sim", "simPg", undefined, () => <Sim />],
  ["tests", "testsPg", { paddingTop: 16, maxWidth: 1180 }, () => <Tests />],
  ["run", "runPg", undefined, () => <Run />],
  ["compare", "cmpPg", undefined, () => <Compare />],
  ["evals", "evalsPg", { maxWidth: 1180 }, () => <Evals />],
];

function Svg({ d, className = "i ic", style }: { d: string; className?: string; style?: React.CSSProperties }) {
  return <svg className={className} viewBox="0 0 24 24" style={style} dangerouslySetInnerHTML={{ __html: d }} />;
}

/**
 * `/lab?v=<draft>`, the link the MCP's `tex_dev` hands out (`packages/lab/gateway/texDev/tool.js` `link`): open that draft
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

/** Each architecture's icon in the sidebar: Texting, Nightly, Search. */
const PAGE_ICONS: Record<GraphPage, string> = {
  texting: '<path d="M5 6.5h14v9H10l-4 3v-3H5z"/>',
  nightly: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
};

/**
 * The architectures under Architecture in the sidebar (Dev2, 2026-11-21: "put it as a sub component under architecture,
 * and then move texting under there, move nightly under there, and then add search under there as well. So people know
 * that we have like three different architectures"). Each is a page of the one config (`engine/pages.ts`); picking one
 * opens the canvas on it, fitted, with nothing selected, as the top bar's switcher did before. Later ones (meeting
 * summaries, say) are one more `GRAPHS` entry.
 */
function ArchPages({ onPick }: { onPick: () => void }) {
  const s = useLab();
  const counts = stepCountsByPage(G());
  const pick = (page: GraphPage) => {
    onPick();
    if (page === s.graphPage && s.view === "canvas") return;
    set({ graphPage: page, view: "canvas", sel: null, cfocus: null });
    setTimeout(fit, 0);
  };
  return (
    <div className="archpages" id="graphPages" role="group" aria-label="Architectures">
      {GRAPH_PAGES.map(([page, name]) => (
        <button
          key={page}
          className="rowi archpage"
          data-graph={page}
          aria-current={s.view === "canvas" && s.graphPage === page}
          title={`${name}: ${counts[page]} step${counts[page] === 1 ? "" : "s"}`}
          onClick={() => pick(page)}
        >
          <Svg d={PAGE_ICONS[page]} />
          <span className="nm">{name}</span>
          <span className="tag">{counts[page] || ""}</span>
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
        <StaffOnly runs="Tex" testID="tex-lab-staff-only" textClass="lede" />
      ) : isAdmin === true ? (
        <Lab />
      ) : null}
    </div>
  );
}

function Lab() {
  const s = useLab();
  const sandbox = useSandbox();
  useLiveFeed();
  useRevBase();
  const closeSide = () => set({ sideOpen: false });
  const d = diff();
  const cvn = cvDiff().length;
  const nm = Object.keys(G().modules || {}).length;
  const tags = { modTag: nm + cvn ? nm + cvn + " edited" : "", toolTag: "", runTag: d.length ? d.length + " change" + (d.length > 1 ? "s" : "") : "" };
  useLabUrl();
  const testing = s.mode === "testing";
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

  // Lab or Testing. Replay is part of the Lab (Lab live sandbox, Dev2 2026-11-16): a real text's play button shows what
  // ran in production (`engine/prodRun.ts`). Testing (Dev2, 2026-11-15): the Training, Dev and Test sets as
  // conversations, labelled per message and node.
  const setMode = (mode: "lab" | "testing") => {
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
  // The step panel floats on the canvas (`ArchCanvas.web.tsx`), so it takes no column of its own.
  const gridCols = s.sideHidden && !phone() ? "minmax(0,1fr)" : undefined;

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
            <button id="modeLab" aria-pressed={!testing} onClick={() => setMode("lab")}>
              Lab
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
          ) : (
            <>
              <VersionMenu />
              {s.graphPage === "nightly" && s.view === "canvas" ? <RunNightly /> : null}
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
        <div className={"body labnav" + (s.navMin ? " navmin" : "")} id="body" style={gridCols ? { gridTemplateColumns: gridCols } : undefined}>
          <nav className="side" id="side" aria-label="Lab" hidden={s.sideHidden && !phone()}>
            {NAV.map(([v, name, icon, tag]) => (
              <Fragment key={v}>
                <button className="rowi" data-view={v} aria-current={s.view === v && v !== "canvas"} title={name} onClick={() => (closeSide(), go(v))}>
                  <Svg d={icon} />
                  <span className="nm">{name}</span>
                  {tag ? (
                    <span className="tag" id={tag}>
                      {tags[tag]}
                    </span>
                  ) : null}
                </button>
                {v === "canvas" ? <ArchPages onPick={closeSide} /> : null}
              </Fragment>
            ))}
            <div className="sidefoot">
              <button className="rowi" id="navMin" title={s.navMin ? "Show names" : "Fold the sidebar to icons"} onClick={() => set({ navMin: !s.navMin })}>
                <Svg d={s.navMin ? '<path d="M9 6l6 6-6 6"/>' : '<path d="M15 6l-6 6 6 6"/>'} />
                <span className="nm">Collapse</span>
              </button>
            </div>
          </nav>
          <div className="scrim" id="scrim" onClick={closeSide} />
          <main className="main" id="main">
            <div id="v-canvas" hidden={s.view !== "canvas"}>
              {s.view === "canvas" ? <ArchCanvas /> : null}
            </div>
            {PAGES.map(([v, id, style, render]) => (
              <div key={v} className="pg" id={"v-" + v} hidden={s.view !== v}>
                <div className="pgin" id={id} style={style}>
                  {s.view === v ? render() : null}
                </div>
              </div>
            ))}
          </main>
        </div>
        )}
      </div>
      {/* Reads the person's own ledger, once the test chat shows real texts, so a real text's play button can show what ran (`views/mine/playProd.ts`). */}
      {s.tester === "me" || sandbox.rows.some((r) => r.prod) ? <MineLoader /> : null}
      <div className="toast" id="toast" hidden={!s.toastText}>
        {s.toastText}
      </div>
      <div className="viewer" id="viewer" hidden={!s.viewer} role="dialog" aria-modal="true" aria-label="Module">
        {s.viewer ? <Viewer /> : null}
      </div>
    </>
  );
}
