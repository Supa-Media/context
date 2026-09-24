/**
 * The presence connection as a state machine, with no socket in it.
 *
 * `usePresence` owns the `WebSocket`, the timers and React. Everything that
 * *decides* something lives here, pure, so the cases that matter can be tested
 * without a server: a peer joining while another is leaving, a reconnect that
 * must not lose the roster, a note switched under a live connection, and the
 * one that would be worth the feature being reverted — **carets from the note
 * you just closed appearing in the note you just opened.**
 *
 * ## The failure this file is really about
 *
 * A socket is opened for `a.md`. Somebody opens `b.md` before the welcome
 * frame lands. Frames now arrive for a room the editor is no longer showing,
 * and every one of them is an offset into a document it does not describe. So
 * every frame carries the note it belongs to through this reducer and is
 * dropped if it does not match — the same shape `useFileBrowser` uses for a
 * fired autosave, and for the same reason.
 *
 * ## Why the roster survives a reconnect but the carets do not
 *
 * A reconnect happens every five minutes by design (the gateway closes an
 * authorized socket at `PRESENCE_SOCKET_MAX_MS`). Emptying the roster each time
 * would make everybody blink out and back once a minute-ish, so the members are
 * kept across a reconnect and replaced wholesale by the next welcome. Their
 * *carets* are a different matter: an offset from before a reconnect describes
 * a document that may have changed, so the peers stay in the header and their
 * carets stop being drawn until they move again.
 */

import type { PresenceMember, ServerFrame } from "./protocol";
import { electWriter } from "./sharedDoc";

export type PresencePhase = "idle" | "connecting" | "live" | "reconnecting" | "unavailable";

export interface PresenceState {
  phase: PresencePhase;
  /** The note these members are in. Every frame is checked against it. */
  notePath: string | null;
  /** This connection's own member id, once the gateway has named it. */
  you: string | null;
  /**
   * Whether the room would accept an edit from **this** client.
   *
   * Kept separately because `members` deliberately does not contain you — the
   * header counts it as "2 here" — so your own authority is nowhere in it. It
   * arrives on your own entry in the welcome roster and was being dropped on
   * the floor by the filter below, which is what made every save impossible.
   *
   * The resets on `open` and `dropped` cannot be observed today and are kept
   * anyway: this field is only ever read on the `live` branch of
   * `savesToBucket`, and the one action that reaches `live` carrying an
   * identity is the welcome frame, which recomputes it. Deleting either reset
   * measures nothing — that is a fact about the current transitions, not a
   * spare line, and it stops being true the moment another action sets `you`.
   */
  youCanWrite: boolean;
  members: PresenceMember[];
  /** Whether each member's caret may be drawn — false across a reconnect. */
  stale: boolean;
  /** How many consecutive failures; the backoff reads it. */
  attempts: number;
}

export const initialPresenceState: PresenceState = {
  phase: "idle",
  notePath: null,
  you: null,
  youCanWrite: false,
  members: [],
  stale: false,
  attempts: 0,
};

export type PresenceAction =
  | { type: "open"; notePath: string }
  | { type: "close" }
  /** The gateway refused in a way retrying cannot fix: no binding, no access. */
  | { type: "unavailable" }
  | { type: "connected" }
  | { type: "dropped" }
  | { type: "frame"; notePath: string; frame: ServerFrame };

