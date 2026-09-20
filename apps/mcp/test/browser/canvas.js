/**
 * The console's half of a shared canvas, in a page a browser can drive.
 *
 * This embeds **the real drawing editor** — the artifact
 * `scripts/build-drawing-editor.mjs` produces, Excalidraw and all — and wires
 * it to **the real presence socket** through the product's own bridge and wire
 * modules. What it stands in for is the console's React shell, which is thirty
 * lines of relaying here and a screen's worth of layout there.
 *
 * The relay is deliberately the same shape as `DrawingEditor.web.tsx`'s, and
 * for the same reasons, because a harness that relays differently proves the
 * harness works:
 *
 *  - `share` goes to the room, `change` does not. `change` is "the drawing is
 *    now this, save it" and fires for every reason including a peer's element
 *    arriving; sharing it would echo every incoming shape back at the room it
 *    came from.
 *  - Remote elements go to the page untouched. The reconciliation is
 *    Excalidraw's `reconcileElements`, and it lives in the page.
 */
import {
  decodeServerFrame,
  drawFrame,
  pointerFrame,
} from "../../../mobile/features/console/presence/protocol.ts";
import { decodeElements, encodeElements } from "../../../../packages/drawings/src/collab.js";
import { parseDrawing } from "../../../../packages/drawings/src/excalidraw.js";

const CHANNEL = "context.drawing.v1";

window.joinCanvas = ({ gateway, token, note }) => {
  const state = {
    connected: false,
    /** The whole scene, as the editor last reported it. */
    elements: [],
    /** Peers whose pointer we have seen, by member id. */
    peers: [],
    /** The version a tool's write left behind, and the room's latest. */
    externalEtag: null,
    etag: null,
    you: null,
    members: [],
    shared: 0,
    received: 0,
    /** Diagnostics for the verification, which has needed them. */
    frames: [],
    syncs: 0,
  };

  const frame = document.createElement("iframe");
  frame.src = "/drawing-assets/editor/index.html";
  frame.style.cssText = "width:100vw;height:100vh;border:0";
  document.body.appendChild(frame);

  /*
    Held until the page says it is listening, exactly as `DrawingEditor.web.tsx`
    holds them: the editor is fetched on demand, the socket is open long before
    it has booted, and a message posted into a frame with no listener is gone
    rather than queued. Losing those is a second person opening a shared canvas
    and finding it blank — which is what this verification found.
  */
  let listening = false;
  const queued = [];
  const toPage = (message) => {
    if (!listening) {
      queued.push(message);
      return;
    }
    frame.contentWindow?.postMessage({ channel: CHANNEL, ...message }, window.location.origin);
  };

  const url = `${gateway.replace(/^http/, "ws")}/t/${encodeURIComponent(token)}/presence?note=${encodeURIComponent(note)}&seed=tab`;
  const socket = new WebSocket(url);
  const pointers = new Map();
  const byId = new Map();

  socket.onopen = () => {
    state.connected = true;
  };
  socket.onclose = () => {
    state.connected = false;
  };
  socket.onmessage = (event) => {
    const message = decodeServerFrame(event.data);
    if (!message) {
      state.frames.push("?");
      return;
    }
    state.frames.push(message.t);
    if (message.t === "welcome") {
      state.you = message.you;
      state.members = message.members;
      for (const member of message.members) byId.set(member.id, member);
      return;
    }
    if (message.t === "join") {
      state.members = [...state.members, message.member];
      byId.set(message.member.id, message.member);
      return;
    }
    if (message.t === "leave") {
      state.members = state.members.filter((one) => one.id !== message.id);
      pointers.delete(message.id);
      return;
    }
    if (message.t === "external") {
      /*
        A tool wrote this drawing. The console parses the file back into
        elements — a tool writes a `.excalidraw.md` as a file, which is the
        only shape `write_note` has — and hands them to the page exactly like a
        peer's change. `usePresence` does the same; this stands in for it.
      */
      const parsed = parseDrawing(message.text, note);
      const elements = parsed.elements ?? [];
      state.externalEtag = message.etag;
      if (elements.length > 0) {
        state.received += elements.length;
        toPage({ type: "remote", elements });
      }
      return;
    }
    if (message.t === "etag") {
      // The version the bucket is at now, told to every member.
      state.etag = message.etag;
      return;
    }
    if (message.t === "draw") {
      const elements = decodeElements(message.d);
      if (elements.length === 0) return;
      state.received += elements.length;
      toPage({ type: "remote", elements });
      return;
    }
    if (message.t === "sync") {
      state.syncs += message.updates.length;
      for (const entry of message.updates) {
        const elements = decodeElements(entry);
        if (elements.length === 0) continue;
        state.received += elements.length;
        toPage({ type: "remote", elements });
      }
      return;
    }
    if (message.t === "pointer") {
      pointers.set(message.id, { x: message.x, y: message.y, selected: message.selected });
      state.peers = [...pointers.entries()].map(([id, at]) => ({
        id,
        name: byId.get(id)?.name ?? "Someone",
        color: byId.get(id)?.color ?? null,
        x: at.x,
        y: at.y,
        selected: at.selected,
      }));
      toPage({ type: "peers", peers: state.peers });
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.channel !== CHANNEL) return;
    if (data.type === "ready") {
      listening = true;
      toPage({
        type: "load",
        elements: window.__seed ?? [],
        appState: null,
        theme: "light",
        editable: window.__editable !== false,
        collaborating: true,
      });
      const held = queued.splice(0, queued.length);
      for (const message of held) toPage(message);
      return;
    }
    if (data.type === "change") {
      state.elements = data.elements;
      return;
    }
    if (data.type === "share") {
      state.shared += data.elements.length;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(drawFrame(encodeElements(data.elements)));
      }
      return;
    }
    if (data.type === "point") {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(pointerFrame(data.x, data.y, data.selected));
      }
    }
  });

  state.live = () => state.elements.filter((one) => !one.isDeleted);
  state.ids = () => state.live().map((one) => one.id).sort();
  window.canvas = state;
  return state;
};
