import type { ShownFace } from "../../../faces/faceStore";
import type { CameraDetail, Inset } from "../engine/camera";
import type { MapEngine } from "../engine/engine";
import type { FollowState } from "../engine/follow";
import type { HitFrame, HitTarget } from "../engine/hit";
import type { MapData } from "../engine/model";
import type { MapClock } from "../types";
import { MAP_PROTOCOL_VERSION, parseGuestMessage, type HostMessage, type MapCall, type Unversioned } from "./protocol";

/**
 * The phone app's half of the map bridge, with the React taken out so it is
 * tested in plain Jest (`liveMapWebview.test.ts`). `LiveMapCanvas.tsx` is a
 * `WebView` around this.
 *
 * It holds what the guest should be showing and sends it again whenever the
 * guest says `ready` (a web view reloaded under memory pressure starts
 * blank). Graphs, every note of every workspace shown, are sent only when
 * they change; the rest of the data, which a poll replaces every few
 * seconds, travels without them.
 */
export type MapHostHandlers = {
  onCamera?: (info: CameraDetail) => void;
  onFollow?: (state: FollowState | null) => void;
  onHover?: (target: HitTarget | null) => void;
  onOpenNote?: (note: { workspaceId: string; path: string }) => void;
  onDiveInto?: (folder: { workspaceId: string; path: string }) => void;
  onTime?: (t: number) => void;
  onFailed?: (message: string) => void;
};

export type MapHostProps = {
  inset: Inset | null;
  reducedMotion: boolean;
  playing: boolean;
  following: string | null | undefined;
  minimap: boolean | undefined;
};

export type MapHost = {
  setData: (data: MapData) => void;
  setProps: (props: MapHostProps) => void;
  setFaces: (faces: Record<string, ShownFace>) => void;
  /** A raw `onMessage` payload. */
  receive: (raw: unknown) => void;
  /** The engine as the zoom control, breadcrumb and panels use it. */
  engine: MapEngine;
};

export function createMapHost(post: (raw: string) => void, handlers: () => MapHostHandlers): MapHost {
  let ready = false;
  let graphs: MapData["graphs"] | null = null;
  let graphsVersion = 0;
  let data: MapData | null = null;
  let props: MapHostProps | null = null;
  let faces: Record<string, ShownFace> = {};
  let camera: CameraDetail | null = null;
  let follow: FollowState | null = null;

  const send = (message: Unversioned<HostMessage>) => {
    if (ready) post(JSON.stringify({ v: MAP_PROTOCOL_VERSION, ...message }));
  };
  const sendData = () => {
    if (data === null) return;
    const { graphs: _graphs, ...rest } = data;
    send({ type: "data", graphsVersion, data: rest });
  };
  const sendAll = () => {
    if (graphs !== null) send({ type: "graphs", graphsVersion, graphs });
    if (props !== null) send({ type: "props", ...props });
    send({ type: "faces", faces });
    sendData();
  };
  const call = (c: MapCall) => send({ type: "call", call: c });

  const engine: MapEngine = {
    setData: (next) => host.setData(next),
    setClock: (clock: MapClock) => {
      if (data !== null) host.setData({ ...data, clock });
    },
    setPlaying: (playing) => {
      if (props !== null) host.setProps({ ...props, playing });
    },
    follow: (actorId) => call({ name: "follow", actorId }),
    select: (note) => call({ name: "select", note }),
    zoomIn: () => call({ name: "zoomIn" }),
    zoomOut: () => call({ name: "zoomOut" }),
    zoomTo: (level) => call({ name: "zoomTo", level }),
    fit: () => call({ name: "fit" }),
    focusPath: (workspaceId, path) => call({ name: "focusPath", workspaceId, path }),
    diveInto: (workspaceId, path) => call({ name: "diveInto", workspaceId, path }),
    // The web view sizes itself; nothing here draws.
    resize: () => {},
    setInset: (inset) => {
      if (props !== null) host.setProps({ ...props, inset });
    },
    setReducedMotion: (reducedMotion) => {
      if (props !== null) host.setProps({ ...props, reducedMotion });
    },
    redraw: () => {},
    getCamera: () => camera,
    getFollow: () => follow,
    // Drawing and hit testing happen in the web view; the page never asks the
    // phone for either.
    renderAt: () => ({ shapes: [] }) as unknown as HitFrame,
    hitTest: () => null,
    destroy: () => {},
  };

  const host: MapHost = {
    setData(next) {
      if (next.graphs !== graphs) {
        graphs = next.graphs;
        graphsVersion += 1;
        send({ type: "graphs", graphsVersion, graphs });
      }
      data = next;
      sendData();
    },
    setProps(next) {
      props = next;
      send({ type: "props", ...next });
    },
    setFaces(next) {
      faces = next;
      send({ type: "faces", faces });
    },
    receive(raw) {
      const message = parseGuestMessage(raw);
      if (message === null) return;
      const h = handlers();
      switch (message.type) {
        case "ready":
          ready = true;
          sendAll();
          return;
        case "failed":
          h.onFailed?.(message.message);
          return;
        case "camera":
          camera = message.info;
          h.onCamera?.(message.info);
          return;
        case "follow":
          follow = message.state;
          h.onFollow?.(message.state);
          return;
        case "hover":
          h.onHover?.(message.target);
          return;
        case "openNote":
          h.onOpenNote?.(message.note);
          return;
        case "diveInto":
          h.onDiveInto?.(message.folder);
          return;
        case "time":
          h.onTime?.(message.t);
          return;
      }
    },
    engine,
  };
  return host;
}

/** The people on the map: whose faces the guest may need. */
export function peopleIn(data: MapData): string[] {
  const names = new Set<string>();
  for (const actor of data.actors) if (actor.kind === "person") names.add(actor.name);
  for (const event of data.events) if (event.actor.kind === "person") names.add(event.actor.name);
  return [...names].sort();
}
