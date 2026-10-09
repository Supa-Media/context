import type { ShownFace } from "../../../faces/faceStore";
import { createMapEngine, type MapEngine, type MapEngineOptions } from "../engine/engine";
import type { MapData } from "../engine/model";
import { createFaceImages } from "../faceImages";
import { MAP_PROTOCOL_VERSION, type GuestMessage, type HostMessage } from "./protocol";

/**
 * The map inside the phone app's web view: the same engine the web build
 * draws with, on a canvas filling the page, driven by `HostMessage`s and
 * answering in `GuestMessage`s.
 *
 * Takes its bridge and its canvas as arguments, so it runs in a test without a
 * web view; `entry.ts` supplies the real ones.
 */
export type GuestBridge = {
  post: (message: GuestMessage) => void;
  listen: (handler: (raw: string) => void) => void;
};

export function mountMapGuest(
  canvas: HTMLCanvasElement,
  bridge: GuestBridge,
  size: () => { width: number; height: number; dpr: number },
  options: Pick<MapEngineOptions, "now" | "requestFrame" | "cancelFrame"> = {},
): { engine: MapEngine; resize: () => void } {
  let faces: Record<string, ShownFace> = {};
  let graphs: { version: number; graphs: MapData["graphs"] } | null = null;
  let pending: { graphsVersion: number; data: Omit<MapData, "graphs"> } | null = null;
  let minimap: boolean | undefined;

  const send = (message: GuestMessage) => bridge.post({ v: MAP_PROTOCOL_VERSION, ...message } as unknown as GuestMessage);
  const faceImages = createFaceImages(() => engine.redraw(), (name) => faces[name]);
  const engine = createMapEngine(canvas, {
    ...options,
    faceFor: faceImages,
    onCamera: (info) => send({ type: "camera", info }),
    onFollow: (state) => send({ type: "follow", state }),
    onHover: (target) => send({ type: "hover", target }),
    onOpenNote: (note) => send({ type: "openNote", note }),
    onDiveInto: (folder) => send({ type: "diveInto", folder }),
    onTime: (t) => send({ type: "time", t }),
    get minimap() {
      return minimap;
    },
  });

  // The data travels in two parts so a poll every few seconds does not resend
  // every note: it is drawn once both halves agree on the graphs.
  const draw = () => {
    if (pending === null || graphs === null || pending.graphsVersion !== graphs.version) return;
    engine.setData({ ...pending.data, graphs: graphs.graphs });
  };

  const resize = () => {
    const { width, height, dpr } = size();
    engine.resize(width, height, dpr);
  };

  bridge.listen((raw) => {
    let message: HostMessage;
    try {
      message = JSON.parse(raw) as HostMessage;
    } catch {
      return;
    }
    if (message?.v !== MAP_PROTOCOL_VERSION) return;
    switch (message.type) {
      case "graphs":
        graphs = { version: message.graphsVersion, graphs: message.graphs };
        draw();
        return;
      case "data":
        pending = { graphsVersion: message.graphsVersion, data: message.data };
        draw();
        return;
      case "props":
        minimap = message.minimap;
        if (message.inset) engine.setInset(message.inset);
        engine.setReducedMotion(message.reducedMotion);
        engine.setPlaying(message.playing);
        if (message.following !== undefined) engine.follow(message.following);
        return;
      case "faces":
        faces = message.faces;
        faceImages.clear();
        engine.redraw();
        return;
      case "call":
        call(engine, message.call);
        return;
    }
  });

  resize();
  send({ type: "ready" });
  return { engine, resize };
}

function call(engine: MapEngine, c: Extract<HostMessage, { type: "call" }>["call"]): void {
  switch (c.name) {
    case "zoomIn":
      return engine.zoomIn();
    case "zoomOut":
      return engine.zoomOut();
    case "zoomTo":
      return engine.zoomTo(c.level);
    case "fit":
      return engine.fit();
    case "focusPath":
      return engine.focusPath(c.workspaceId, c.path);
    case "diveInto":
      return engine.diveInto(c.workspaceId, c.path);
    case "select":
      return engine.select(c.note);
    case "follow":
      return engine.follow(c.actorId);
  }
}
