/**
 * A FIGURE IS QUOTED ONLY FROM WHAT THE TURN READ (self-review, the Tex Devs
 * group, 2026-10-29 and 2026-10-30).
 *
 * Asked whether switching to OpenAI would be cheaper, Tex opened OpenAI's
 * pricing page and texted "Claude Haiku 5.5 and GPT-6 Luna both cost $0.10 in
 * and $0.50 out per million tokens": the figures were on the page, but only
 * for OpenAI's own models, and no page it read named Haiku at all. A day
 * earlier it gave two models' benchmark scores with nothing read behind them.
 * In the same chat it texted "Flovia publishes no prices" about a page it had
 * opened, and two texts later quoted that page's "free for an initial period
 * after launch".
 *
 * Both are things the gateway can see for itself once a turn has used the
 * web (`claimCheck.js` passes every tool result here):
 *
 *   1. A sentence quotes a price, a percentage or a score, and that figure is
 *      in nothing the turn read, their words or an earlier text; or a name in
 *      the same sentence (Haiku, Sonnet) is in none of the things that hold
 *      the figure. A total worked out in the sentence ("30 × $10 = $300")
 *      stands on the figures it is worked from.
 *   2. The answer says a page publishes, lists or shows no prices, and a page
 *      the turn read does speak of price (a "$", "free", "pricing").
 *
 * Either sends one more round, once a turn, saying which figures or which
 * claim. Pictures they sent are read by the model, not by a tool, so a turn
 * carrying them is not checked. Docs: docs/decisions/texting-assistant/history.md.
 */

import { readClaimCheck } from "./readClaims.js";

/** A price ($0.10, €2, £1,200, $1.5k), a percentage (12%), or a score ("scored 39", "a score of 30"). */
const FIGURE =
  /[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion)\b)?|\b\d+(?:\.\d+)?\s?%|\bscor(?:e|es|ed|ing)\s+(?:of\s+|was\s+|is\s+)?\d+(?:\.\d+)?\b/gi;

/** A sentence that works its total out in front of them. */
const WORKED_OUT = /[=×]|\b\d+\s?x\s?[$€£]|\btimes\b|\bcomes? (?:out )?to\b|\bworks? out\b|\badds? up\b|\bin all\b|\baltogether\b|\bin total\b/i;

/** Capitalized words that open a sentence or say no product's name. */
const NOT_NAMES = new Set(
  (
    "i a an the it its it's that this these those there they their them we our us you your he she his her both each every all any some no not yes so but and or if " +
    "then also only just about around roughly per at on in to for with by from of as is are was were be being been do does did has have had can could would should will " +
    "after before since until while when where which who what why how than more less most least one two three four five six seven eight nine ten " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
    "usd eur gbp ok okay note notes page pages tex"
  ).split(/\s+/),
);

function said(text) {
  return String(text ?? "").replace(/[‘’]/g, "'");
}

/** A figure as a number: "$1,200" and "$1.2k" are 1200, "12 %" is 12, "scored 39" is 39. */
function valueOf(figure) {
  const digits = figure.match(/\d[\d,]*(?:\.\d+)?/);
  if (digits === null) return null;
  const base = Number(digits[0].replace(/,/g, ""));
  const scale = /\d\s?k\b/i.test(figure) ? 1e3 : /\d\s?(?:m|million)\b/i.test(figure) ? 1e6 : /\d\s?(?:bn|billion)\b/i.test(figure) ? 1e9 : 1;
  return Number.isFinite(base) ? Math.round(base * scale * 1e6) / 1e6 : null;
}

/** Every number written in a text, as values: a page's "$2.00 / 1M" holds 2. */
function numbersIn(text) {
  const values = new Set();
  for (const match of said(text).matchAll(/\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion)\b)?/gi)) {
    const value = valueOf(match[0]);
    if (value !== null) values.add(value);
  }
  return values;
}

/**
 * The names a sentence gives its figures to: capitalized words past its
 * first, and model-like words (GPT-6, o4). Its first word is a name only when
 * it has a digit or is written capitalized mid-sentence somewhere (`known`):
 * "Claude" is, "Switching" is not.
 */
