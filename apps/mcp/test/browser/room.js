/**
 * The client half of the browser verification, bundled into the page.
 *
 * Deliberately built from the *product's own* modules — `sharedDoc`, `sync`
 * and the wire `protocol` — rather than a reimplementation. A harness that
 * reimplements the client proves the harness works.
 *
 * What it does not include is React, the console, or the editor: this verifies
 * the socket, the room and the sync protocol end to end, which is the part no
 * test in the repo reaches. The editor binding is covered by jsdom tests that
 * mount the real `LiveEditor`.
 */
import { createSharedDoc, seedSharedDoc } from "../../../mobile/features/console/presence/sharedDoc.ts";
import { encodeSyncStep1, encodeUpdate, readSyncMessage } from "../../../mobile/features/console/presence/sync.ts";
import { askFrame, decodeServerFrame, syncFrame } from "../../../mobile/features/console/presence/protocol.ts";

const REMOTE = Symbol("remote");

window.joinRoom = ({ gateway, token, note, seedWith }) => {
  const state = { text: () => doc.markdown(), members: [], connected: false, frames: 0 };
  const doc = createSharedDoc({
    onLocalUpdateBytes: (update) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(syncFrame(encodeUpdate(update)));
      }
    },
  });

  const url = `${gateway.replace(/^http/, "ws")}/t/${encodeURIComponent(token)}/presence?note=${encodeURIComponent(note)}&seed=tab`;
  const socket = new WebSocket(url);

  socket.onopen = () => {
    state.connected = true;
    socket.send(askFrame(encodeSyncStep1(doc.doc)));
  };
  socket.onmessage = (event) => {
    state.frames += 1;
    const frame = decodeServerFrame(event.data);
    if (!frame) return;
    if (frame.t === "welcome") {
      state.you = frame.you;
      state.members = frame.members;
      // The room's decision, not this client's. See `protocol.ts`.
      if (frame.seed && seedWith) seedSharedDoc(doc, seedWith);
      return;
    }
    if (frame.t === "join") state.members = [...state.members, frame.member];
    if (frame.t === "leave") state.members = state.members.filter((m) => m.id !== frame.id);
    if (frame.t === "y") {
      const outcome = readSyncMessage(frame.d, doc.doc, REMOTE);
      if (outcome.kind === "reply") socket.send(syncFrame(outcome.payload));
    }
    if (frame.t === "sync") {
      for (const message of frame.updates) readSyncMessage(message, doc.doc, REMOTE);
    }
  };
  socket.onclose = () => {
    state.connected = false;
  };

  state.type = (at, text) => doc.text.insert(at, text);
  state.append = (text) => doc.text.insert(doc.text.length, text);
  state.disconnect = () => socket.close();
  window.room = state;
  return state;
};
