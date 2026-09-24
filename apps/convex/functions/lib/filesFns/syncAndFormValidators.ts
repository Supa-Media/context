/**
 * The Google sync and form return validators.
 *
 * Split out of `functions/files.ts`, which registers every function that uses
 * them; that file's header holds the rules they keep.
 */

import { v } from "convex/values";

export const googleSyncRunValidator = v.object({
  kind: v.literal("googleSyncRun"),
  runId: v.id("googleSyncRuns"),
  status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
  totalUnits: v.number(),
  completedUnits: v.number(),
  itemsFound: v.number(),
  daysWithMail: v.number(),
  bytesWritten: v.number(),
  continue: v.boolean(),
});

/**
 * One forward sync pass, as the scheduler sees it. No mail, no path, no
 * cursor — the cursor is written to the connection row by
 * `recordGoogleForwardSyncPass`, and a scheduled action's return value is read
 * by nobody but a test.
 */
export const googleForwardSyncValidator = v.object({
  kind: v.literal("googleForwardSync"),
  connectionId: v.id("googleConnections"),
  status: v.union(v.literal("synced"), v.literal("skipped"), v.literal("failed")),
  daysTouched: v.number(),
  bytesWritten: v.number(),
  cursorAdvanced: v.boolean(),
  gapDetected: v.boolean(),
  /** The history walk ran out of pages; this connection has more to drain. */
  truncated: v.boolean(),
  errorCode: v.optional(v.string()),
});

/**
 * One answer to one field.
 *
 * A list of pairs rather than an object keyed by field name, because a form's
 * fields are the author's and a Convex validator — like the gateway's tool
 * schema — cannot close an object whose keys it does not know. An open one at
 * this position accepts whatever a caller puts there, which is the hole both
 * validators exist to shut.
 */
export const formAnswerValidator = v.object({ field: v.string(), value: v.string() });

export const formResultValidator = v.object({
  kind: v.literal("formApplied"),
  responseId: v.string(),
  formId: v.string(),
  responsesPath: v.string(),
  votes: v.optional(v.number()),
});

/**
 * The one response a notification is about, or `null`.
 *
 * `null` covers every refusal without distinguishing them — the manifest says
 * no, the response was retracted, the block stopped parsing. The caller is a
 * scheduled job with nobody to tell, and the differences are facts about a
 * file the recipient may not be able to open.
 *
 * Note what the `formApplied` validator beside this does **not** name:
 * `notify`. `FormResult` carries it and Convex refuses a returned field its
 * validator does not know, so the `form` branch has to strip it before
 * returning — forgetting to is a test failure rather than a submitter learning
 * who their answer was mailed to.
 */
export const formNotifyReadValidator = v.object({
  kind: v.literal("formNotifyRead"),
  response: v.union(
    v.null(),
    v.object({
      by: v.string(),
      at: v.string(),
      answers: v.array(formAnswerValidator),
    }),
  ),
});
