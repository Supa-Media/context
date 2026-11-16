/**
 * The Lab's Architecture canvas: the artifact's `#v-canvas` (its lines 382-401) and the code that drew and drove it
 * (lines 653-768, and 992-1027 for focus on one step). The graph is drawn as the artifact drew it, one SVG string
 * into `#world` (`canvas/render.ts`), and driven the same way, by listeners on `#stage` that read the target's
 * `data-*` attributes (`canvas/useStageInput.web.ts`); the camera is applied straight to `#world` so panning never
 * draws again. Built to be EXACTLY the artifact (Dev2, 2026-11-13).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  G,
  lab,
  node,
  set,
  setFitter,
  toast,
  undo,
} from "../engine/state";
import { isGroupFocus } from "../engine/groups";
import { FocusPath } from "./canvas/FocusPath.web";
import { renderGroupFocusHtml } from "./canvas/groupView";
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
import type { LabGraph } from "../types";
import type { Lit } from "./canvas/usePlayback";
import { setCanvasReadOnly, useStageInput } from "./canvas/useStageInput.web";
import { useFollowRunning } from "./props/useFollowRunning";
import { lineNodes } from "../engine/lineSteps";
import { useSandbox } from "../engine/sandbox";
import { usePlay } from "../engine/sandboxPlay";
import { panelRow } from "../engine/stepRunNow";
import { lineDecorHtml, lineTimes } from "./canvas/lineDecor";

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

/**
 * `lead` sits first in the canvas's top-left row, before the change legend (the run pill, mockup's top-left): the two
 * share one wrapping row, so they never cover each other.
 */
export function Canvas({ testLit = null, graph = null, lead = null }: { testLit?: Lit | ReadonlySet<string> | null; graph?: LabGraph | null; lead?: ReactNode }) {
  const s = useLab();
  useFollowRunning();
  const sbId = useSandbox().id;
  const { play, pick } = usePlay();
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
    const b = el.getBoundingClientRect();
    // The step card floats over the canvas's right side: fit the graph beside it, as the mockup's fit does.
    const r = { width: b.width - (lab.sel && b.width > 900 ? 350 : 0), height: b.height };
    // The test chat's line is fitted in too, as the mockup's fit does (`canvas/lineDecor.ts`).
    const c = fitCam(lab.cfocus ? G().nodes : [...G().nodes, ...lineNodes(G())], r, lab.cfocus ? fBounds.current : null);
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

  // A test chat opened (or closed) adds (or takes away) its line beside the graph: fit again so it is in view.
  useEffect(() => {
    if (sbId !== undefined) requestAnimationFrame(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sbId]);

  useStageInput({
    stage,
    cam,
    applyCam,
    closeAddMenu: () => setAddOpen(false),
  });

  // The artifact's renderCanvas: a focused step that no longer exists drops the focus.
  // A real text's run draws the graph Tex had then, read only (`ArchCanvas.web.tsx`); else the version open.
  const g = graph ?? G();
  setCanvasReadOnly(!!graph);
  // A focus on a group opens just that group: its steps and the cards of the groups inside it, nothing else (mockup
  // 5y8sZpxqRYNZEdqqXTjq6J v3, Dev2 2026-11-16: "when I click focus on a group, I want it to open just that group").
  const groups = groupsOf(g);
  const opened = isGroupFocus(g, lab.cfocus, groups);
  if (s.cfocus && !node(s.cfocus, g) && !opened) lab.cfocus = null;
  const sim = labSim(g);
  // A draft's changes against main or its last revision (`engine/changeMarks.ts`), drawn on the whole graph only.
  const marks = graph || (lab.cfocus && !opened) ? null : currentMarks();
  const tags = runTags(s.scn);
  let html: string;
  if (lab.cfocus && !opened) {
    const f = renderFocusCanvasHtml(g, sim, lab.cfocus, s.sel);
    fBounds.current = f.fBounds;
    html = f.html;
  } else if (lab.cfocus && opened) {
    const f = renderGroupFocusHtml(g, sim, lab.cfocus, groups, { tags, sel: s.sel, lit: testLit, counts: stepCounts(g), marks });
    fBounds.current = f.fBounds;
    html = f.html;
  } else {
    fBounds.current = null;
    // The test chat's line: two view-only pseudo-steps beside the graph, never in it (`canvas/lineDecor.ts`).
    const line = lineDecorHtml(g, s.sel, testLit, lineTimes(panelRow(pick, play)?.steps));
    html = line.under + renderGraphHtml(g, sim, tags, s.sel, testLit, "off", stepCounts(g), marks, { groups }) + line.over;
  }
  // The focus bar is the path to the focus: Whole graph / each group around it / it (mockup 5y8sZpxqRYNZEdqqXTjq6J v3).
  const focused = lab.cfocus && (opened || node(lab.cfocus, g)) ? lab.cfocus : null;
  // A step's own view hides the wires' key and the change legend, as it always has; an open group is a graph and keeps them.
  const stepView = !!focused && !opened;

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
      <div className="ctop">
      {lead}
      <div className="float fbar" id="fbar" hidden={!focused}>
        {focused ? <FocusPath g={g} id={focused} opened={opened} /> : null}
      </div>
      {marks && !stepView ? <ChangeLegend mode={marks.mode} vs={marks.vs} /> : null}
      </div>
      {focused ? (
        <div className="ghint">
          <span className="kbd">Esc</span> up one level
        </div>
      ) : g.folded && Object.keys(g.folded).length ? (
        <div className="ghint">Double-click a group, or its ⤢, to open it</div>
      ) : null}
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
        {stepView ? null : (
          <>
            <span className="sep" />
            <button className="ib" id="keyBtn" aria-pressed={keyOpen} aria-expanded={keyOpen} title="Key: what the lines mean" aria-label="Key" onClick={() => setKeyOpen(!keyOpen)}>
              <Svg d='<circle cx="12" cy="12" r="8"/><path d="M10 9.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1V13M12 16v.5"/>' />
            </button>
          </>
        )}
      </div>
      <div className="float keyw keypop" id="keyw" hidden={stepView || !keyOpen} dangerouslySetInnerHTML={{ __html: stepView || !keyOpen ? "" : keywHtml() + caseKeyHtml() }} />
      <div className="menu" id="addMenu" hidden={!addOpen}>
        <AddMenu
          onPick={(kind) => {
            setAddOpen(false);
            if (stage.current) addStep(kind, cam.current, stage.current.getBoundingClientRect());
          }}
        />
      </div>
      </>
    </>
  );
}
