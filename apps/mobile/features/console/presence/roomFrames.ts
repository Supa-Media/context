import type { Dispatch } from "react";
import { decodeElements, encodeElements } from "@context/drawings";
import {
  agentCursorFrame,
  agentPointerFrame,
  drawFrame,
  snapshotFrame,
  syncFrame,
  type PresenceMember,
  type ServerFrame,
} from "./protocol";
import { answerStateVector, cursorPosition, readSyncMessage } from "./sync";
import type { SharedDoc } from "./sharedDoc";
import { applyExternalWrite } from "./externalWrite";
import type { PresenceAction } from "./session";
import { peersFrom } from "./peers";
import type { PresenceOptions } from "./presenceContract";

/**
 * Marks a change as having arrived from the room rather than from this editor.
 *
 * Without it every applied message is echoed straight back out, which is an
 * infinite loop between two browsers rather than a slow one.
 */
const REMOTE_ORIGIN = Symbol("presence-remote");

type Ref<T> = { current: T };

/** What one connection attempt hands the content frames. Built once per socket. */
export interface RoomFrameContext {
  live: WebSocket;
  path: string;
  document: SharedDoc | null;
  mode: "text" | "drawing" | "presence";
  options: { durable?: boolean };
  settle: () => void;
  dispatch: Dispatch<PresenceAction>;
  holdAgent: (id: string) => void;
  watchAgentWrite: (id: string) => void;
  socket: Ref<WebSocket | null>;
  shared: Ref<SharedDoc | null>;
  pointers: Ref<Map<string, { x: number; y: number; selected: string[] }>>;
  roster: Ref<PresenceMember[]>;
  onDrawing: Ref<PresenceOptions["onDrawing"]>;
  onDrawingCompact: Ref<PresenceOptions["onDrawingCompact"]>;
  onPeerPointers: Ref<PresenceOptions["onPeerPointers"]>;
  onExternalWrite: Ref<PresenceOptions["onExternalWrite"]>;
  onLiveUpdate: Ref<PresenceOptions["onLiveUpdate"]>;
  onCommitted: Ref<PresenceOptions["onCommitted"]>;
}

/**
 * The frames about the note or the canvas rather than about the connection:
 * every branch of the socket's message handler that used to end in `return`.
 * `true` when this frame was one of them and has been dealt with; `false` for
 * the roster and lifecycle frames, which `roomSocket.ts` goes on to handle
 * exactly as it did before. Moved out of `usePresence.ts` verbatim.
 */
