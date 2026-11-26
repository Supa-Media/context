/**
 * SENSITIVE DETAILS GO TO THE ASKER'S OWN CHAT, NEVER THE GROUP (Dev2, 2026-11-25).
 *
 * Asked in a group to order with a site's login, Tex sent the private vault link and the steps to save it into the
 * group. Dev2: "logins and etc is something that should be handled 1:1 side ... Tex being - sure thing, and then
 * texting the person who asked on the side", and then "not just logins but anything that requires a user to enter
 * sensitive information. steps for that shouldn't be stated in the groupchat - it should be handled in 1:1. anything
 * along the lines of tex mentioning that it will text the user for details is good." A guest, who has no chat of
 * their own with Tex yet, is told to make an account first.
 *
 * So in a group turn, by code and not by the model's choice:
 *
 *  - a link to save or view something in a vault (`vault_add_link`, `vault_view_link`) never reaches the model: its
 *    words go to whoever tagged Tex as an aside, and the model is told only that it went. The vault watch still keys
 *    on the group (`vaultSaved.js` `withVaultWatch`, inside this wrapper), so the save carries the task on here.
 *  - `text_privately` asks them for anything else sensitive (a card, an ID, a one-time code) in their own chat.
 *
 * Each aside is handed to the texting Worker with the answer (`asides`), which starts a run in the asker's own 1:1
 * (`packages/tex/worker/crossChat.ts` `sendAsides`), framed by `crossChatPrompt` as a cross-chat answer with state
 * `aside`. Only the tagger is ever texted: the Worker sends to the message's own sender, never a name the model gives.
 * Decision: `docs/decisions/texting-assistant/private-asides.md`.
 */

export const TEXT_PRIVATELY = "text_privately";

/** The `send` action it is shown as (`sixTools.js`). */
export const PRIVATE_ASIDE_SEND_ACTIONS = {
  text_privately: {
    tool: TEXT_PRIVATELY,
    summary: "In a group chat, text whoever tagged you in their own chat with you, for anything sensitive (a card, an ID, a one-time code): never asked for here.",
  },
};

/** Vault links: each opens only for the person who asked, so its words go to them alone. */
export const PRIVATE_LINK_TOOLS = Object.freeze(["vault_add_link", "vault_view_link"]);

/** Most asides one turn sends. */
export const MAX_ASIDES = 2;
const MAX_WHAT = 300;
const MAX_TEXT = 1_200;
/** A held answer's draft, as long as a cross-chat answer's text (`crossChat.js`). */
const MAX_HELD = 4_000;

const clip = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim();
}

/** Whether the tagger has a chat of their own with Tex to be texted in: an account, and a handle on this turn. */
export function canAside(group) {
  return group !== null && group !== undefined && group.guestTagger !== true && typeof group.from === "string" && group.from !== "";
}

/** What a guest is told instead: no account yet, so nothing sensitive is asked for anywhere. */
export const GUEST_ASIDE_REFUSAL =
  "Not sent: whoever tagged you isn't on Context, so they have no chat of their own with you to be texted the details in. " +
  "Tell them in one short line to text you on their own from their phone to set up an account first, and that you'll text them for it then; " +
  "never ask for it, or explain how to give it, here.";

function keep(ledger, aside) {
  const asides = (ledger.asides ??= []);
  if (asides.length >= MAX_ASIDES) return false;
  asides.push(aside);
  return true;
}

/**
 * An answer held from the group (`roomCheck.js`): its draft goes to the tagger alone, with the facts of why, as a held
 * aside their own Tex texts them. False when they have no chat of their own, or this turn already sent its asides.
 */
export function holdForAsker(ledger, group, draft, facts) {
  if (!canAside(group) || ledger === null || ledger === undefined) return false;
  const words = typeof draft === "string" ? draft.trim().slice(0, MAX_HELD) : "";
  if (words === "") return false;
  return keep(ledger, { what: clip(facts, MAX_WHAT), texts: [words], held: true });
}

/**
 * The `text_privately` tool for one group chat turn, or null on any other turn. `ledger` is the turn's egress ledger;
 * the aside is kept as `ledger.asides` for the Worker.
 */
export function privateAsideTool({ group, ledger }) {
  if (group === null || group === undefined || ledger === null || ledger === undefined) return null;
  return {
    tool: {
      name: TEXT_PRIVATELY,
      description:
        "Text whoever tagged you in their own chat with you, for something sensitive this group mustn't see: a card, an ID, an account number, " +
        "a one-time code a site sent them. what: what you need from them and what it is for, in a sentence. " +
        "Their own Tex texts them right after your answer, and when they reply there it is passed back here. " +
        "Here, say only that you'll text them; never ask for it or give the steps in this chat.",
      inputSchema: {
        type: "object",
        properties: { what: { type: "string", description: "What you need from them and what it's for, in a sentence." } },
        required: ["what"],
      },
    },
    call: async (args) => {
      if (!canAside(group)) return text(GUEST_ASIDE_REFUSAL, true);
      const what = clip(args?.what, MAX_WHAT);
      if (what === "") return text("Not sent: say what you need from them, in a sentence.", true);
      if (!keep(ledger, { what, texts: [] })) return text(`Not sent: this answer already texts @${group.from} privately ${MAX_ASIDES} times. Wait for their reply.`, true);
      return text(sentLine(group));
    },
  };
}

function sentLine(group) {
  return (
    `@${group.from} is texted this in their own chat with you right after your answer. ` +
    "In this chat say only, in a few words, that you'll text them for it (\"Sure thing, I'll text you for the login\"); " +
    "never the link, the details or how to give them."
  );
}

/**
 * In a group chat turn, a vault link's words go to the tagger as an aside and never to the model. Wraps the call
 * that `withVaultWatch` wraps, so the watch still sees the link and the save wakes this group.
 */
export function withPrivateLinks(group, ledger, callTool) {
  if (group === null || group === undefined || ledger === null || ledger === undefined) return callTool;
  return async (name, args) => {
    if (!PRIVATE_LINK_TOOLS.includes(name)) return callTool(name, args);
    if (!canAside(group)) return text(GUEST_ASIDE_REFUSAL, true);
    if ((ledger.asides ?? []).length >= MAX_ASIDES) return text(`Not made: this answer already texts @${group.from} privately ${MAX_ASIDES} times. Wait for their reply.`, true);
    const result = await callTool(name, args);
    if (result?.isError === true) return result;
    const words = resultText(result).slice(0, MAX_TEXT);
    if (words === "") return text("That link could not be made right now. Try again in a minute.", true);
    const what = name === "vault_view_link" ? "a private link to see what's saved" : `a private link to save ${clip(args?.name, 80) || clip(args?.site, 80) || "it"}`;
    keep(ledger, { what, texts: [words] });
    return text(`The link was made and goes to @${group.from} alone. ${sentLine(group)} Once they save, you're told here and carry on by yourself.`);
  };
}
