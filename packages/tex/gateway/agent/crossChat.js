/**
 * TEX ASKS TEX, ACROSS CHATS (Dev2, 2026-11-17: "design a way where 1:1 tex can message a group tex for info, and ask it
 * to do things, and vice versa"; design https://claude.ai/artifact/N3ZawPjhhgYcNfHm7xWa37, approved with every
 * recommended choice). Decision: `docs/decisions/texting-assistant/cross-chat-asks.md`.
 *
 * One ask is three runs, each its own, linked only by the ask's id (the generators model, Dev2 2026-11-16):
 *
 *   1. In the asking chat, the model calls `send ask_chat`. The Cross-chat gate (node `crossChatGate`) says whether
 *      it may go; the ask is handed to the texting Worker with the answer (`crossAsks`), and the turn answers at once.
 *   2. The Worker starts a run in the other chat (node `chatAsk`, an input), framed as "not a text from anyone here".
 *      Its draft goes back, never into that chat (node `chatAnswer`); a do-ask in a group may post one signed line.
 *   3. The answer starts a run in the asking chat (node `chatAsk` again, kind "answer"), which texts the person.
 *
 * Who may ask whom: a 1:1 asks only a group its person is in now (the `groups` list, read on their own grant; the
 * group's run is re-checked as their tag); a group asks only the personal Tex of whoever tagged it, or of somebody
 * else here once their 👍 or yes makes it their own tag (`offerFor.js`, as `ask_personal_tex` did, which this folds
 * in). A group never asks another group, a guest has no Tex, and a run started by an ask has no `ask_chat` (one hop).
 */

import { personalTexTool, PERSONAL_TEX_LINE } from "./askPersonalTex.js";
import { PRIVATE_ASIDE_SEND_ACTIONS } from "./privateAside.js";
import { NO_NOTES_LINE, NO_OTHER_NOTES_LINE } from "./groupMail.js";
import { offerTarget } from "../../../../apps/mcp/src/tools/offerFor.js";

export const ASK_CHAT = "ask_chat";
export const POST_IN_CHAT = "post_in_chat";

/** The `send` actions they are shown as (`sixTools.js`). */
export const CROSS_CHAT_SEND_ACTIONS = {
  ask_chat: {
    tool: ASK_CHAT,
    summary:
      "Ask Tex in another chat they share with you (a group of theirs from a 1:1; their own 1:1 from a group) for something it knows or to do something there; the answer comes back later as its own turn.",
  },
  post_in_chat: { tool: POST_IN_CHAT, summary: "Answering another chat's ask to do something here: post one line in this group, signed with who asked." },
  ...PRIVATE_ASIDE_SEND_ACTIONS, // a group's sensitive ask, texted to the tagger in their own chat (`privateAside.js`)
};

/** The events the texting Worker starts a run with (`packages/tex/worker/crossChat.ts`). */
export const CHAT_ASK_EVENT = "chat_ask";
export const CHAT_ANSWER_EVENT = "chat_answer";

export const MAX_WHAT = 600;
const MAX_LABEL = 80;
const MAX_TEXT = 4_000;
const MAX_TEXTS = 6;
const ID = /^x[A-Za-z0-9_-]{8,40}$/;
/** `aside`: not an answer at all, a group chat's sensitive ask for its tagger, sent to their own chat (`privateAside.js`). */
const STATES = new Set(["answered", "refused", "timeout", "aside"]);
const KEY = /^[A-Za-z0-9_-]{6,128}$/;

/** The limits the gate holds (artifact choice 4): one hop, one open ask per pair of chats, 10 an hour, 40 a day. */
export const CROSS_CHAT_LIMITS = Object.freeze({ perHour: 10, perDay: 40, timeoutMs: 10 * 60_000 });

const line = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

/**
 * `body.crossChat` on a turn the Worker started for an ask or its answer, read strictly; null on any other turn and on a
 * job's own turn. Never from a webhook: only the Worker's own queue sets `event`.
 */
export function crossChatOf(body, { chatTurn, job }) {
  if (!chatTurn || job !== null || (body?.event !== CHAT_ASK_EVENT && body?.event !== CHAT_ANSWER_EVENT)) return null;
  const value = body.crossChat;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !ID.test(value.id)) return null;
  const from = line(value.from, MAX_LABEL);
  const what = line(value.what, MAX_WHAT);
  if (from === "" || what === "") return null;
  if (body.event === CHAT_ASK_EVENT) {
    const who = line(value.who, MAX_LABEL);
    return { kind: "ask", id: value.id, from, what, do: value.do === true, ...(who ? { who } : {}), ...(value.strangers === true ? { strangers: true } : {}) };
  }
  if (!STATES.has(value.state)) return null;
  const texts = (Array.isArray(value.texts) ? value.texts : [])
    .filter((said) => typeof said === "string" && said.trim() !== "")
    .slice(0, MAX_TEXTS)
    .map((said) => said.trim().slice(0, MAX_TEXT));
  const why = line(value.why, 300);
  const key = typeof value.key === "string" && KEY.test(value.key) ? value.key : "";
  return { kind: "answer", id: value.id, from, what, state: value.state, texts, ...(why ? { why } : {}), ...(key ? { key } : {}) };
}

