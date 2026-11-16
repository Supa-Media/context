/**
 * The Lab's Architecture canvas: the artifact's `#v-canvas` (its lines 382-401) and the code that drew and drove it
 * (lines 653-768, and 992-1027 for focus on one step). The graph is drawn as the artifact drew it, one SVG string
 * into `#world` (`canvas/render.ts`), and driven the same way, by listeners on `#stage` that read the target's
 * `data-*` attributes (`canvas/useStageInput.web.ts`); the camera is applied straight to `#world` so panning never
 * draws again. Built to be EXACTLY the artifact (Dev2, 2026-11-13).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  G,
  lab,
  node,
  set,
  setFitter,
  toast,
  unfocus,
  undo,
} from "../engine/state";
import { stepsShownFor } from "../engine/groups";
import { groupsOf } from "../data/graph";
import { labSim } from "../engine/realTimes";
import { runTags } from "../engine/sim";
import { useLab } from "../store";
import { AddMenu } from "./canvas/AddMenu";
import { addStep } from "./canvas/actions";
import { currentMarks } from "../engine/changeMarks";
import { stepCounts } from "../engine/cases";
import { ChangeLegend, ChangeTip } from "./canvas/ChangeTip";
import {
  caseKeyHtml,
  fitCam,
  keywHtml,
  renderFocusCanvasHtml,
  renderGraphHtml,
  zoomCam,
  type Cam,
} from "./canvas/render";
import type { Lit } from "./canvas/usePlayback";
import { ReplayTimeline } from "./replay/ReplayTimeline";
import type { Moment } from "../engine/replay";
import type { LedgerEntry } from "../../page/texPageTypes";
import { useStageInput } from "./canvas/useStageInput.web";

function Svg({
  d,
  className = "i",
  style,
}: {
  d: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      style={style}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

export function Canvas({ replay = null, testLit = null }: { replay?: { m: Moment | null; entries: LedgerEntry[] } | null; testLit?: Lit | ReadonlySet<string> | null }) {
  const s = useLab();
  // Replay draws the same graph, read only, lit by its own timeline (`replay/ReplayTimeline.tsx`).
  const [replayLit, setReplayLit] = useState<Lit | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<SVGGElement>(null);
  const cam = useRef<Cam>({ x: 40, y: 40, k: 0.6 });
  const fBounds = useRef<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // The wires' key, behind the toolbar's ? (mockup W21NekNf2vtnFLXXzAmp7N, Dev2 2026-11-16: "much cleaner").
  const [keyOpen, setKeyOpen] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const applyCam = () =>
    world.current?.setAttribute(
      "transform",
      `translate(${cam.current.x},${cam.current.y}) scale(${cam.current.k})`,
    );
  const fit = () => {
    const el = stage.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const c = fitCam(G().nodes, r, lab.cfocus ? fBounds.current : null);
    if (!c) return;
    cam.current = c;
    applyCam();
  };
  const zoomBy = (f: number) => {
    const el = stage.current;
    if (!el) return;
    cam.current = zoomCam(cam.current, f, el.getBoundingClientRect());
    applyCam();
  };

  useEffect(() => {
    setFitter(fit);
    const pending = timers.current;
    const raf = requestAnimationFrame(fit);
    return () => {
      setFitter(null);
      cancelAnimationFrame(raf);
      for (const t of pending) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useStageInput({
    stage,
    cam,
    applyCam,
    closeAddMenu: () => setAddOpen(false),
  });

  // The artifact's renderCanvas: a focused step that no longer exists drops the focus.
  const g = G();
  // A focus on an open group draws the whole graph with its steps in it (Dev2, 2026-11-14: "Focus on it opens all eleven steps").
  const opened = stepsShownFor(g, lab.cfocus).length > 0;
  if (s.cfocus && !node(s.cfocus, g) && !opened) lab.cfocus = null;
  const sim = labSim(g);
  // A draft's changes against main or its last revision (`engine/changeMarks.ts`), drawn on the whole graph only.
  const marks = replay || (lab.cfocus && !opened) ? null : currentMarks();
  const tags = runTags(s.scn);
  let html: string;
  if (lab.cfocus && !opened) {
    const f = renderFocusCanvasHtml(g, sim, lab.cfocus, s.sel);
    fBounds.current = f.fBounds;
    html = f.html;
  } else {
    fBounds.current = null;
    html = renderGraphHtml(g, sim, tags, s.sel, replay ? replayLit : testLit, "off", replay ? null : stepCounts(g), replay ? null : marks);
  }
  // An open group has no box to name, so its focus bar takes the group's label (Dev2, 2026-11-14).
  const focused = lab.cfocus ? node(lab.cfocus, g) ?? (opened ? { label: groupsOf(g)[lab.cfocus]?.label ?? lab.cfocus } : undefined) : undefined;

  useLayoutEffect(applyCam);

  const tool = s.tool;
  const setTool = (t: typeof tool) => set({ tool: t });

  return (
    <>
      <div
        id="stage"
        ref={stage}
        className={
          tool === "con" ? "connect" : tool === "pan" ? "pan" : undefined
        }
      >
        <svg id="svg" aria-label="Tex architecture">
          <g
            id="world"
            ref={world}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </svg>
      </div>
      <ChangeTip marks={marks} stage={stage} />
      {/* In Replay the key leads the row on the left and the numbers stay right (Dev2, 2026-11-14: "put the key back to float left"). */}
      <div className={replay ? "ctop replay" : "ctop"}>
      {/* Replay's chat on the left already shows the text (Dev2, 2026-11-14: "this feels redundant with the left panel"); the Lab's canvas shows the test chat's text instead (Dev2, 2026-11-16: "do we really need this strip?"). */}
      {replay ? (
        <>
          <div className="float keyw" id="keyw" hidden={!!focused} dangerouslySetInnerHTML={{ __html: focused ? "" : keywHtml() }} />
        </>
      ) : null}
      {marks && !focused ? <ChangeLegend mode={marks.mode} vs={marks.vs} /> : null}
      <div className="float fbar" id="fbar" hidden={!focused}>
        {focused ? (
          <>
            <span className="hint">Focus</span>
            <b>{focused.label}</b>
            <button className="ghost" id="fbOut" onClick={unfocus}>
              Whole graph
            </button>
          </>
        ) : null}
      </div>
      </div>
      {replay ? (
        replay.m ? <ReplayTimeline m={replay.m} entries={replay.entries} onLit={setReplayLit} /> : null
      ) : (
      <>
      <div className="float tools" role="toolbar" aria-label="Tools">
        <button className="ib" id="tSel" aria-pressed={tool === "sel"} title="Select and move (V); hold space to move the canvas" aria-label="Select" onClick={() => setTool("sel")}>
          <Svg d='<path d="M6 4l12 7-5.5 1.5L10 18z"/>' />
        </button>
        <button
          className="ib"
          id="tCon"
          aria-pressed={tool === "con"}
          title="Connect: drag from one step to another (C)"
          aria-label="Connect"
          onClick={() => {
            setTool("con");
            toast("Drag from one step to another");
          }}
        >
          <Svg d='<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.5 16.5c3-1 2-8 9-9"/>' />
        </button>
        <button className="ib" id="tAdd" title="Add a step" aria-label="Add a step" onClick={() => setAddOpen(!addOpen)}>
          <Svg d='<rect x="4" y="6" width="16" height="12" rx="3"/><path d="M12 9.5v5M9.5 12h5"/>' />
        </button>
        <button className="ib" id="tUndo" title="Undo (Ctrl or ⌘ Z)" aria-label="Undo" onClick={undo}>
          <Svg d='<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>' />
        </button>
        <span className="sep" />
        <button className="ib" id="zOut" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <Svg d='<path d="M6 12h12"/>' />
        </button>
        <button className="ib" id="zFit" aria-label="Fit to screen" title="Fit" onClick={fit}>
          <Svg d='<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' />
        </button>
        <button className="ib" id="zIn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.2)}>
          <Svg d='<path d="M12 6v12M6 12h12"/>' />
        </button>
        {focused ? null : (
          <>
            <span className="sep" />
            <button className="ib" id="keyBtn" aria-pressed={keyOpen} aria-expanded={keyOpen} title="Key: what the lines mean" aria-label="Key" onClick={() => setKeyOpen(!keyOpen)}>
              <Svg d='<circle cx="12" cy="12" r="8"/><path d="M10 9.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1V13M12 16v.5"/>' />
            </button>
          </>
        )}
      </div>
      <div className="float keyw keypop" id="keyw" hidden={!!focused || !keyOpen} dangerouslySetInnerHTML={{ __html: focused || !keyOpen ? "" : keywHtml() + caseKeyHtml() }} />
      <div className="menu" id="addMenu" hidden={!addOpen}>
        <AddMenu
          onPick={(kind) => {
            setAddOpen(false);
            if (stage.current) addStep(kind, cam.current, stage.current.getBoundingClientRect());
          }}
        />
      </div>
      </>
      )}
    </>
  );
}
