/**
 * THE LOOKUP LADDER: TRY THE CHEAPEST WAY TO FIND IT BEFORE ASKING THE PERSON (Dev2, 2026-11-20: "sometimes it just
 * asks me for something so stupid or it didn't really search"; Lab draft "Lookup ladder before asking").
 *
 * A draft that asks the person something is read once by a decision model (Clef by default; Jev or Clef Flash when the
 * step's config names them): is it an ask Tex could answer itself by looking, or one only they can answer (an approval,
 * a code, their taste)? Only a findable fact climbs. The rungs, cheapest first:
 *
 *   1 what Tex already knows: the chat's older history, beyond the days the front door reads (`rungKnows`);
 *   2 their notes (`rungNotes`);
 *   3 a connected app (mail, calendar, Google Chat) and 4 web search: the front door's own tools, tried on a send-back
 *     that says which it has not tried (`rungTools`). A connector that failed this turn is never worked around with the
 *     browser: the ask goes to the person, saying it is broken;
 *   5 its own browser, 6 its own computer and 7 the Job advisor: slow, so never inside the turn; the turn ends on its
 *     start line and a background job climbs them, asking the person only when all are stumped (the Hand-off node).
 *
 * This file is the pure part: which sentences ask, which rung a tool call is, the model's request and how its answer
 * reads, and the words a send-back carries. Each rung's own node logs what it searched and found, so Replay shows the
 * climb as it ran.
 */
/** The kinds of ask a draft can make of the person, as the gate's choices. */
export const ASK_KINDS = Object.freeze({
  none: "it asks the person nothing they must answer: a statement, a result, a rhetorical question, or an offer of a next step",
  approval: "it asks for their yes before Tex does something that leaves or can't be undone: sending an email or text, paying, booking, deleting, sharing",
  person: "only they can answer it: their choice or taste, what they meant, a code or passkey sent to them, a captcha, or something about them that is written nowhere Tex can read",
  fact: "it asks them for a fact Tex could find by looking: in the chat's history, their notes, mail, calendar, accounts or on the web",
});

/** Rungs in the order they are climbed. 5 to 7 are a background job's. */
export const RUNGS = Object.freeze(["knows", "notes", "apps", "web", "browser", "computer", "advisor"]);
/** Rungs the turn itself climbs; the rest go to a job. */
export const TURN_RUNGS = Object.freeze(["knows", "notes", "apps", "web"]);

/** The most of a draft and of their text the gate reads. */
const MAX_DRAFT = 3_000;
const MAX_ASK = 2_000;

/** Sentences of a draft that end in a question mark, in order. Code's only part of reading an ask: a pre-filter. */
export function questionsIn(draft) {
  const text = String(draft ?? "");
  const tidy = (list) => list.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => /[a-z0-9]/i.test(s));
  const marked = text.includes("?") ? tidy(text.match(/[^.!?\n]*\?+/g) ?? []) : [];
  // An ask need not end in a question mark: "Send me her address." asks them as surely as "What's her address?"
  // (2026-11-20, a live test text that skipped the climb). Sentences that ask them for something count too; the model
  // still reads what each asks, so a "let me know if you want more" is passed as no real ask.
  const told = tidy((text.match(/[^.!?\n]+[.!]?/g) ?? []).filter((s) => !s.includes("?") && ASKS_THEM.test(s)));
  return [...marked, ...told];
}

