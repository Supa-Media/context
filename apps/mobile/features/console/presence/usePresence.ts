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

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { gatewayOriginFrom } from "../../meetings/gateway";
import {
  byeFrame,
  cursorFrame,
  decodeServerFrame,
  pingFrame,
  presenceSocketUrl,
  snapshotFrame,
  updateFrame,
  type PresenceMember,
} from "./protocol";
import { createSharedDoc, isWriter, seedSharedDoc, type SharedDoc } from "./sharedDoc";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
  reconnectDelayMs,
  type PresencePhase,
} from "./session";

/** How often a caret move is sent, at most. */
const CURSOR_THROTTLE_MS = 120;

/** Reconnect this long before the gateway would close the socket itself. */
const REAUTH_MARGIN_MS = 15_000;

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
   * Whether this client is the one that writes the merged text to the bucket.
   *
   * Exactly one member is, and the rest deliberately leave their local draft
   * clean so the existing autosave cannot fire for them. Two savers would race
   * against one etag and conflict with each other, which is the failure this
   * whole feature exists to remove — reintroduced from the other end.
   */
  canWrite: boolean;
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
}): Presence {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const [state, dispatch] = useReducer(presenceReducer, initialPresenceState);

  const socket = useRef<WebSocket | null>(null);
  const timers = useRef<{ heartbeat?: number; reconnect?: number; reauth?: number }>({});
  const lastSent = useRef<{ at: number; anchor: number; head: number }>({ at: 0, anchor: -1, head: -1 });
  const pending = useRef<{ anchor: number; head: number } | null>(null);
  const seed = useRef<string | null>(null);
  const shared = useRef<SharedDoc | null>(null);
  const textForSeed = useRef(options.textForSeed);
  textForSeed.current = options.textForSeed;
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
      One document per note, created with the room and destroyed with it.

      `onLocalUpdate` fires for this editor's own edits only — an update that
      arrived from the room is applied with a marker origin and does not come
      back out — so this is the one place a keystroke becomes a frame, and it
      does so immediately. Batching here is what would turn "I see the letter
      appear" into "I see the sentence appear".
    */
    const document = createSharedDoc({
      onLocalUpdate: (update) => {
        const live = socket.current;
        if (!live || live.readyState !== WebSocket.OPEN) return;
        try {
          live.send(updateFrame(update));
        } catch {
          // The edit is still in this document; a reconnect replays it.
        }
      },
    });
    shared.current = document;

    const connect = async (attempt: number) => {
      if (cancelled) return;
      let token: string;
      try {
        const granted = await mint({ workspaceId: workspaceId as never });
        token = granted.accessToken;
      } catch {
        // No token, no presence — and no retry. A mint that failed is either a
        // rate limit or a session that is gone, and neither is fixed by asking
        // again in a loop.
        if (!cancelled) dispatch({ type: "unavailable" });
        return;
      }
      if (cancelled) return;

      let live: WebSocket;
      try {
        live = new WebSocket(
          presenceSocketUrl({
            gatewayOrigin: origin as string,
            notePath: path,
            token,
            colorSeed: seed.current || "tab",
          }),
        );
      } catch {
        if (!cancelled) dispatch({ type: "unavailable" });
        return;
      }
      socket.current = live;

      live.onopen = () => {
        if (cancelled) return;
        dispatch({ type: "connected" });

        /*
          **Our whole document, on every connect, and why it is not optional.**

          Edits are causally ordered: a client that misses one cannot apply the
          ones after it, so it stops updating and says nothing about it. That
          makes a single dropped frame permanent divergence rather than a
          hiccup — and frames do get dropped, because the send below is inside
          a `try`.

          An earlier comment on that `catch` claimed "a reconnect replays it".
          That was wrong: a reconnect replays the *room's* log, which never
          received the frame that failed to send. This is what actually makes
          it true. A snapshot subsumes every edit this client has ever made, so
          whatever the room missed it gets now — and sending it is cheap enough
          to do unconditionally rather than trying to work out whether anything
          was lost, which is the kind of bookkeeping that is wrong once and
          then silently wrong forever.
        */
        try {
          live.send(snapshotFrame(document.snapshot()));
        } catch {
          // The next reconnect tries again; the document is still here.
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

        if (frame.t === "u") {
          document.applyRemote(frame.d);
          return;
        }

        if (frame.t === "sync") {
          // The document so far. Applied before anything else this client
          // does, so a person who joined mid-sentence is looking at the same
          // text as everybody else before their first keystroke.
          for (const update of frame.updates) document.applyRemote(update);
          return;
        }

        if (frame.t === "compact") {
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
            **Seeding, and why only one client may do it.**

            A note starts as text in a bucket and somebody has to put it into
            the shared document. If two clients do, the note contains it twice.
            The room admits members one at a time, so "was anybody already
            here?" has exactly one answer per join: an empty roster and an empty
            replay means this client is first, and it seeds. Everybody else
            waits for the replay however fast they were.
          */
          if (frame.members.length === 0) seedSharedDoc(document, textForSeed.current());

          // Reconnect just before the gateway would close this socket, so the
          // roster never visibly drops. See the header.
          const due = Math.max(frame.reconnectAfterMs - REAUTH_MARGIN_MS, 30_000);
          timers.current.reauth = window.setTimeout(() => {
            closeSocket(true);
            void connect(0);
          }, due);
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

    void connect(0);

    return () => {
      cancelled = true;
      closeSocket(true);
      shared.current = null;
      document.destroy();
    };
    // `mint` is stable from Convex; the rest is the identity of the room.
  }, [active, workspaceId, origin, notePath, mint, closeSocket, clearTimers]);

  /**
   * Send a caret, at most every `CURSOR_THROTTLE_MS`.
   *
   * A trailing send is scheduled rather than dropped, because the position that
   * matters most is the one somebody stopped at — dropping the last frame of a
   * fast movement leaves a peer's caret a word behind for as long as its owner
   * sits still.
   */
  const report = useCallback((anchor: number, head: number) => {
    const live = socket.current;
    if (!live || live.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const held = lastSent.current;
    if (held.anchor === anchor && held.head === head) return;

    const send = (a: number, h: number) => {
      try {
        if (live.readyState === WebSocket.OPEN) live.send(cursorFrame(a, h));
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

  return useMemo(
    () => ({
      members: state.stale ? [] : state.members,
      phase: state.phase,
      summary: presenceSummary(state),
      report,
      shared: shared.current,
      canWrite: isWriter(
        state.you,
        state.members.map((one) => one.id),
      ),
    }),
    [state, report],
  );
}