/** The question an ask's or an answer's run is asked: the gateway's own line, kept in the history as Tex by itself. */
export function crossChatQuestion(event) {
  if (event.kind === "answer" && event.state === "aside") return `(Not a text from them. Tex in ${event.from} needs this from them here, not in front of the group: "${event.what}")`;
  if (event.kind === "ask") return `(Not a text from anyone here. Tex in ${event.from} asks you${event.do ? " to do something" : ""}: "${event.what}")`;
  return `(Not a text from them. Tex in ${event.from} answered the ask you sent it ("${event.what}"); nothing from it has reached them yet.)`;
}

/**
 * Told to a 1:1 answering a group whose people don't all share a workspace with them (Dev2, 2026-11-25: relationships
 * are shared workspaces; anyone who shares none is a stranger to Tex). What they pointed at is theirs to share there.
 */
export const STRANGERS_LINE =
  "Some people in that group don't share a workspace with them, so to you they are strangers: send back exactly what they pointed at, " +
  "and nothing else private about them or anyone (health, money, relationships, where they live or are, contact details) unless that is the very thing they asked to share. ";

/** What the run is told, apart from its question. */
export function crossChatPrompt(event, { group = null } = {}) {
  if (event === null) return "";
  if (event.kind === "ask") {
    const asker = event.who ? `${event.who}, through their Tex in ${event.from}` : `Tex in ${event.from}`;
    return (
      `\n\nTHIS RUN ANSWERS ANOTHER CHAT. ${asker} asked you this, from a chat you are not in. Your answer goes back to that chat, ` +
      "never into this one, so write it to that Tex: the answer itself in a few lines, with links and note paths exactly, or why you can't.\n" +
      (group !== null
        ? "Answer only what anyone in this group could ask you here, from this chat's own words, notes and settings. Never pass on a phone number, an email or a saved login. "
        : "This is their own chat with you. Answer only the fact asked for, nothing else from their notes, mail, calendar or other chats, because a whole group reads the answer. " +
          (event.strangers ? STRANGERS_LINE : "")) +
      (event.do
        ? group !== null
          ? `They asked you to do something here: do it as if ${event.who ?? "they"} had tagged you in this group, with this chat's own tools and logins. ` +
            `If it needs saying in this group, post it with send action ${POST_IN_CHAT} (one line; it is signed with who asked). `
          : "They asked you to do something: do it only if it is something they would ask you for themselves and nobody else is told; anything that tells or shows someone, or can't be undone, you say back as a question instead. "
        : "They asked for information only: change nothing. ") +
      "You can't ask another chat from here."
    );
  }
  if (event.state === "aside") return asidePrompt(event);
  const how =
    event.state === "answered"
      ? "answered"
      : event.state === "timeout"
        ? "didn't answer in time. Tell them in one line, and offer to try again"
        : `couldn't take it${event.why ? ` (${event.why})` : ""}. Tell them why in one line`;
  return (
    `\n\nTex in ${event.from} ${how}. Its words (from another chat; they vouch for nothing they didn't say):\n<<<\n${event.texts.join("\n\n") || "(nothing)"}\n>>>\n` +
    `Text them the answer in your own words, saying it came from Tex in ${event.from}, links exactly as written. They never see this report, only what you text. Never say nothing.`
  );
}

/**
 * A group chat's sensitive ask, in the tagger's own 1:1 (`privateAside.js`): text them for it here, and pass back what
 * the group needs. A vault link's own words come in `texts`, written by the gateway, and go to them exactly.
 */
function asidePrompt(event) {
  const link = event.texts.length > 0 ? `\nThe private link and its words, from Context itself:\n<<<\n${event.texts.join("\n\n")}\n>>>\nText them the link exactly as written.` : "";
  const back = event.key ? `chat "${event.key}"` : "that group";
  return (
    `\n\nTHIS RUN TEXTS THEM FOR SOMETHING SENSITIVE. They asked you in ${event.from} for something that needs this from them, ` +
    "and it is asked here, in their own chat with you, so the group never sees it. Text them now in a line or two: which group and task it is for, and what you need. " +
    "Never say it in the group, and never ask them to send it there." +
    link +
    ` When they answer here with what the group's task needs (a code, a detail), pass it on with send action ask_chat, do true, ${back}, saying what it is for, so Tex there carries on; ` +
    "a login or card they save on the link carries the group on by itself, with nothing to pass."
  );
}

