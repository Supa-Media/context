/**
 * The shared document — the part that makes two people typing in one note work.
 *
 * Presence drew other people's carets. This is the half underneath it: every
 * keystroke becomes a small update, goes out over the same socket, and is
 * applied by everybody else's editor as it arrives. Nobody's save overwrites
 * anybody's, because there is no longer a moment where two editors hold
 * different text and race to write it.
 *
 * ## The room does not understand any of this
 *
 * Updates are opaque bytes to the gateway: it relays them and keeps them in
 * order so somebody joining late can be replayed into the same state. That is
 * the whole reason `apps/mcp` still has no dependencies — the merge lives
 * here, on the clients, where the document already is.
 *
 * ## Seeding is the subtle part, and it is decided by the server
 *
 * A note starts as text in a bucket. Somebody has to put that text into the
 * shared document, and if two people do it the document contains it twice —
 * the classic duplicated-first-paragraph bug in every CRDT editor that gets
 * this wrong.
 *
 * So seeding is not a race anybody can lose: the room admits members one at a
 * time, the welcome frame says who was already there, and **only a client that
 * arrives to an empty room with an empty log seeds**. Everybody else waits for
 * the replay, however fast they were. If the first person's connection dies
 * before they seed, the room is empty again and the next arrival seeds — which
 * is the same rule, not a special case.
 */

import * as Y from "yjs";

/** What the editor needs to bind to, and what the socket needs to send. */
export interface SharedDoc {
  doc: Y.Doc;
  text: Y.Text;
  /** Apply bytes that arrived from the room. */
  applyRemote: (base64: string) => void;
  /** The whole document as one update, for compaction and for a late joiner. */
  snapshot: () => string;
  /** The current text, for the client elected to write it to the bucket. */
  markdown: () => string;
  destroy: () => void;
}

/**
 * base64 for the wire, because this socket carries JSON frames.
 *
 * Binary frames would be smaller and are the obvious improvement, but every
 * other frame on this socket is JSON and one channel with two encodings is a
 * place for a subtle bug rather than a saving worth having yet.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Create the document for one note.
 *
 * `onLocalUpdate` fires for every change this editor makes and for nothing
 * else — the origin check is what stops an update that arrived from the room
 * being echoed straight back to it, which is an infinite loop between two
 * browsers rather than a slow one.
 */
export function createSharedDoc(options: {
  /** Raw bytes, so the caller frames them with the sync protocol. */
  onLocalUpdateBytes?: (update: Uint8Array) => void;
  /** Base64, kept for the tests that drive two documents directly. */
  onLocalUpdate?: (base64: string) => void;
}): SharedDoc {
  const doc = new Y.Doc();
  const text = doc.getText("note");

  const REMOTE = Symbol("remote");

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    // Anything that did not originate in this editor is somebody else's edit
    // arriving; echoing it back is a loop between two browsers.
    if (origin === REMOTE || (typeof origin === "symbol" && origin.description?.includes("remote"))) {
      return;
    }
    options.onLocalUpdateBytes?.(update);
    options.onLocalUpdate?.(toBase64(update));
  });

  return {
    doc,
    text,
    applyRemote(base64: string) {
      try {
        Y.applyUpdate(doc, fromBase64(base64), REMOTE);
      } catch {
        // A malformed update from a peer is refused here rather than taking
        // the editor with it. The document keeps the state it had; the next
        // update from that peer, or a rejoin, brings it back into line.
      }
    },
    snapshot() {
      return toBase64(Y.encodeStateAsUpdate(doc));
    },
    markdown() {
      return text.toString();
    },
    destroy() {
      doc.destroy();
    },
  };
}

/**
 * Put the bucket's text into an empty shared document.
 *
 * Only ever called by the one client the room seeded (see the header), and it
 * checks again anyway: seeding a document that already has text is the
 * duplication bug, and the cost of the second check is one comparison.
 */
export function seedSharedDoc(shared: SharedDoc, markdown: string): boolean {
  if (shared.text.length > 0) return false;
  shared.doc.transact(() => {
    shared.text.insert(0, markdown);
  });
  return true;
}

/**
 * Bring an out-of-band change into a live document.
 *
 * Obsidian and `rclone` are out of scope, but an MCP agent writing the note
 * somebody has open is not: the whole point is watching that land. The agent
 * writes a whole file, so what arrives is new text rather than a keystroke,
 * and this is what turns one into the other.
 *
 * A naive version replaces everything, which would delete and re-insert the
 * entire note — every caret in the room jumps to the end and the history is
 * one enormous entry. So the common prefix and suffix are left alone and only
 * the span that actually differs is replaced. For an agent appending a
 * paragraph that is an insert at the end, which is what it looks like on
 * screen: the paragraph appears, and nobody's cursor moves.
 */
