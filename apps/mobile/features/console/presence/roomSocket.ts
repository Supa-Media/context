import type { Dispatch } from "react";
import type { useConsoleGrant } from "../../agent/useConsoleGrant";
import { onReturnToApp } from "../../app/returnToApp";
import {
  askFrame,
  decodeServerFrame,
  pingFrame,
  CLOSE_REFUSED,
  presenceSocketUrl,
  syncFrame,
  type PresenceMember,
} from "./protocol";
import { encodeSyncStep1, encodeUpdate } from "./sync";
import { createSharedDoc, seedSharedDoc, type SharedDoc } from "./sharedDoc";
import {
  CONNECT_DEADLINE_MS,
  HEARTBEAT_MS,
  MISSED_HEARTBEATS,
  REFRESH_AFTER_UNOPENED,
  PROBE_GRACE_MS,
  reconnectDelayMs,
  type PresenceAction,
} from "./session";
import { isDefinitiveGrantRefusal, type GrantRefresh } from "../../agent/consoleGrantCache";
import { peersFrom } from "./peers";
import { agentCarets } from "./agentCarets";
import { handleRoomFrame, type RoomFrameContext } from "./roomFrames";
import type { PresenceOptions } from "./presenceContract";

/** Reconnect this long before the gateway would close the socket itself. */
const REAUTH_MARGIN_MS = 15_000;

type Ref<T> = { current: T };

/** Everything one room reads: the room's identity, and the hook's refs. */
export interface PresenceRoomInputs {
  notePath: string | null;
  workspaceId: string | null;
  origin: string | null;
  mode: "text" | "drawing" | "presence";
  options: { durable?: boolean; documentId?: string | null };
  mint: ReturnType<typeof useConsoleGrant>;
  closeSocket: (say: boolean) => void;
  settle: () => void;
  dispatch: Dispatch<PresenceAction>;
  socket: Ref<WebSocket | null>;
  timers: Ref<{
    heartbeat?: number;
    reconnect?: number;
    reauth?: number;
    cursor?: number;
    deadline?: number;
    probe?: number;
  }>;
  socketToken: Ref<string | null>;
  selection: Ref<{ anchor: number; head: number } | null>;
  reportCurrent: Ref<() => void>;
  lastSent: Ref<{ at: number; anchor: number; head: number }>;
  pending: Ref<{ anchor: number; head: number } | null>;
  seed: Ref<string | null>;
  shared: Ref<SharedDoc | null>;
  externalShared: Ref<SharedDoc | null>;
  settled: Ref<boolean>;
  textForSeed: Ref<() => string>;
  onExternalWrite: Ref<PresenceOptions["onExternalWrite"]>;
  onDrawing: Ref<PresenceOptions["onDrawing"]>;
  onDrawingCompact: Ref<PresenceOptions["onDrawingCompact"]>;
  onPeerPointers: Ref<PresenceOptions["onPeerPointers"]>;
  onLiveUpdate: Ref<PresenceOptions["onLiveUpdate"]>;
  onCommitted: Ref<PresenceOptions["onCommitted"]>;
  pointers: Ref<Map<string, { x: number; y: number; selected: string[] }>>;
  roster: Ref<PresenceMember[]>;
  agentTimers: Ref<Map<string, number>>;
  agentWatch: Ref<(() => void) | null>;
}

/**
 * Open one room: the body of `usePresence`'s socket effect after its
 * "nothing to open" guard, moved verbatim. The effect still owns the
 * dependency list that decides when a room is opened and closed; it calls
 * this and returns what this returns, which is the room's cleanup.
 */
