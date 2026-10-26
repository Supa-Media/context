/**
 * What the Mac app tells the console about the Messages backup
 * (`docs/decisions/communications/messages-backup.md`), carried as the
 * optional `backup` field of `ImessageStatus`, which `contract.ts` re-exports.
 */

/**
 * What the console may know about iMessage import. Never a path, never a
 * message, never a contact — only whether it is on, whether this Mac has
 * granted the one permission it needs, and when it last actually wrote
 * something.
 */
export interface ImessageStatus {
  enabled: boolean;
  /**
   * Full Disk Access cannot be requested, only attempted — see
   * `core/imessage/permission.ts`. `"unknown"` covers both "never tried yet"
   * and "tried, and the failure was not clearly a permission refusal" (a
   * `chat.db` that does not exist yet, for instance); it is never shown as a
   * more alarming "denied" than the evidence supports.
   */
  permission: "granted" | "denied" | "unknown";
  /**
   * Epoch milliseconds of the last pass that actually filed a note, or `null`
   * until one has.
   *
   * **A pass that wrote nothing does not stamp this**, whether it wrote nothing
   * because every day was refused or because there was nothing new to write.
   * The console renders it as "last synced <time>", which is read as "your
   * messages are in your context" — so an attempt is not enough to earn it, and
   * this field said "the last completed sync attempt" while the shell stamped
   * it for refusals, which is how a card came to report a working import over a
   * gateway that had never accepted a single note.
   */
  lastSyncedAt: number | null;
  /** The shell's own words for the last thing that went wrong, or `null`. */
  lastError: string | null;
  /**
   * The Messages backup (`docs/decisions/communications/messages-backup.md`),
   * which is what this member reports since the import into notes was retired
   * (owner, 2026-10-21). A payload field rather than a version: a shell that
   * predates the backup sends none, and the console reads its absence as "this
   * Mac app needs an update" rather than as a backup that is off.
   */
  backup?: MessagesBackupView;
}

/** What a backup pass is doing, as a word the console turns into a sentence. */
export type MessagesBackupPhase =
  | "off"
  | "needs_permission"
  | "no_messages"
  | "not_connected"
  | "copying"
  | "up_to_date"
  | "stopped";

/**
 * The backup's progress, and nothing of what it copied: counts, two times,
 * the masked account and the Mac's own name. Never a handle, never a word of
 * a text, never a path.
 */
export interface MessagesBackupView {
  phase: MessagesBackupPhase;
  /** Rows of the Mac's Messages database copied so far, and how many it has. */
  copiedRows: number;
  totalRows: number;
  /** Epoch milliseconds of the oldest text copied so far, or `null` before the first. */
  reachedBack: number | null;
  /** Why it stopped, a closed set of codes, when `phase` is `stopped`. */
  problem: string | null;
  /** The account Messages is signed into, masked: `+1 ••• 4410`. */
  account: string | null;
  /** This Mac's name, as its owner set it: `Sam's MacBook Pro`. */
  machine: string | null;
  /**
   * Which files are copied, and how many bytes of them so far. Absent from a
   * Mac app that copies none, which the console reads as "update to copy
   * pictures" rather than as both switches off.
   */
  files?: MessagesBackupFiles;
}

/** The two switches of "What's copied" (owner's pick: pictures on, videos off), and the bytes sent. */
export interface MessagesBackupFiles {
  /** Pictures and documents, up to 25 MB each. */
  pictures: boolean;
  /** Videos, up to 25 MB each. */
  videos: boolean;
  bytes: number;
}

/** A change to one or both switches; a switch left out stays as it is. */
export interface MessagesBackupFilesChoice {
  pictures?: boolean;
  videos?: boolean;
}
