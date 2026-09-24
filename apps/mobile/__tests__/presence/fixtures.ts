/**
 * @jest-environment jsdom
 */

/**
 * PRESENCE, ON THE CLIENT — the wire, the state machine, and the decorations.
 *
 * The socket itself lives in `usePresence` and is deliberately not tested here:
 * everything it *decides* was moved into `session.ts` so it could be, which is
 * the same split `autosave.ts` draws. What is left in the hook is a
 * `WebSocket`, three timers and React.
 *
 * Two failures are worth naming before the checks that prove they cannot
 * happen, because both would be reported as "the editor is broken" rather than
 * as "presence is broken":
 *
 *  1. **A caret drawn past the end of the document.** Offsets come from another
 *     person's browser through a gateway that has never seen this note, so they
 *     can be anything. A CodeMirror range past `doc.length` throws inside the
 *     update cycle of an editor somebody is typing in, which costs them their
 *     next keystrokes.
 *  2. **Carets from the note you just closed, in the note you just opened.** A
 *     frame in flight when a different note is opened describes a document that
 *     is no longer on screen, and its offsets are meaningless against the one
 *     that is.
 *
 * This module carries the shared fixtures for every file in this folder; it
 * has no tests of its own.
 */

import {
  initialPresenceState,
  type PresenceState,
} from "../../features/console/presence/session";
import { createSharedDoc } from "../../features/console/presence/sharedDoc";
import { type PresenceMember } from "../../features/console/presence/protocol";

/**
 * A peer, with its caret as an encoded relative position.
 *
 * The tests use readable stand-ins ("p:12") and a resolver that reads the
 * number back out, because what these checks are about is the geometry the
 * decorations produce — not Yjs's encoding, which `sync.test` covers against
 * a real document.
 */
export function member(over: Partial<PresenceMember> = {}): PresenceMember {
  return {
    id: "m1",
    name: "@ana",
    color: "#8b5cf6",
    anchor: "p:0",
    head: "p:0",
    canWrite: true,
    isAgent: false,
    ...over,
  };
}

/** Reads the offset back out of a stand-in position. */
export const resolve = (encoded: string): number | null => {
  const match = /^p:(-?\d+)$/.exec(encoded);
  return match ? Number(match[1]) : null;
};

export const at = (offset: number) => `p:${offset}`;

export function live(members: PresenceMember[]): PresenceState {
  return { ...initialPresenceState, phase: "live", notePath: "a.md", you: "me", members, stale: false };
}

/** Two documents wired to each other, as the room wires them. */
export function pair() {
  let a: ReturnType<typeof createSharedDoc>;
  let b: ReturnType<typeof createSharedDoc>;
  a = createSharedDoc({ onLocalUpdate: (u) => b.applyRemote(u) });
  b = createSharedDoc({ onLocalUpdate: (u) => a.applyRemote(u) });
  return { a, b };
}