export function handleRoomFrame(
  frame: ServerFrame,
  {
    live,
    path,
    document,
    mode,
    options,
    settle,
    dispatch,
    holdAgent,
    watchAgentWrite,
    socket,
    shared,
    pointers,
    roster,
    onDrawing,
    onDrawingCompact,
    onPeerPointers,
    onExternalWrite,
    onLiveUpdate,
    onCommitted,
  }: RoomFrameContext,
): boolean {
  if (frame.t === "draw") {
    /*
      Somebody else's elements. Handed straight out — the reconciliation
      is Excalidraw's, and Excalidraw is in the editor page, not here.
      The console is a relay for this one and deliberately holds no
      second copy of the scene.
    */
    onDrawing.current?.(decodeElements(frame.d));
    return true;
  }

  if (frame.t === "pointer") {
    /*
      Where a peer's pointer is. Kept in a ref and pushed at the canvas,
      never through React: this frame arrives on every mouse move of
      every person here.
    */
    pointers.current.set(frame.id, { x: frame.x, y: frame.y, selected: frame.selected });
    onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
    return true;
  }

  if (frame.t === "ask") {
    /*
      A peer asking what it is missing — answered, and never applied.

      The room relays this past its write gate, because asking is a read.
      Reading it with `readSyncMessage` would let the sender decide
      between "answer me" and "apply this" with a byte inside the
      payload, which is a read-only member's edit reaching every peer.
      `answerStateVector` can only produce an answer.
    */
    if (!document) return true;
    const answer = answerStateVector(frame.d, document.doc);
    if (answer.kind !== "reply") return true;
    try {
      live.send(syncFrame(answer.payload));
    } catch {
      // They ask again on their next reconnect.
    }
    return true;
  }

  if (frame.t === "y") {
    if (!document) return true;
    /*
      A peer answered the state vector this client sent on connect, which
      is the joiner's half of "the room has told me everything". It stays
      outside the `reply` branch below because an ordinary edit relayed
      from a peer settles this client just as well: either way somebody
      who was already here has spoken about this document.
    */
    settle();
    // A reply is produced when a peer asked what we have; sending it is
    // how a late joiner gets filled in by whoever is already here.
    const outcome = readSyncMessage(frame.d, document.doc, REMOTE_ORIGIN);
    if (outcome.kind === "reply") {
      try {
        live.send(syncFrame(outcome.payload));
      } catch {
        // They will ask again on their next reconnect.
      }
    }
    return true;
  }

  if (frame.t === "sync") {
    // The room's own log, replayed on join: every message it kept, in
    // the order it received them. Same handler, because they are the
    // same protocol messages — the room stored them without reading them.
    //
    // The replay is the room's whole answer to a joiner, so it settles
    // this client whether or not any of the messages in it apply.
    settle();
    if (!document) {
      /*
        For a canvas the log holds element updates instead, replayed the
        same way. Reconciliation is by element version, so applying the
        same element twice is the same drawing — which is what makes a
        replay safe rather than a second copy of somebody's work.
      */
      for (const message of frame.updates) {
        const elements = decodeElements(message);
        if (elements.length > 0) onDrawing.current?.(elements);
      }
      return true;
    }
    for (const message of frame.updates) {
      readSyncMessage(message, document.doc, REMOTE_ORIGIN);
    }
    return true;
  }

  if (frame.t === "etag") {
    /*
      Somebody else saved, or a tool wrote the note. The text is already
      shared — this is only the version, so the next conditional write
      from this client is checked against what is in the bucket.
    */
    onExternalWrite.current?.({ path, etag: frame.etag });
    return true;
  }

  if (frame.t === "live") {
    if (options.durable) onLiveUpdate.current?.(frame.documentId, frame.d);
    return true;
  }

  if (frame.t === "committed") {
    /*
      **A durable note changed, and the room says an agent changed it.**

      The agent joins the roster exactly as a v1 tool does, so the chip
      names it and it goes away on the same clock. Where its caret goes
      is this client's own finding: the next update applied from an
      authorized HTTP read is the write it was told about, and its span
      becomes the agent's selection. See `agentSpan.ts`.

      Armed before the repair is asked for, so the read cannot land
      before anybody is listening for it.
    */
    if (frame.agent && options.durable) {
      const member: PresenceMember = {
        ...frame.agent,
        anchor: null,
        head: null,
        canWrite: false,
        isAgent: true,
      };
      holdAgent(member.id);
      dispatch({ type: "frame", notePath: path, frame: { t: "join", member } });
      watchAgentWrite(member.id);
    }
    onCommitted.current?.(frame);
    return true;
  }

  if (frame.t === "external") {
    /*
      **A tool wrote this note, and this client was asked to merge it.**

      Asked, rather than every client deciding for itself: the same text
      applied to N copies of the shared document inserts it N times,
      because each copy generates its own operations for it. The room
      picks one member — see `presenceRoom.js` — and this is that member.

      `mergeExternalText` is a prefix/suffix diff, so a write that
      appended a paragraph is an insert at the end rather than a replace
      of the whole note, and carets and other people's in-flight edits
      survive it. The resulting update goes out through the ordinary
      local-update path, so everybody else sees it as an edit.

      **A canvas receives the same write as elements**, because a tool
      writes a `.excalidraw.md` as a *file* — the only shape `write_note`
      has — and this room merges elements rather than text.

      **And the version is adopted only if one of those deliveries
      happened.** A merge that throws, a payload that will not parse and
      a scene with nothing in it each leave this client without the
      tool's content, and a client that claims the version of a write it
      does not hold overwrites it on its next save with nobody shown a
      conflict. `externalWrite.ts` holds both halves and is handed the
      adoption rather than asked about it — there is no branch here to
      get wrong, which matters because no test reaches this handler.
    */
    /*
      Reporting back is best-effort, on the same socket the write came
      down. A room that has already closed under this client costs the
      tool's caret and nothing else — the write is in the bucket and the
      merge has happened either way, so there is nothing here worth
      failing over.
    */
    const tell = (outgoing: string) => {
      try {
        if (live.readyState === WebSocket.OPEN) live.send(outgoing);
      } catch {
        // See above.
      }
    };
    applyExternalWrite(
      { text: frame.text, path, shared: shared.current, drawing: mode === "drawing" },
      {
        deliverElements: (elements) => onDrawing.current?.(elements),
        /*
          **And on to everybody else's canvas.**

          A note's merge reaches the room by itself: it is an edit, and
          edits travel. A drawing's does not — elements handed to this
          browser's Excalidraw go nowhere — so the second person on the
          canvas saw the tool's version land and none of its shapes.
          Re-broadcast here, from the one client that was given them,
          which is the same shape the room already trusts for a peer's
          own drawing.
        */
        shareElements: (elements) => tell(drawFrame(encodeElements(elements))),
        /*
          **Where the tool's caret goes.** The offsets are in the text as
          it now stands, so they are turned into relative positions the
          same way this editor's own caret is — a position that survives
          the next person's keystroke rather than an offset that does not.

          No id on the frame: the client says the caret is the agent's
          and the room says which agent. See `agentCursorFrame`.
        */
        reportCaret: (span) => {
          const text = shared.current?.text;
          if (!text) return;
          tell(agentCursorFrame(cursorPosition(text, span.from), cursorPosition(text, span.to)));
        },
        reportPointer: (at) => tell(agentPointerFrame(at.x, at.y)),
        adopt: () => onExternalWrite.current?.({ path, etag: frame.etag }),
      },
    );
    return true;
  }

  if (frame.t === "compact") {
    if (!document) {
      // A canvas answers with its whole scene, which the editor page has
      // and this one does not — so the request is passed on.
      onDrawingCompact.current?.();
      return true;
    }
    try {
      const live = socket.current;
      if (live && live.readyState === WebSocket.OPEN) {
        live.send(snapshotFrame(document.snapshot()));
      }
    } catch {
      // The room asks again in another fifty updates.
    }
    return true;
  }

  return false;
}
