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
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../../meetings/gateway";
import {
  byeFrame,
  cursorFrame,
  liveUpdateFrame,
  drawFrame,
  savedFrame,
  drawSnapshotFrame,
  pointerFrame,
  type PresenceMember,
} from "./protocol";
import { cursorPositions } from "./sync";
import { encodeElements } from "@context/drawings";
import type { SharedDoc } from "./sharedDoc";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
  savesToBucket,
} from "./session";
import { tabSeed } from "./peers";
import { openPresenceRoom } from "./roomSocket";
import type { Presence, PresenceOptions } from "./presenceContract";

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

export type { Presence } from "./presenceContract";
export type { PeerPointer } from "./peers";

export function usePresence(options: PresenceOptions): Presence {
  const mint = useConsoleGrant();
  const [state, dispatch] = useReducer(presenceReducer, initialPresenceState);

  const socket = useRef<WebSocket | null>(null);
  const timers = useRef<{
    heartbeat?: number;
    reconnect?: number;
    reauth?: number;
    cursor?: number;
    deadline?: number;
    probe?: number;
  }>({});
  const socketToken = useRef<string | null>(null);
  const selection = useRef<{ anchor: number; head: number } | null>(null);
  const reportCurrent = useRef<() => void>(() => {});
  const lastSent = useRef<{ at: number; anchor: number; head: number }>({ at: 0, anchor: -1, head: -1 });
  const pending = useRef<{ anchor: number; head: number } | null>(null);
  const seed = useRef<string | null>(null);
  const shared = useRef<SharedDoc | null>(null);
  const externalShared = useRef<SharedDoc | null>(options.shared ?? null);
  if (externalShared.current !== (options.shared ?? null)) {
    externalShared.current = options.shared ?? null;
    // A relative position is meaningless until it is encoded against the new
    // document. Re-send the current selection after durable binding or a note
    // switch even if its numeric offsets did not change.
    lastSent.current = { at: 0, anchor: -1, head: -1 };
    pending.current = null;
  }
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
  const onLiveUpdate = useRef(options.onLiveUpdate);
  onLiveUpdate.current = options.onLiveUpdate;
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
  /** Stops waiting for the read that brings a named agent's write in. */
  const agentWatch = useRef<(() => void) | null>(null);
  if (seed.current === null && typeof window !== "undefined") seed.current = tabSeed();

  const { workspaceId, endpoint, notePath, enabled } = options;
  const origin = endpoint === null ? null : gatewayOriginFrom(endpoint);
  const active = enabled && workspaceId !== null && origin !== null && notePath !== null &&
    (!options.durable || options.documentId != null);

  const clearTimers = useCallback(() => {
    const held = timers.current;
    if (held.heartbeat) window.clearInterval(held.heartbeat);
    if (held.reconnect) window.clearTimeout(held.reconnect);
    if (held.reauth) window.clearTimeout(held.reauth);
    if (held.cursor) window.clearTimeout(held.cursor);
    if (held.deadline) window.clearTimeout(held.deadline);
    if (held.probe) window.clearTimeout(held.probe);
    timers.current = {};
  }, []);

  const closeSocket = useCallback(
    (say: boolean) => {
      const live = socket.current;
      socket.current = null;
      socketToken.current = null;
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

    return openPresenceRoom({
      notePath,
      workspaceId,
      origin,
      mode,
      options: { durable: options.durable, documentId: options.documentId },
      mint,
      closeSocket,
      settle,
      dispatch,
      socket,
      timers,
      socketToken,
      selection,
      reportCurrent,
      lastSent,
      pending,
      seed,
      shared,
      externalShared,
      settled,
      textForSeed,
      onExternalWrite,
      onDrawing,
      onDrawingCompact,
      onPeerPointers,
      onLiveUpdate,
      onCommitted,
      pointers,
      roster,
      agentTimers,
      agentWatch,
    });
    // `mint` is stable from Convex; the rest is the identity of the room —
    // `mode` included, because it decides whether this socket creates a shared
    // text document at all. It is derived from the path and so moves with it,
    // but a dependency that is true by coincidence is one that stops being
    // true without anybody noticing.
  }, [active, workspaceId, origin, notePath, mode, options.durable, options.documentId, mint, closeSocket, clearTimers, settle]);

  /**
   * Send a caret, at most every `CURSOR_THROTTLE_MS`.
   *
   * A trailing send is scheduled rather than dropped, because the position that
   * matters most is the one somebody stopped at — dropping the last frame of a
   * fast movement leaves a peer's caret a word behind for as long as its owner
   * sits still.
   */
  const report = useCallback((anchor: number, head: number) => {
    selection.current = { anchor, head };
    const live = socket.current;
    if (!live || live.readyState !== WebSocket.OPEN) return;
    const held = lastSent.current;
    if (held.anchor === anchor && held.head === head) {
      pending.current = null;
      if (timers.current.cursor !== undefined) window.clearTimeout(timers.current.cursor);
      timers.current.cursor = undefined;
      return;
    }
    pending.current = { anchor, head };
    const send = () => {
      timers.current.cursor = undefined;
      const queued = pending.current;
      pending.current = null;
      const currentSocket = socket.current;
      if (!queued || !currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
      try {
        const document = shared.current ?? externalShared.current;
        const positions = cursorPositions(document?.text ?? null, queued.anchor, queued.head);
        currentSocket.send(cursorFrame(positions.anchor, positions.head));
        lastSent.current = { at: Date.now(), ...queued };
      } catch {
        // A reconnect re-announces the current selection.
      }
    };
    if (timers.current.cursor !== undefined) window.clearTimeout(timers.current.cursor);
    const remaining = CURSOR_THROTTLE_MS - (Date.now() - held.at);
    if (remaining <= 0) send();
    else timers.current.cursor = window.setTimeout(send, remaining);
  }, []);
  reportCurrent.current = () => {
    const at = selection.current;
    if (!at) return;
    lastSent.current = { at: 0, anchor: -1, head: -1 };
    report(at.anchor, at.head);
  };
  useEffect(() => { reportCurrent.current(); }, [options.shared]);

  const subscribeLiveUpdates = options.subscribeLiveUpdates;
  useEffect(() => {
    const unsubscribe = subscribeLiveUpdates?.((frame) => {
      const live = socket.current;
      const token = socketToken.current;
      if (!live || live.readyState !== WebSocket.OPEN || !token || frame.update.length > 32 * 1024) return;
      try {
        live.send(liveUpdateFrame(frame.documentId, frame.update, token));
      } catch {
        // The persisted HTTP queue still owns delivery and the save indicator.
      }
    });
    return unsubscribe;
    // Bind again when the controller acquires its authoritative document. The
    // first render can precede that binding even with a stable subscription API.
  }, [subscribeLiveUpdates, options.documentId]);


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
