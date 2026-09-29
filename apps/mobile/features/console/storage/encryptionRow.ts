/**
 * What the Encryption row in Settings › Storage says (Boards 4, 5 and 8).
 *
 * Decided here, from the binding alone, so the rules are tested without a
 * renderer:
 *
 *  - **No row before the rollout reaches a workspace.** A managed workspace
 *    with no encryption state is promised nothing.
 *  - **Owners never see "failed".** A failed check is ours to fix; the
 *    control plane sends it as `paused`, and so does this.
 *  - **Never "end-to-end".** Context can still read these notes, which is how
 *    search and AI tools work, and the encrypted copy says so.
 *  - **A bucket the customer owns gets one honest sentence**: Context adds no
 *    encryption of its own there. Dropbox is neither, and gets no row.
 */

import type { ConsoleStorage } from "../types";

export interface EncryptionRowCopy {
  /** The row's headline, beside the mark. Absent for a customer's own bucket. */
  title?: string;
  /** Whether the headline carries the lock mark. */
  lock: boolean;
  body: string;
  /** The longer body behind "What this means" on a phone. */
  more?: string;
  /** Progress, 0 to 1, while encrypting with a known total. */
  progress?: number;
  state: "encrypting" | "checking" | "encrypted" | "paused" | "own-bucket";
}

export const ENCRYPTED_TITLE = "Encrypted in transit and at rest";
export const ENCRYPTED_BODY =
  "Context encrypts what's inside each file before storing it and keeps the key apart from your files. " +
  "File and folder names aren't encrypted. Context can still read your notes for search and your AI tools.";
export const ENCRYPTED_BODY_SHORT =
  "What's inside each file is encrypted. Context can still read your notes for search and your AI tools.";
export const OWN_BUCKET_BODY =
  "Context doesn't add its own encryption to a bucket you own. Your files stay plain and open in any app.";

/** `null` draws no row. `compact` is the phone's shorter copy (Board 8). */
export function encryptionRowCopy(
  storage: Pick<ConsoleStorage, "managed" | "provider" | "encryption">,
  compact = false,
): EncryptionRowCopy | null {
  if (storage.managed !== true) {
    if (storage.provider === "dropbox") return null;
    return { lock: false, body: OWN_BUCKET_BODY, state: "own-bucket" };
  }
  const encryption = storage.encryption;
  if (encryption === undefined || encryption === null) return null;
  switch (encryption.state) {
    case "encrypting": {
      const { filesDone, filesTotal } = encryption;
      const known = filesTotal !== undefined && filesTotal > 0;
      const done = Math.min(filesDone ?? 0, filesTotal ?? 0);
      const count = known ? `${done.toLocaleString("en-US")} of ${filesTotal.toLocaleString("en-US")}. ` : "";
      return {
        title: "Encrypting your files",
        lock: true,
        body: compact
          ? `${count}Keep working.`
          : `${count}Keep working. New notes are encrypted as you save them.`,
        ...(known ? { progress: done / filesTotal } : {}),
        state: "encrypting",
      };
    }
    case "checking":
      return {
        title: "Almost done: checking your files",
        lock: true,
        body: "Every file is read back once to make sure it opens.",
        state: "checking",
      };
    case "encrypted":
      return compact
        ? { title: ENCRYPTED_TITLE, lock: true, body: ENCRYPTED_BODY_SHORT, more: ENCRYPTED_BODY, state: "encrypted" }
        : { title: ENCRYPTED_TITLE, lock: true, body: ENCRYPTED_BODY, state: "encrypted" };
    case "paused":
    default:
      return {
        title: "Paused",
        lock: false,
        body: "Your notes open normally. We'll finish this when we can. Nothing for you to do.",
        state: "paused",
      };
  }
}
