import { useCallback, useMemo, useRef } from "react";
import { LiveMapCanvas } from "../console/map/live/LiveMapCanvas.web";
import { mapPalette, type MapData, type MapEngine } from "../console/map/live/engine";
import type { Inset } from "../console/map/live/engine/camera";
import { darkMapColors, lightMapColors } from "../design/tokens/colors";
import { useColors, useScheme } from "../design/theme";
import { useReducedMotion } from "../design/useReducedMotion";
import { darkLandingColors as darkLanding, lightLandingColors as lightLanding } from "../design/tokens/landingColors";
import { DEMO_FROM, DEMO_LOOP_MS, DEMO_TOUR, demoEvents, demoGraphs, tourStopAt, type TourStop } from "./demoMap";

/**
 * The landing pages' map: the console's live map engine playing the demo
 * (`demoMap.ts`) on a loop, with the camera touring between the workspaces.
 *
 * It is a picture, not a control. The canvas takes no pointer, so scrolling
 * the page over it scrolls the page rather than zooming the map, and nothing
 * on it can be clicked into.
 */
export type LandingMapProps = {
  /** One workspace held still, or the tour over all of them. */
  only?: string;
  tour?: readonly TourStop[];
  /** Parts of the map the page's copy covers; the camera fits the rest. */
  inset?: Inset;
  /** Drawn on the page's paper rather than the console's ground, so the map has no edge. */
  paper?: boolean;
};

const GRAPHS = demoGraphs();
const EVENTS = demoEvents();
const START = { kind: "replay", from: DEMO_FROM, to: DEMO_FROM + DEMO_LOOP_MS, at: DEMO_FROM, speed: 1, idleMs: DEMO_LOOP_MS } as const;

export function LandingMap({ only, tour = DEMO_TOUR, inset, paper = false }: LandingMapProps) {
  const colors = useColors();
  const scheme = useScheme();
  const reduced = useReducedMotion();
  const palette = useMemo(() => {
    const base = mapPalette(colors, scheme === "dark" ? darkMapColors : lightMapColors);
    const sheet = scheme === "dark" ? darkLanding : lightLanding;
    return paper ? { ...base, ground: sheet.paper, island: sheet.paper2 } : base;
  }, [colors, scheme, paper]);
  const data = useMemo<MapData>(
    () => ({
      graphs: GRAPHS,
      actors: [],
      events: EVENTS,
      scope: only === undefined ? { kind: "all" } : { kind: "one", workspaceId: only },
      view: "map",
      clock: START,
      palette,
      selfId: null,
    }),
    [only, palette],
  );

  const engine = useRef<MapEngine | null>(null);
  const stop = useRef<TourStop | null>(null);
  const goTo = useCallback((next: TourStop) => {
    const e = engine.current;
    if (e === null || stop.current === next) return;
    stop.current = next;
    if (next.workspaceId === null) e.fit();
    else e.diveInto(next.workspaceId, next.folder);
  }, []);

  const onTime = useCallback(
    (t: number) => {
      const e = engine.current;
      if (e === null) return;
      if (t >= START.to) {
        // The end of the window: back to its start, and round again.
        e.setClock(START);
        e.setPlaying(true);
        return;
      }
      if (only === undefined && !reduced) goTo(tourStopAt((t - START.from) / 1000, tour));
    },
    [goTo, only, reduced, tour],
  );

  const onEngine = useCallback((e: MapEngine | null) => {
    engine.current = e;
    stop.current = null;
  }, []);

  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <LiveMapCanvas data={data} inset={inset} reducedMotion={reduced} playing minimap={false} onEngine={onEngine} onTime={onTime} />
    </div>
  );
}
