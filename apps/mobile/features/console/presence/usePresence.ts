/**
 * The presence socket, bound to React.
 *
 * Everything that decides something is in `session.ts`; this owns the socket,
 * the timers and the token, and is deliberately the only file in the feature
 * that is hard to test. The split is the same one `autosave.ts` draws and for
 * the same reason.
 *
 * ## Presence is never allowed to break the editor
 *
 * Every failure here is silent and terminal-in-one-direction: no token, no
 * binding on the gateway, no network, a refusal, a browser with no `WebSocket`
 * — all of them land on `unavailable`, which draws exactly the editor that
 * existed before this feature. There is no error state a person has to dismiss
 * and no retry that can spin, because a note that will not open is a worse
 * outcome than a caret nobody sees. The editor's own save path never consults
 * this hook.
 *
 * ## The five-minute reconnect is normal, not a failure
 *
 * The gateway closes an authorized socket at `PRESENCE_SOCKET_MAX_MS` so that a
 * revoked grant stops showing a caret. A close is therefore the expected case
 * rather than the exceptional one: the first retry is fast, the roster is kept
 * across it, and the colour is held by a per-tab seed so nobody appears to
 * leave and rejoin.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { gatewayOriginFrom } from "../../meetings/gateway";
import {
  agentCursorFrame,
  agentPointerFrame,
  askFrame,
  byeFrame,
  cursorFrame,
  drawFrame,
  savedFrame,
  drawSnapshotFrame,
  pointerFrame,
  decodeServerFrame,
  pingFrame,
  presenceSocketUrl,
  snapshotFrame,
  syncFrame,
  type PresenceMember,
} from "./protocol";
import {
  answerStateVector,
  cursorPosition,
  encodeSyncStep1,
  encodeUpdate,
  readSyncMessage,
} from "./sync";
import { decodeElements, encodeElements } from "@context/drawings";
import {
  createSharedDoc,
  seedSharedDoc,
  type SharedDoc,
} from "./sharedDoc";
import { applyExternalWrite } from "./externalWrite";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
  reconnectDelayMs,
  savesToBucket,
  type PresencePhase,
} from "./session";
import type { DurableCollaboration } from "../collaboration/durable";

/** How often a caret move is sent, at most. */
const CURSOR_THROTTLE_MS = 120;

/**
 * How often a drawing puts its changes on the wire.
 *
 * Shorter than the caret throttle, because a shape being dragged is the thing
 * people watch and 60ms is the difference between "it moves" and "it jumps".
 * Not zero: Excalidraw reports a change per animation frame per element, and
 * one frame per animation frame per person is what would fill the room's log
 * with a thousand copies of one rectangle.
 */
const DRAW_THROTTLE_MS = 60;

/**
 * How long a tool's caret stays after its write.
 *
 * The same clock the room uses to expire a member who stopped speaking, and
 * for the same reason: past it, the caret is claiming somebody is here who is
 * not. A tool holds no socket, so nothing else will ever take it down.
 */
const MEMBER_IDLE_MS = 45_000;

/** Reconnect this long before the gateway would close the socket itself. */
const REAUTH_MARGIN_MS = 15_000;

/**
 * Marks a change as having arrived from the room rather than from this editor.
 *
 * Without it every applied message is echoed straight back out, which is an
 * infinite loop between two browsers rather than a slow one.
 */
const REMOTE_ORIGIN = Symbol("presence-remote");

