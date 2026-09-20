/**
 * The Yjs sync protocol, over this room's socket.
 *
 * Replaces a hand-rolled relay that was wrong in a way worth recording: every
 * client announced its whole document on connect and the room replaced its
 * history with it, so the second person to open a note destroyed what the
 * first had written. The mistake underneath that patch was writing an
 * initialization protocol at all — Yjs ships one, it is the thing every other
 * Yjs deployment uses, and it does not have this failure mode because no
 * client ever replaces anything.
 *
 * ## How initialization actually works here
 *
 * On connect a client sends **SyncStep1**, which is its state *vector* — a
 * summary of what it already has, not its content. Anybody holding more
 * answers **SyncStep2** with exactly the difference. Two clients that each
 * hold half of a document exchange halves and converge; a client that holds
 * nothing receives everything; a client that holds everything receives an
 * empty diff and nothing is overwritten in either direction. An empty document
 * cannot destroy a full one, because it has nothing to send that would.
 *
 * Reconnect is the same exchange with no special case, which is the other
 * reason to use the real protocol: the bug it replaces was in reconnect
 * handling I had written myself.
 *
 * ## Why cursors do not use the awareness protocol
 *
 * `y-protocols/awareness` is the established way to carry carets, and this
 * deliberately does not use it for identity. Awareness state is written by the
 * client that owns it, so a name in awareness is a name a client asserted —
 * and this room already has something better: the gateway resolves who you are
 * from your grant and stamps it on the frame. Moving names into awareness
 * would trade a server-vouched identity for a self-declared one, and a peer
 * able to put somebody else's name on its caret is a spoof wearing a
 * colleague's face.
 *
 * So the room keeps stamping identity, and awareness's genuinely better idea —
 * *relative* positions, which survive edits above them — is taken on its own
 * (`cursorPosition` below). That is the half that was actually broken: a caret
 * at offset 40 means nothing once somebody inserts a paragraph at offset 10.
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { fromBase64, toBase64 } from "./sharedDoc";

/** What a decoded sync message turned out to be, for the caller to act on. */
export type SyncOutcome =
  | { kind: "reply"; payload: string }
  | { kind: "applied" }
  | { kind: "ignored" };

/**
 * "Here is what I already have." The first thing a client sends, on every
 * connect and every reconnect.
 */
export function encodeSyncStep1(doc: Y.Doc): string {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, doc);
  return toBase64(encoding.toUint8Array(encoder));
}

/** One local edit, as the protocol's update message. */
export function encodeUpdate(update: Uint8Array): string {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  return toBase64(encoding.toUint8Array(encoder));
}

/**
 * Handle one sync message from the room.
 *
 * Returns a reply when the protocol asks for one — a SyncStep1 is answered
 * with the difference, which is how a late joiner is filled in by whoever is
 * already there. Everything is wrapped: a malformed message from a peer costs
 * that message and not the document, and the editor is mid-transaction when
 * this runs.
 */
export function readSyncMessage(payload: string, doc: Y.Doc, origin: unknown): SyncOutcome {
  let decoder: decoding.Decoder;
  try {
    decoder = decoding.createDecoder(fromBase64(payload));
  } catch {
    return { kind: "ignored" };
  }

  const encoder = encoding.createEncoder();
  try {
    const messageType = syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
    // A SyncStep1 is the only one that produces an answer. The protocol writes
    // that answer into `encoder`; anything else leaves it empty.
    if (messageType === syncProtocol.messageYjsSyncStep1 && encoding.length(encoder) > 1) {
      return { kind: "reply", payload: toBase64(encoding.toUint8Array(encoder)) };
    }
    return { kind: "applied" };
  } catch {
    return { kind: "ignored" };
  }
}

/**
 * A caret, as a position that survives other people's edits.
 *
 * An offset is a number into a document that is changing underneath it: a peer
 * inserting a paragraph above your caret moves it without telling anybody, so
 * every caret in the room drifts by exactly as much as was typed above it. A
 * relative position names the *character it sits beside* instead, so it stays
 * where the person put it no matter what happens elsewhere.
 *
 * `null` when the position cannot be expressed — an empty document has no
 * character to be relative to — and the caller draws nothing rather than
 * drawing at zero.
 */
export function cursorPosition(text: Y.Text, index: number): string | null {
  try {
    const relative = Y.createRelativePositionFromTypeIndex(text, index);
    return toBase64(Y.encodeRelativePosition(relative));
  } catch {
    return null;
  }
}

/** Turn a peer's relative position back into an offset in this document. */
export function cursorOffset(encoded: string, doc: Y.Doc): number | null {
  try {
    const relative = Y.decodeRelativePosition(fromBase64(encoded));
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    return absolute ? absolute.index : null;
  } catch {
    return null;
  }
}