export function mergeExternalText(
  shared: SharedDoc,
  incoming: string,
): { from: number; to: number } | null {
  const current = shared.text.toString();
  // Nothing changed, so there is nowhere for a caret to be.
  if (current === incoming) return null;

  let prefix = 0;
  const max = Math.min(current.length, incoming.length);
  while (prefix < max && current[prefix] === incoming[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    current[current.length - 1 - suffix] === incoming[incoming.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removeFrom = prefix;
  const removeLength = current.length - prefix - suffix;
  const insert = incoming.slice(prefix, incoming.length - suffix);

  shared.doc.transact(() => {
    if (removeLength > 0) shared.text.delete(removeFrom, removeLength);
    if (insert.length > 0) shared.text.insert(removeFrom, insert);
  });
  /*
    Where the change landed, so a caret can be drawn there.

    The end of what was written is where a person typing would have left their
    cursor, and it is the only position in the note that means anything about
    the write. Returned rather than recomputed by the caller, because the
    caller would have to diff the same two strings again to find it.
  */
  return { from: removeFrom, to: removeFrom + insert.length };
}

/**
 * Which member writes the merged text to the bucket.
 *
 * Exactly one, or every editor in the room races to save the same document and
 * they all conflict with each other — the bug this whole feature exists to
 * remove, reintroduced from the other end. The lowest id wins because every
 * client can compute that from the roster it already has, with no extra frame
 * and no election to go wrong; and because ids are server-minted, nobody can
 * make themselves the writer.
 *
 * When that person leaves, the next-lowest takes over on the very next roster
 * the room sends, so there is no gap where nobody is saving.
 */
/**
 * The one member of a room that saves, chosen from the roster.
 *
 * Two halves, and leaving either out has been a bug:
 *
 *  - **Only members the room would accept an edit from are candidates.** The
 *    election used to run over everybody, so a room whose lowest member id
 *    belonged to a read-only viewer elected that viewer — and then nobody
 *    saved at all, because the one client that believed it was saving was the
 *    one whose frames the room drops.
 *  - **You are only a candidate if the room would accept an edit from you.**
 *    `isWriter` adds you to the list it sorts, so a read-only member alone in
 *    a room would otherwise elect itself against an empty field.
 *
 * ## `members` does not contain you, and that was the whole bug
 *
 * This used to look for the caller inside `members` to answer the second half.
 * It is not there: the reducer removes you from the roster on purpose, because
 * the roster is what the header counts as "2 here". So the guard could never
 * be satisfied — **no client in any room was ever elected**, nothing was ever
 * written to the bucket, and a note reopened was a note reverted.
 *
 * The unit tests passed a list that did contain the caller, and the browser
 * harness built its roster from the welcome frame unfiltered so it did too.
 * Both halves were green against a shape the product never produces.
 *
 * So your own authority is passed in rather than looked up. It comes off your
 * own entry in the welcome roster before the filter drops it — see
 * `savesToBucket`, which is where this is called from and where the "no live
 * room" case is decided.
 *
 * Pure, and exported, because this is the kind of decision that reads as
 * obviously right inside a `useMemo` and is obviously wrong the moment it is
 * written down beside a read-only member.
 */
export function electWriter(
  you: string | null,
  youCanWrite: boolean,
  members: { id: string; canWrite: boolean }[],
): boolean {
  // The `you === null` half is unmeasurable and deliberate: `isWriter` opens
  // with the same check, and `savesToBucket` never reaches here with a null
  // `you`. It stays because this function is exported and pure, so a caller
  // that is not `savesToBucket` is the case it is written for.
  if (you === null || !youCanWrite) return false;
  return isWriter(
    you,
    members.filter((one) => one.canWrite).map((one) => one.id),
  );
}

export function isWriter(you: string | null, memberIds: string[]): boolean {
  if (you === null) return false;
  const all = [...memberIds, you].sort();
  return all[0] === you;
}

/**
 * May this editor put text into the local draft, or save it?
 *
 * The same question for typing and for ⌘S, so it is one function rather than
 * two conditions that can drift — and they had drifted: `onChange` was gated
 * and the save key was not, so any client in a room could push its own draft
 * to the bucket with one keystroke, which is the racing-writers collision the
 * election exists to prevent.
 *
 * True when there is no room at all, which is what keeps a note nobody else is
 * in behaving exactly as it always did.
 *
 * ## `bound`, and why it is not `shared`
 *
 * This used to ask whether a `SharedDoc` **existed**. It always does: the hook
 * creates one the moment it runs, before a socket connects and whether or not
 * one ever does. What decides whether anybody else is coordinating this client
 * is whether the editor is *wired to* that document — `yCollab` installed, so
 * a keystroke here becomes an update everybody else applies.
 *
 * The gap between the two is where a note goes missing. An empty note seeds to
 * an empty document, the editor waits for text that is never coming, and the
 * binding never goes up — so with the old question a client that was not
 * elected to save sat behind a `false` forever: its typing reached neither the
 * room nor the bucket. Asking about the binding makes the unbound case what it
 * has to be, which is the case where this feature is not running.
 */
export function mayPersist(presence: { bound: unknown; canWrite: boolean } | undefined): boolean {
  if (!presence || !presence.bound) return true;
  return presence.canWrite;
}
