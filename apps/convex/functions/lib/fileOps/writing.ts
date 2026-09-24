/**
 * Writing a note, and taking a note out of encryption.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { canReplaceEncryptedNote, isEncryptedNote } from "../noteEncryption";
import { PRIVACY_KEY, canSee, foldPath, isPlumbing, visibilityOf } from "../privacy";
import { type Clearance } from "../clearance";
import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
  sealDocument as sealCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import { MAX_NOTE_BYTES, type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";

/* -------------------------------------------------------------------------- */
/*                                   writing                                  */
/* -------------------------------------------------------------------------- */

export interface WriteResult {
  path: string;
  etag: string;
  /**
   * What was written, in bytes, for `activity.md`.
   *
   * `byteLength`, not `String.length`: the activity file's substance test is a
   * byte threshold, and it must not be laxer for a note written in English
   * than for one written in Yoruba.
   *
   * There is deliberately no `previousBytes` beside it. The store's `get`
   * returns a handle without a size, so knowing what was there before would
   * mean reading the old body on every save — a second full read per
   * keystroke-triggered autosave, to answer a question the activity file
   * already answers another way: an unknown size counts as substantial, and
   * the merge window collapses a typing session into one line whatever the
   * sizes were. The gateway, which has the old body in hand for its own
   * conflict message, does send both.
   */
  bytes: number;
  /**
   * How the conflict check was performed.
   *
   * `conditional` — the backend enforced `If-Match`, so a concurrent write
   * could not have landed between the check and ours.
   * `read-compare` — the backend does not enforce it (B2, Wasabi), so we read
   * the etag and compared it ourselves. That is a real check with a real race
   * window, and the console says so rather than implying a guarantee we do not
   * have. Never silently downgraded to no check at all.
   */
  conflictCheck: "conditional" | "read-compare";
}


/**
 * Save a note.
 *
 * `expectedEtag` is the etag the editor read. A mismatch is a **conflict**,
 * surfaced with the current etag so the console can say "this changed
 * elsewhere" and offer to reload — never a silent overwrite.
 *
 * Omitting `expectedEtag` means "this is new": if the key already exists that
 * is also a conflict, not an overwrite — and where the bucket can enforce it
 * (`conditionalCreate`), the put itself is `onlyIf: { absent: true }`, so that
 * holds even for a file created between the check and the write. That is the
 * create mode an offline-queued new note uses. There is no way to say "clobber
 * whatever is there", by design.
 */
