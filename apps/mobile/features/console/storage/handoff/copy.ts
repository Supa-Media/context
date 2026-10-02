/**
 * What the owner reads about a move into a bucket they hold: out of managed
 * storage, or between two of their own (`to_own`).
 *
 * One place, so the setup form, the progress card and the failure states say
 * the same thing in the same words. Failure text is keyed by the closed error
 * codes the move records (`functions/managedProvisioning.ts`), never by a
 * provider's own text. Every failure says the managed copy is still live,
 * because it is: a move that stops has switched nothing.
 *
 * What stays encrypted: nothing Context puts in the customer's bucket carries
 * Context's storage encryption. Notes the owner locked with a password stay
 * locked, because that lock is theirs, not storage's. Never "end-to-end".
 */

export const STILL_LIVE = "Your workspace keeps running from Context's storage until every file matches.";

/** The same promise for a move between two of the owner's own buckets (`to_own`). */
export const STILL_LIVE_OWN = "Your workspace keeps running from the storage it uses now until every file matches.";

/** The offer, on a workspace whose storage the owner holds. */
export const OWN_MOVE = {
  title: "Move to another bucket",
  body:
    "Copies every file to a bucket you choose, checks each one, then switches this workspace to it. " +
    "Your current storage is left exactly as it is; delete it yourself whenever you like.",
  move: "Move to another bucket",
};

/** The destination form's heading and button, for either move into a bucket the owner holds. */
export const MOVE_FORM_WORDS = { submit: "Start the move", submitting: "Starting…" };

/** The line above the destination form for that move. */
export const OWN_MOVE_FORM_LEDE =
  "Choose the bucket to move to. Context uses the whole bucket, not a folder inside it; if it already " +
  "has files, you'll choose whether to keep them or start fresh. Nothing in your current storage is " +
  "changed or deleted. " +
  STILL_LIVE_OWN;

/**
 * Dropbox support is ending (`docs/decisions/billing.md`: no new Dropbox
 * connections). No date is given, so nothing is promised that has to be kept.
 */
export const DROPBOX_ENDING = {
  line: "Dropbox support is ending. Move this workspace to a bucket you own, or to Context storage.",
  toBucket: "Move to my bucket",
  toContext: "Use Context storage",
};

export const TAKE_IT_WITH_YOU = {
  title: "Take your workspace with you",
  body:
    "Move everything to a bucket you own, as plain files any app can open. " +
    "Free, and it still works after you cancel.",
  move: "Move to my own bucket",
  download: "Download everything (.zip)",
  notOwner: "Only an owner of this workspace can move its storage. Anyone can download what they can read.",
};

/** The line above the destination form. */
export const HANDOFF_FORM_LEDE =
  "Choose a bucket you own. Context uses the whole bucket, not a folder inside it; if it already " +
  "has files, you'll choose whether to keep them or start fresh. Your files arrive as plain Markdown " +
  "and attachments; Context adds no encryption in your bucket, and notes you locked with a password " +
  "stay locked. " +
  STILL_LIVE;

/** The two answers for a bucket that already has files in it. */
export const EXISTING = {
  merge: {
    title: "Keep them and add this workspace",
    body:
      "Your files stay, and they show up in this workspace beside your notes. If one has the same " +
      'name as a note here, yours is kept next to it as "name (from your bucket)".',
    button: "Keep and merge",
  },
  fresh: {
    title: "Start fresh",
    body: (bucket: string) =>
      `Deletes everything already in ${bucket}, then moves this workspace in. This can't be undone. ` +
      "Type the bucket's name to confirm.",
    field: "Bucket name",
    button: "Delete and start fresh",
  },
  other: "Use a different bucket",
};

/** What the progress card says about a choice already made. */
export function existingFilesLine(choice: "replace" | "merge" | undefined): string | null {
  if (choice === "merge") return "Keeping the files already in your bucket.";
  if (choice === "replace") return "Starting fresh: files already in your bucket are deleted before anything is copied.";
  return null;
}

export const STOP = {
  button: "Stop the move",
  title: "Stop the move?",
  body:
    "Your workspace keeps running from Context's storage, exactly as it is now. Files already " +
    "copied to your bucket are plain copies and stay there: keep or delete them, and a later " +
    "move into the same place carries on from them.",
};

export const STOP_OWN = {
  ...STOP,
  body:
    "Your workspace keeps running from the storage it uses now, exactly as it is. Files already " +
    "copied to the new bucket are plain copies and stay there: keep or delete them, and a later " +
    "move into the same place carries on from them.",
};

export function stoppedLine(bucket: string | undefined): string {
  return bucket === undefined
    ? "Move stopped. Nothing changed."
    : `Move stopped. Nothing changed. Anything already copied to ${bucket} stays there.`;
}

export function failureHeadline(code: string | undefined, failedCount: number): string {
  switch (code) {
    case "DESTINATION_NOT_EMPTY":
      return "Your bucket already has files in it";
    case "DESTINATION_NOT_CLEARED":
      return "Some files in your bucket wouldn't delete";
    case "OBJECT_TOO_LARGE":
      return failedCount === 1 ? "1 file didn't copy" : `${failedCount} files didn't copy`;
    default:
      return "The move paused";
  }
}

export function describeHandoffFailure(code: string | undefined, stillLive: string = STILL_LIVE): string {
  switch (code) {
    case "DESTINATION_NOT_EMPTY":
      return `Nothing has been copied or deleted yet. Choose what happens to the files already there. ${stillLive}`;
    case "DESTINATION_NOT_CLEARED":
      return `Nothing has been copied yet. A retention rule or the key's permissions can stop a delete: remove the rest yourself and start fresh again, or keep them and add your workspace beside them. ${stillLive}`;
    case "TARGET_NOT_READY":
      return `Context couldn't reach that bucket with the key you gave. Check the key and its permissions, then retry. ${stillLive}`;
    case "OBJECT_TOO_LARGE":
      return `These are too large to move this way yet. Download them from Files instead. ${stillLive}`;
    case "SOURCE_CHANGED":
      return `This workspace's storage changed while it was moving, so nothing was switched. Retry to start again. ${stillLive}`;
    default:
      return `The move stopped before switching over. ${stillLive} Retry to carry on.`;
  }
}

export function retainedLine(until: number): string {
  const date = new Date(until).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `Context's copy is kept until ${date} in case you want to switch back, then deleted.`;
}

export const MOVED = {
  title: "Your workspace now lives in your bucket",
  plain:
    "Context adds no encryption in your bucket; protect it with your provider's settings. " +
    "Notes you locked with a password stay locked.",
  switchBack: "Switch back to Context's storage",
};
