import type { MapClock, ZoomLevel } from "../types";
import {
  NO_INSET,
  camAt,
  camForLevel,
  cameraInfo,
  clampScale,
  fitAll,
  fitCircle,
  fitIsland,
  flightDuration,
  toWorld,
  visibleRect,
  type Cam,
  type CamFlight,
  type CameraDetail,
  type Inset,
  type Viewport,
} from "./camera";
import { renderFolders } from "./folders";
import { HitFrame, hitTest, type HitTarget } from "./hit";
import { attachInput } from "./input";
import type { IslandPlace } from "./layout";
import { buildModel, createMemory, type MapData } from "./model";
import { noteKey } from "./paths";
import { NARROW, renderMap } from "./draw/render";
import { FACES_APART_PX } from "./lod";
import { SPACING } from "./pack";
import { DEFAULT_FONT, type FaceFor, type Style } from "./draw/primitives";
import { sceneAt, type Model, type SceneAt } from "./scene";
import { focusTarget, followSnapshot, type FollowState } from "./follow";

/**
 * The live map's canvas engine: `createMapEngine(canvas, options)` returns a
 * controller the React wrapper drives with `setData` and the camera methods.
 *
 * It draws only what `setData` gave it, keeps no network or theme of its own,
 * and runs its animation loop only while something is moving, the canvas is
 * visible, and (for a replay) the playhead is playing.
 */

export type MapEngineOptions = {
  /** A person's picture. Agents are always drawn as the robot. */
  faceFor?: FaceFor;
  reducedMotion?: boolean;
  /** Parts of the canvas covered by other UI (a bottom sheet); the camera fits the rest. */
  inset?: Inset;
  /** Draw the overview in the top-right corner once zoomed in. Default true. */
  minimap?: boolean;
  font?: string;
  /** Replay: how long somebody stays on the map after their last event. Default 10 minutes. */
  idleMs?: number;
  onCamera?: (info: CameraDetail) => void;
  onFollow?: (state: FollowState | null) => void;
  onHover?: (target: HitTarget | null) => void;
  onOpenNote?: (note: { workspaceId: string; path: string }) => void;
  onDiveInto?: (folder: { workspaceId: string; path: string }) => void;
  /** Replay: the playhead while the engine plays it. */
  onTime?: (t: number) => void;
  /** Injected for tests: wall clock and frame scheduling. */
  now?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
};

export type MapEngine = {
  setData(data: MapData): void;
  setClock(clock: MapClock): void;
  /** Replay: advance the playhead at the clock's speed. */
  setPlaying(playing: boolean): void;
  follow(actorId: string | null): void;
  select(note: { workspaceId: string; path: string } | null): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomTo(level: ZoomLevel): void;
  fit(): void;
  focusPath(workspaceId: string, path: string): void;
  diveInto(workspaceId: string, folderPath: string): void;
  resize(width: number, height: number, dpr?: number): void;
  setInset(inset: Inset): void;
  setReducedMotion(reduced: boolean): void;
  /** Draw again (a face image finished loading). */
  redraw(): void;
  getCamera(): CameraDetail | null;
  getFollow(): FollowState | null;
  /** Draw now at time `t` (a replay frame, or a test). */
  renderAt(t: number): HitFrame;
  hitTest(x: number, y: number): HitTarget | null;
  destroy(): void;
};

const MIN_TICK = 1000 / 60;

