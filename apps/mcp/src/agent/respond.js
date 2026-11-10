/**
 * REPLY, REACT OR STAY QUIET, AND WHERE THE REPLY GOES (Dev2, 2026-11-10: "i'm
 * thinking that the thread classifier could probably do this for us, have an
 * output based on examples that's a 'no response'"; picked "classifier
 * decides, before the model").
 *
 * Tex Devs, Nov 5 to 9: Tex texted on 59 turns and about 16 should have been
 * silence (people talking to each other, "oops uploaded wrong order" answered
 * "No problem.", a 😭 tapback answered with a text); a 1:1 "thanks ill look at
 * it at work today" got "Anytime." The model rarely chose `say_nothing`, and
 * the reviewer reads what a reply says, never whether one is needed.
 *
 * The conversation classifier (`conversationThreads.js`) already reads the
 * open threads, the chat's last lines and the new text before the model runs,
 * so it also answers:
 *  - `respond`: `reply` (the model runs, as before), `react` (a tapback only)
 *    or `quiet` (nothing). Either of the last two ends the turn before the
 *    model, so a silence costs one small call, not a whole turn;
 *  - `emoji`: the tapback, for `react`;
 *  - `place`: `under` (the reply goes as a reply under the text it answers)
 *    or `plain` (straight into the chat);
 *  - `why`: a few words, kept in the history.
 *
 * It learns from `RESPOND_EXAMPLES`: real cases, names changed, the same
 * shape as the bench (`bench/respond/`), which holds it to a bar.
 *
 * Code keeps the floor, never the model (`mayHush`): a turn whose text could
 * be an answer to Tex's own question, a question to Tex or typed under one of
 * its texts, a text naming Tex in a group, a tapback that reached a turn, or a file sent in a 1:1 is never
 * hushed. A classifier that failed or was late hushes nothing.
 */

import { SAID_NOTHING, SAY_NOTHING_TOOL } from "./sayNothing.js";

export const RESPONSES = ["reply", "react", "quiet"];
export const PLACES = ["under", "plain"];
const WHY_CHARS = 160;

/**
 * Labelled examples the classifier is shown (names invented; each is one the
 * team saw go wrong, or its mirror that must still be answered). `chat` is
 * "group" or "one" (a 1:1); `before` the lines just before the new text, as
 * the classifier reads lines: "You" is Tex, a person is "@name".
 */
export const RESPOND_EXAMPLES = [
  { chat: "group", before: ["@ben: shared the release notes", "You: Summary is up in the notes."], text: "@ben: Maya, do you have your mail set up? had some questions", respond: "quiet", why: "asks Maya, not Tex" },
  { chat: "group", before: ["@maya: [a picture]", "@maya: [a picture]"], text: "@maya: oops uploaded wrong order", respond: "quiet", why: "a remark to the chat" },
  { chat: "group", before: ["@ben: Priya have i been spelling your name wrong?"], text: "@priya: no Pree is my nickname", respond: "quiet", why: "people talking to each other" },
  { chat: "group", before: ["You: (a long answer)"], text: "@priya: dang this a lot of reading", respond: "react", emoji: "😅", why: "a reaction to Tex, needs no text" },
  { chat: "group", before: ["@dev: https://apps.example.com/our-app"], text: "@dev: 👀🥹", respond: "react", emoji: "🎉", why: "news shared with the chat" },
  { chat: "group", before: ["@ben: is the bug fixed?"], text: "@dev: just changed it so Tex only answers when mentioned", respond: "quiet", why: "news between the team" },
  { chat: "group", before: ["@ben: Priya how do you debug it usually?"], text: "@priya: 1:1 tex?", respond: "quiet", why: "asks Ben, not Tex" },
  { chat: "group", before: [], text: "@ben: Tex which provider did we pick?", respond: "reply", place: "plain", why: "a question to Tex" },
  { chat: "group", before: ["@dev: can you redo the comparison as a page", "@ben: lol", "@maya: ok"], text: "@dev: Tex", respond: "reply", place: "under", why: "tags Tex on an ask a few lines up" },
  { chat: "group", before: ["You: Want me to file it as a bug? 👍 or 👎"], text: "@priya: yes", respond: "reply", place: "plain", why: "answers Tex's question" },
  { chat: "group", before: [], text: "@ben: Tex you talk too much", respond: "reply", place: "plain", why: "said to Tex" },
  { chat: "one", before: ["You: Reminder: today's the deadline to pick your benefits."], text: "@sam: thanks ill look at it at work today", respond: "react", emoji: "👍", why: "thanks, asks nothing" },
  { chat: "one", before: ["You: Done, it's on your calendar for 3."], text: "@sam: ok cool", respond: "react", emoji: "👍", why: "an acknowledgement" },
  { chat: "one", before: ["You: Their price went up again, ha."], text: "@sam: lol", respond: "quiet", why: "a laugh, nothing asked" },
  { chat: "one", before: ["You: Done, it's on your calendar for 3."], text: "@sam: thanks! can you move it to 4 though", respond: "reply", place: "plain", why: "a new ask" },
  { chat: "one", before: [], text: "@sam: how long does frozen ground beef last", respond: "reply", place: "plain", why: "a question" },
  { chat: "one", before: ["You: Want me to put Dec 5 on your calendar? 👍 or 👎"], text: "@sam: yeah i did, put it on the cal", respond: "reply", place: "plain", why: "answers Tex's question" },
  { chat: "one", before: ["@sam: can you find me a florist", "You: Three near you: ...", "@sam: also what time is the game"], text: "@sam: (replying to \"Three near you\") which one is cheapest", respond: "reply", place: "under", why: "picks up an earlier subject" },
];