export function namesIn(sentence, known) {
  const words = sentence.match(/[A-Za-z][\w.-]*\d[\w.-]*|[A-Z][A-Za-z][\w-]*/g) ?? [];
  const first = sentence.match(/^[^A-Za-z]*([A-Za-z][\w.-]*)/)?.[1];
  const named = (word) => /\d/.test(word) || new RegExp(String.raw`[a-z0-9,;:(] ${escaped(word)}(?![A-Za-z0-9])`).test(known);
  return [
    ...new Set(
      words
        .filter((word, index) => index > 0 || word !== first || named(word))
        .map((word) => word.replace(/'s$/i, "").replace(/[.-]+$/, ""))
        .filter((word) => word.length > 1 && !NOT_NAMES.has(word.toLowerCase()) && !/^\d/.test(word)),
    ),
  ];
}

function escaped(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sentencesOf(answer) {
  return said(answer)
    .replace(/https?:\/\/\S+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"(])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The figures in an answer that nothing read backs: `{ figure, name? }` for
 * each, `name` when the figure is there but not beside that name.
 */
export function unsourcedFigures(answer, sources = []) {
  const read = sources.map((text) => ({ lower: said(text).toLowerCase(), numbers: numbersIn(text) }));
  const known = said([answer, ...sources].join("\n"));
  const missing = [];
  for (const sentence of sentencesOf(answer)) {
    const figures = [...sentence.matchAll(FIGURE)].map((match) => match[0].trim());
    if (figures.length === 0) continue;
    const worked = WORKED_OUT.test(sentence);
    const holding = new Set();
    for (const figure of figures) {
      const value = valueOf(figure);
      const found = read.filter((source) => source.numbers.has(value));
      if (found.length === 0 && !worked) missing.push({ figure });
      for (const source of found) holding.add(source);
    }
    if (holding.size === 0) continue;
    for (const name of namesIn(sentence, known)) {
      const pattern = new RegExp(String.raw`(?:^|[^a-z0-9])${escaped(name.toLowerCase())}(?![a-z0-9])`);
      if (![...holding].some((source) => pattern.test(source.lower))) missing.push({ figure: figures.join(", "), name });
    }
  }
  return missing;
}

/** "Flovia publishes no prices", "they don't list pricing", "the site shows no prices". */
const SAYS_NO_PRICES =
  /\b(?:publish|list|post|show|give|share)(?:es|s)? no (?:\w+\s+)?(?:prices?|pricing|rates?|costs?)\b|\b(?:doesn't|does not|don't|do not|didn't|did not)\s+(?:publish|list|post|show|give|share|mention|say)\s+(?:any\s+|a\s+)?(?:\w+\s+)?(?:prices?|pricing|rates?|costs?)\b|\bno (?:public |published )?(?:prices?|pricing) (?:on (?:the|its|their) (?:site|page|website))\b/i;

/** A page that speaks of price: a currency figure, "free", "pricing", a rate. */
const SPEAKS_OF_PRICE = /[$€£]\s?\d|\bfree\b|\bpric(?:e|es|ing)\b|\b(?:per|a) (?:month|year|seat|user|token|request)\b/i;

/** Whether the answer says a page has no prices when a page this turn read speaks of price. */
export function deniesWhatAPageSays(answer, pages = []) {
  return SAYS_NO_PRICES.test(said(answer)) && pages.some((text) => SPEAKS_OF_PRICE.test(String(text ?? "")));
}

export function figuresNotice(missing) {
  const bare = missing.filter((item) => !item.name).map((item) => item.figure);
  const misplaced = missing.filter((item) => item.name).map((item) => `${item.name} (${item.figure})`);
  return (
    "Before this goes: your answer quotes figures that nothing you read in this turn backs" +
    (bare.length > 0 ? `: ${[...new Set(bare)].slice(0, 6).join(", ")} appear in no page, note or email you read, nor in their texts` : "") +
    (misplaced.length > 0 ? `${bare.length > 0 ? "; and" : ":"} ${[...new Set(misplaced)].slice(0, 6).join(", ")} sit beside a name that no source holding those figures mentions (one company's page doesn't give another's prices)` : "") +
    ". Open the page that gives each one for that very thing (its own pricing page, its own benchmark page), and quote what it says, with its link. " +
    "A figure you can't find a source for comes out, said plainly as not found. A total you work out, show the sum. " +
    "Start with the one-line answer to what they asked, then the figures."
  );
}

export const SAYS_SOMETHING_NOTICE =
  "Before this goes: your answer says a page publishes or lists no prices, but a page you read in this turn does speak of price (a figure, \"free\", a plan or a rate). " +
  "Say what that page does say, quoting its own words and its link (\"free for a launch period, no end date, then below standard rates\"), and never that it says nothing. " +
  "Start with the one-line answer to what they asked.";

/** The texts a tool result carries, joined, capped so a huge page stays cheap to scan. */
export function resultText(result) {
  const parts = Array.isArray(result?.content) ? result.content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")) : [];
  return parts.join("\n").slice(0, 400_000);
}

/** The words a write carried (a note's content, an edit's text), which the answer may describe. */
function wroteText(args) {
  if (args === null || typeof args !== "object") return "";
  const inner = args.args && typeof args.args === "object" ? args.args : {};
  return [args.content, args.text, args.body, args.new_text, inner.content, inner.text, inner.body]
    .filter((part) => typeof part === "string")
    .join("\n")
    .slice(0, 200_000);
}

/**
 * The check `claimCheck.js` runs: `read` every tool result (`web: true` for a
 * page or a search, `args` the call's own), and `check` an answer. Figures are
 * checked once a turn that used the web; what a page or note is said to hold,
 * once a turn, whatever it read (`readClaims.js`).
 */
export function figureCheck({ question = "", history = [], pictures = false } = {}) {
  const read = [];
  const pages = [];
  const claims = readClaimCheck({ question, history, pictures });
  let usedWeb = false;
  let noticed = false;
  return {
    read(result, { web = false, args = null } = {}) {
      claims.read(result, { web, wrote: wroteText(args) });
      if (web) usedWeb = true;
      if (result?.isError === true) return;
      const text = resultText(result);
      if (text === "") return;
      read.push(text);
      if (web) pages.push(text);
    },
    check(answer) {
      const unread = claims.check(answer);
      if (unread !== null) return unread;
      if (noticed || pictures || !usedWeb) return null;
      if (deniesWhatAPageSays(answer, pages)) {
        noticed = true;
        return SAYS_SOMETHING_NOTICE;
      }
      const earlier = (Array.isArray(history) ? history : []).map((turn) => String(turn?.text ?? ""));
      const missing = unsourcedFigures(answer, [...read, String(question ?? ""), ...earlier]);
      if (missing.length === 0) return null;
      noticed = true;
      return figuresNotice(missing);
    },
  };
}