export interface Presence {
  members: PresenceMember[];
  phase: PresencePhase;
  /** "2 here", "Reconnecting", or "" when there is nothing worth saying. */
  summary: string;
  /** Tell the room where this editor's caret is. Safe to call on every change. */
  report: (anchor: number, head: number) => void;
  /**
   * The document every editor in this room shares, once there is one.
   *
   * `null` until the room has answered, and on every surface with no room at
   * all — the editor then holds its own text exactly as it did before this
   * feature, which is what makes the whole thing safe to switch off.
   */
  shared: SharedDoc | null;
  /**
   * Whether the room has told this client everything it holds for this note.
   *
   * **`shared` says a document exists; this says the room has spoken.** The
   * two are not the same question and the gap between them is where a note
   * goes missing: the document is created when the hook runs, before a socket
   * connects and whether or not one ever does, while this turns true only when
   * one of the three things that can settle a joiner has happened — this
   * client was told to seed, the room replayed its log, or a peer answered the
   * state vector this client sent on connect.
   *
   * The editor needs it because an **empty** document is ambiguous on its own:
   * a brand-new note and a room that has not answered yet look identical, and
   * binding in the second case means the seed arrives a moment later as an
   * insert of text the editor is already showing — the duplicated note. So the
   * editor waits for text *or* for this, and an empty note stops being a room
   * nobody is ever wired into.
   *
   * False again on a reconnect, and correctly so: the exchange runs from the
   * start on every connect, and until it has this client cannot say the room
   * holds nothing.
   */
  settled: boolean;
  /**
   * Whether this client is the one that writes the merged text to the bucket.
   *
   * Exactly one member is, and the rest deliberately leave their local draft
   * clean so the existing autosave cannot fire for them. Two savers would race
   * against one etag and conflict with each other, which is the failure this
   * whole feature exists to remove — reintroduced from the other end.
   */
  canWrite: boolean;
  /** Durable prose synchronization, when the open note uses collaboration v2. */
  collaboration?: DurableCollaboration;
  /**
   * Tell the room this client just wrote the note to the bucket at `etag`.
   *
   * Safe to call when there is no room: it drops the message. Every other
   * member moves onto that version, so the next person elected to save is not
   * writing against a version two edits old.
   */
  announceSaved: (etag: string) => void;
  /**
   * The canvas half, present in `drawing` mode and inert otherwise.
   *
   * Both calls are safe to make when there is no room: they drop the message,
   * which is what keeps a drawing opened alone behaving exactly as it did
   * before any of this existed.
   */
  drawing: {
    /** Put these elements — this person's own changes — on the wire. */
    share: (elements: unknown[]) => void;
    /** Tell the room where this person's pointer is. */
    point: (x: number, y: number, selected: string[]) => void;
    /** The whole scene, when the room asked for a compaction. */
    compact: (elements: unknown[]) => void;
  };
}

/** A peer, as the drawing editor needs one: a name, a colour, and a pointer. */
export interface PeerPointer {
  id: string;
  name: string;
  color: string | null;
  x: number;
  y: number;
  selected: string[];
}

/**
 * The roster and the pointers, joined.
 *
 * Two sources because they change at different rates and for different
 * reasons: who is here arrives on `welcome`/`join`/`leave` and belongs in
 * React state, while where their pointer is arrives on every mouse move and
 * must not. A peer with no pointer yet is simply not in the answer — drawing
 * a cursor at the origin would be a claim about where somebody is, and a
 * wrong one.
 */
function peersFrom(
  members: PresenceMember[],
  pointers: Map<string, { x: number; y: number; selected: string[] }>,
): PeerPointer[] {
  const out: PeerPointer[] = [];
  for (const member of members) {
    const at = pointers.get(member.id);
    if (!at) continue;
    out.push({
      id: member.id,
      name: member.name,
      color: member.color,
      x: at.x,
      y: at.y,
      selected: at.selected,
    });
  }
  return out;
}

/**
 * A colour seed that survives a reload but not a new tab.
 *
 * The same person in two tabs is two members — which is true — and each keeps
 * its colour across reconnects and refreshes. `sessionStorage` can throw in a
 * private window, so a failure falls back to a per-mount value rather than
 * taking the feature down with it.
 */