export function presenceReducer(state: PresenceState, action: PresenceAction): PresenceState {
  switch (action.type) {
    case "open": {
      if (state.notePath === action.notePath && state.phase !== "idle") return state;
      // A different note is a different room. Nothing from the old one is
      // carried across — not the roster, not the member id, not the attempts.
      return {
        phase: "connecting",
        notePath: action.notePath,
        you: null,
        youCanWrite: false,
        members: [],
        stale: false,
        attempts: 0,
      };
    }

    case "close":
      return initialPresenceState;

    case "unavailable":
      // Terminal and quiet. The editor shows exactly what it showed before
      // presence existed; there is nothing for a person to dismiss.
      return { ...initialPresenceState, phase: "unavailable", notePath: state.notePath };

    case "connected":
      return state.phase === "unavailable" ? state : { ...state, phase: "live", attempts: 0 };

    case "dropped": {
      if (state.phase === "unavailable" || state.phase === "idle") return state;
      // Members are kept and their carets are not drawn. See the header.
      return {
        ...state,
        phase: "reconnecting",
        you: null,
        youCanWrite: false,
        stale: true,
        attempts: state.attempts + 1,
      };
    }

    case "frame": {
      // The guard this file exists for: a frame for a note we are no longer
      // showing is not a frame about this document.
      if (action.notePath !== state.notePath) return state;
      if (state.phase === "unavailable") return state;
      return applyFrame(state, action.frame);
    }

    default:
      return state;
  }
}

function applyFrame(state: PresenceState, frame: ServerFrame): PresenceState {
  switch (frame.t) {
    case "welcome":
      return {
        ...state,
        phase: "live",
        you: frame.you,
        /*
          Read before the filter throws your own entry away. The room resolved
          this from your grant and your role; it is the only place this client
          is told whether its own edits would be accepted, and it used to be
          discarded one line later.
        */
        youCanWrite: frame.members.some((one) => one.id === frame.you && one.canWrite),
        // The welcome roster is authoritative and replaces whatever a previous
        // connection left, rather than merging with it — a merge would keep a
        // peer who left while we were away.
        members: frame.members.filter((one) => one.id !== frame.you),
        stale: false,
        attempts: 0,
      };

    case "join": {
      if (frame.member.id === state.you) return state;
      // Replace rather than append: a duplicate id is impossible from the
      // gateway and the failure mode of trusting that is two carets for one
      // person, which is worse than the cost of the scan.
      const without = state.members.filter((one) => one.id !== frame.member.id);
      return { ...state, members: [...without, frame.member] };
    }

    case "cursor": {
      if (frame.id === state.you) return state;
      const index = state.members.findIndex((one) => one.id === frame.id);
      // A cursor for somebody who is not in the roster is dropped rather than
      // being turned into a nameless member: a caret with no name and no colour
      // is a rendering bug wearing a person's clothes.
      if (index === -1) return state;
      const members = state.members.slice();
      members[index] = { ...members[index], anchor: frame.anchor, head: frame.head };
      return { ...state, members, stale: false };
    }

    case "leave": {
      if (!state.members.some((one) => one.id === frame.id)) return state;
      return { ...state, members: state.members.filter((one) => one.id !== frame.id) };
    }

    case "pong":
      return state;

    default:
      return state;
  }
}

/**
 * How long to wait before the next attempt.
 *
 * Exponential with a ceiling, and the ceiling matters more than the curve: a
 * console left open overnight against a gateway that is down must not be
 * retrying every second by morning. The first retry is fast because the
 * ordinary cause is the five-minute reauthorization close, where the right
 * answer is "reconnect now".
 */
export function reconnectDelayMs(attempts: number, jitter = 1): number {
  const base = attempts <= 1 ? 250 : Math.min(250 * 2 ** (attempts - 1), 30_000);
  /*
    Between half the step and the whole of it. A gateway deploy or a network
    blip drops every open console at the same instant, and without the spread
    they all come back on the same tick, every tick of the curve.
  */
  const spread = Math.min(Math.max(jitter, 0), 1);
  return Math.round(base * (0.5 + 0.5 * spread));
}

/**
 * How long one attempt — mint, handshake and welcome together — may take
 * before it is abandoned and retried. Long enough for a slow phone network,
 * well inside the minute somebody will stare at "Reconnecting" before
 * reloading.
 */
export const CONNECT_DEADLINE_MS = 20_000;

/** How often an open socket pings the gateway, which answers every ping. */
export const HEARTBEAT_MS = 15_000;