export async function writeFile(
  store: FileStore,
  options: {
    path: string;
    text: string;
    expectedEtag?: string;
    clearance: Clearance;
    now: number;
  },
): Promise<WriteResult> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (byteLength(options.text) > MAX_NOTE_BYTES) {
    throw new FileOpError(
      "CONTENT_TOO_LARGE",
      `A note must be at most ${MAX_NOTE_BYTES} bytes.`,
    );
  }

  const state = await loadPrivacyState(store);
  // Creating a note somewhere a team caller cannot see means creating a note
  // they immediately could not read. Refuse with the same not-found as a note
  // that is not theirs, so the folder's default is not an oracle either.
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const existing = await store.get(path);

  /*
   * AND A CREATE ASKS A SECOND QUESTION: DOES THE FOLDER ADMIT A NOTE FROM
   * THIS TIER?
   *
   * `canSee` above is the read direction, and its comment is right about it.
   * It is not sufficient for a CREATE, because it honours an exact override —
   * and **an override can outlive the note it was written for.** `trashPath`
   * deliberately leaves one behind: `restoreTrashedPath` re-checks `canSee` at
   * the original path, so the exception has to survive for a restored note to
   * come back at the visibility it had. (`deletePath` is permanent and clears
   * it; the two differ on purpose.)
   *
   * In the window between, the manifest names a path with no object at it. A
   * team caller writing there passed `canSee` on the dead note's exception and
   * created a note **inside a folder the owner keeps private** — the thing
   * `scope_info` advertises as outside their write surface.
   *
   * The gateway's `write_note` has always asked this, and its answer is the
   * one ported here: not "can this caller see this path" but "what does the
   * FOLDER say", which `visibilityOf` answers without consulting overrides.
   * `notFound()` rather than a permission error, to match the refusal above:
   * a distinct message here would make the folder's default an oracle.
   */
  if (existing === null && options.clearance.scope !== "private") {
    const inherited = visibilityOf(path, state.rules);
    if (inherited !== "team" && !options.clearance.names.has(inherited)) throw notFound();
  }

  /*
   * AN ENCRYPTED NOTE IS NOT OVERWRITTEN WITH PLAINTEXT THROUGH THIS DOOR —
   * AND A DIFFERENT RECIPIENT SET DOES NOT GET THROUGH IT EITHER.
   *
   * The gateway's rule is that whether a write is encrypted is decided by the
   * stored object, and it enforces that by re-encrypting: the gateway holds a
   * workspace key and can open a `workspace`-recipient note itself, so it can
   * tell a legitimate re-encryption from a downgrade. This path cannot — the
   * control plane holds no key, by design, for either recipient kind — so for
   * a long time the only correct answer here was to refuse outright.
   *
   * A passphrase-locked note changed that, in one direction only. Its owner
   * derives the key **here**, on this device, and the console is the only
   * place a passphrase note can ever be edited, its passphrase changed, or its
   * lock removed — so a door that only ever emitted "no" made every one of
   * those unreachable as shipped. What is admitted is exactly what those flows
   * produce and nothing else: a submitted document that is *itself* a
   * well-formed envelope naming precisely the recipients already at this path.
   * `canReplaceEncryptedNote` is the whole of that check, and it is what keeps
   * this from being the second, weaker door onto the same bucket that the
   * gateway's stronger rule forbids — plaintext is refused exactly as before,
   * and so is any envelope that adds, drops or swaps a recipient, which is the
   * shape a downgrade or a mismatched context would take. What this door does
   * not and cannot check — because it holds no key — is whether the ciphertext
   * itself decrypts to anything: that is bounded by the same write authority
   * this caller already has over every other note at this path, not by
   * encryption, which `docs/decisions/encryption.md` is explicit is
   * confidentiality and not access control.
   *
   * Removing a passphrase lock is deliberately **not** reachable here at any
   * recipient set: this door never accepts plaintext over an encrypted note.
   * `removeNoteEncryption` is the separate, narrower door for that, reachable
   * only from an explicit action — never from an ordinary Save.
   *
   * Checked on the marker rather than on a parse, so a malformed *existing*
   * envelope is refused too — that is the case where overwriting is least
   * recoverable, and `canReplaceEncryptedNote` answers `false` for it because
   * a stored envelope it cannot parse can never equal anything.
   *
   * Before the conflict checks on purpose: this is a property of the note, not
   * of the etag, and answering `CONFLICT` first would tell somebody to reload
   * and try again at a write that can never succeed.
   */
  const existingText = existing !== null ? await existing.text() : null;
  if (existing !== null) {
    if (isEncryptedNote(existingText!) && !canReplaceEncryptedNote(existingText!, options.text)) {
      throw new FileOpError(
        "NOTE_ENCRYPTED",
        "That note is encrypted. Its content is stored as ciphertext and can only be edited through a client that can decrypt it.",
        existing.etag,
      );
    }
  }

  let collaborationResult: {
    documentId: string;
    update: string;
    text: string;
    etag: string;
  } | null = null;
  let sealedResult: { etag: string; bytes: number } | null = null;
  if (
    existing !== null &&
    !isEncryptedNote(existingText!) &&
    collaborationSupported(store)
  ) {
    if (collaborationEligible(path, existingText!) && options.expectedEtag !== undefined) {
      try {
        const base = await readCollaborationDocument(store, path);
        if (isEncryptedNote(options.text)) {
          const sealed = await sealCollaborationDocument(store, path, {
            documentId: base.documentId,
            expectedEtag: options.expectedEtag,
            text: options.text,
          });
          sealedResult = { etag: sealed.etag, bytes: byteLength(options.text) };
        } else {
          collaborationResult = await replaceCollaborationText(store, path, {
            documentId: base.documentId,
            expectedEtag: options.expectedEtag,
            text: options.text,
          });
        }
      } catch (error) {
        // An old/raw or forged base is still the ordinary stale-save conflict
        // at this API boundary. Do not turn it into STORAGE_FAILED merely
        // because the collaboration engine has a more precise internal code.
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["BASE_MISSING", "CONFLICT", "GENERATION_MISMATCH", "SEAL_CONFLICT", "CONCURRENT_WRITE"].includes(code)) {
          throw new FileOpError(
            "CONFLICT",
            "That file changed somewhere else while you were editing it.",
            existing.etag,
          );
        }
        if (code === "UNSUPPORTED_STORAGE" || code === "STORAGE_WRITE_FAILED" || code === "CORRUPT_STATE") {
          throw new FileOpError(
            "STORAGE_UNSAFE",
            "This note cannot be saved safely for collaborative editing.",
            existing.etag,
          );
        }
        throw error;
      }
    }
  }

  if (options.expectedEtag === undefined) {
    if (existing !== null) {
      throw new FileOpError(
        "CONFLICT",
        "A file already exists at that path. Reload to see it.",
        existing.etag,
      );
    }
  } else if (existing === null) {
    throw new FileOpError(
      "CONFLICT",
      "That file was deleted somewhere else while you were editing it.",
    );
  } else if (!collaborationResult && !sealedResult && existing.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      existing.etag,
    );
  }

  // The version being replaced is not copied anywhere. Object versioning at the
  // provider is what keeps it, and it is the customer's to enable on a bucket
  // they own — see docs/decisions/storage-and-credentials.md. With it off, this
  // overwrite is final, and the console says so before it runs.
  const conditional = store.capabilities?.conditionalWrite === true && existing !== null;
  /*
   * A CREATE IS CONDITIONAL TOO, WHERE THE BUCKET HAS PROVEN IT CAN BE.
   *
   * The read above found nothing, and until this was added the put that
   * followed was unconditional — so a note created at the same path in the
   * round trip between them (an Obsidian sync, an AI client, a second device
   * draining its own offline queue) was overwritten with no error. Offline
   * made that window hours wide: a "new note" typed on a train is sent when
   * the train comes out of the tunnel, and whatever landed at that path in
   * between is exactly what it would have clobbered.
   *
   * `onlyIf: { absent: true }` is `If-None-Match: *`, which is a different
   * feature from `If-Match` and is probed separately, as `conditionalCreate`.
   * A bucket that honours one need not honour the other, so this asks for the
   * capability it is about to rely on and not its neighbour. Where it is not
   * proven the read above is the check, its one-round-trip race is what the
   * `read-compare` in the result reports, and nothing is sent that the bucket
   * might accept and ignore — `importVaultFiles` gives the same reasoning.
   */
  const conditionalCreate =
    existing === null && store.capabilities?.conditionalCreate === true;
  const put = sealedResult
    ? { etag: sealedResult.etag }
    : collaborationResult
    ? { etag: collaborationResult.etag }
    : conditional
      ? await store.put(path, options.text, { onlyIf: { etagMatches: existing!.etag } })
      : conditionalCreate
        ? await store.put(path, options.text, { onlyIf: { absent: true } })
        : await store.put(path, options.text);

  if (put === null) {
    // The backend rejected the precondition: somebody wrote between our read
    // and our put. Exactly the case conditional writes exist for — and for a
    // create it is the same `CONFLICT` a create onto an existing file gets
    // above, with the etag of what is there now.
    const current = await store.get(path);
    throw new FileOpError(
      "CONFLICT",
      existing === null
        ? "A file already exists at that path. Reload to see it."
        : "That file changed somewhere else while you were editing it.",
      current?.etag,
    );
  }

  return {
    path,
    etag: put.etag,
    bytes: sealedResult?.bytes ?? byteLength(collaborationResult?.text ?? options.text),
    conflictCheck: conditional || conditionalCreate ? "conditional" : "read-compare",
  };
}

