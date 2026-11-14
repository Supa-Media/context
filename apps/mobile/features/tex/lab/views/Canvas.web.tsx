/**
 * The Lab's Architecture canvas: the artifact's `#v-canvas` (its lines 382-401) and the code that drew and drove it
 * (lines 653-768, and 992-1027 for focus on one step). The graph is drawn as the artifact drew it, one SVG string
 * into `#world` (`canvas/render.ts`), and driven the same way, by listeners on `#stage` that read the target's
 * `data-*` attributes (`canvas/useStageInput.web.ts`); the camera is applied straight to `#world` so panning never
 * draws again. Built to be EXACTLY the artifact (Dev2, 2026-11-13).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  delSel,
  G,
  lab,
  node,
  set,
  setFitter,
  toast,
  unfocus,
  undo,
} from "../engine/state";
import { fmtS } from "../engine/sim";
import { labSim, tracedReal } from "../engine/realTimes";
import { SCENARIOS, scnLabel } from "../engine/traces";
import { useLab } from "../store";
import { AddMenu } from "./canvas/AddMenu";
import { addStep } from "./canvas/actions";
import {
  fitCam,
  keywHtml,
  renderFocusCanvasHtml,
  renderGraphHtml,
  statsHtml,
  zoomCam,
  type Cam,
} from "./canvas/render";
import { ScnPop } from "./canvas/ScnPop";
import { usePlayback } from "./canvas/usePlayback";
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

/** Playback speeds against real time: a quarter speed up to eight times faster. */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const SPEED_KEY = "tex-lab-play-speed";
const speedLabel = (v: number) => (v === 1 ? "Real time" : v < 1 ? `${1 / v}× slower` : `${v}× faster`);
function readSpeed() {
  try {
    const v = Number(window.localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}
function keepSpeed(v: number) {
  try {
    window.localStorage.setItem(SPEED_KEY, String(v));
  } catch {
    // Storage blocked: the speed lasts for this page only.
  }
}

export function Canvas() {
  const s = useLab();
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<SVGGElement>(null);
  const cam = useRef<Cam>({ x: 40, y: 40, k: 0.6 });
  const fBounds = useRef<{
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  } | null>(null);
  const [speed, setSpeed] = useState(() => readSpeed());
  // The moment the playback runs over: a new trace or new measured times start it over.
  const { lit, clock, running, toggle: play, restart, scrub, total } = usePlayback(speed, `${s.scn}|${s.ownText}|${s.real?.text ?? ""}|${s.real ? 1 : 0}`);
  const [addOpen, setAddOpen] = useState(false);
  const [scnOpen, setScnOpen] = useState(false);
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
  if (s.cfocus && !node(s.cfocus, g)) lab.cfocus = null;
  const sim = labSim(g);
  const tags = (SCENARIOS[s.scn] || SCENARIOS.own)?.tags || [];
  let html: string;
  if (lab.cfocus) {
    const f = renderFocusCanvasHtml(g, sim, lab.cfocus, s.sel);
    fBounds.current = f.fBounds;
    html = f.html;
  } else html = renderGraphHtml(g, sim, tags, s.sel, lit, "off");
  const focused = lab.cfocus ? node(lab.cfocus, g) : undefined;

  useLayoutEffect(applyCam);

  useEffect(() => {
    if (!scnOpen) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (
        !document.getElementById("scnPop")?.contains(t) &&
        !t.closest?.("#scnBtn")
      )
        setScnOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [scnOpen]);

  // A text clicked in the conversation (`ChatPanel`) asks for its moment to play once its times are read.
  const asked = useRef(s.playReq);
  useEffect(() => {
    if (s.playReq === asked.current) return;
    asked.current = s.playReq;
    restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.playReq]);

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
      <div className="ctop">
      <div className="float moment">
        <Svg
          d='<path d="M4 5h16v11H9l-5 4z"/>'
          style={{ color: "var(--muted)" }}
        />
        <button
          className="scnbtn"
          id="scnBtn"
          aria-haspopup="true"
          onClick={(e) => {
            e.stopPropagation();
            setScnOpen(!scnOpen);
          }}
        >
          <span id="scnName">{scnLabel(s.scn)}</span>
          <Svg
            d='<path d="M7 10l5 5 5-5"/>'
            style={{ width: 14, height: 14 }}
          />
        </button>
        <button
          className="ib"
          id="playBtn"
          aria-label={running ? "Pause" : "Play the moment"}
          title={running ? "Pause" : tracedReal() ? "Play at the pace it really ran" : "Play the moment"}
          style={{ width: 30, height: 30, border: "none", background: "none" }}
          onClick={play}
        >
          <Svg d={running ? '<rect x="7" y="6" width="3.5" height="12" rx="1"/><rect x="13.5" y="6" width="3.5" height="12" rx="1"/>' : '<path d="M8 5l10 7-10 7z"/>'} />
        </button>
      </div>
      <div
        className="float stats"
        id="stats"
        dangerouslySetInnerHTML={{ __html: statsHtml(sim) }}
      />
      <div className="cbreak" />
      <div
        className="float keyw"
        id="keyw"
        hidden={!!focused}
        dangerouslySetInnerHTML={{ __html: focused ? "" : keywHtml() }}
      />
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
      <div className="float playbar" aria-label="Playback">
        <input
          id="playScrub"
          type="range"
          min={0}
          max={Math.max(1, Math.round(clock?.of ?? total()))}
          step={10}
          value={Math.round(clock?.at ?? 0)}
          aria-label="Scrub through the moment"
          title="Drag to see any moment of the turn"
          onChange={(e) => scrub(Number(e.target.value))}
        />
        <span className="clock" id="playClock">
          {fmtS(clock?.at ?? 0)} / {fmtS(clock?.of ?? total())}
        </span>
        <label className="pace" title="Playback speed against real time">
          <input
            id="playSpeed"
            type="range"
            min={0}
            max={SPEEDS.length - 1}
            step={1}
            value={SPEEDS.indexOf(speed)}
            aria-label="Playback speed"
            onChange={(e) => {
              const v = SPEEDS[Number(e.target.value)] ?? 1;
              setSpeed(v);
              keepSpeed(v);
            }}
          />
          <span id="playSpeedLabel">{speedLabel(speed)}</span>
        </label>
      </div>
      <div className="float tools" role="toolbar" aria-label="Tools">
        <button
          className="ib"
          id="tSel"
          aria-pressed={tool === "sel"}
          title="Select and move (V)"
          aria-label="Select"
          onClick={() => setTool("sel")}
        >
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
        <button
          className="ib"
          id="tPan"
          aria-pressed={tool === "pan"}
          title="Move the canvas (H, or hold space)"
          aria-label="Move the canvas"
          onClick={() => setTool("pan")}
        >
          <Svg d='<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10V5a1.5 1.5 0 0 1 3 0v6M14 10.5V7a1.5 1.5 0 0 1 3 0v6.5c0 3.5-2.5 6.5-6 6.5-2.3 0-3.6-1-5-3l-2.2-3.4a1.4 1.4 0 0 1 2.2-1.7L8 13"/>' />
        </button>
        <span className="sep" />
        <button
          className="ib"
          id="tAdd"
          title="Add a step"
          aria-label="Add a step"
          onClick={() => setAddOpen(!addOpen)}
        >
          <Svg d='<rect x="4" y="6" width="16" height="12" rx="3"/><path d="M12 9.5v5M9.5 12h5"/>' />
        </button>
        <button
          className="ib"
          id="tDel"
          title="Delete the selection (Delete)"
          aria-label="Delete the selection"
          onClick={() =>
            lab.sel ? delSel() : toast("Click a step or a wire first")
          }
        >
          <Svg d='<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>' />
        </button>
        <span className="sep" />
        <button
          className="ib"
          id="tUndo"
          title="Undo (Ctrl or ⌘ Z)"
          aria-label="Undo"
          onClick={undo}
        >
          <Svg d='<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-2"/>' />
        </button>
      </div>
      <div className="menu" id="addMenu" hidden={!addOpen}>
        <AddMenu
          onPick={(kind) => {
            setAddOpen(false);
            if (stage.current)
              addStep(kind, cam.current, stage.current.getBoundingClientRect());
          }}
        />
      </div>
      <div className="scnpop" id="scnPop" hidden={!scnOpen}>
        {scnOpen ? <ScnPop onClose={() => setScnOpen(false)} /> : null}
      </div>
      <div className="float zoom">
        <button
          className="ib"
          id="zOut"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <Svg d='<path d="M6 12h12"/>' />
        </button>
        <button
          className="ib"
          id="zFit"
          aria-label="Fit to screen"
          onClick={fit}
        >
          <Svg d='<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' />
        </button>
        <button
          className="ib"
          id="zIn"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.2)}
        >
          <Svg d='<path d="M12 6v12M6 12h12"/>' />
        </button>
      </div>
    </>
  );
}