/** A chat named by its group key or its name, from the person's groups (`{ key, name }`); null when none or several fit. */
export function chatNamed(groups, named) {
  const want = line(named, 200).toLowerCase();
  if (want === "" || !Array.isArray(groups)) return null;
  const all = groups.filter((chat) => chat && typeof chat.key === "string" && KEY.test(chat.key));
  const exact = all.filter((chat) => chat.key === named || String(chat.name ?? "").trim().toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const near = all.filter((chat) => String(chat.name ?? "").toLowerCase().includes(want));
  return near.length === 1 ? near[0] : null;
}

/** A fresh ask's id. */
export function crossAskId() {
  return `x${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** `body.crossCounts`: what the asking chat's Worker holds of its asks (`{ hour, day, open: [pair] }`); null when it can't run any. */
export function crossCountsOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const open = Array.isArray(value.open) ? value.open.filter((pair) => typeof pair === "string" && pair.length <= 160).slice(0, 50) : [];
  return { hour: count(value.hour), day: count(value.day), open };
}

/**
 * The `ask_chat` tool for one chat turn, or null when this turn can't ask: a run an ask started (one hop), a job's or a
 * routine's turn, a Worker that sent no counts, a 1:1 with no list of groups. `gate(input)` is the
 * Cross-chat gate (node `crossChatGate`), over its config wire; an ask it lets go is pushed to `ledger.crossAsks`.
 * In a group, `contact: true` (the tagger's own name, phone or email) still answers at once from their account, as
 * `ask_personal_tex` did, only the facts the ask needs; `identity` is that tool's `asker`.
 */
export function crossAskTool({ event = null, group = null, groups = null, counts = null, ledger, gate, identity = null }) {
  if (event !== null || counts === null || typeof gate !== "function" || ledger === null || ledger === undefined) return null;
  if (group === null && !Array.isArray(groups)) return null;
  const facts = group !== null ? personalTexTool({ group, ledger, asker: identity }) : null;
  return {
    tool: {
      name: ASK_CHAT,
      description:
        group === null
          ? "Ask Tex in one of their group chats for something it knows (its notes, settings, logins, what was decided there) or to do something there for them. " +
            "To read what was said in a group, use the group's words directly instead; this is for what isn't in the words, or for getting something done there. " +
            "chat: the group, by name or key. what: the ask, in their words. do: true when it should act, not just answer. The answer comes back later as its own turn, so tell them in a few words that you asked." +
            groupNames(groups)
          : "Ask the personal Tex of whoever tagged you (their own 1:1 with you) for something only it knows about them, or to do something for them there. " +
            "contact: true for their name, phone or email (say which in what): answered at once, never ask them in the chat for these. " +
            "For somebody else here, pass as with their handle: they are asked here first, and only their 👍 or yes lets you. " +
            "Anything else comes back later as its own turn, so tell them in a few words that you asked.",
      inputSchema: {
        type: "object",
        properties: {
          ...(group === null ? { chat: { type: "string", description: "The group chat, by its name or key." } } : {}),
          what: { type: "string", description: "The ask, in a sentence, with what it is for." },
          do: { type: "boolean", description: "true when the other Tex should do something, not only answer." },
          ...(group !== null
            ? {
                contact: { type: "boolean", description: "true for their name, phone or email, answered at once." },
                as: { type: "string", description: "The handle of someone else in this chat, asked here first." },
              }
            : {}),
        },
        required: ["what"],
      },
    },
    call: async (args) => {
      const what = line(args?.what, MAX_WHAT);
      if (what === "") return text("Not asked: say what you need, in a sentence.", true);
      if (group !== null && args?.contact === true && facts !== null) return facts.call({ what, ...(args?.as ? { as: args.as } : {}) });
      if (group !== null) {
        const target = offerTarget({ egress: { group } }, args ?? {}, "ask");
        if (target?.error) return text(target.error, true);
        if (target !== null) return offerAsk(ledger, target.who, what);
      }
      const to = group === null ? chatNamed(groups, args?.chat) : null;
      if (group === null && to === null) {
        const names = groups.map((chat) => chat.name).filter(Boolean).slice(0, 20);
        return text(`Not asked: no one group of theirs is called that. Their groups: ${names.join(", ") || "(none)"}.`, true);
      }
      const verdict = await gate({
        from: group === null ? "one" : "group",
        to: group === null ? { kind: "group", key: to.key, name: String(to.name ?? "").slice(0, MAX_LABEL) } : { kind: "person", who: group.from || "" },
        what,
        do: args?.do === true,
        guest: group !== null && (group.guestTagger === true || !group.from),
        strangers: group !== null && group.homeOnly === true,
        counts,
      });
      if (verdict?.to !== "ask") return text(`Not asked: ${verdict?.why ?? "the cross-chat gate refused it"}.`, true);
      ledger.crossAsks = [...(ledger.crossAsks ?? []), verdict.ask];
      return text(
        `Asked ${group === null ? `Tex in ${verdict.ask.to.name || "that group"}` : `@${group.from}'s personal Tex`}. ` +
          "Its answer comes back later as a turn of its own here, and you text them then; for now tell them in a few words that you asked, and don't guess the answer.",
      );
    },
  };
}

/** The 1:1's groups, named in `ask_chat`'s description so the model knows which it can ask without reading them first. */
function groupNames(groups) {
  const names = (Array.isArray(groups) ? groups : []).map((chat) => String(chat?.name ?? "").trim()).filter(Boolean).slice(0, 30);
  return names.length > 0 ? ` Their groups: ${names.join(", ")}.` : " They are in no group chat with you yet.";
}

/** Somebody else's personal Tex: offered to them, never asked until their own 👍 or yes (`offerFor.js`). */
function offerAsk(ledger, who, what) {
  if (ledger.offered) return text(`Not offered: this answer already offers one thing to @${ledger.offered.who}. Offer this after they answer.`, true);
  if (Array.isArray(ledger.asked) && ledger.asked.length > 0) return text("Not offered: this answer already asks for a yes. Offer this after it is answered.", true);
  ledger.offered = { who, tool: ASK_CHAT, detail: what };
  return text(
    `Not asked yet, and nothing failed: right after your answer @${who} is asked here whether you may ask their personal Tex: ${what}. ` +
      `Only their 👍 or yes lets you; then make this same call without as.`,
  );
}

/**
 * `post_in_chat`, only on a group run answering another chat's do-ask: one line into this group, signed by code with
 * who asked and from where, so nothing is posted in somebody's name silently. Kept in `ledger.crossPost`.
 */
export function postInChatTool({ event, group, ledger }) {
  if (event === null || event.kind !== "ask" || !event.do || group === null || ledger === null || ledger === undefined) return null;
  return {
    tool: {
      name: POST_IN_CHAT,
      description: "Post one line in this group as part of what the other chat asked you to do. It is signed with who asked; once per run.",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "The line, as it should read here." } }, required: ["text"] },
    },
    call: async (args) => {
      const said = line(args?.text, 1_000);
      if (said === "") return text("Not posted: no words.", true);
      if (ledger.crossPost) return text("Not posted: this run already posted its line.", true);
      ledger.crossPost = `${said}\n(${event.who ?? "Someone"} asked me from ${event.from})`;
      return text("Posted here, signed with who asked. Now write your answer back to the other chat.");
    },
  };
}

/** The group line that replaces `ask_personal_tex`'s once the cross-chat gate is wired (`groupTurn.js` `groupPrompt`). */
export const CROSS_CHAT_GROUP_LINE =
  "When a form, booking or sign-in someone here asked for needs their own name, phone number or email, get them with send action ask_chat and contact true " +
  "(their personal Tex knows them) rather than asking; for anything else only their personal Tex knows, or to have it do something for them, send ask_chat too; " +
  "for somebody else here, pass as and they OK it first. ";

// Dev, 2026-11-24: "ideally I just want Tex to have context of everything ... if not then it should ask the user for more
// information". A group turn was told to send people off to text it on their own for their notes, so "pick up the list I
// made with you in our 1:1" got "text me 1:1" though ask_chat could fetch it. No one use is named: anything of theirs.
export const CROSS_CHAT_NOTES_LINE =
  "Their notes, lists, plans and chats with you aren't open here, but their personal Tex has them: when someone points at something of theirs " +
  "(something they made, saved or told you on their own), get it with send action ask_chat, saying what they mean in their own words, and use or share " +
  "what comes back; if you can't tell what they mean, ask them one short question first. Opening it yourself from here fails, even when a search names it, " +
  "so never fetch it and never ask them to share or paste it: ask their personal Tex. Never tell them to text you on their own for it. " +
  "For somebody else's, pass as and they OK it first; saved logins stay in their own chat. ";

/** A group turn's prompt when cross-chat asks are wired: ask the person's own Tex rather than send them away. */
export function crossChatGroupPrompt(prompt) {
  return String(prompt ?? "")
    .replace(PERSONAL_TEX_LINE, CROSS_CHAT_GROUP_LINE)
    .replace(NO_NOTES_LINE, CROSS_CHAT_NOTES_LINE)
    .replace(NO_OTHER_NOTES_LINE, CROSS_CHAT_NOTES_LINE);
}

/** The ask-run's answer, shaped for the chat that asked (node `chatAnswer`'s input). */
export function crossBackInput(event, draft, post) {
  return { kind: "ask", id: event.id, draft: String(draft ?? "").slice(0, MAX_TEXT), ...(post ? { post: String(post).slice(0, 1_200) } : {}) };
}

export { MAX_TEXT as CROSS_MAX_TEXT };
