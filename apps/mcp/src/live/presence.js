/**
 * Presence identities and announcements: the per-client key a room tells
 * people apart by, the display name and actor shown to others, and telling a
 * note's room that a write or a committed edit happened. Moved verbatim out
 * of `src/index.js`; authorizing a socket stays beside the privacy engine.
 */

import { personalNameFor } from "../context/identity.js";
import { roomKey } from "../presence.js";

/**
 * Broadcast one committed snapshot to v2 presence sockets, best-effort.
 *
 * `actor` is set only by `write_note`, so the room can name the agent whose
 * write this was. The console's own `/collaboration` saves pass none: they
 * are somebody typing, and the room already has them as a member.
 */
export async function announceCommittedToPresence(store, path, result, actor = null) {
  const rooms = store.presenceRooms;
  const workspaceId = store.actor?.workspaceId;
  if (!rooms || typeof workspaceId !== "string" || !workspaceId) return;
  if (!result || typeof result.documentId !== "string" || typeof result.etag !== "string") return;
  const run = async () => {
    try {
      const room = rooms.get(rooms.idFromName(roomKey(workspaceId, path)));
      await room.fetch("https://presence.invalid/committed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentId: result.documentId,
          etag: result.etag,
          ...(actor && typeof actor.id === "string" ? { actor } : {}),
        }),
      });
    } catch {
      // A room is a live view. The bucket commit already succeeded, and a
      // reconnect reads the authoritative snapshot from the bucket.
    }
  };
  if (typeof store.defer === "function") {
    try {
      store.defer(run());
      return;
    } catch {
      // Fall through for self-hosted shims without a working waitUntil.
    }
  }
  await run();
}


/**
 * The name a caret is labelled with.
 *
 * `personalNameFor` and nothing else, because a caret is a person and that
 * function is where "which of these contexts *is* this person" is decided. A
 * second copy of the predicate lived here and had two of its three clauses,
 * which is the whole of the bug it caused: see that function.
 *
 * The client name is the fallback rather than the first choice: "@sayo's Claude"
 * describes a connection, and a caret belongs to a person. It is asserted by
 * whoever registered the client at an unauthenticated endpoint, so it is the
 * last resort and is never allowed to displace a handle that was verified — nor
 * to be assembled into one, which is why the fallback is reached whole rather
 * than an absent slug being interpolated into `@${slug}`.
 */
export function presenceDisplayName(session) {
  return personalNameFor(session) || session.actorClientName || "Someone";
}

/**
 * Keep a ready Fast Search database current when this gateway writes a note.
 *
 * The initial backfill and periodic reconciliation remain the repair path for
 * writes made through Obsidian, rclone, or a provider console. A gateway write
 * is different: we already have the new plaintext, version, and effective
 * visibility, so waiting for another bucket listing makes the very next search
 * stale for no reason. The projection is a derivative, so a D1 refusal never
 * rolls back the canonical bucket write.
 *
 * Deferred where the runtime supports `waitUntil`; awaited on self-hosted
 * shims so "no deferral" never means "no indexing". Three idempotent attempts
 * cover a transient provider refusal without inventing a second write format:
 * every attempt starts by deleting this path's prior rows.
 */
/**
 * Tell the note's presence room that a tool just changed it.
 *
 * ## Why the room, and not every client
 *
 * The room holds live sockets for the people with this note open. They are
 * already editing one shared document, and the whole point of that document is
 * that two edits to it merge instead of colliding. A write arriving from an
 * MCP client is a third editor — so it joins the same document rather than
 * landing underneath it as a surprise at save time.
 *
 * **Exactly one client merges it, and the room picks which.** Every client
 * applying the same text to its own copy would produce the same characters
 * inserted N times, because each copy would generate its own operations for
 * them — a merge that duplicates the note is worse than no merge. The room
 * knows which of its sockets holds write authority and can therefore have its
 * merge accepted, so the room chooses, exactly as it chooses who seeds.
 *
 * ## What this is not
 *
 * Not a guarantee. A room nobody is in drops the notice; a room of read-only
 * members has nobody who may merge and drops it too, and those clients see the
 * write at their next reconnect. The canonical copy is in the bucket either
 * way — this is a live view catching up faster, never the only path by which a
 * change is recorded, and it cannot fail the write that triggered it.
 */
/**
 * Who a tool's write shows up as, to the people watching the note change.
 *
 * A name and an opaque id, and no more than that. The name is the one the
 * route already trusts for a caret — the caller's own handle where there is
 * one, the client's registered name otherwise — and it is display text that
 * decides nothing.
 *
 * **The id is a digest of the client id, never the client id.** A caret needs
 * something stable so the same agent writing twice is one agent rather than
 * two, and the control plane's own identifier is nobody else's business even
 * among people who share a workspace. Sixteen hex characters is far more than
 * enough to keep two agents in one note apart and far too few to be worth
 * anything to somebody who collects it.
 */
/**
 * The opaque, stable id a client is known by inside a presence room.
 *
 * A digest of the control plane's client id, never the client id itself: a
 * caret needs something stable so the same agent writing twice is one agent
 * rather than two, and the control plane's own identifier is nobody else's
 * business even among people who share a workspace. Sixteen hex characters is
 * far more than enough to keep two agents in one note apart and far too few to
 * be worth anything to somebody who collects it.
 *
 * The same value is computed for a socket (so the room can tell that a write
 * came from somebody already sitting in it) and for a write (so the room can
 * announce the tool that made it). They have to be the same function or the
 * comparison is always false and every console save announces a robot.
 */
export async function presenceClientKey(clientId) {
  if (typeof clientId !== "string" || !clientId) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // No caret rather than a guessed identity. The write still lands and the
    // text still reaches the room.
    return null;
  }
}

export async function presenceActor(actor) {
  /*
    The client's own name first, which is the reverse of a caret's rule and is
    the point: a person watching their note change wants to know *an agent* did
    it, and "@seyi" on a caret they are also holding reads as themselves in two
    places. `actorFor` already carries both — the handle for the audit line,
    the client name for the sentence a person reads.
  */
  const name = actor?.client || (actor?.name ? `${actor.name}'s agent` : "An agent");
  return { id: await presenceClientKey(actor?.clientId), name };
}

/**
 * The console's own client id, as the control plane issues it
 * (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`).
 *
 * The console reads and writes through the same tools any agent does, so
 * without this every note a person opened in the app would show up in their
 * file tree as an agent reading it.
 */
const CONSOLE_CLIENT_ID = "context_console";

export function isConsoleActor(actor) {
  return actor?.clientId === CONSOLE_CLIENT_ID;
}

export async function announceWriteToPresence(store, { path, content, etag, actor }) {
  const rooms = store.presenceRooms;
  if (!rooms) return "off";
  const workspaceId = store.actor?.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) return "off";

  const run = async () => {
    try {
      const room = rooms.get(rooms.idFromName(roomKey(workspaceId, path)));
      await room.fetch("https://presence.invalid/external", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: content, etag: etag ?? null, actor: actor ?? null }),
      });
    } catch {
      // A room that cannot be reached is a live view that refreshes a little
      // later. The note is already in the customer's bucket.
    }
  };

  if (typeof store.defer === "function") {
    try {
      store.defer(run());
      return "deferred";
    } catch {
      // A host that refuses deferral runs it inline, below.
    }
  }
  await run();
  return "inline";
}