/** Words that ask the person for something without a question mark. */
const ASKS_THEM = /\b(?:send|tell|give|text|share|forward|drop|remind) me\b|\blet me know\b|\bi(?:'ll| will)? need (?:you|your|the|her|his|their)\b|\bconfirm (?:the|your|which|her|his|their)\b/i;

/** The selector a Workers AI decision model is asked with: the last part of its id ("@cf/typesafe/jev" -> "jev"). */
export function selectorOf(model) {
  const id = String(model ?? "");
  const last = id.split("/").pop() ?? "";
  return last === "" ? "clef" : last;
}

/** The gate's request: one choice over the draft, read beside their text and the gate's own context (`training`, `today`). */
export function askRequest({ ask, draft, context = "" }) {
  const state = [
    context ? context.trim() : "",
    `<their_text>\n${String(ask ?? "").slice(0, MAX_ASK)}\n</their_text>`,
    `<tex_draft>\n${String(draft ?? "").slice(0, MAX_DRAFT)}\n</tex_draft>`,
  ].filter(Boolean).join("\n\n");
  return {
    state,
    questions: {
      kind: {
        type: "choice",
        instructions: "Tex is an assistant a person texts; it can read the chat's history, their notes, mail, calendar and accounts, search the web and use its own browser. The state holds their text and the reply Tex is about to send. What does that reply ask of them?",
        criteria: { ...ASK_KINDS },
      },
    },
  };
}

/** The gate's answer: `{ kind, sure }`, or null when the model named no kind. */
export function readAsk(answers) {
  const kind = answers?.kind?.choice;
  if (typeof kind !== "string" || !Object.hasOwn(ASK_KINDS, kind)) return null;
  const sure = typeof answers.kind.confidence === "number" && Number.isFinite(answers.kind.confidence) ? Math.max(0, Math.min(1, answers.kind.confidence)) : 0;
  return { kind, sure };
}

const STOP = new Set("about above after again also been before being could does doing done every from have here into just know like make many more most much need only other over please same should some such than that their them then there these they thing this those through under very want were what when where which while will with would your yours you're what's when's where's which's".split(" "));

/** The words a search for the asked fact uses: the questions' content words, longest first, at most `max`. */
export function termsOf(questions, max = 6) {
  const seen = new Set();
  for (const q of Array.isArray(questions) ? questions : [questions]) {
    for (const word of String(q ?? "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []) {
      if (!STOP.has(word)) seen.add(word.replace(/'s$/, ""));
    }
  }
  return [...seen].sort((a, b) => b.length - a.length).slice(0, max);
}

/** Lines of `text` holding at least `need` of `terms` (half of them, at least one), best first, at most `max`. */
export function linesWith(text, terms, { max = 5, need = null } = {}) {
  const list = Array.isArray(terms) ? terms.filter(Boolean) : [];
  if (list.length === 0) return [];
  const bar = need ?? Math.max(1, Math.ceil(list.length / 2));
  const scored = [];
  for (const line of String(text ?? "").split("\n")) {
    const lower = line.toLowerCase();
    const hits = list.filter((term) => lower.includes(term)).length;
    if (hits >= bar) scored.push({ line: line.trim().slice(0, 300), hits });
  }
  return scored.sort((a, b) => b.hits - a.hits).slice(0, max).map((s) => s.line);
}

const APP_IDS = /^(?:email:|calendar:|chat:|meetings:|messages:|contacts:|apps:)/;
const APP_TOOLS = /^(?:read_email|search_email|read_calendar|read_thread|group_chats|read_texts|list_texts|search_texts)$|^(?:gmail|google|calendar|drive|slack|notion)_/;
const NOTE_TOOLS = /^(?:search|fetch|orient|search_notes|read_note|read_notes|read_file|read_image)$/;

/** Which rung a tool call of the turn climbed, or null for one that looks nothing up. */
export function rungOf(name, args = {}) {
  const tool = String(name ?? "");
  if (tool === "search_web") return "web";
  if (tool === "open_page" || tool.startsWith("browse")) return "browser";
  if (tool === "ask_advisor") return "advisor";
  if (tool === "read_back" || tool === "read_day") return "knows";
  if (APP_TOOLS.test(tool)) return "apps";
  if (tool === "search" && args?.email === true) return "apps";
  if (tool === "fetch" && APP_IDS.test(String(args?.id ?? ""))) return "apps";
  if (NOTE_TOOLS.test(tool)) return "notes";
  return null;
}

/**
 * What the turn tried, by rung, from its messages (`turn.js`: an assistant message's `toolCalls`, then each call's
 * `role: "tool"` result): `{ tried: Set<rung>, failedApps: string[] }`. A failed app call is a broken connector.
 */
export function triedRungs(messages) {
  const tried = new Set();
  const failedApps = [];
  const argsById = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const call of Array.isArray(m?.toolCalls) ? m.toolCalls : []) argsById.set(call?.id, call?.args ?? {});
    if (m?.role !== "tool") continue;
    const rung = rungOf(m.name, argsById.get(m.id) ?? {});
    if (rung === null) continue;
    tried.add(rung);
    if (rung === "apps" && m.isError) failedApps.push(String(m.name ?? ""));
  }
  return { tried, failedApps };
}

/** The fast rungs the turn has not tried, cheapest first. */
export const untriedFast = (tried) => ["apps", "web"].filter((rung) => !tried.has(rung));

const RUNG_WORDS = { apps: "their connected apps (mail, calendar, Google Chat)", web: "a web search" };

/**
 * The send-back after rungs 1 to 4, or null when there is nothing to send back with: what the cheap rungs found, and
 * which fast rungs are still untried. A broken connector says so and asks.
 */
export function ladderNotice({ questions, knows = [], notes = [], untried = [], failedApps = [] }) {
  const asked = (Array.isArray(questions) ? questions : []).slice(0, 3).join(" ");
  const facts = [];
  if (knows.length > 0) facts.push(`Before asking "${asked}": the chat's own history already has lines on it:\n${knows.map((l) => `- ${l}`).join("\n")}`);
  if (notes.length > 0) facts.push(`Their notes have results on it:\n${notes.map((l) => `- ${l}`).join("\n")}`);
  if (failedApps.length > 0) facts.push(`A connected app failed this turn (${failedApps.join(", ")}). Don't work around it with the browser: tell them it is broken and ask.`);
  else if (untried.length > 0) facts.push(`You have not tried ${untried.map((r) => RUNG_WORDS[r]).join(" or ")} for it yet. Look there before asking them.`);
  if (facts.length === 0) return null;
  return `Before this goes: ${facts.join("\n\n")}\nAnswer from what you find; ask them only what none of it answers.`;
}
