/**
 * The errors a file operation raises, and the codes the console branches on.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

/* -------------------------------------------------------------------------- */
/*                                   errors                                   */
/* -------------------------------------------------------------------------- */

export type FileErrorCode =
  /** Missing, or invisible at the caller's scope. Deliberately the same code. */
  | "FILE_NOT_FOUND"
  | "PATH_INVALID"
  | "DESTINATION_EXISTS"
  | "CONFLICT"
  | "PRIVACY_MANIFEST_READ_ONLY"
  | "PRIVACY_MANIFEST_MISSING"
  | "PRIVACY_MANIFEST_INVALID"
  /** A reset was asked for on a manifest that parses. Refused, not a no-op. */
  | "PRIVACY_MANIFEST_USABLE"
  | "PRIVACY_MANIFEST_BUSY"
  | "CONTENT_TOO_LARGE"
  /** `readFiles` was asked for more paths than one call may name. */
  | "BATCH_TOO_LARGE"
  | "FOLDER_TOO_LARGE"
  | "STORAGE_UNSAFE"
  | "PLUGIN_TOO_LARGE"
  /**
   * The Context plugin this operation belongs to is switched off here.
   *
   * Its own code rather than `CONFIRMATION_REQUIRED` or `CONFLICT`, because it
   * means something neither of those does to whoever is holding the editor:
   * retrying will not help and there is nothing to reload — an owner turns the
   * plugin back on, or this does not happen. See `plugins.md`.
   */
  | "PLUGIN_OFF"
  /** The store would not hand over the whole listing. Not the folder's fault. */
  | "LISTING_INCOMPLETE"
  | "ARCHIVE_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  /**
   * The note at that path is stored encrypted, so this path may not write it.
   *
   * Its own code rather than `CONFLICT`, because the two mean opposite things
   * to whoever is holding the editor: a conflict says reload and try again, and
   * this says a write through this door cannot succeed at all.
   *
   * Also the code `removeNoteEncryption` refuses its own misuse with — a
   * replacement that is itself still an encrypted note — since that is the same
   * claim in the other direction: this door writes plaintext, and only
   * plaintext, over an encrypted note.
   */
  | "NOTE_ENCRYPTED"
  /** `removeNoteEncryption` asked to act on a note that was never encrypted. */
  | "NOTE_NOT_ENCRYPTED"
  | "NOT_A_FOLDER"
  /**
   * The five a markdown form refuses with. See `lib/formOps.ts`.
   *
   * Separate codes rather than one, because the console does something
   * different with each: `FORM_NOT_FOUND` and `FORM_INVALID` are the author's
   * to fix and name a block, `FORM_FORBIDDEN` is the reader's answer and must
   * read as a refusal rather than a fault, `FORM_NOT_COLLECTING` is a form an
   * editor has to save once more, and `FORM_STORAGE_UNSUITABLE` is a property
   * of the customer's store that no retry will change.
   */
  | "FORM_NOT_FOUND"
  | "FORM_INVALID"
  | "FORM_FORBIDDEN"
  | "FORM_NOT_COLLECTING"
  | "FORM_STORAGE_UNSUITABLE";

/**
 * A failure with a code the console can branch on and a message a person can
 * act on.
 *
 * `message` may name a **path**; it may never carry note content, a
 * credential, or a provider's raw response. Rule 1 at the top of this file.
 */
export class FileOpError extends Error {
  constructor(
    readonly code: FileErrorCode,
    message: string,
    /** Only ever an etag or a path — never content. */
    readonly currentEtag?: string,
  ) {
    super(message);
    this.name = "FileOpError";
  }
}

/**
 * The one error used for "you cannot have this".
 *
 * Built in a single place so no future operation can leak the difference
 * between "not yours to see" and "never existed" by phrasing its own message
 * slightly differently — the same discipline `lib/workspaceAuth.ts` applies to
 * `WORKSPACE_NOT_FOUND`, for the same reason.
 */
export function notFound(): FileOpError {
  return new FileOpError("FILE_NOT_FOUND", "That file does not exist.");
}
