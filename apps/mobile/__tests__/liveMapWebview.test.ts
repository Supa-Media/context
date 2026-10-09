/**
 * The phone app's map: the web build's engine in a web view, and the bridge
 * between them (`map/live/webview/`). The host and the guest are tested here
 * wired to each other through JSON strings, the only thing a real web view
 * carries, with the fake canvas the engine's other tests use.
 */
import { describe, expect, test } from "@jest/globals";
import type { MapData } from "../features/console/map/live/engine/model";
import { mountMapGuest } from "../features/console/map/live/webview/guest";
import { createMapHost, peopleIn, type MapHostHandlers } from "../features/console/map/live/webview/host";
import { MAP_PROTOCOL_VERSION, parseGuestMessage } from "../features/console/map/live/webview/protocol";
import { ev, fakeCanvas, palette, para, WHO } from "./liveMapFixture";

const W = 390;
const H = 700;

function mapData(graphs = [para("ws-a", "Personal", 8)]): MapData {
  return { graphs, actors: [], events: [], scope: { kind: "one", workspaceId: "ws-a" }, view: "map", clock: { kind: "live" }, palette, selfId: null };
}

const PROPS = { inset: null, reducedMotion: true, playing: false, following: undefined, minimap: undefined };

/** A host and a guest joined by an in-memory web view; `toGuest` records what crossed. */
function wired(handlers: MapHostHandlers = {}) {
  const toGuest: Record<string, unknown>[] = [];
  // Frames run when the test says, as a web view's would between messages.
  let frames: ((t: number) => void)[] = [];
  const flush = () => {
    const due = frames;
    frames = [];
    for (const frame of due) frame(0);
  };
  let listener: ((raw: string) => void) | null = null;
  const host = createMapHost(
    (raw) => {
      toGuest.push(JSON.parse(raw));
      listener?.(raw);
    },
    () => handlers,
  );
  const mount = () => {
    listener = null;
    return mountMapGuest(
      fakeCanvas(W, H),
      { post: (message) => host.receive(JSON.stringify(message)), listen: (handler) => (listener = handler) },
      () => ({ width: W, height: H, dpr: 1 }),
      { now: () => 0, requestFrame: (frame) => frames.push(frame), cancelFrame: () => {} },
    );
  };
  return { host, toGuest, mount, flush };
}

describe("what the app accepts from the web view", () => {
  const msg = (body: Record<string, unknown>) => JSON.stringify({ v: MAP_PROTOCOL_VERSION, ...body });

  test("a note to open is rebuilt field by field", () => {
    expect(parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "ws-a", path: "1-projects/a.md", extra: "x" } }))).toEqual({
      type: "openNote",
      note: { workspaceId: "ws-a", path: "1-projects/a.md" },
    });
  });

  test("where a note was tapped comes across only as two finite numbers", () => {
    const open = (at: unknown) => parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "ws-a", path: "a.md", at } }));
    expect(open({ x: 120.5, y: 40, z: 1 })).toEqual({ type: "openNote", note: { workspaceId: "ws-a", path: "a.md", at: { x: 120.5, y: 40 } } });
    // A bad point loses the point, not the tap: the card still opens, at its corner.
    for (const bad of [{ x: "1", y: 2 }, { x: Number.MAX_VALUE, y: 2 }, { x: 1 }, [1, 2], "1,2", null]) {
      expect(open(bad)).toEqual({ type: "openNote", note: { workspaceId: "ws-a", path: "a.md" } });
    }
    expect(parseGuestMessage(msg({ type: "tapEmpty", extra: true }))).toEqual({ type: "tapEmpty" });
  });

  test("anything not exactly a message is dropped", () => {
    expect(parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "ws-a" } }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "ws-a", path: 7 } }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "", path: "a.md" } }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "openNote", note: { workspaceId: "w".repeat(257), path: "a.md" } }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "diveInto", folder: null }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "time", t: "soon" }))).toBeNull();
    expect(parseGuestMessage(msg({ type: "navigate", url: "https://example.com" }))).toBeNull();
    expect(parseGuestMessage(JSON.stringify({ v: 2, type: "ready" }))).toBeNull();
    expect(parseGuestMessage("{not json")).toBeNull();
    expect(parseGuestMessage({ type: "ready" })).toBeNull();
    expect(parseGuestMessage(msg({ type: "failed", message: "x".repeat(1_000_001) }))).toBeNull();
  });
});

