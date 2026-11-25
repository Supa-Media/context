/**
 * Marking a person active for the Context usage source (`apps/convex/functions/usagePeople.ts`): at most once per
 * person, kind and UTC day per isolate, behind the response, its failure nobody's problem.
 */

import { usagePersonId, usagePersonKeyOf } from "./person.js";

export const PERSON_KINDS = Object.freeze(["wrote", "called"]);
const KINDS = new Set(PERSON_KINDS);
/** What one isolate remembers having sent, so a busy client is one mark a day and not one per call. */
const MAX_REMEMBERED = 5000;
const sent = new Set();

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** For the suite: forget what was sent. */
export function forgetSentMarks() {
  sent.clear();
}

/**
 * Mark `session`'s person `kind` today. Returns the deferred promise (for tests), or null when nothing is sent: no
 * person, an unknown kind, no way to defer, or already sent from this isolate today.
 */
export function markPersonActive(store, session, env, controlPlane, kind, now = Date.now()) {
  const userId = session?.actorUserId;
  if (!KINDS.has(kind) || typeof userId !== "string" || userId === "") return null;
  if (typeof store?.defer !== "function" || typeof controlPlane?.reportUsage !== "function") return null;
  const memo = `${userId}\u0000${kind}\u0000${dayOf(now)}`;
  if (sent.has(memo)) return null;
  if (sent.size >= MAX_REMEMBERED) sent.clear();
  sent.add(memo);
  const work = (async () => {
    const person = await usagePersonId(await usagePersonKeyOf(env), userId);
    if (person === null) return;
    await controlPlane.reportUsage([], [], [{ person, kind }]);
  })().catch(() => {
    // Not sent: let the next call of the day try again.
    sent.delete(memo);
  });
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
  return work;
}