/** The examples as the classifier reads them. */
export function examplesText(examples = RESPOND_EXAMPLES) {
  return examples
    .map((item) => {
      const said = [`[${item.chat === "group" ? "group chat" : "1:1"}]`, ...item.before.map((line) => `  ${line}`), `  NEW TEXT ${item.text}`].join("\n");
      const answer = { respond: item.respond, ...(item.emoji ? { emoji: item.emoji } : {}), ...(item.place ? { place: item.place } : {}), why: item.why };
      return `${said}\n  -> ${JSON.stringify(answer)}`;
    })
    .join("\n");
}

/** The classifier's rules for the respond part, appended to its system prompt. */
export const RESPOND_RULES = `5. respond: what Tex does about the NEW TEXT. "reply": Tex texts back. "react": a tapback only, no text (give emoji). "quiet": nothing at all.
In a 1:1 chat every text is to Tex: reply, unless it is only thanks, an ok or a laugh that asks nothing and changes nothing, which gets react (a thanks or an ok: 👍) or quiet.
In a group chat, reply only when the text is for Tex: it names Tex, replies to Tex, answers a question Tex asked, or carries on an ask Tex is working on. People talking to each other, a question to a named person, news, jokes and remarks between them are quiet; news, a win or thanks shared with the chat may get react.
Never quiet or react on a question or request to Tex, an answer to Tex's question, a correction of Tex, or something Tex must act on. When unsure, reply.
6. place, only with reply: "under" when Tex's reply could be read as answering a different text (other texts came after it, several conversations are interleaving, or it picks up an older subject), else "plain".
7. why: a few words on why.

Examples (names invented):
${examplesText()}`;

/** The respond part of a classifier answer, checked; `{respond: "reply"}` for anything missing or off the set. */
export function readRespond(found) {
  const respond = RESPONSES.includes(found?.respond) ? found.respond : "reply";
  const emoji = respond === "react" && typeof found?.emoji === "string" && found.emoji.trim() !== "" && found.emoji.trim().length <= 8 ? found.emoji.trim() : null;
  // A react without an emoji is a react all the same: the Worker picks one from the words (`reactEmoji.ts`).
  const place = respond === "reply" && PLACES.includes(found?.place) ? found.place : null;
  const why = typeof found?.why === "string" ? found.why.replace(/\s+/g, " ").trim().slice(0, WHY_CHARS) : "";
  return { respond, ...(emoji ? { emoji } : {}), ...(place ? { place } : {}), ...(why ? { why } : {}) };
}

const NAMES_TEX = /\btex\b/i;
const ASKS = /\?/;

/**
 * Whether code lets the classifier's quiet or react stand. Never on: a tapback
 * that reached a turn (it answers an ask, or is a ❓); a file in a 1:1; a
 * question in a 1:1; a group text naming Tex; a question typed under one of
 * Tex's texts; a text that comes straight after
 * a question of Tex's (it may be the answer: a bare "ok" to "want me to? 👍 or
 * 👎" is a yes). `lastTex` is Tex's last text before this one, `between` the
 * number of other people's texts since it.
 */
export function mayHush({ verdict, text, group = false, tapback = false, files = 0, lastTex = null, between = 0, repliesToTex = false }) {
  if (verdict?.respond !== "quiet" && verdict?.respond !== "react") return false;
  const words = String(text ?? "");
  if (tapback || words.trim() === "") return false;
  if (!group && (files > 0 || ASKS.test(words))) return false;
  if (group && NAMES_TEX.test(words)) return false;
  if (repliesToTex && ASKS.test(words)) return false;
  if (typeof lastTex === "string" && ASKS.test(lastTex) && between === 0) return false;
  return true;
}

/** Tex's last text in the shown events before the new ones, and how many people's texts came after it. */
export function lastTexBefore(events, covered = []) {
  const skip = new Set(covered);
  const before = (Array.isArray(events) ? events : []).filter((event) => !skip.has(event.id));
  let between = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const event = before[index];
    if (event?.from?.kind === "tex") return { lastTex: String(event.text ?? ""), between };
    if (event?.from?.kind === "person") between += 1;
  }
  return { lastTex: null, between };
}

/**
 * The turn a hushed text ends with, in `runTurn`'s shape: the say_nothing settlement every reader already knows
 * (`sayNothing.js`), so `sendTheReply` sends nothing; `react` rides on it for the Worker to send.
 */
export function hushedTurn(verdict, model) {
  return {
    answer: SAID_NOTHING,
    settled: SAY_NOTHING_TOOL,
    provider: "classifier",
    model,
    steps: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, decision: 0 },
    usageByModel: {},
    timing: null,
    hushed: { respond: verdict.respond, ...(verdict.emoji ? { emoji: verdict.emoji } : {}), why: verdict.why ?? "" },
  };
}

/** The history's record of a hushed text: a say_nothing call, its reason the classifier's. */
export function hushedToolEvent(verdict) {
  const said = verdict.respond === "react" ? `a ${verdict.emoji ?? "tapback"} instead of a text` : "nothing";
  return { kind: "tool", name: SAY_NOTHING_TOOL, args: { why: `conversation classifier: ${verdict.why || verdict.respond}`, by: "classifier" }, ok: true, ms: 0, result: `Answered with ${said}, before the model ran.` };
}