describe("the host", () => {
  test("sends nothing until the web view says it is ready, then everything", () => {
    const sent: Record<string, unknown>[] = [];
    const host = createMapHost((raw) => sent.push(JSON.parse(raw)), () => ({}));
    host.setData(mapData());
    host.setProps(PROPS);
    expect(sent).toEqual([]);
    host.receive(JSON.stringify({ v: MAP_PROTOCOL_VERSION, type: "ready" }));
    expect(sent.map((m) => m.type)).toEqual(["graphs", "props", "faces", "data"]);
    expect(sent.every((m) => m.v === MAP_PROTOCOL_VERSION)).toBe(true);
    // The rest of the data travels without every note in it.
    expect((sent[3]!.data as Record<string, unknown>).graphs).toBeUndefined();
  });

  test("sends the graphs again only when they change", () => {
    const sent: Record<string, unknown>[] = [];
    const host = createMapHost((raw) => sent.push(JSON.parse(raw)), () => ({}));
    host.receive(JSON.stringify({ v: MAP_PROTOCOL_VERSION, type: "ready" }));
    const first = mapData();
    host.setData(first);
    host.setData({ ...first, events: [ev.edit(5, "ws-a", "index.md", WHO.maya)] });
    host.setData(mapData());
    const types = sent.filter((m) => m.type !== "faces").map((m) => `${m.type}@${m.graphsVersion}`);
    expect(types).toEqual(["graphs@1", "data@1", "data@1", "graphs@2", "data@2"]);
  });

  test("answers the page's callbacks with what the guest sent", () => {
    const opened: unknown[] = [];
    const host = createMapHost(() => {}, () => ({ onOpenNote: (note) => opened.push(note) }));
    host.receive(JSON.stringify({ v: 1, type: "openNote", note: { workspaceId: "ws-a", path: "index.md" } }));
    host.receive(JSON.stringify({ v: 1, type: "openNote", note: { path: "index.md" } }));
    expect(opened).toEqual([{ workspaceId: "ws-a", path: "index.md" }]);
  });

  test("a tap on nothing reaches the page", () => {
    let taps = 0;
    const host = createMapHost(() => {}, () => ({ onTapEmpty: () => (taps += 1) }));
    host.receive(JSON.stringify({ v: 1, type: "tapEmpty" }));
    expect(taps).toBe(1);
  });

  test("a camera to put back and a note to highlight wait for the web view, then go after the data", () => {
    const sent: Record<string, unknown>[] = [];
    const host = createMapHost((raw) => sent.push(JSON.parse(raw)), () => ({}));
    host.setData(mapData());
    host.setProps(PROPS);
    host.engine.restoreCamera({ x: 1, y: 2, s: 3 });
    host.engine.select({ workspaceId: "ws-a", path: "index.md" });
    expect(sent).toEqual([]);
    host.receive(JSON.stringify({ v: MAP_PROTOCOL_VERSION, type: "ready" }));
    expect(sent.map((m) => (m.type === "call" ? `call:${(m.call as { name: string }).name}` : m.type))).toEqual([
      "graphs",
      "props",
      "faces",
      "data",
      "call:restoreCamera",
      "call:select",
    ]);
    // Sent once: a reload later does not drag the old camera back.
    sent.length = 0;
    host.receive(JSON.stringify({ v: MAP_PROTOCOL_VERSION, type: "ready" }));
    expect(sent.some((m) => m.type === "call")).toBe(false);
  });

  test("names the people whose faces the guest may need", () => {
    const data = { ...mapData(), events: [ev.edit(5, "ws-a", "index.md", WHO.maya), ev.edit(6, "ws-a", "index.md", WHO.claude)] };
    expect(peopleIn(data)).toEqual(["Maya"]);
  });
});

describe("the host and the guest together", () => {
  test("the guest draws the map it was sent, and the camera comes back", () => {
    const { host, mount, flush } = wired();
    host.setData(mapData());
    host.setProps(PROPS);
    const guest = mount();
    flush();
    expect(guest.engine.getCamera()).not.toBeNull();
    expect(host.engine.getCamera()?.cam).toEqual(guest.engine.getCamera()?.cam);
  });

  test("coming back to the map, the web view is put back where it was", () => {
    const first = wired();
    first.host.setData(mapData());
    first.host.setProps(PROPS);
    const before = first.mount();
    first.host.engine.zoomIn();
    first.host.engine.zoomIn();
    const left = before.engine.getCamera()!.cam;
    // The map unmounts (a note was opened) and mounts again on Back.
    const again = wired();
    again.host.setData(mapData());
    again.host.setProps(PROPS);
    again.host.engine.restoreCamera(left);
    const after = again.mount();
    expect(after.engine.getCamera()!.cam).toEqual(left);
  });

  test("zooming on the phone zooms the map in the web view", () => {
    const { host, mount } = wired();
    host.setData(mapData());
    host.setProps(PROPS);
    const guest = mount();
    const before = guest.engine.getCamera()!.cam.s;
    host.engine.zoomIn();
    expect(guest.engine.getCamera()!.cam.s).toBeGreaterThan(before);
  });

  test("a guest that reloads gets everything again", () => {
    const { host, toGuest, mount } = wired();
    host.setData(mapData());
    host.setProps(PROPS);
    mount();
    toGuest.length = 0;
    // The web view's content process died and it started blank.
    const again = mount();
    expect(toGuest.map((m) => m.type)).toEqual(["graphs", "props", "faces", "data"]);
    expect(again.engine.getCamera()).not.toBeNull();
  });

  test("the guest never draws data against graphs it does not have", () => {
    let listener: ((raw: string) => void) | null = null;
    const guest = mountMapGuest(
      fakeCanvas(W, H),
      { post: () => {}, listen: (handler) => (listener = handler) },
      () => ({ width: W, height: H, dpr: 1 }),
      { now: () => 0, requestFrame: () => 1, cancelFrame: () => {} },
    );
    const { graphs, ...rest } = mapData();
    listener!(JSON.stringify({ v: 1, type: "graphs", graphsVersion: 1, graphs }));
    listener!(JSON.stringify({ v: 1, type: "data", graphsVersion: 2, data: rest }));
    expect(guest.engine.getCamera()).toBeNull();
    listener!(JSON.stringify({ v: 1, type: "data", graphsVersion: 1, data: rest }));
    expect(guest.engine.getCamera()).not.toBeNull();
  });
});
