/**
 * THE JUDGE'S BRIEF: WHAT A GROUP TURN KNEW, KEPT WHEN IT ENDS, FOR THE JUDGE (Dev2, 2026-11-12).
 *
 * The judge (`textsDecide.js`, Clef) decides whether Tex speaks, reacts or stays quiet, from the chat's lines and a few
 * facts. It could not see what the turn saw: Tex's own work (a booking form it was filling, a page it opened, a yes it
 * was waiting on) and the chat's own rules (its about note, its custom instructions). So a follow-up about the Puttery
 * booking, which Tex was handling, was judged as people talking to each other ("it's directly related to details it
 * was handling"). Asked to "just give the judge all the information it needs", Dev2 said yes to this brief.
 *
 * It is step 5 of the one-record-per-chat design (draft #3196: "the next turn's context is built when a turn ends"),
 * for the judge only: when a group turn ends, the gateway keeps a `brief` entry in the chat's ledger (the chat's one
 * copy, sealed as its home is), and the judge reads the newest few beside the chat (`nowFacts`). When that design
 * lands, its next-prompt copy replaces this entry, and the judge reads that instead.
 *
 * Facts only, never a rule about what to do: the judge's examples decide that (JUDGMENT BY EXAMPLES).
 */

/** At most this many of a turn's tools and places are kept. */
const MAX_TOOLS = 6;
const MAX_PLACES = 4;
const MAX_ASK = 200;
const MAX_ABOUT = 900;
const MAX_INSTRUCTIONS = 400;
const MAX_WAITING = 3;
/** Work older than this isn't shown to the judge as something Tex is handling. */
export const BRIEF_FRESH_MS = 12 * 60 * 60 * 1000;
/** How many recent turns' work the judge is told. */
const MAX_TURNS = 3;
/** Tools that are no work on anything (how the turn ran, not what it did). */
const NOT_WORK = new Set(["say_nothing", "ask_advisor", "earlier_chat", "read_thread", "job_status"]);

const newId = () => `brief${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
/** Control characters and line and paragraph separators, as `logRender.js` `BREAKS`: a brief is one line each. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");
const oneLine = (value, max) => (typeof value === "string" ? value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Where a source points, shortly: a site's host, or a note's path. */
function placeOf(source) {
  if (typeof source !== "string" || source === "") return "";
  try {
    const url = new URL(source);
    if (url.protocol === "https:" || url.protocol === "http:") return url.hostname.replace(/^www\./, "");
  } catch {
    // not a URL: a note's path
  }
  return oneLine(source.replace(/^[a-z]+:/, ""), 120);
}

/** What one approval or offer waits on, in words: whose yes, for what. */
function waitingLine(entry, fallbackWho) {
  const who = oneLine(entry?.who ?? fallbackWho ?? "", 64).replace(/^@*/, "");
  const what = oneLine(entry?.tool ?? entry?.kind ?? entry?.action ?? "", 40);
  return `${who ? `@${who}'s` : "a"} yes${what ? ` for ${what}` : ""}`;
}

/**
 * The brief for one group turn, or null outside a group or a job's turn: who asked and what, the tools it ran and
 * where, what it waits on, and the chat's own about note and instructions as the turn read them.
 */
export function briefEntry({ group, question = "", steps = [], asked = [], offered = null, instructions = "", turn = null, at = Date.now() }) {
  if (group === null || group === undefined) return null;
  const done = (Array.isArray(steps) ? steps : []).filter((step) => typeof step?.tool === "string" && !NOT_WORK.has(step.tool));
  const tools = [...new Set(done.map((step) => step.tool))].slice(0, MAX_TOOLS);
  const places = [...new Set(done.flatMap((step) => (Array.isArray(step.sources) ? step.sources : []).map(placeOf)).filter(Boolean))].slice(0, MAX_PLACES);
  const waiting = [...(Array.isArray(asked) ? asked : []).map((entry) => waitingLine(entry, group.from)), ...(offered ? [waitingLine(offered)] : [])].slice(0, MAX_WAITING);
  const about = oneLine(typeof group.aboutUs === "string" ? group.aboutUs : "", MAX_ABOUT);
  const rules = oneLine(instructions, MAX_INSTRUCTIONS);
  const asker = group.from || group.asker || "";
  return {
    v: 1,
    id: newId(),
    at,
    kind: "brief",
    ...(turn ? { turn } : {}),
    ...(asker ? { asker } : {}),
    ...(oneLine(question, MAX_ASK) ? { ask: oneLine(question, MAX_ASK) } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(places.length > 0 ? { places } : {}),
    ...(waiting.length > 0 ? { waiting } : {}),
    ...(about ? { about } : {}),
    ...(rules ? { rules } : {}),
  };
}

/** How the about-note fact opens, so the judge's facts can put it last (`textsDecide.js`). */
export const ABOUT_FACT = "This chat's about note:";

/** The judge's facts from the chat's briefs, newest first: recent work, what it waits on, and the chat's own rules. */
export function briefFacts(entries, { now = Date.now() } = {}) {
  const briefs = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.kind === "brief" && Number.isFinite(entry.at));
  if (briefs.length === 0) return [];
  const at = (ms) => new Date(ms).toISOString().slice(11, 16);
  const facts = [];
  const worked = briefs.filter((entry) => Array.isArray(entry.tools) && entry.tools.length > 0 && now - entry.at <= BRIEF_FRESH_MS).slice(0, MAX_TURNS);
  for (const entry of worked) {
    const who = typeof entry.asker === "string" && entry.asker ? `@${entry.asker.replace(/^@*/, "")}` : "someone";
    const ask = typeof entry.ask === "string" && entry.ask ? ` "${entry.ask.replace(/"/g, "'")}"` : "";
    const where = Array.isArray(entry.places) && entry.places.length > 0 ? ` on ${entry.places.join(", ")}` : "";
    facts.push(`Tex worked on ${who}'s ask${ask} at ${at(entry.at)} UTC: ${entry.tools.join(", ")}${where}.`);
  }
  const newest = briefs[0];
  if (Array.isArray(newest.waiting) && newest.waiting.length > 0 && now - newest.at <= BRIEF_FRESH_MS) facts.push(`Tex is waiting on ${newest.waiting.join("; ")}.`);
  if (typeof newest.rules === "string" && newest.rules) facts.push(`This chat's instructions to Tex: ${newest.rules}`);
  if (typeof newest.about === "string" && newest.about) facts.push(`${ABOUT_FACT} ${newest.about}`);
  return facts;
}