/**
 * Replace an encrypted note's content with plaintext.
 *
 * `writeFile`'s widening lets an envelope replace an envelope naming the same
 * recipients — an edit, a passphrase change — and refuses plaintext over an
 * encrypted note in every case, on purpose: a person who merely re-saves what
 * they had loaded must never silently turn a passphrase lock off. Removing one
 * is therefore a separate, narrower door rather than a wider version of that
 * one, reachable only from an explicit "Remove encryption" action in the
 * console — never from the ordinary Save button, and never as a side effect of
 * `writeFile` accepting a plaintext body.
 *
 * **What this can and cannot verify.** The control plane holds no passphrase
 * and no key — it cannot check that `options.text` really is what the stored
 * envelope decrypts to, any more than `writeFile`'s widening can check that an
 * accepted envelope actually re-encrypts the same content. What stands in for
 * that is the same authority every other write at this path already carries:
 * `canSee` and a matching etag. `docs/decisions/encryption.md` is explicit that
 * this is the right boundary — "Encryption is confidentiality, and it is not
 * access control" — so a caller who could already overwrite this note's bytes
 * with garbage before it was locked can still overwrite them after, and the
 * one thing this function refuses that `writeFile` would not have to is a
 * replacement that is *itself* still an encrypted note: accepting one here
 * would reopen exactly the recipient-set hole `writeFile`'s own guard exists to
 * close, wearing this door's name instead.
 */
