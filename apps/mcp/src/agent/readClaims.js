/**
 * A PAGE IS SAID TO HOLD ONLY WHAT TEX READ IN IT (self-review, the Tex Devs
 * group, 2026-10-30; theme read-claims-contradict).
 *
 * Asked about a spec, Tex texted "Yep, the memory section is there" and
 * quoted a heading; two texts later, "Only the overview loaded, so the memory
 * section is still unread". It had also written the spec off as being for
 * another company's models before opening it. In the same group, Tex said
 * from the notes that a model switch "isn't switched over yet", then a few
 * turns on described the switch as live, without saying what had changed.
 *
 * The words-level sibling of `sourcedFigures.js`, which does this for prices
 * and scores. Each is a thing the gateway can see for itself, and each sends
 * one more round, once a turn, naming what it found:
 *
 *   1. The answer says a page or note has a section, covers a subject, or
 *      quotes its words, and nothing read (this turn's tool results, their
 *      texts, what Tex itself wrote this turn) holds those words.
 *   2. A page came back cut (`[cut`, `computer.js`) and the answer reviews it
 *      or says it lacks something, without saying it was only partly read.
 *   3. Their text carries a link, nothing on the web was read this turn, and
 *      the answer sums the link up ("it's for GPT, skip it").
 *   4. Something read, or an earlier text, says a change is not live yet
 *      (planned, not switched over), and the answer states it as live with
 *      no correction named.
 *   5. The answer says a page is unread or didn't load, after one of Tex's
 *      last texts said what it holds, and names no correction.
 *
 * Pictures they sent are read by the model, not by a tool, so the read checks
 * (1 to 3) skip a turn carrying them. Docs: docs/decisions/texting-assistant/history.md.
 */

import { namesIn, resultText, sentencesOf } from "./sourcedFigures.js";

/** Told on every texted turn, beside `RESEARCH_LINE` (`prompt.js`). */
export const READ_CLAIMS_LINE =
  "Say a page or note holds something only once the text you read shows it. A page ending \"[cut\" was only partly read: say so first, then open_page it again with from: the heading you need. " +
  "Keep planned as planned and live as live, as the source says, and when you change an earlier answer, say it corrects it. ";

/** "the memory section is there", "the pricing part covers", "the Memory heading says". */
const SECTION_IS_THERE =
  /\b(?:the\s+|a\s+|an\s+|its\s+)?["“]?([A-Za-z0-9][\w'’&/ -]{1,40}?)["”]?\s+(?:section|part|chapter|heading)\s+(?:is\s+(?:there|in\s+(?:it|there)|included|covered)|exists|covers|says|lists|explains|describes|spells\s+out)\b/gi;
/** "it has a section on memory", "a part about pricing", "a heading called Memory". */
const HAS_A_SECTION_ON =
  /\b(?:a|an|the|its)\s+(?:section|part|chapter|heading)\s+(?:on|about|for|called|titled|named)\s+["“]?([^".,;:!?”\n]{2,50})/gi;
/** "the spec covers memory", "the page talks about pricing". */
const THE_PAGE_COVERS =
  /\b(?:the|this|that|their|its)\s+(?:page|spec|doc|docs|document|guide|article|post|site|readme|pdf|paper|playbook|write-?up|note)\s+(?:covers|explains|describes|walks\s+through|talks\s+about|mentions|spells\s+out|lays\s+out|goes\s+over)\s+([^.,;:!?\n]{2,60})/gi;