export function createMapEngine(canvas: HTMLCanvasElement, options: MapEngineOptions = {}): MapEngine {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The map needs a 2D canvas.");
  const now = options.now ?? (() => Date.now());
  const raf = options.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
  const caf = options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));
  const memory = createMemory();
  let data: MapData | null = null;
  let model: Model | null = null;
  let vp: Viewport = { w: canvas.clientWidth || canvas.width || 300, h: canvas.clientHeight || canvas.height || 150, inset: options.inset ?? NO_INSET };
  let dpr = 1;
  let cam: Cam | null = null;
  let flight: CamFlight | null = null;
  let reduced = !!options.reducedMotion;
  let following: string | null = null;
  let selected: string | null = null;
  let playing = false;
  let replayAt = 0;
  let lastTick = 0;
  let frameId: number | null = null;
  let visible = true;
  let hit = new HitFrame();
  let hovered = "";
  let lastCameraSig = "";
  let lastFollowSig = "";
  let lastScope = "";
  let foldersScroll = 0;
  let foldersWidth = 0;
  let destroyed = false;

  const style = (): Style => ({ palette: data!.palette, font: options.font ?? DEFAULT_FONT, faceFor: options.faceFor ?? null });
  const timeNow = (): number => (data?.clock.kind === "replay" ? replayAt : now());
  const rebuild = () => {
    if (!data) return;
    model = buildModel(data, memory, now(), { idleMs: options.idleMs ?? 600_000, reducedMotion: reduced, following });
  };

  const fitCam = (): Cam => {
    const layout = model!.layout;
    if (model!.scope.kind === "all") return fitAll(vp, layout);
    const island = layout.islands[0];
    if (!island) return { x: 0, y: 0, s: 1 };
    const fit = fitIsland(vp, island);
    // A phone frames the middle of the workspace close enough to see faces, not all of it.
    if (visibleRect(vp).w < NARROW) return { ...fit, s: Math.max(fit.s, (FACES_APART_PX + 2) / SPACING) };
    return fit;
  };

  const flyTo = (to: Cam) => {
    if (!model) return;
    const target = clampScale(model.layout, vp, to, model.scope);
    const from = currentCam();
    if (reduced || !from) {
      cam = target;
      flight = null;
    } else {
      flight = { from, to: target, start: now(), duration: flightDuration(from, target, vp) };
    }
    wake();
  };

  const currentCam = (): Cam | null => {
    if (flight) {
      const { cam: c, done } = camAt(flight, now());
      if (done) {
        cam = flight.to;
        flight = null;
        return cam;
      }
      return c;
    }
    return cam;
  };

  const drawFrame = (t: number): SceneAt | null => {
    if (!model || !data) return null;
    const c = currentCam();
    if (!c) return null;
    const scene = sceneAt(model, t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (model.view === "folders") {
      const island = foldersIsland(c);
      if (island) {
        const out = renderFolders(ctx, model, scene, island, vp, foldersScroll, style());
        hit = out.hit;
        foldersWidth = out.contentW;
      }
    } else {
      hit = renderMap(ctx, model, scene, c, vp, { style: style(), selected, minimap: options.minimap ?? true });
      emitCamera(c);
    }
    emitFollow(scene);
    return scene;
  };

  const foldersIsland = (c: Cam): IslandPlace | null => {
    const layout = model!.layout;
    if (layout.islands.length <= 1) return layout.islands[0] ?? null;
    let best: IslandPlace | null = null;
    let bestD = Infinity;
    for (const i of layout.islands) {
      const d = Math.hypot(i.x - c.x, i.y - c.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const emitCamera = (c: Cam) => {
    if (!options.onCamera || !model) return;
    const info = cameraInfo(model.layout, vp, c, model.scope);
    const sig = `${info.level}|${info.trail.join("/")}|${info.zoom.toFixed(3)}`;
    if (sig === lastCameraSig) return;
    lastCameraSig = sig;
    options.onCamera(info);
  };

  const emitFollow = (scene: SceneAt) => {
    if (!options.onFollow) return;
    const state = following ? followSnapshot(following, scene) : null;
    const sig = state ? `${state.actorId}|${state.reads.map((r) => r.path).join("|")}|${state.doing}` : "";
    if (sig === lastFollowSig) return;
    lastFollowSig = sig;
    options.onFollow(state);
  };

  const tick = () => {
    frameId = null;
    if (destroyed || !visible || !data) return;
    const wall = now();
    if (data.clock.kind === "replay" && playing) {
      const dt = lastTick ? Math.min(250, wall - lastTick) : MIN_TICK;
      replayAt = Math.min(data.clock.to, replayAt + dt * data.clock.speed);
      options.onTime?.(replayAt);
      if (replayAt >= data.clock.to) playing = false;
    }
    lastTick = wall;
    const scene = drawFrame(timeNow());
    const moving = !!flight || (scene?.animating ?? false) || playing;
    if (moving) frameId = raf(tick);
    else lastTick = 0;
  };

  function wake(): void {
    if (frameId === null && visible && !destroyed) frameId = raf(tick);
  }

  // Gestures.
  const detach = attachInput(canvas, {
    grab: () => {
      if (flight) {
        cam = currentCam();
        flight = null;
      }
    },
    pan: (dx, dy) => {
      if (!model || !cam) return;
      if (model.view === "folders") {
        foldersScroll = Math.max(0, Math.min(foldersScroll - dx, Math.max(0, foldersWidth - visibleRect(vp).w)));
      } else {
        cam = { ...cam, x: cam.x - dx / cam.s, y: cam.y - dy / cam.s };
      }
      wake();
    },
    zoom: (factor, x, y) => {
      if (!model || !cam) return;
      if (model.view === "folders") return;
      const anchor = toWorld(cam, vp, { x, y });
      const next = clampScale(model.layout, vp, { ...cam, s: cam.s * factor }, model.scope);
      const r = visibleRect(vp);
      cam = { s: next.s, x: anchor.x - (x - r.x - r.w / 2) / next.s, y: anchor.y - (y - r.y - r.h / 2) / next.s };
      wake();
    },
    tap: (x, y) => {
      const target = hitTest(hit, x, y);
      if (!target) return;
      if (target.kind === "actor") api.follow(following === target.id ? null : target.id);
      else if (target.kind === "pile") zoomToPile(target.ids);
      else if (target.kind === "note") options.onOpenNote?.({ workspaceId: target.workspaceId, path: target.path });
    },
    doubleTap: (x, y) => {
      const target = hitTest(hit, x, y);
      if (!target) return;
      if (target.kind === "folder") api.diveInto(target.workspaceId, target.path);
      else if (target.kind === "workspace") {
        const island = model?.layout.islands.find((i) => i.workspaceId === target.workspaceId);
        if (island) flyTo(fitIsland(vp, island));
      }
    },
    hover: (x, y) => {
      const target = hitTest(hit, x, y);
      const sig = target ? JSON.stringify(target) : "";
      if (sig === hovered) return;
      hovered = sig;
      canvas.style.cursor = target && target.kind !== "workspace" ? "pointer" : "";
      options.onHover?.(target);
    },
    leave: () => {
      if (hovered === "") return;
      hovered = "";
      canvas.style.cursor = "";
      options.onHover?.(null);
    },
  });

  const zoomToPile = (ids: string[]) => {
    if (!model) return;
    const scene = sceneAt(model, timeNow());
    const a = scene.actors.find((x) => ids.includes(x.id));
    if (!a) return;
    const c = currentCam() ?? fitCam();
    flyTo({ x: a.x, y: a.y, s: c.s * 2.6 });
  };

  // Stop drawing while nobody can see the canvas.
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((e) => e.isIntersecting) && !(typeof document !== "undefined" && document.hidden);
          if (visible) wake();
        })
      : null;
  io?.observe(canvas);
  const onVisibility = () => {
    visible = !document.hidden;
    if (visible) wake();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const api: MapEngine = {
    setData(next) {
      const scopeSig = `${next.scope.kind === "all" ? "*" : next.scope.workspaceId}|${next.view}`;
      const clockChanged = !data || data.clock.kind !== next.clock.kind || (next.clock.kind === "replay" && data.clock.kind === "replay" && next.clock.at !== data.clock.at);
      data = next;
      if (next.clock.kind === "replay" && clockChanged) replayAt = next.clock.at;
      rebuild();
      if (!cam || scopeSig !== lastScope) {
        cam = fitCam();
        flight = null;
        foldersScroll = 0;
      }
      lastScope = scopeSig;
      wake();
    },
    setClock(clock) {
      if (!data) return;
      const wasLive = data.clock.kind === "live";
      data = { ...data, clock };
      if (clock.kind === "replay") replayAt = clock.at;
      if (wasLive !== (clock.kind === "live")) rebuild();
      else if (model) model = { ...model, speed: clock.kind === "replay" ? clock.speed : 1 };
      wake();
    },
    setPlaying(next) {
      playing = next && data?.clock.kind === "replay";
      lastTick = 0;
      wake();
    },
    follow(actorId) {
      following = actorId;
      if (model) model = { ...model, following };
      lastFollowSig = "\u0000";
      if (actorId && model && cam) {
        const scene = sceneAt(model, timeNow());
        const target = focusTarget(scene, actorId, model.layout, vp, currentCam() ?? cam);
        if (target) flyTo(target);
      }
      if (!actorId) options.onFollow?.(null);
      wake();
    },
    select(note) {
      selected = note ? noteKey(note.workspaceId, note.path) : null;
      wake();
    },
    zoomIn() {
      stepLevel(1);
    },
    zoomOut() {
      stepLevel(-1);
    },
    zoomTo(level) {
      if (!model || !cam) return;
      flyTo(camForLevel(model.layout, vp, currentCam() ?? cam, model.scope, level));
    },
    fit() {
      if (model) flyTo(fitCam());
    },
    focusPath(workspaceId, path) {
      if (!model) return;
      const layout = model.layout;
      const note = layout.notes.get(noteKey(workspaceId, path));
      if (note) {
        flyTo({ x: note.x, y: note.y, s: camForLevel(layout, vp, { x: note.x, y: note.y, s: 1 }, model.scope, "notes").s });
        return;
      }
      api.diveInto(workspaceId, path);
    },
    diveInto(workspaceId, folderPath) {
      if (!model) return;
      const clean = folderPath.replace(/\/+$/, "");
      const [root = "", sub = ""] = clean.split("/");
      const island = model.layout.islands.find((i) => i.workspaceId === workspaceId);
      const folder = island?.folders.find((f) => f.name === root);
      const place = (sub && folder?.subs.find((s) => s.name === sub)) || folder || island;
      if (!place) return;
      if ("folders" in place) flyTo(fitIsland(vp, place));
      else flyTo(fitCircle(vp, place.x, place.y, place.r, "subs" in place ? 2.4 : 2.35));
      options.onDiveInto?.({ workspaceId, path: clean ? `${clean}/` : "" });
    },
    resize(width, height, ratio = 1) {
      const prev = vp;
      vp = { ...vp, w: Math.max(1, width), h: Math.max(1, height) };
      dpr = ratio;
      canvas.width = Math.round(vp.w * dpr);
      canvas.height = Math.round(vp.h * dpr);
      if (cam && model && (prev.w !== vp.w || prev.h !== vp.h)) {
        // Keep the same world width in view when the canvas changes size.
        const k = Math.min(visibleRect(vp).w, visibleRect(vp).h) / Math.min(visibleRect(prev).w, visibleRect(prev).h);
        cam = { ...cam, s: cam.s * (Number.isFinite(k) && k > 0 ? k : 1) };
      }
      tick();
    },
    setInset(inset) {
      vp = { ...vp, inset };
      wake();
    },
    setReducedMotion(next) {
      reduced = next;
      if (model) model = { ...model, reducedMotion: next };
      wake();
    },
    redraw() {
      wake();
    },
    getCamera() {
      const c = currentCam();
      return c && model ? cameraInfo(model.layout, vp, c, model.scope) : null;
    },
    getFollow() {
      if (!following || !model) return null;
      return followSnapshot(following, sceneAt(model, timeNow()));
    },
    renderAt(t) {
      if (data?.clock.kind === "replay") replayAt = t;
      drawFrame(t);
      return hit;
    },
    hitTest(x, y) {
      return hitTest(hit, x, y);
    },
    destroy() {
      destroyed = true;
      if (frameId !== null) caf(frameId);
      frameId = null;
      detach();
      io?.disconnect();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };

  const stepLevel = (dir: 1 | -1) => {
    if (!model || !cam) return;
    const c = currentCam() ?? cam;
    const info = cameraInfo(model.layout, vp, c, model.scope);
    const levels = Object.keys(info.stops) as ZoomLevel[];
    const order: ZoomLevel[] = ["all", "workspace", "folders", "notes"];
    const shown = order.filter((l) => levels.includes(l));
    const here = shown.indexOf(info.level);
    const nextLevel = shown[Math.max(0, Math.min(shown.length - 1, here + dir))]!;
    if (nextLevel === info.level) {
      flyTo({ ...c, s: c.s * (dir > 0 ? 1.6 : 1 / 1.6) });
      return;
    }
    flyTo(camForLevel(model.layout, vp, c, model.scope, nextLevel));
  };

  return api;
}

export type { CameraDetail, FollowState, HitTarget, Inset, MapData };
