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
 * `aside`. Only the tagger is ever texted, but for one case: a calendar clash goes to the calendar's own person, a
 * handle whose calendar is shared here, which the Worker resolves among the chat's people now (`calendarAside`).
 * Decision: `docs/decisions/texting-assistant/private-asides.md`.
 */

export const TEXT_PRIVATELY = "text_privately";

/** The `send` action it is shown as (`sixTools.js`). */
export const PRIVATE_ASIDE_SEND_ACTIONS = {
  text_privately: {
    tool: TEXT_PRIVATELY,
    summary: "In a group chat, follow up with whoever tagged you in their own chat with you: something sensitive to ask them for, or something of theirs to give or go over there.",
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

/**
 * What a guest's call answers instead (Dev2, 2026-11-27: "the 1:1 shouldnt work with someone who is a guest. if someone
 * ask for a 1:1 chat it should prompt them to signup for an account"): facts, never words for Tex to say. Texting Tex's
 * number on their own is how a phone with no account signs up (the setup texts), so that is the way named.
 */
export const GUEST_ASIDE_REFUSAL = JSON.stringify({
  sent: false,
  status: "not_on_context",
  has_account: false,
  own_chat_with_you: false,
  to_sign_up: "text you directly, not here",
  after_sign_up: "follow up there",
});

/** Whether this turn already followed up with whoever tagged Tex in their own chat: their 1:1 text answers them. */
export function followedUpWith(ledger) {
  return (Array.isArray(ledger?.asides) ? ledger.asides : []).some((aside) => aside && aside.calendar !== true);
}

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

/** Whose calendars are shared with this chat, by handle: the only people a calendar aside may go to (`to`). */
function calendarOwners(group) {
  return [...new Set((Array.isArray(group?.calendar) ? group.calendar : []).map((row) => row?.handle).filter((handle) => typeof handle === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(handle)))];
}

/**
 * A calendar clash, for the calendar's own person alone (Dev2, 2026-11-27, choosing that a check-in's clash goes to
 * the calendar's owner privately): the room reads a shared calendar only as free or busy, so whether a busy time is
 * the plan the chat means is asked of its owner, whose own Tex reads it whole. Only a handle whose calendar is shared
 * here; the Worker texts them only while they are in the chat (`packages/tex/worker/crossChat.ts`). Answers facts.
 */
function calendarAside(group, ledger, handle, what) {
  const owners = calendarOwners(group);
  if (!owners.includes(handle)) return text(JSON.stringify({ sent: false, status: "no_calendar_of_theirs_shared_here", calendars_shared_by: owners.map((h) => `@${h}`) }), true);
  if (!keep(ledger, { what, texts: [], to: handle, calendar: true })) return text(JSON.stringify({ sent: false, status: "aside_limit_reached", limit: MAX_ASIDES }), true);
  return text(JSON.stringify({ texted_privately: `@${handle}`, about: "shared_calendar", when: "right after your answer" }));
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
        "Follow up with whoever tagged you in their own chat with you, for what is theirs alone and not for this group: something sensitive you need " +
        "from them (a card, an ID, a one-time code), or something of theirs to give them or go over with them there (their own notes, a summary, a draft, a question). " +
        "what: what their own Tex should do there, in a sentence. Their own Tex, which reads all of their notes and calendar, texts them right after your answer, " +
        "and can post back here what they choose to share. Here, a tapback on their text is enough (send action tapback); never the details. " +
        "Someone not on Context has no chat of their own with you yet: the call says so.",
      inputSchema: {
        type: "object",
        properties: {
          what: { type: "string", description: "What their own Tex should do with them there, in a sentence." },
          to: { type: "string", description: "calendar clash: its owner's handle" },
        },
        required: ["what"],
      },
    },
    call: async (args) => {
      const to = typeof args?.to === "string" ? args.to.trim().replace(/^@/, "").toLowerCase() : "";
      // `to` naming the tagger is their own follow-up: Haiku names them (`to: "@ada"`) more often than not, and that
      // was refused as a calendar clash with no calendar (Lab, 2026-11-28). Only another handle is a calendar's owner.
      // A guest naming anyone but a calendar's owner (themselves, by name) is still told to sign up.
      const tagger = typeof group.from === "string" ? group.from.toLowerCase() : "";
      const self = to === "" || (tagger !== "" && to === tagger);
      if (!self && (calendarOwners(group).includes(to) || group.guestTagger !== true)) return calendarAside(group, ledger, to, clip(args?.what, MAX_WHAT));
      if (!canAside(group)) return text(GUEST_ASIDE_REFUSAL, true);
      const what = clip(args?.what, MAX_WHAT);
      if (what === "") return text("Not sent: say what you need from them, in a sentence.", true);
      if (!keep(ledger, { what, texts: [] })) return text(`Not sent: this answer already texts @${group.from} privately ${MAX_ASIDES} times. Wait for their reply.`, true);
      // A tapback is the group's whole answer to a follow-up (Dev2, 2026-11-28); the description alone left Haiku
      // texting "Texting you now." (Lab, 2026-11-28), so the result carries it as a fact too.
      return text(JSON.stringify({ ...sentFacts(group), answer_here: "tapback" }));
    },
  };
}

/** What the group's model is told once an aside is kept: facts, never words to say (`no-scripted-wording`). */
function sentFacts(group) {
  return { texted_privately: `@${group.from}`, when: "right after your answer", this_group_sees: "nothing of it" };
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
    return text(JSON.stringify({ link_made: true, ...sentFacts(group), once_they_save: "you are told here and carry on" }));
  };
}