function tabSeed(): string {
  const key = "context.presence.seed";
  try {
    const held = window.sessionStorage.getItem(key);
    if (held) return held;
    const minted = Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.sessionStorage.setItem(key, minted);
    return minted;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

export function usePresence(options: {
  workspaceId: string | null;
  /** The MCP endpoint the console already shows, e.g. `https://…/mcp`. */
  endpoint: string | null;
  /** The note on screen, or `null` when none is. */
  notePath: string | null;
  /** Off for an unsaved draft, a drawing, a locked note, or a folder. */
  enabled: boolean;
  /**
   * The note as the bucket has it, for the one client that seeds the room.
   *
   * Read through a ref rather than a dependency: it changes on every keystroke
   * and re-opening the socket for that would reset the room on every letter.
   * Only the seeding client reads it, and only once.
   */
  textForSeed: () => string;
  /**
   * A tool wrote this note while it was open, and the shared document has just
   * been merged onto it.
   *
   * The etag is what makes this more than a redraw: the bucket has moved, so
   * the next conditional save from this client must be checked against the
   * version the tool left behind rather than the one this editor opened. Fired
   * only on the client the room asked to merge.
   */
  onExternalWrite?: (written: { path: string; etag: string | null }) => void;
  /**
   * What kind of thing is open: prose, or a canvas.
   *
   * A note merges as text through a shared document; a drawing merges as
   * *elements*, through Excalidraw's own reconciliation, because merging two
   * people's serialized scenes character by character produces a payload that
   * is neither person's drawing. One socket, one room, one roster — two merge
   * strategies, chosen by what the file is.
   *
   * In `drawing` mode no shared document is created at all. Seeding a
   * `.excalidraw.md` into one would put a multi-megabyte compressed payload in
   * the room's log to no purpose.
   */
  mode?: "text" | "drawing" | "presence";
  /** Durable prose uses this socket for carets only; legacy Y frames are disabled. */
  durable?: boolean;
  /** A v2 commit notification triggers an authorized HTTP read repair. */
  onCommitted?: (frame: { documentId: string; update?: string; etag: string }) => void;
  /** Elements from a peer, or replayed on join. Drawing mode only. */
  onDrawing?: (elements: unknown[]) => void;
  /** The room is asking for a full scene, because the log is getting long. */
  onDrawingCompact?: () => void;
  /** Who else is on the canvas and where their pointers are. Drawing mode only. */
  onPeerPointers?: (
    peers: { id: string; name: string; color: string | null; x: number; y: number; selected: string[] }[],
  ) => void;
}): Presence {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const [state, dispatch] = useReducer(presenceReducer, initialPresenceState);

  const socket = useRef<WebSocket | null>(null);
  const timers = useRef<{ heartbeat?: number; reconnect?: number; reauth?: number }>({});
  const lastSent = useRef<{ at: number; anchor: number; head: number }>({ at: 0, anchor: -1, head: -1 });
  const pending = useRef<{ anchor: number; head: number } | null>(null);
  const seed = useRef<string | null>(null);
  const shared = useRef<SharedDoc | null>(null);
  /**
   * Has the room answered for the document currently in `shared`?
   *
   * A ref plus a counter rather than a piece of reducer state: the reducer is
   * keyed on frames that describe the *roster*, and this describes the
   * *document*. The counter is what makes the change visible to React — the
   * value itself is read off the ref, so a settle that lands between renders
   * is never missed.
   */
  const settled = useRef(false);
  const [settledAt, setSettledAt] = useState(0);
  const settle = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    setSettledAt((count) => count + 1);
  }, []);
  const textForSeed = useRef(options.textForSeed);
  textForSeed.current = options.textForSeed;
  const onExternalWrite = useRef(options.onExternalWrite);
  onExternalWrite.current = options.onExternalWrite;
  const mode = options.mode ?? "text";
  const onDrawing = useRef(options.onDrawing);
  onDrawing.current = options.onDrawing;
  const onDrawingCompact = useRef(options.onDrawingCompact);
  onDrawingCompact.current = options.onDrawingCompact;
  const onPeerPointers = useRef(options.onPeerPointers);
  onPeerPointers.current = options.onPeerPointers;
  const onCommitted = useRef(options.onCommitted);
  onCommitted.current = options.onCommitted;
  /*
    Where each peer's pointer is, in a ref rather than in the reducer.

    A pointer frame arrives on every mouse move of every person on the canvas.
    Putting that through React state would re-render the console at the frame
    rate of everybody else's mouse; the canvas is drawn by Excalidraw inside an
    iframe and needs the numbers, not a render.
  */
  const pointers = useRef(new Map<string, { x: number; y: number; selected: string[] }>());
  const roster = useRef<PresenceMember[]>([]);
  const lastPointer = useRef(0);
  /** When each agent's caret should be taken down, by member id. */
  const agentTimers = useRef(new Map<string, number>());
  if (seed.current === null && typeof window !== "undefined") seed.current = tabSeed();

  const { workspaceId, endpoint, notePath, enabled } = options;
  const origin = endpoint === null ? null : gatewayOriginFrom(endpoint);
  const active = enabled && workspaceId !== null && origin !== null && notePath !== null;

  const clearTimers = useCallback(() => {
    const held = timers.current;
    if (held.heartbeat) window.clearInterval(held.heartbeat);
    if (held.reconnect) window.clearTimeout(held.reconnect);
    if (held.reauth) window.clearTimeout(held.reauth);
    timers.current = {};
  }, []);

  const closeSocket = useCallback(
    (say: boolean) => {
      const live = socket.current;
      socket.current = null;
      clearTimers();
      if (!live) return;
      try {
        if (say && live.readyState === WebSocket.OPEN) live.send(byeFrame());
      } catch {
        // A socket that cannot be written to is already going.
      }
      try {
        live.close();
      } catch {
        // Same.
      }
    },
    [clearTimers],
  );

  useEffect(() => {
    if (!active || typeof window === "undefined" || typeof WebSocket === "undefined") {
      closeSocket(false);
      dispatch({ type: "close" });
      return;
    }

    let cancelled = false;
    const path = notePath as string;
    dispatch({ type: "open", notePath: path });
    /*
      Read once, here, rather than off the ref in the cleanup below.

      The map is created with the hook and never replaced, so the two are the
      same object — but the lint rule that asks for this is right in general
      and the cost of agreeing with it is one line: a cleanup that reads
      `.current` is a cleanup that clears whatever is there when React gets
      round to running it, not what this room put there.
    */
    const toolCarets = agentTimers.current;

    /*
      One document per note, created with the room and destroyed with it.

      `onLocalUpdate` fires for this editor's own edits only — an update that
      arrived from the room is applied with a marker origin and does not come
      back out — so this is the one place a keystroke becomes a frame, and it
      does so immediately. Batching here is what would turn "I see the letter
      appear" into "I see the sentence appear".
    */
    const document = mode === "drawing" || mode === "presence" ? null : createSharedDoc({
      onLocalUpdateBytes: (update) => {
        const live = socket.current;
        if (!live || live.readyState !== WebSocket.OPEN) return;
        try {
          live.send(syncFrame(encodeUpdate(update)));
        } catch {
          /*
            Dropped, and the protocol is what recovers it rather than a patch
            of mine. A reconnect opens with SyncStep1, whoever holds more
            answers with the difference, and this edit is in that difference.
            The version of this that tried to solve it by announcing a whole
            document on connect is the one that destroyed notes.
          */
        }
      },
    });
    shared.current = document;
    /*
      A new document is a room that has not answered for it yet. Reset before
      the socket opens rather than on the welcome, so the window between the
      hook running and the room replying is never mistaken for a settled one.
    */
    settled.current = false;
    pointers.current = new Map();
    let cachedGrant: { accessToken: string; expiresAt: number } | null = null;
    let connecting = false;

    const connect = async (attempt: number) => {
      if (cancelled || connecting || socket.current !== null) return;
      connecting = true;
      let token: string;
      try {
        if (cachedGrant !== null && cachedGrant.expiresAt - Date.now() > 60_000) {
          token = cachedGrant.accessToken;
        } else {
          const granted = await mint({ workspaceId: workspaceId as never });
          cachedGrant = granted;
          token = granted.accessToken;
        }
      } catch {
        connecting = false;
        // Minting can fail while the app is waking or the gateway is rolling
        // out. Keep the editor usable and retry with the same bounded backoff
        // as a dropped socket; unlike a definitive socket authorization
        // refusal, this is not terminal and must not strand the room forever.
        if (!cancelled) {
          dispatch({ type: "dropped" });
          timers.current.reconnect = window.setTimeout(() => {
            timers.current.reconnect = undefined;
            void connect(attempt + 1);
          }, reconnectDelayMs(attempt + 1));
        }
        return;
      }
      if (cancelled) {
        connecting = false;
        return;
      }

      let live: WebSocket;
      try {
        live = new WebSocket(
          presenceSocketUrl({
            gatewayOrigin: origin as string,
            notePath: path,
            token,
            colorSeed: seed.current || "tab",
            ...(options.durable ? { collaborationVersion: 2 as const } : {}),
          }),
        );
      } catch {
        connecting = false;
        if (!cancelled) {
          dispatch({ type: "dropped" });
          timers.current.reconnect = window.setTimeout(() => {
            timers.current.reconnect = undefined;
            void connect(attempt + 1);
          }, reconnectDelayMs(attempt + 1));
        }
        return;
      }
      connecting = false;
      socket.current = live;

      live.onopen = () => {
        if (cancelled) return;
        dispatch({ type: "connected" });

        /*
          **SyncStep1: what this client already has, not what it holds.**

          The previous version sent the whole document here, and the room
          replaced its history with it — so an empty document destroyed a full
          one. This sends a state *vector*: a summary of what is already known.
          Anybody holding more answers with exactly the difference, in both
          directions, so two clients converge upward and neither can overwrite
          the other. An empty document has nothing to send that could delete
          anything.

          The same exchange runs on every reconnect with no special case, which
          also closes the dropped-frame gap the snapshot was patching.

          On `ask` rather than `y`: the room relays it to peers without writing
          it to the log, and a read-only member may send it, because asking
          what a note says is a read.
        */
        try {
          if (document) live.send(askFrame(encodeSyncStep1(document.doc)));
          /*
            A canvas has no state vector to announce. It does not need one:
            a joiner is brought up to date by the room's replay, and anything
            it draws afterwards reconciles by element version — which is
            idempotent, so there is nothing to ask for and nothing to miss.
          */
        } catch {
          // The close handler reconnects, and the reconnect opens the same way.
        }
        timers.current.heartbeat = window.setInterval(() => {
          try {
            if (live.readyState === WebSocket.OPEN) live.send(pingFrame());
          } catch {
            // The close handler below does the reconnecting.
          }
        }, 15_000);
      };

      live.onmessage = (event: MessageEvent) => {
        if (cancelled) return;
        const frame = decodeServerFrame(event.data);
        if (!frame) return;

        if (frame.t === "draw") {
          /*
            Somebody else's elements. Handed straight out — the reconciliation
            is Excalidraw's, and Excalidraw is in the editor page, not here.
            The console is a relay for this one and deliberately holds no
            second copy of the scene.
          */
          onDrawing.current?.(decodeElements(frame.d));
          return;
        }

        if (frame.t === "pointer") {
          /*
            Where a peer's pointer is. Kept in a ref and pushed at the canvas,
            never through React: this frame arrives on every mouse move of
            every person here.
          */
          pointers.current.set(frame.id, { x: frame.x, y: frame.y, selected: frame.selected });
          onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
          return;
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
          if (!document) return;
          const answer = answerStateVector(frame.d, document.doc);
          if (answer.kind !== "reply") return;
          try {
            live.send(syncFrame(answer.payload));
          } catch {
            // They ask again on their next reconnect.
          }
          return;
        }

        if (frame.t === "y") {
          if (!document) return;
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
          return;
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
            return;
          }
          for (const message of frame.updates) {
            readSyncMessage(message, document.doc, REMOTE_ORIGIN);
          }
          return;
        }

        if (frame.t === "etag") {
          /*
            Somebody else saved, or a tool wrote the note. The text is already
            shared — this is only the version, so the next conditional write
            from this client is checked against what is in the bucket.
          */
          onExternalWrite.current?.({ path, etag: frame.etag });
          return;
        }

        if (frame.t === "committed") {
          onCommitted.current?.(frame);
          return;
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
          return;
        }

        if (frame.t === "compact") {
          if (!document) {
            // A canvas answers with its whole scene, which the editor page has
            // and this one does not — so the request is passed on.
            onDrawingCompact.current?.();
            return;
          }
          try {
            const live = socket.current;
            if (live && live.readyState === WebSocket.OPEN) {
              live.send(snapshotFrame(document.snapshot()));
            }
          } catch {
            // The room asks again in another fifty updates.
          }
          return;
        }

        if (frame.t === "welcome") {
          /*
            **Seeding, and why the room is the one to decide it.**

            A note starts as text in a bucket and somebody has to put it into
            the shared document. If two clients do, the note contains it twice;
            if none does, the document starts empty and the client elected to
            save writes that emptiness over the note.

            This used to read `frame.members.length === 0`, and that is never
            true: the roster in a welcome includes the member it was sent to.
            So nobody ever seeded. It survived a full unit suite because the
            fixtures were written from this line's own assumption, and died to
            two browsers on a real socket in under a second.

            `frame.seed` is the room's answer, and the room is the only party
            that holds both halves of the question — who else is seated, and
            whether the replay it is about to send already carries the text.
          */
          if (frame.seed && document) seedSharedDoc(document, textForSeed.current());
          /*
            **The seeder is settled by definition**, whatever the seed produced.

            Nothing is coming for it: the room told it the log was empty and
            nobody else was seated, so what the document holds after this line
            is the whole of what the room holds — including for a brand-new
            note, where the seed is the empty string and the document stays
            empty. That case is the one the editor could not tell apart from
            "still waiting", and this is the answer.
          */
          if (frame.seed) settle();

          // Reconnect just before the gateway would close this socket, so the
          // roster never visibly drops. See the header.
          const due = Math.max(frame.reconnectAfterMs - REAUTH_MARGIN_MS, 30_000);
          timers.current.reauth = window.setTimeout(() => {
            closeSocket(true);
            void connect(0);
          }, due);
        }
        if (frame.t === "join" && frame.member.isAgent) {
          /*
            **A tool is present while it is writing, and then it is not.**

            It holds no socket, so nothing will ever send a `leave` for it —
            the room cannot know when an agent has stopped, because there was
            never a connection to close. A caret that stayed would be claiming
            somebody is in the note who left minutes ago, which is exactly the
            lie presence exists to remove. So this client drops it, on the same
            clock the room uses to expire a member who stopped speaking.

            Re-armed on every write: an agent making a series of edits stays
            present throughout rather than flickering.
          */
          const id = frame.member.id;
          const held = agentTimers.current.get(id);
          if (held !== undefined) window.clearTimeout(held);
          agentTimers.current.set(
            id,
            window.setTimeout(() => {
              agentTimers.current.delete(id);
              // Its pointer too, and by hand: a peer's goes down in the
              // `leave` branch below, and this leave never comes off the wire.
              pointers.current.delete(id);
              onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
              dispatch({ type: "frame", notePath: path, frame: { t: "leave", id } });
            }, MEMBER_IDLE_MS),
          );
        }

        if (frame.t === "leave") {
          // A peer that left takes its pointer with it, or Excalidraw goes on
          // drawing a cursor for somebody who has closed the tab.
          pointers.current.delete(frame.id);
          onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
        }
        dispatch({ type: "frame", notePath: path, frame });
      };

      live.onclose = () => {
        if (cancelled || socket.current !== live) return;
        socket.current = null;
        clearTimers();
        dispatch({ type: "dropped" });
        const next = attempt + 1;
        timers.current.reconnect = window.setTimeout(() => void connect(next), reconnectDelayMs(next));
      };

      live.onerror = () => {
        // `onclose` always follows, and it is where the reconnect lives. Doing
        // it here as well would double every backoff.
      };
    };

    const retryNow = () => {
      if (cancelled || socket.current !== null) return;
      if (timers.current.reconnect !== undefined) {
        window.clearTimeout(timers.current.reconnect);
        timers.current.reconnect = undefined;
      }
      void connect(0);
    };
    void connect(0);
    window.addEventListener("online", retryNow);
    window.addEventListener("focus", retryNow);
    window.addEventListener("visibilitychange", retryNow);

    return () => {
      cancelled = true;
      window.removeEventListener("online", retryNow);
      window.removeEventListener("focus", retryNow);
      window.removeEventListener("visibilitychange", retryNow);
      closeSocket(true);
      for (const timer of toolCarets.values()) window.clearTimeout(timer);
      toolCarets.clear();
      shared.current = null;
      document?.destroy();
    };
    // `mint` is stable from Convex; the rest is the identity of the room —
    // `mode` included, because it decides whether this socket creates a shared
    // text document at all. It is derived from the path and so moves with it,
    // but a dependency that is true by coincidence is one that stops being
    // true without anybody noticing.
  }, [active, workspaceId, origin, notePath, mode, options.durable, mint, closeSocket, clearTimers, settle]);

  /**
   * Send a caret, at most every `CURSOR_THROTTLE_MS`.
   *
   * A trailing send is scheduled rather than dropped, because the position that
   * matters most is the one somebody stopped at — dropping the last frame of a
   * fast movement leaves a peer's caret a word behind for as long as its owner
   * sits still.
   */
  const report = useCallback((anchor: number, head: number) => {
    // Named for what it is rather than `held`, which the throttle below
    // already uses for the last caret it sent — the typechecker caught the
    // shadowing, and two different things under one name in one function is
    // how the wrong one gets read six months from now.
    const document = shared.current;
    const live = socket.current;
    if (!live || live.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const held = lastSent.current;
    if (held.anchor === anchor && held.head === head) return;

    const send = (a: number, h: number) => {
      try {
        if (live.readyState === WebSocket.OPEN) {
          // Relative positions, so a caret stays beside the character its owner
          // put it next to rather than drifting when somebody types above it.
          live.send(
            cursorFrame(
              document ? cursorPosition(document.text, a) : null,
              document ? cursorPosition(document.text, h) : null,
            ),
          );
        }
        lastSent.current = { at: Date.now(), anchor: a, head: h };
      } catch {
        // Dropped on the floor: the close handler reconnects and the next
        // movement re-establishes where this caret is.
      }
    };

    if (now - held.at >= CURSOR_THROTTLE_MS) {
      send(anchor, head);
      return;
    }
    pending.current = { anchor, head };
    if (timers.current.heartbeat === undefined && pending.current === null) return;
    window.setTimeout(() => {
      const queued = pending.current;
      pending.current = null;
      if (queued) send(queued.anchor, queued.head);
    }, CURSOR_THROTTLE_MS - (now - held.at));
  }, []);

  /*
    The canvas half of the socket.

    Three calls rather than one, because the three things a drawing sends have
    genuinely different rules: an element change is logged and needs write
    authority, a pointer is neither, and a compaction is a whole scene the room
    asked for. All three drop silently with no socket, which is what makes a
    drawing opened alone behave exactly as it did before any of this.

    `share` throttles element changes the way `report` throttles carets, and
    for the same reason: Excalidraw fires `onChange` continuously while
    somebody drags, and a frame per animation frame per person would fill the
    room's log with a thousand copies of one rectangle. The trailing send is
    the one that matters — it is where the shape ends up.
  */
  const drawQueue = useRef<Map<string, unknown>>(new Map());
  const drawSentAt = useRef(0);
  const drawTimer = useRef<number | undefined>(undefined);

  const flushDrawing = useCallback(() => {
    drawTimer.current = undefined;
    const queued = [...drawQueue.current.values()];
    drawQueue.current.clear();
    if (queued.length === 0) return;
    const live = socket.current;
    if (!live || live.readyState !== WebSocket.OPEN) return;
    try {
      live.send(drawFrame(encodeElements(queued)));
      drawSentAt.current = Date.now();
    } catch {
      // The reconnect replays the room's log, and the elements this client
      // holds go out again on its next change. An element update is
      // idempotent, so nothing here has to be replayed exactly once.
    }
  }, []);

  /**
   * Tell the room this client just wrote the note to the bucket.
   *
   * The console saves through the control plane rather than through the
   * gateway's `write_note`, so this frame is the room's only way to learn that
   * the bucket moved. Everybody else adopts the version; without it they keep
   * the etag their editor opened with, and whoever is elected to save next
   * gets a conflict about a change that is already in their own text.
   */
  const announceSaved = useCallback((etag: string) => {
    const live = socket.current;
    if (!live || live.readyState !== WebSocket.OPEN) return;
    try {
      live.send(savedFrame(etag));
    } catch {
      // A peer that misses this conflicts once and resolves it the ordinary
      // way. There is nothing here worth a retry queue.
    }
  }, []);

  const drawing = useMemo(
    () => ({
      share: (elements: unknown[]) => {
        if (elements.length === 0) return;
        for (const element of elements) {
          const id = (element as { id?: unknown } | null)?.id;
          // Keyed by id, so a shape dragged across twenty frames is sent once,
          // at the position it stopped in, rather than twenty times.
          if (typeof id === "string") drawQueue.current.set(id, element);
        }
        const since = Date.now() - drawSentAt.current;
        if (since >= DRAW_THROTTLE_MS) {
          flushDrawing();
          return;
        }
        if (drawTimer.current === undefined) {
          drawTimer.current = window.setTimeout(flushDrawing, DRAW_THROTTLE_MS - since);
        }
      },
      point: (x: number, y: number, selected: string[]) => {
        const live = socket.current;
        if (!live || live.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - lastPointer.current < CURSOR_THROTTLE_MS) return;
        lastPointer.current = now;
        try {
          live.send(pointerFrame(x, y, selected));
        } catch {
          // A pointer is only interesting where it is now. There is nothing
          // worth retrying about one.
        }
      },
      compact: (elements: unknown[]) => {
        const live = socket.current;
        if (!live || live.readyState !== WebSocket.OPEN) return;
        try {
          live.send(drawSnapshotFrame(encodeElements(elements)));
        } catch {
          // The room asks again in another fifty updates.
        }
      },
    }),
    [flushDrawing],
  );

  /*
    The roster, where the socket handlers can reach it.

    They run outside React and need names and colours to pair with the pointer
    frames arriving between renders. Assigned during render rather than in an
    effect so a frame that lands before the effect flushes still finds the
    roster it was sent alongside.
  */
  roster.current = state.members;

  return useMemo(
    () => ({
      drawing,
      announceSaved,
      members: state.stale ? [] : state.members,
      phase: state.phase,
      summary: presenceSummary(state),
      report,
      shared: shared.current,
      /*
        Read off the ref, recomputed when `settledAt` moves. The ref is the
        value and the counter is only the signal — a memo that closed over the
        counter alone would report the state of the render it was built in.
      */
      settled: settled.current,
      /*
        One question, asked in one pure place a test can reach — see
        `savesToBucket`. It used to be computed here against `state.members`,
        which does not contain this client, by a guard that required it to:
        nobody was ever elected, so nothing was ever written to the bucket and
        every note reopened was a note reverted.
      */
      canWrite: savesToBucket(state),
    }),
    /*
      `settledAt` is the whole reason this list has a counter in it, and the
      lint rule calls it unnecessary because nothing in the body reads it. That
      is the point: the value is `settled.current`, a ref, which React cannot
      see change. The counter is the only thing that tells this memo to look
      again, and dropping it leaves every consumer holding the answer from
      whichever render happened to be last.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, report, drawing, announceSaved, settledAt],
  );
}