/** A sentence speaking of what a source says, where a quote is that source's words. */
const QUOTES_A_SOURCE = /\b(?:page|section|heading|spec|doc|docs|document|guide|note|readme|says|reads|titled|called|quote[sd]?|word(?:ed|s))\b/i;
const QUOTED = /["“]([^"“”\n]{6,160})["”]/g;

/** Words that carry no subject. */
const STOP = new Set(
  (
    "the a an and or of on in to for with by from at as is are was were be it its this that these those there their them they we our you your " +
    "about into over under all any some no not yes yep yeah so but just also only one two how what which who why when where whole full main new " +
    "page pages section sections part parts doc docs spec note notes heading tab"
  ).split(/\s+/),
);

/** A page that came back cut (`computer.js`, `browse.js`), and one read again from a heading. */
const CUT = /\n\[cut\b/;
const READ_FROM = /^\(Read from "/m;

/** An answer saying up front it read only part of a page. */
const SAYS_PARTLY =
  /\b(?:partly|partial(?:ly)?|only (?:the )?(?:first|top|start|beginning|overview|opening|part|intro)|first part|cut off|got cut|was cut|(?:didn['’]t|did not|never) (?:all |fully )?load|not (?:all|fully) load(?:ed)?|the rest (?:of it |of the page )?(?:is |was )?(?:unread|cut|didn['’]t load|still)|(?:read|got) (?:only )?(?:the )?(?:first|top) )/i;
/** Their text asks what a page holds. */
const ASKS_ABOUT_A_PAGE =
  /\b(?:review|summari[sz]e|sum (?:it )?up|read (?:it|this|that|the)|look (?:at|over|through) (?:it|this|that|the)|go (?:over|through)|what does (?:it|this|that|the \w+) (?:say|cover|have)|thoughts on|tl;?dr|does (?:it|this|that|the \w+) (?:cover|have|mention|say|include))\b/i;
/** "it doesn't mention memory", "there's no section on", "nothing about pricing". */
const SAYS_IT_LACKS =
  /\b(?:does\s*n[o']t|doesn['’]t|does not|did\s*n[o']t|didn['’]t) (?:mention|cover|say|have|include|talk about|list|get into)\b|\bno (?:mention|section|part|word) (?:of|on|about)\b|\bnothing (?:about|on)\b|\bnever (?:mentions|covers|says)\b/i;

/** "it's for GPT", "that's only about pricing", "skip it". */
const SUMS_UP_A_LINK =
  /\b(?:it['’]?s|it is|that['’]?s|that is|this is|this one is|looks|seems)\s+(?:only\s+|just\s+|mostly\s+|really\s+)?(?:for|about|aimed at|meant for|written for|specific to)\b|\bskip (?:it|that|this)\b|\b(?:is\s*n['’o]?t|isn['’]t|is not|not)\s+(?:relevant|for us|for you|useful|worth (?:reading|it))\b/i;

/** A sentence saying a change is not live yet: not switched over, not shipped, a planned switch. */
const NOT_LIVE_YET =
  /\b(?:is\s*n['’o]?t|isn['’]t|is not|are\s*n['’o]?t|aren['’]t|are not|has\s*n['’o]?t|hasn['’]t|has not|have\s*n['’o]?t|haven['’]t|have not|was\s*n['’o]?t|wasn['’]t|not)\s+(?:been\s+)?(?:yet\s+)?(?:switched|live|shipped|rolled\s+out|enabled|turned\s+on|merged|deployed|launched|in\s+place|adopted)\b|\bnot\s+(?:yet\s+)?(?:live|on)\s+yet\b|\b(?:planned|proposed)\s+(?:change|switch|default|rollout|roll-out|feature|update|migration|move)\b/i;
/** A sentence stating how something works now. */
const SAID_AS_LIVE = /\b(?:now|every|always|by default|default|is live|went live|runs|talks|handles|uses|answers|advises|does|is on|are on|switched)\b/i;
/** A sentence that keeps a change as planned, or asks. */
const HEDGED =
  /\?|\b(?:plan(?:s|ned)?|would|will|once|after|yet|is\s*n['’o]?t|isn['’]t|is not|are\s*n['’o]?t|aren['’]t|has\s*n['’o]?t|hasn['’]t|proposed?|proposal|going to|draft|should|could|might|if|meant to|supposed to|intended|idea|spec|design(?:ed|s)?|aims?|goal|wants?)\b/i;
/** An answer naming that it changes what was said before. */
const NAMES_A_CORRECTION =
  /\b(?:I was wrong|that was wrong|I got (?:that|it|this) wrong|correction|correcting|correct (?:that|myself|what I)|I (?:said|told you) (?:earlier|before)|earlier I said|my earlier|my last (?:text|reply|answer)|scratch that|I misspoke|I was mistaken|that['’]s not right|I overstated|walk(?:ing)? (?:that|it) back|take (?:that|it) back|changed since|is now live|has since)\b/i;

/** "the memory section is still unread", "only the overview loaded", "I haven't read it". */
const SAYS_UNREAD =
  /\b(?:still unread|is unread|was unread|(?:did\s*n[o']t|didn['’]t|did not|never) (?:load|come through)|only (?:the )?[\w ]{1,30}? (?:loaded|came through)|(?:have\s*n[o']t|haven['’]t|have not|had\s*n[o']t|hadn['’]t|had not) (?:actually )?(?:read|opened|loaded|seen) (?:it|that|this|the)\b)/i;

/** How many of the latest texts count as "what I said a page holds", and as what was said about a change. */
const RECENT_TEXTS = 6;
const EARLIER_TEXTS = 20;
/** A text of theirs this long is taken for a pasted page. */
const PASTED_CHARS = 400;

function said(text) {
  return String(text ?? "").replace(/[‘’]/g, "'");
}

function plain(text) {
  return said(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The names a sentence holds, lowercased, with "Haiku-by-default" taken as "haiku". */
function namesOf(sentence, known) {
  return namesIn(sentence, known).map((name) => name.replace(/-[a-z][a-z-]*$/, "").toLowerCase());
}

/** A word's stem, so "prices" finds "price" and "memories" finds "memory". */
function stem(word) {
  if (word.length <= 4) return word;
  return word.replace(/(?:ies|es|s|ing|ed)$/, "") || word;
}

/** The subject words of a topic, and whether the texts read hold (nearly) all of them. */
function heldIn(topic, read) {
  const words = plain(topic)
    .split(" ")
    .filter((word) => word.length >= 3 && !STOP.has(word))
    .slice(0, 6);
  if (words.length === 0) return true;
  const found = words.filter((word) => read.includes(stem(word)));
  return found.length >= Math.ceil(words.length * 0.75);
}

/** What an answer says a page or note holds, as topics and quotes. */
export function claimedContents(answer) {
  const text = said(answer);
  const topics = [];
  for (const pattern of [SECTION_IS_THERE, HAS_A_SECTION_ON, THE_PAGE_COVERS]) {
    for (const match of text.matchAll(pattern)) topics.push(match[1].trim().replace(/^(?:yes|yep|yeah|so|and|the|a|an|its)\s+/i, ""));
  }
  const quotes = [];
  for (const sentence of sentencesOf(text)) {
    if (!QUOTES_A_SOURCE.test(sentence)) continue;
    for (const match of sentence.matchAll(QUOTED)) if (plain(match[1]).split(" ").length >= 3) quotes.push(match[1].trim());
  }
  return { topics: [...new Set(topics)].filter(Boolean), quotes: [...new Set(quotes)] };
}

/** The topics and quotes an answer gives a page or note that nothing read holds. */
export function unreadContents(answer, sources = [], { theirs = [] } = {}) {
  const read = plain(sources.join("\n"));
  // Their asking "does it have a memory section?" names the subject without holding it; a pasted page holds it.
  const pasted = plain(theirs.filter((text) => String(text).length >= PASTED_CHARS).join("\n"));
  const quoted = plain(theirs.join("\n"));
  const { topics, quotes } = claimedContents(answer);
  return {
    topics: topics.filter((topic) => !heldIn(topic, `${read} ${pasted}`)),
    quotes: quotes.filter((quote) => !read.includes(plain(quote)) && !quoted.includes(plain(quote))),
  };
}

/**
 * A change the sources say is not live yet that the answer states as live:
 * `{ answer, source }` sentences, or null.
 */
export function plannedSaidAsLive(answer, sources = []) {
  if (NAMES_A_CORRECTION.test(said(answer))) return null;
  const known = said([answer, ...sources].join("\n"));
  const pending = [];
  for (const text of sources) {
    for (const sentence of sentencesOf(text)) {
      if (!NOT_LIVE_YET.test(sentence)) continue;
      const names = namesOf(sentence, known);
      if (names.length > 0 && names.length <= 8) pending.push({ sentence, names });
    }
  }
  if (pending.length === 0) return null;
  for (const sentence of sentencesOf(answer)) {
    if (!SAID_AS_LIVE.test(sentence) || HEDGED.test(sentence) || NOT_LIVE_YET.test(sentence)) continue;
    const names = new Set(namesOf(sentence, known));
    for (const source of pending) {
      const shared = source.names.filter((name) => names.has(name));
      if (shared.length > 0 && shared.length >= Math.min(2, source.names.length)) return { answer: sentence, source: source.sentence };
    }
  }
  return null;
}

/** An answer saying a page is unread after one of Tex's last texts said what it holds, naming no correction. */
export function unnamedRetraction(answer, history = []) {
  const text = said(answer);
  if (!SAYS_UNREAD.test(text) || NAMES_A_CORRECTION.test(text)) return false;
  return (Array.isArray(history) ? history : [])
    .slice(-RECENT_TEXTS)
    .some((turn) => turn?.role === "assistant" && (() => {
      const { topics, quotes } = claimedContents(turn.text);
      return topics.length > 0 || quotes.length > 0;
    })());
}

function clip(text, length = 140) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The one notice for everything this answer was found to claim unread. */
export function readClaimsNotice({ topics = [], quotes = [], cut = false, partly = false, link = false, planned = null, retracted = false }) {
  const parts = [];
  if (topics.length > 0 || quotes.length > 0) {
    const named = [...topics.map((topic) => `"${clip(topic, 60)}"`), ...quotes.map((quote) => `the quote "${clip(quote, 80)}"`)].slice(0, 5);
    parts.push(
      `your answer says a page or note holds ${named.join(", ")}, but nothing you read in this turn has those words` +
        (cut ? " (a page you opened came back cut, so the rest of it is unread)" : "") +
        ". Open it, or open_page it again with from: the section's heading, and check before saying it is there; if it isn't in what you read, say you haven't read that part",
    );
  }
  if (partly) {
    parts.push(
      "a page you opened came back cut (\"[cut\"), so you read only its first part. Say so up front, then read the rest (open_page it again with from: the heading you need) before reviewing it or saying what it lacks",
    );
  }
  if (link) {
    parts.push("your answer sums up the link in their text, but you haven't opened it in this turn. Open it and read it first, then say what it is");
  }
  if (planned !== null) {
    parts.push(
      `your answer says "${clip(planned.answer)}" as if it is live, but what you read or said earlier says it isn't yet: "${clip(planned.source)}". Keep it as planned the way the source says. If something you read now shows it went live, say plainly that this corrects the earlier text, and what showed it`,
    );
  }
  if (retracted) {
    parts.push(
      "your answer now says a page is unread or didn't load, after one of your last texts said what it holds. If what you read did show it, stand by that. If not, say plainly that your earlier text was wrong, then read it",
    );
  }
  return `Before this goes: ${parts.join("; and ")}.`;
}

/**
 * The check `sourcedFigures.js`'s `figureCheck` runs beside its own: `read`
 * every tool result (`web` for a page or a search; `wrote`, the words a write
 * carried, which Tex may describe), and `check` an answer, once a turn.
 */
export function readClaimCheck({ question = "", history = [], pictures = false } = {}) {
  const read = [];
  let cut = false;
  let readOn = false;
  let readTheWeb = false;
  let noticed = false;
  const turns = (Array.isArray(history) ? history : []).filter((turn) => typeof turn?.text === "string");
  return {
    read(result, { web = false, wrote = "" } = {}) {
      if (wrote !== "") read.push(wrote);
      if (result?.isError === true) return;
      const text = resultText(result);
      if (text === "") return;
      read.push(text);
      if (!web) return;
      readTheWeb = true;
      if (CUT.test(text)) cut = true;
      if (READ_FROM.test(text)) readOn = true;
    },
    check(answer) {
      if (noticed) return null;
      const theirs = [String(question ?? ""), ...turns.filter((turn) => turn.role === "user").map((turn) => turn.text)];
      const found = { topics: [], quotes: [], cut: false, partly: false, link: false, planned: null, retracted: false };
      if (!pictures) {
        Object.assign(found, unreadContents(answer, read, { theirs }));
        found.cut = cut && !readOn;
        found.partly = found.topics.length === 0 && found.quotes.length === 0 && cut && !readOn && !SAYS_PARTLY.test(said(answer)) && (ASKS_ABOUT_A_PAGE.test(String(question ?? "")) || SAYS_IT_LACKS.test(said(answer)));
        found.link = !readTheWeb && /https?:\/\//i.test(String(question ?? "")) && SUMS_UP_A_LINK.test(said(answer));
      }
      found.planned = plannedSaidAsLive(answer, [...read, String(question ?? ""), ...turns.slice(-EARLIER_TEXTS).map((turn) => turn.text)]);
      found.retracted = unnamedRetraction(answer, turns);
      if (found.topics.length === 0 && found.quotes.length === 0 && !found.partly && !found.link && found.planned === null && !found.retracted) return null;
      noticed = true;
      return readClaimsNotice(found);
    },
  };
}
