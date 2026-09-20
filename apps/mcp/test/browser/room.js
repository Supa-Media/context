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
import {
  createSharedDoc,
  isWriter,
  seedSharedDoc,
} from "../../../mobile/features/console/presence/sharedDoc.ts";
import { applyExternalWrite } from "../../../mobile/features/console/presence/externalWrite.ts";
import {
  answerStateVector,
  cursorOffset,
  cursorPosition,
  encodeSyncStep1,
  encodeUpdate,
  readSyncMessage,
} from "../../../mobile/features/console/presence/sync.ts";
import {
  agentCursorFrame,
  askFrame,
  decodeServerFrame,
  savedFrame,
  syncFrame,
} from "../../../mobile/features/console/presence/protocol.ts";

const REMOTE = Symbol("remote");

window.joinRoom = ({ gateway, token, note, seedWith }) => {
  const state = {
    text: () => doc.markdown(),
    members: [],
    connected: false,
    frames: 0,
    /** The version a tool's write left behind, once this client merged it. */
    externalEtag: null,
    /** The version the room last said the bucket is at. */
    etag: null,
    /**
     * Where each member's caret is, as an offset in *this* document.
     *
     * Resolved through `cursorOffset` rather than kept as the encoded relative
     * position, because what the verification asks is "is the tool's caret at
     * the text the tool wrote", and only this document can answer that.
     */
    carets: () => {
      const out = {};
      for (const [id, at] of positions) {
        const offset = at.head === null ? null : cursorOffset(at.head, doc.doc);
        if (offset !== null) out[id] = offset;
      }
      return out;
    },
    /** The members the room says are tools rather than people. */
    agents: () => state.members.filter((m) => m.isAgent),
    /** Whether this client is the one elected to save. */
    saver: () => Boolean(state.you) &&
      state.members.some((m) => m.id === state.you && m.canWrite) &&
      isWriter(state.you, state.members.filter((m) => m.canWrite).map((m) => m.id)),
  };
  /** The last edit this client made, kept so the reader can try to smuggle it. */
  let lastUpdate = null;
  /** Every member's caret as it arrived, encoded, by member id. */
  const positions = new Map();
  const doc = createSharedDoc({
    onLocalUpdateBytes: (update) => {
      lastUpdate = update;
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
    if (frame.t === "external") {
      /*
        The room asked this client, and only this client, to merge a write that
        came from a tool — and the product's own function does it, rather than
        this harness doing its own version of the same branch. That is the
        whole point of the file: the two defects it was extracted for both
        lived in a branch no test reached, and a harness that reimplements it
        would reach a reimplementation.
      */
      applyExternalWrite(
        { text: frame.text, path: note, shared: doc, drawing: false },
        {
          deliverElements: () => {},
          shareElements: () => {},
          reportCaret: (span) => {
            socket.send(
              agentCursorFrame(
                cursorPosition(doc.text, span.from),
                cursorPosition(doc.text, span.to),
              ),
            );
          },
          reportPointer: () => {},
          adopt: () => {
            state.externalEtag = frame.etag;
          },
        },
      );
      return;
    }
    if (frame.t === "cursor") {
      positions.set(frame.id, { anchor: frame.anchor, head: frame.head });
      return;
    }
    if (frame.t === "etag") {
      // The version the bucket is at now, told to every member — which is what
      // keeps the next person elected to save from writing against a version
      // two edits old.
      state.etag = frame.etag;
      return;
    }
    if (frame.t === "join") {
      state.members = [...state.members.filter((m) => m.id !== frame.member.id), frame.member];
    }
    if (frame.t === "leave") state.members = state.members.filter((m) => m.id !== frame.id);
    if (frame.t === "ask") {
      // Answered, never applied. See `answerStateVector`.
      const answer = answerStateVector(frame.d, doc.doc);
      if (answer.kind === "reply") socket.send(syncFrame(answer.payload));
    }
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
  /*
    Put this client's own edit on the `ask` frame — the one the room lets past
    its write gate, because asking what a note says is a read.

    This is the attack, run for real rather than described: before the fix the
    room relayed an `ask` as a `y`, and every peer read it with a reader that
    applies whatever the payload's type byte asks for. A read-only member's
    edit reached everybody and the elected writer flushed it to the bucket.
  */
  /** Announce a save the way the console does after its own write lands. */
  state.announceSaved = (etag) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(savedFrame(etag));
    return true;
  };
  state.smuggle = () => {
    if (!lastUpdate || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(askFrame(encodeUpdate(lastUpdate)));
    return true;
  };
  state.disconnect = () => socket.close();
  window.room = state;
  return state;
};
