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

export type PresencePhase = "idle" | "connecting" | "live" | "reconnecting" | "unavailable";

export interface PresenceState {
  phase: PresencePhase;
  /** The note these members are in. Every frame is checked against it. */
  notePath: string | null;
  /** This connection's own member id, once the gateway has named it. */
  you: string | null;
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
      return { ...state, phase: "reconnecting", you: null, stale: true, attempts: state.attempts + 1 };
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
export function reconnectDelayMs(attempts: number): number {
  if (attempts <= 1) return 250;
  const backoff = 250 * 2 ** (attempts - 1);
  return backoff > 30_000 ? 30_000 : backoff;
}

/** What the header says. Empty when there is nothing worth saying. */
export function presenceSummary(state: PresenceState): string {
  if (state.phase === "reconnecting") return "Reconnecting";
  if (state.members.length === 0) return "";
  return state.members.length === 1 ? "1 here" : `${state.members.length} here`;
}
