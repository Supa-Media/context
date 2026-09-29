/**
 * What the owner reads about a move out of managed storage.
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
  "Choose a bucket you own. It must be empty, or give a root prefix for an empty folder inside it. " +
  "Your files arrive as plain Markdown and attachments; Context adds no encryption in your bucket, " +
  "and notes you locked with a password stay locked. " +
  STILL_LIVE;

export const STOP = {
  button: "Stop the move",
  title: "Stop the move?",
  body:
    "Your workspace keeps running from Context's storage, exactly as it is now. Files already " +
    "copied to your bucket are plain copies and stay there: keep or delete them, and a later " +
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
    case "OBJECT_TOO_LARGE":
      return failedCount === 1 ? "1 file didn't copy" : `${failedCount} files didn't copy`;
    default:
      return "The move paused";
  }
}

export function describeHandoffFailure(code: string | undefined): string {
  switch (code) {
    case "DESTINATION_NOT_EMPTY":
      return (
        "Context won't change or delete anything already there. Choose an empty bucket, " +
        "or add a root prefix to use an empty folder inside it. Nothing has been copied. " +
        STILL_LIVE
      );
    case "TARGET_NOT_READY":
      return `Context couldn't reach that bucket with the key you gave. Check the key and its permissions, then retry. ${STILL_LIVE}`;
    case "OBJECT_TOO_LARGE":
      return `These are too large to move this way yet. Download them from Files instead. ${STILL_LIVE}`;
    case "SOURCE_CHANGED":
      return `This workspace's storage changed while it was moving, so nothing was switched. Retry to start again. ${STILL_LIVE}`;
    default:
      return `The move stopped before switching over. ${STILL_LIVE} Retry to carry on.`;
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