export function openPresenceRoom({
  notePath,
  workspaceId,
  origin,
  mode,
  options,
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
}: PresenceRoomInputs): () => void {
  let cancelled = false;
  selection.current = null;
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

  const { holdAgent, watchAgentWrite } = agentCarets({
    path,
    dispatch,
    agentTimers,
    agentWatch,
    pointers,
    roster,
    externalShared,
    onPeerPointers,
  });

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
  /*
    **One attempt at a time, and every attempt has an end.**

    Each attempt is a numbered generation: the grant, the socket, its
    handlers and its timers all belong to it, and anything that answers for
    an older generation — a mint that settles late, an `onclose` from a
    socket already replaced, a deadline that fires after the welcome — is
    ignored rather than allowed to open a second socket or schedule a second
    retry. The deadline covers mint, handshake and welcome together: a
    handshake that never answers, or a mint that never settles, used to
    leave this room in "Reconnecting" until the page was reloaded.
  */
  let generation = 0;
  let attemptInFlight = false;
  /** Consecutive failures since the last welcome; the backoff reads it. */
  let failures = 0;
  /** Sockets that closed before opening since the last welcome or refresh. */
  let unopened = 0;
  /** Whether this run of failures has already replaced the credential. */
  let refreshed = false;
  let refreshNext: GrantRefresh = false;
  /** Pings sent since the last frame arrived, and when the heartbeat last ran. */
  let unanswered = 0;
  let lastBeat = 0;
  /** Frames received, for the resume probe to tell "heard since" apart. */
  let heard = 0;

  const scheduleRetry = () => {
    if (cancelled) return;
    failures += 1;
    if (timers.current.reconnect !== undefined) window.clearTimeout(timers.current.reconnect);
    timers.current.reconnect = window.setTimeout(() => {
      timers.current.reconnect = undefined;
      void connect();
    }, reconnectDelayMs(failures, Math.random()));
  };

  /**
   * End generation `gen` and try again later.
   *
   * `opened` says whether the gateway accepted the upgrade. A browser hides
   * the HTTP refusal of a rejected upgrade behind code 1006, so a socket that
   * never opens might be a credential the gateway no longer honours — minted
   * for this instance and replaced since, or expired on the server first.
   * Two of those in a row earn one refresh, naming the token that failed;
   * after that it is backoff, never a mint per retry. Whether access was
   * really withdrawn is the mint's answer to give, not a guess from 1006.
   */
  const fail = (gen: number, opened: boolean, token: string | null) => {
    if (cancelled || gen !== generation) return;
    generation += 1;
    attemptInFlight = false;
    closeSocket(false);
    if (!opened && token !== null) {
      unopened += 1;
      if (unopened >= REFRESH_AFTER_UNOPENED && !refreshed) {
        refreshed = true;
        unopened = 0;
        refreshNext = { rejected: token };
      }
    }
    dispatch({ type: "dropped" });
    scheduleRetry();
  };

  /**
   * Ask an open socket to prove it is alive: one ping, and a short wait for
   * any frame at all. Silence ends the generation.
   */
  const probe = (gen: number, token: string | null) => {
    const live = socket.current;
    if (cancelled || gen !== generation || live === null) return;
    if (timers.current.probe !== undefined) return;
    const before = heard;
    try {
      live.send(pingFrame());
    } catch {
      fail(gen, true, token);
      return;
    }
    timers.current.probe = window.setTimeout(() => {
      timers.current.probe = undefined;
      if (heard === before) fail(gen, true, token);
    }, PROBE_GRACE_MS);
  };

  /** Access is gone. Stop quietly; the editor is exactly what it was. */
  const refuse = () => {
    generation += 1;
    attemptInFlight = false;
    closeSocket(false);
    dispatch({ type: "unavailable" });
  };

  const connect = async () => {
    if (cancelled || attemptInFlight || socket.current !== null) return;
    attemptInFlight = true;
    const gen = ++generation;
    const refresh = refreshNext;
    refreshNext = false;
    let opened = false;
    let token: string | null = null;
    timers.current.deadline = window.setTimeout(() => {
      timers.current.deadline = undefined;
      fail(gen, opened, token);
    }, CONNECT_DEADLINE_MS);

    try {
      const granted = await mint({ workspaceId: workspaceId as never }, refresh);
      token = granted.accessToken;
    } catch (error) {
      if (cancelled || gen !== generation) return;
      // Minting can fail while the app is waking or the gateway is rolling
      // out, and that is retried. A refusal from the control plane — the
      // workspace is not yours any more — is the definitive answer a socket
      // close can never give, and it is final for this room.
      if (isDefinitiveGrantRefusal(error)) refuse();
      else fail(gen, true, null);
      return;
    }
    if (cancelled || gen !== generation) return;

    let live: WebSocket;
    try {
      live = new WebSocket(
        presenceSocketUrl({
          gatewayOrigin: origin as string,
          notePath: path,
          token,
          colorSeed: seed.current || "tab",
          ...(options.durable ? { collaborationVersion: 2 as const, documentId: options.documentId ?? undefined } : {}),
        }),
      );
    } catch {
      fail(gen, true, null);
      return;
    }
    attemptInFlight = false;
    socket.current = live;
    socketToken.current = token;
    const sentToken = token;
    /** Whether a callback still speaks for the socket this room is using. */
    const current = () => !cancelled && gen === generation && socket.current === live;
    /** What the note and canvas frames need from this attempt. See `roomFrames.ts`. */
    const content: RoomFrameContext = {
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
    };

    live.onopen = () => {
      if (!current()) return;
      opened = true;
      // Reconnects use the same document but need a fresh caret frame: the
      // room discarded the old position when this socket left.
      lastSent.current = { at: 0, anchor: -1, head: -1 };
      pending.current = null;
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
      /*
        **An open socket is not a live one.** A laptop that slept, a proxy
        that dropped the connection silently, a network that changed under
        it: the browser can go on reporting OPEN with nothing at the other
        end, and no close event ever comes. The gateway answers every ping,
        so pings that go unanswered are the only evidence there is — and
        three of them end the socket.

        A heartbeat that ran late was throttled or suspended with its tab,
        so the pings before it could not have been answered in time and are
        not counted. That is what keeps a background tab from reconnecting
        on every throttled tick; its socket is probed when it comes back.
      */
      unanswered = 0;
      lastBeat = Date.now();
      timers.current.heartbeat = window.setInterval(() => {
        if (!current()) return;
        const now = Date.now();
        if (now - lastBeat > HEARTBEAT_MS * 2.5) unanswered = 0;
        lastBeat = now;
        if (live.readyState !== WebSocket.OPEN) return;
        unanswered += 1;
        // The last of the allowed pings gets a short grace to be answered,
        // and then the socket is replaced.
        if (unanswered >= MISSED_HEARTBEATS) probe(gen, sentToken);
        else {
          try {
            live.send(pingFrame());
          } catch {
            // The close handler below does the reconnecting.
          }
        }
      }, HEARTBEAT_MS);
    };

    live.onmessage = (event: MessageEvent) => {
      if (!current()) return;
      // Any frame is proof of life, not only a pong.
      unanswered = 0;
      heard += 1;
      const frame = decodeServerFrame(event.data);
      if (!frame) return;

      if (handleRoomFrame(frame, content)) return;

      if (frame.t === "welcome") {
        reportCurrent.current();
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

        /*
          The attempt succeeded: stop its deadline and forget the failures
          that preceded it, so the next ordinary drop is retried at once
          rather than at whatever backoff an earlier outage had reached.
        */
        if (timers.current.deadline !== undefined) window.clearTimeout(timers.current.deadline);
        timers.current.deadline = undefined;
        failures = 0;
        unopened = 0;
        refreshed = false;

        // Reconnect just before the gateway would close this socket, so the
        // roster never visibly drops. See the header.
        const due = Math.max(frame.reconnectAfterMs - REAUTH_MARGIN_MS, 30_000);
        if (timers.current.reauth !== undefined) window.clearTimeout(timers.current.reauth);
        timers.current.reauth = window.setTimeout(() => {
          timers.current.reauth = undefined;
          if (!current()) return;
          generation += 1;
          closeSocket(true);
          void connect();
        }, due);
      }
      if (frame.t === "join" && frame.member.isAgent) holdAgent(frame.member.id);
      if (frame.t === "leave") {
        // A peer that left takes its pointer with it, or Excalidraw goes on
        // drawing a cursor for somebody who has closed the tab.
        pointers.current.delete(frame.id);
        onPeerPointers.current?.(peersFrom(roster.current, pointers.current));
      }
      dispatch({ type: "frame", notePath: path, frame });
    };

    live.onclose = (event: CloseEvent) => {
      // An intentional close has already moved `socket.current` on, so it
      // cannot schedule a second reconnect here.
      if (!current()) return;
      if (event.code === CLOSE_REFUSED) {
        refuse();
        return;
      }
      fail(gen, opened, sentToken);
    };

    live.onerror = () => {
      // `onclose` always follows, and it is where the reconnect lives. Doing
      // it here as well would double every backoff.
    };
  };

  /*
    **Back in the app: repair now rather than when a timer gets round to it.**

    Waiting out a backoff is skipped. An open socket is probed, because a
    machine that slept can come back to a socket that is OPEN in name only,
    and the heartbeat deliberately did not count the pings it could not send
    while the tab was throttled. A handshake in progress is left to its own
    deadline rather than duplicated.
  */
  const resume = () => {
    if (cancelled) return;
    const live = socket.current;
    if (live === null) {
      if (attemptInFlight) return;
      if (timers.current.reconnect !== undefined) {
        window.clearTimeout(timers.current.reconnect);
        timers.current.reconnect = undefined;
      }
      failures = 0;
      void connect();
      return;
    }
    if (live.readyState !== WebSocket.OPEN || timers.current.deadline !== undefined) return;
    probe(generation, socketToken.current);
  };
  void connect();
  const stopRetrying = onReturnToApp(resume);

  return () => {
    cancelled = true;
    stopRetrying();
    closeSocket(true);
    for (const timer of toolCarets.values()) window.clearTimeout(timer);
    toolCarets.clear();
    agentWatch.current?.();
    shared.current = null;
    document?.destroy();
  };
}
