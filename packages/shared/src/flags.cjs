/**
 * Every feature flag: one id per feature that is built and on production but
 * not yet open to everyone (decided by the owner, 2026-11-08; the design is
 * `docs/decisions/app-and-console/feature-flags.md`).
 *
 * Who has a flag is not here. Staff choose it in the console's Features tab
 * (`apps/convex/functions/featureFlags.ts`): off, a list of people, or
 * everyone. This repository is public, and who is testing what is theirs.
 *
 * ## Every flag expires
 *
 * The owner, 2026-11-08: "put expiration dates on flags, either remove the
 * feature or launch it". `expires` is at most `MAX_FLAG_DAYS` after `added`,
 * and once it has passed, `flagProblems` names the flag and the Convex suite
 * fails (`apps/convex/__tests__/featureFlags.test.ts`) until a pull request
 * launches it (deletes the flag and keeps the code) or removes the feature
 * (deletes both). Moving `expires` later is allowed only within the same
 * limit from `added`, so a flag cannot be kept forever by editing its date.
 *
 * ## Ids
 *
 * `area.name`, lower case words joined by hyphens (`tex.conversation-threads`).
 * An id is never reused once its flag is gone: a person's list from the old
 * flag must not switch on the new one.
 *
 * Read by the control plane, the gateway and the app, so it is CommonJS with
 * its types beside it (`flags.d.cts`), as `folderJobInfo.cjs` is.
 */

/** The longest a flag may live, from `added` to `expires`. */
const MAX_FLAG_DAYS = 90;
/** How soon before `expires` the console shows a flag as due. */
const FLAG_DUE_DAYS = 14;

const FLAG_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The flags. Add one as
 *
 *   "tex.conversation-threads": {
 *     label: "Conversation threads",
 *     description: "Tex sorts texts into threads before it answers.",
 *     added: "2026-11-08",
 *     expires: "2026-12-08",
 *   },
 */
const FLAGS = Object.freeze({
  "mail.in-notes": {
    label: "Mail in notes",
    description: "Gmail is copied into the person's notes again, so new mail starts a Tex check-in at once.",
    added: "2026-11-08",
    expires: "2027-02-06",
  },
});

const FLAG_MODES = Object.freeze(["off", "people", "everyone"]);

function isFlagId(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FLAGS, value);
}

/** Milliseconds at midnight UTC of a `YYYY-MM-DD` day, or NaN. */
function dayMs(day) {
  if (typeof day !== "string" || !DAY.test(day)) return NaN;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

/** Whole days from `today` (a `YYYY-MM-DD`) to the flag's `expires`: 0 on the day, negative after. */
function daysLeft(flag, today) {
  return Math.round((dayMs(flag.expires) - dayMs(today)) / 86_400_000);
}

/** Today in UTC as `YYYY-MM-DD`. */
function todayOf(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Everything wrong with a registry on `today`, one sentence each; empty when
 * it is fine. An expired flag is one of them, on purpose.
 */
function flagProblems(flags, today) {
  const problems = [];
  for (const [id, flag] of Object.entries(flags)) {
    if (!FLAG_ID.test(id)) problems.push(`${id}: an id is area.name in lower case words joined by hyphens.`);
    if (!flag || typeof flag !== "object") {
      problems.push(`${id}: needs label, description, added and expires.`);
      continue;
    }
    if (typeof flag.label !== "string" || flag.label.trim() === "") problems.push(`${id}: needs a label.`);
    if (typeof flag.description !== "string" || flag.description.trim() === "") problems.push(`${id}: needs a description.`);
    const added = dayMs(flag.added);
    const expires = dayMs(flag.expires);
    if (Number.isNaN(added)) problems.push(`${id}: added must be a YYYY-MM-DD day.`);
    if (Number.isNaN(expires)) problems.push(`${id}: expires must be a YYYY-MM-DD day.`);
    if (Number.isNaN(added) || Number.isNaN(expires)) continue;
    if (expires <= added) problems.push(`${id}: expires must come after added.`);
    if (expires - added > MAX_FLAG_DAYS * 86_400_000) problems.push(`${id}: expires is more than ${MAX_FLAG_DAYS} days after added.`);
    if (daysLeft(flag, today) < 0) problems.push(`${id}: expired on ${flag.expires}. Launch it (delete the flag, keep the code) or remove the feature.`);
  }
  return problems;
}

module.exports = { FLAGS, FLAG_MODES, MAX_FLAG_DAYS, FLAG_DUE_DAYS, isFlagId, daysLeft, todayOf, flagProblems };
