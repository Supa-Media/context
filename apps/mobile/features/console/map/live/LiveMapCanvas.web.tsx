import { useEffect, useRef } from "react";

import { createMapEngine, type MapData, type MapEngine, type MapEngineOptions } from "./engine";
import type { Inset } from "./engine/camera";
import { createFaceImages } from "./faceImages";

/**
 * The live map on the web: a `<canvas>` filling its parent at the screen's
 * pixel density, driven by the engine (`./engine`). The panels, chips and
 * replay bar round it are other components; this only hands the engine its
 * data and passes its callbacks out.
 *
 * Callbacks are read through a ref, so a parent passing fresh closures every
 * render never tears the engine down.
 */
export type LiveMapCanvasProps = {
  data: MapData;
  /** Parts of the canvas covered by other UI (a bottom sheet); the camera fits the rest. */
  inset?: Inset;
  reducedMotion?: boolean;
  /** Replay: advance the playhead at the clock's speed. */
  playing?: boolean;
  /** Who is being followed, if anybody (clicking a face also follows, via `onFollow`). */
  following?: string | null;
  /** The engine, for the zoom control and breadcrumb to drive. */
  onEngine?: (engine: MapEngine | null) => void;
} & Pick<MapEngineOptions, "onCamera" | "onFollow" | "onHover" | "onOpenNote" | "onDiveInto" | "onTime" | "minimap">;

export function LiveMapCanvas(props: LiveMapCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    let engine: MapEngine | null = null;
    const faces = createFaceImages(() => engine?.redraw());
    engine = createMapEngine(canvas, {
      faceFor: faces,
      reducedMotion: !!propsRef.current.reducedMotion,
      inset: propsRef.current.inset,
      minimap: propsRef.current.minimap,
      onCamera: (info) => propsRef.current.onCamera?.(info),
      onFollow: (state) => propsRef.current.onFollow?.(state),
      onHover: (target) => propsRef.current.onHover?.(target),
      onOpenNote: (note) => propsRef.current.onOpenNote?.(note),
      onDiveInto: (folder) => propsRef.current.onDiveInto?.(folder),
      onTime: (t) => propsRef.current.onTime?.(t),
    });
    engineRef.current = engine;
    const size = () => {
      const r = host.getBoundingClientRect();
      engine?.resize(r.width, r.height, Math.min(3, window.devicePixelRatio || 1));
    };
    size();
    engine.setData(propsRef.current.data);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(size) : null;
    ro?.observe(host);
    propsRef.current.onEngine?.(engine);
    return () => {
      ro?.disconnect();
      engine?.destroy();
      engineRef.current = null;
      propsRef.current.onEngine?.(null);
    };
  }, []);

  const { data, inset, reducedMotion, playing, following } = props;
  useEffect(() => {
    engineRef.current?.setData(data);
  }, [data]);
  useEffect(() => {
    if (inset) engineRef.current?.setInset(inset);
  }, [inset]);
  useEffect(() => {
    engineRef.current?.setReducedMotion(!!reducedMotion);
  }, [reducedMotion]);
  useEffect(() => {
    engineRef.current?.setPlaying(!!playing);
  }, [playing]);
  useEffect(() => {
    if (following !== undefined) engineRef.current?.follow(following);
  }, [following]);

  return (
    <div ref={hostRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Map of the workspace: notes, links, and the people and AI tools working in it"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
