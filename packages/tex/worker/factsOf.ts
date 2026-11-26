/**
 * What code did, read strictly (docs/decisions/texting-assistant/no-scripted-wording.md): the facts a turn is handed
 * in place of a sentence, by node `did` (`didFacts.ts`) and by a job that ended (`jobs.ts` `jobEndOf`). Its own module
 * so the job's code reads it without the group queue.
 */

/** What code did, as data: short names, and short values. The gateway reads it as strictly (`did.js` `didFactsOf`). */
export type Did = { action: string; status: string; [field: string]: string | number | boolean };

const NAME = /^[a-z_]{1,32}$/;

/** A `Did`, read strictly, or null: the same rules the gateway's node applies, so nothing is queued it would refuse. */
export function didOf(value: unknown): Did | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) return null;
  const facts: Record<string, string | number | boolean> = {};
  for (const [key, field] of entries) {
    if (!NAME.test(key)) return null;
    if (typeof field === "string" && field.length <= 200) facts[key] = field;
    else if (typeof field === "number" && Number.isFinite(field)) facts[key] = field;
    else if (typeof field === "boolean") facts[key] = field;
    else return null;
  }
  if (typeof facts.action !== "string" || !NAME.test(facts.action)) return null;
  if (typeof facts.status !== "string" || !NAME.test(facts.status)) return null;
  return facts as Did;
}

