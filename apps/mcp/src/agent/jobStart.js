/**
 * What Tex says as a background job starts: a line of its own words, or only a
 * tapback, decided by the front door each time from example chats (Dev2,
 * 2026-11-12: "some jobs don't need it, some jobs do need it ... we need
 * specific examples of conversations and what the response was").
 *
 * From 2026-11-11 (#3169) every start was a tapback and nothing else, by
 * code. In the Nov Babies chat that left a group with a 🤝 and eleven minutes
 * of nothing after "do some research and put it in a page for us". There is no
 * count here, no "once per job" and no timer: the line is written in the same
 * call that starts the job (`say`), so the turn still ends the moment the job
 * starts, with no model round after it (`background.js` `endsTurn`).
 *
 * The examples are labelled the way the judge's are: real chats where they
 * exist (names kept to the people who asked for them), the rest made up to
 * cover what the real ones don't. `bench/jobstart/cases.json` holds different
 * cases, scored by `pnpm ai jobstart`.
 */

/** The longest start line texted; a longer one is cut at its last full sentence. */
export const MAX_START_LINE = 280;

/** The `say` field each job tool takes (`start_background_job`, `restart_background_job`, `plan_big_ask`). */
export const SAY_FIELD = {
  type: "string",
  description:
    "What to text them as this starts, in your own words, one or two short plain sentences: what they'll get, where it lands and about when, " +
    "and any assumption you made. Leave it out when a tapback says enough. Judge it from the job-start examples; no link, no title read back.",
};

/** A `say` as it is texted: one line, trimmed, never a control marker, cut at a sentence past `MAX_START_LINE`. Empty means a tapback. */
export function startLine(value) {
  if (typeof value !== "string") return "";
  const said = value.replace(/\s+/g, " ").trim();
  if (said === "" || /\[\[tex:/i.test(said)) return "";
  if (said.length <= MAX_START_LINE) return said;
  const cut = said.slice(0, MAX_START_LINE);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, MAX_START_LINE - 1).trimEnd()}…`;
}

/** The examples, as the front door reads them beside its job rules (`background.js` `JOB_FIRST`). */
export const JOB_START_EXAMPLES = [
  "Whether a job's start gets a line (the `say` on the call that starts it) or only a tapback is yours to judge, every time, from what " +
    "they need to know right now. There is no rule to count by. Some starts need a line, some don't. These are examples, not a list to match:",
  '- Group, Seyi: "do some research and put it in a page for us" (a birthday plan for 20). Say: "On it. I\'ll put a page together with ' +
    'dinner and non-karaoke ideas for 20, with photos, and send it here in a few minutes." A group is waiting on minutes of work: tell them it\'s coming and what it covers.',
  '- Group, Seyi: "I wanted options that weren\'t just karaoke, do better, and put pictures in your research". Say: "Fair. Redoing it with ' +
    'bowling, comedy and dinner spots, real photos this time. New page in a few minutes." A complaint about the last result: a bare tapback reads as ignoring it.',
  '- Group, a job already running: "it doesn\'t have to be karaoke, just something fun". A tapback only, passed to the job: they already know you\'re on it.',
  '- 1:1: "get started on an a16z application". Say: "On it. I\'ll draft it from your notes on Context and Tex and send you the link when ' +
    "it's ready, about 10 minutes.\" Saying what it's built from lets them correct it early.",
  "- A job's report turn where you restart a stopped job yourself, nobody asking just now: nothing. They already heard you were on it.",
  '- 1:1: "restart the jobs that stopped". A tapback only: they asked for exactly that.',
  '- 1:1: "no rush, but can you find me a dentist near work who takes Aetna". Say: "Will do. I\'ll check which ones near Union Square take ' +
    'Aetna and text you a short list." No rush is not silence, and naming the place you assumed lets them correct it.',
  '- Group: "Tex can you make a packing list page for the cabin trip". Say: "On it, taking the cabin as the Catskills one from last week. ' +
    'Page here shortly." When you assumed something, the start line is the cheapest place to say so.',
  '- 1:1, right after a job came back: "add the prices to that page too". A tapback only: a small follow-up, and the change shows up soon.',
  '- Never: "Searching NYC karaoke spots that take groups of 20…" (it narrates a search) or "On it: Birthday dinner and karaoke." (a title read ' +
    "back). A good line says what they'll get, where it lands and about when.",
].join("\n");
