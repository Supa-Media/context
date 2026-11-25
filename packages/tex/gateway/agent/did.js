/**
 * WHAT CODE DID FOR A CHAT, HANDED TO TEX AS DATA (Dev2, 2026-11-25: "Tex's code never writes what Tex says";
 * docs/decisions/texting-assistant/no-scripted-wording.md). When code runs something a person asked for (an invite,
 * a mute, a shared mailbox, a job it could not start), the texting Worker queues one turn of the chat's own with
 * `event: "did"` and the facts (`packages/tex/worker/didFacts.ts`); node `did` (`graph/nodes/did.js`) checks them and
 * hands the Front door the facts as JSON, and Tex says what happened in its own words, taught by Training
 * conversations. No sentence is written here.
 */

export const DID_EVENT = "did";
const NAME = /^[a-z_]{1,32}$/;
const MAX_FIELDS = 12;
const MAX_TEXT = 200;

/**
 * The facts, read strictly, or null: `action` and `status` are short names, and every other field is a short name
 * holding a string (at most 200 characters), a finite number or a yes/no. Anything else drops the whole event:
 * nothing is run on facts this can't place.
 */
export function didFactsOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) return null;
  if (typeof value.action !== "string" || !NAME.test(value.action)) return null;
  if (typeof value.status !== "string" || !NAME.test(value.status)) return null;
  const facts = {};
  for (const [key, field] of entries) {
    if (!NAME.test(key)) return null;
    if (typeof field === "string") {
      if (field.length > MAX_TEXT) return null;
      facts[key] = field;
    } else if (typeof field === "number") {
      if (!Number.isFinite(field)) return null;
      facts[key] = field;
    } else if (typeof field === "boolean") facts[key] = field;
    else return null;
  }
  return facts;
}

/** What the Front door is handed for these facts: the facts themselves, marked as from Context and not a person. */
export function didQuestion(facts) {
  return JSON.stringify({ from: "context", did: facts });
}