export async function removeNoteEncryption(
  store: FileStore,
  options: {
    path: string;
    text: string;
    expectedEtag?: string;
    clearance: Clearance;
  },
): Promise<WriteResult> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  if (byteLength(options.text) > MAX_NOTE_BYTES) {
    throw new FileOpError(
      "CONTENT_TOO_LARGE",
      `A note must be at most ${MAX_NOTE_BYTES} bytes.`,
    );
  }
  // Refused before anything else is even read: a replacement that is itself an
  // encrypted note is not a removal, whatever recipients it names, and letting
  // it through here would be the second, weaker door `writeFile`'s widening was
  // built not to open.
  if (isEncryptedNote(options.text)) {
    throw new FileOpError(
      "NOTE_ENCRYPTED",
      "That replacement is itself an encrypted note. Removing encryption writes plain Markdown — use an ordinary save to replace one encrypted note with another.",
    );
  }

  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const existing = await store.get(path);
  if (existing === null) throw notFound();
  const existingText = await existing.text();
  if (!isEncryptedNote(existingText)) {
    throw new FileOpError(
      "NOTE_NOT_ENCRYPTED",
      "That note is not encrypted; save it the ordinary way.",
      existing.etag,
    );
  }

  // Unlike `writeFile`, there is no "this is new" reading of a missing etag:
  // removal only ever acts on a note that is already there, so an absent
  // `expectedEtag` can only mean the caller never read the version it is about
  // to replace.
  if (options.expectedEtag === undefined) {
    throw new FileOpError(
      "CONFLICT",
      "Removing encryption has to be checked against the version you read. Re-read the note and try again.",
    );
  }
  if (existing.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      existing.etag,
    );
  }

  const conditional = store.capabilities?.conditionalWrite === true;
  const put = conditional
    ? await store.put(path, options.text, { onlyIf: { etagMatches: existing.etag } })
    : await store.put(path, options.text);

  if (put === null) {
    const current = await store.get(path);
    throw new FileOpError(
      "CONFLICT",
      "That file changed somewhere else while you were editing it.",
      current?.etag,
    );
  }

  return {
    path,
    etag: put.etag,
    bytes: byteLength(options.text),
    conflictCheck: conditional ? "conditional" : "read-compare",
  };
}

/** Refuse the paths that are not notes, before anything else happens. */
export function assertWritablePath(path: string): void {
  // Folded, so the manifest refusal is a decision rather than a side effect of
  // `isPlumbing` two lines below answering PATH_INVALID for the wrong reason.
  if (foldPath(path) === PRIVACY_KEY) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_READ_ONLY",
      "privacy.md is generated from your visibility settings. Change a file or folder's visibility instead of editing it.",
    );
  }
  if (isPlumbing(path)) {
    throw new FileOpError(
      "PATH_INVALID",
      "Paths beginning with a dot are reserved for history and audit.",
    );
  }
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