/**
 * Pings, sent on time, that may go unanswered. The last is a probe: it gets
 * `PROBE_GRACE_MS` to be answered before the OPEN socket is treated as dead.
 */
export const MISSED_HEARTBEATS = 3;

/** How long a probed socket — the last heartbeat, or one checked on return to
 * the app — has to say anything at all. */
export const PROBE_GRACE_MS = 5_000;

/**
 * Sockets that close before opening, in a row, before the credential is
 * replaced once. One is ordinary network noise; two with no welcome between
 * them is worth one mint, and never more than one per run of failures.
 */
export const REFRESH_AFTER_UNOPENED = 2;

/** What the header says. Empty when there is nothing worth saying. */
export function presenceSummary(state: PresenceState): string {
  if (state.phase === "reconnecting") return "Reconnecting";
  if (state.members.length === 0) return "";
  return state.members.length === 1 ? "1 here" : `${state.members.length} here`;
}

/**
 * Does **this** client write the note to the bucket?
 *
 * ## The question the editor asks, in the one place it can be checked
 *
 * It used to be asked inside `usePresence`, against `state.members` — and
 * `electWriter` required the caller to be in that list while the reducer
 * removes the caller from it. The guard could never be satisfied. `canWrite`
 * was false for every client in every room, so `mayPersist` refused every
 * change and every ⌘S, and the text lived in the shared document and in the
 * room's log and **never reached the bucket**. Open the note again and the
 * work was gone.
 *
 * Every test on both sides of that seam was green: the unit tests passed a
 * roster containing the caller, and the browser harness built its roster from
 * the welcome frame unfiltered so it contained the caller too. Neither ran the
 * shape the product actually produces. So the decision lives here now, pure
 * and reachable, and the checks drive it through the real reducer.
 *
 * ## Two states, and the second one is the safety net
 *
 * **In a live room**, exactly one member saves — the lowest id among the
 * members the room would accept an edit from — or every editor races against
 * one etag, which is the collision the whole feature exists to remove.
 *
 * **With no live room, this client saves**, exactly as it did before presence
 * existed. `shared` is created the moment the hook runs, before any socket
 * connects and whether or not one ever does, so `mayPersist`'s "no room at
 * all" escape hatch could not fire on its own: a gateway with no presence
 * binding, a refused socket or a dead network left the editor unable to save
 * anything. Nobody else is coordinating in those states.
 *
 * A reconnect counts as "no live room" too. Saving during that gap can cost a
 * conflict, because whoever was elected may still be saving; not saving costs
 * the work. A conflict is the one of those two a person can see and recover
 * from.
 *
 * ## AND `live` IS NOT ONE STATE — THE SOCKET OPENING IS NOT THE ROOM NAMING YOU
 *
 * `connected` fires from `live.onopen` and sets `phase: "live"` before any
 * frame arrives, so with `you: null` and `youCanWrite: false`. Asking only
 * about the phase therefore took the live branch while this client had no id
 * and no roster, `electWriter` refused for want of anybody to elect, and the
 * editor saved nothing — the same sentence this function exists to delete,
 * reached by a different route, on every first connect and every reconnect.
 *
 * Nobody is coordinating this client in that window either: it is not in
 * anyone's roster and no election has named it. So the escape hatch asks the
 * question it means — **has the room named me?** — rather than a proxy for it.
 * `you` is the room's own answer, set only by the welcome frame and cleared by
 * `open` and `dropped`.
 */
export function savesToBucket(state: PresenceState): boolean {
  // `state.you === null` alone would behave identically today, because `you`
  // is non-null only on the `live` branch. Both clauses are kept because they
  // say the two different things this is actually asking — is there a room,
  // and has it named me — and only the pair survives a new transition that
  // carries one without the other.
  if (state.phase !== "live" || state.you === null) return true;
  return electWriter(state.you, state.youCanWrite, state.members);
}
