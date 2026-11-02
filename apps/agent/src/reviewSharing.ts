/**
 * Sharing finished Tex conversations with the team, by text (Dev2,
 * 2026-10-29): "Tex, share my chats with the devs", "stop sharing with the
 * devs", "am I sharing with the devs?". The same switch as Settings →
 * Feedback "Share finished Tex conversations" (`apps/convex/functions/
 * texReviews.ts`), so who a review may keep words for is still decided there
 * and only there.
 *
 * Read from the whole text with no model, like "Tex, settings"
 * (`texStyle.ts`): a yes that lets people read someone's messages is theirs
 * to say in words, never a model's reading of what they might have meant.
 * Both name what they are about (chats, history, the devs): a bare "stop
 * sharing" or "opt out" may mean a note or an email list, and goes to the model.
 *
 * A 1:1 yes also files, once, what Tex still keeps of that chat
 * (`reviewWatch.ts` `watchShared`), so the history they said yes to reaches
 * the team without waiting for the next conversation to end. A group chat's
 * words are kept only once everybody in it has said yes or is on the team
 * (`reviewSetup`); a yes said there is the sender's own, and the answer says
 * whether the whole chat now counts, naming nobody.
 */

import { post, record, type Fetch } from "./clients";

/** On, off, or a question: what the text asks of the switch. */
export type Sharing = "on" | "off" | "ask";

/** Who the words mean: the people who build Tex. Never "the team" alone, which in a group is the people in it. */
const DEVS = "(?:the )?(?:devs?|developers?|dev team|tex team|context team|tex devs|context devs|people who (?:build|make) (?:tex|you|context))";
const WHAT = "(?:(?:my|our|all my|all of my) )?(?:chats?|conversations?|texts?|messages?|chat history|conversation history|history|data)";
const PLEASE = "(?:(?:please|pls|ok|okay|yes|yeah|sure)[, ]+)?";

const ON = [
  // "share my chats with the devs", "send my history to the devs", "share with devs"
  new RegExp(`^${PLEASE}(?:share|send|give)(?: ${WHAT})? (?:with|to) ${DEVS}$`),
  // "opt into sharing with devs", "opt in to sharing my chats", "opt in to share with the devs"
  new RegExp(`^${PLEASE}opt(?: |-)?in(?:to| to)? (?:sharing|share)(?: ${WHAT})?(?: (?:with|to) ${DEVS})?$`),
  // "opt in with the devs", "opt in for the devs"
  new RegExp(`^${PLEASE}opt(?: |-)?in(?: (?:with|to|for) ${DEVS})$`),
  // "start sharing my chats with the devs", "turn on sharing with devs"
  new RegExp(`^${PLEASE}(?:start sharing|turn on sharing|turn sharing on)(?: ${WHAT})?(?: (?:with|to) ${DEVS})?$`),
  // "use my chats to improve tex", "the devs can read my chats"
  new RegExp(`^${PLEASE}(?:you can )?use ${WHAT} to (?:improve|make) (?:tex|you|context|the app)(?: better)?$`),
  new RegExp(`^${PLEASE}${DEVS} can (?:read|see|have) ${WHAT}$`),
];

/** Who or what is being stopped, so a bare "stop sharing" (a note, a location) is never read as this. */
const OF_THIS = `(?: ${WHAT}(?: (?:with|to|from) ${DEVS})?| (?:with|to|from) ${DEVS})`;

const OFF = [
  // "stop sharing with the devs", "stop sharing my chats"
  new RegExp(`^${PLEASE}(?:stop|quit|end) sharing${OF_THIS}$`),
  // "opt out of sharing", "opt out of sharing my chats with the devs", "opt out from the devs"
  new RegExp(`^${PLEASE}opt(?: |-)?out of (?:sharing|share)(?:${OF_THIS})?$`),
  new RegExp(`^${PLEASE}opt(?: |-)?out(?: of)?(?: sharing)? (?:with|from|for) ${DEVS}$`),
  // "turn off sharing with the devs", "don't share my chats with the devs", "unshare my chats from the devs"
  new RegExp(`^${PLEASE}(?:turn off sharing|turn sharing off)${OF_THIS}$`),
  new RegExp(`^(?:don'?t|do not|never) share(?: ${WHAT})? (?:with|to) ${DEVS}$`),
  new RegExp(`^unshare(?: ${WHAT})? (?:with|from) ${DEVS}$`),
];

const ASK = [
  // "am I sharing with the devs?", "are you sharing my chats with the devs"
  new RegExp(`^(?:am i|are you|is tex|are we|do i|do you) (?:sharing|share)(?: ${WHAT})?(?: (?:with|to) ${DEVS})?$`),
  // "what do the devs see?", "can the devs read my chats?"
  new RegExp(`^(?:what do|what can) ${DEVS} (?:see|read)(?: of ${WHAT})?$`),
  new RegExp(`^(?:can|do) ${DEVS} (?:see|read) ${WHAT}$`),
];

/** The whole text, without Tex's name, quotes, case or end punctuation. */
function bare(text: string): string {
  return text
    .trim()
    .replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "")
    .replace(/^(?:(?:hey|hi|yo|ok|okay)\s+)?@?(?:tex|context)(?![\w-])[\s,:!.-]*/i, "")
    .replace(/[.!?\s]+$/, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** What a text asks of the switch, read from all of it, or null when it is anything else. */
export function sharingWords(text: string): Sharing | null {
  const words = bare(text);
  if (words === "" || words.length > 120) return null;
  if (ON.some((pattern) => pattern.test(words))) return "on";
  if (OFF.some((pattern) => pattern.test(words))) return "off";
  if (ASK.some((pattern) => pattern.test(words))) return "ask";
  return null;
}

/** The control plane's answer (`POST /agent-texts/review-sharing`). */
export type SharingAnswer =
  | { status: "unlinked" }
  | { status: "ok"; sharing: boolean; changed: boolean; team: boolean; chatShared?: boolean };

/**
 * `POST /agent-texts/review-sharing`: set or read the switch for the phone
 * that texted. `participants`, in a group: everyone in it but Tex. Null when
 * the control plane could not be reached or answered something else.
 */
export async function saveReviewSharing(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
  sharing: Sharing,
  participants?: string[],
): Promise<SharingAnswer | null> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/review-sharing`, secret, {
    phone,
    ...(sharing === "ask" ? {} : { share: sharing === "on" }),
    ...(participants !== undefined ? { participants } : {}),
  }).catch(() => ({ status: 0, json: null }));
  const answer = record(json);
  if (status !== 200) return null;
  if (answer.status === "unlinked") return { status: "unlinked" };
  if (answer.status !== "ok" || typeof answer.sharing !== "boolean") return null;
  return {
    status: "ok",
    sharing: answer.sharing,
    changed: answer.changed === true,
    team: answer.team === true,
    ...(typeof answer.chatShared === "boolean" ? { chatShared: answer.chatShared } : {}),
  };
}

/** What sharing means, said the same way everywhere a yes is asked for or given. */
const WHAT_IT_MEANS =
  "When a chat with me ends, the Context team (the people who build Tex) can read the whole thing: your texts, my replies, and anything you sent me in it, with a score of how it went, to make Tex better. It stays with them, never public, never sold, never used for ads.";
const SCORES_ONLY = "With sharing off, they only get a score of how each chat went, with no words and no name.";
const HOW_TO_STOP = 'Text "stop sharing with the devs" any time to stop.';
const HOW_TO_START = 'Text "share my chats with the devs" if you want them to read your chats to make Tex better.';
const GROUP_RULE = "In a group chat, the words are only shared once everyone in it has said yes.";
const UNREACHABLE = "I couldn't change that just now. Try again in a minute, or use Settings → Feedback in the Context app.";

/**
 * The answer to a texted yes, no or question, in plain words. `inGroup`: said
 * in a group chat, where the answer also says whether this chat now counts.
 * `backfill`: a 1:1 yes whose kept history is on its way to the team.
 */
export function sharingReply(sharing: Sharing, answer: SharingAnswer | null, { inGroup = false, backfill = false } = {}): string {
  if (answer === null) return UNREACHABLE;
  if (answer.status === "unlinked") return "I can't find a Context account for your number, so there's nothing of yours to share. Text me directly to set one up.";
  const chat =
    answer.chatShared === undefined
      ? ""
      : answer.chatShared
        ? " Everyone here has, so this chat is shared too."
        : " Not everyone here has yet, so this chat's words stay out.";
  const team = answer.team ? " You're on the Context team, so your chats go to reviews either way." : "";
  if (sharing === "on") {
    const already = answer.changed ? "Done, you're sharing your chats with the devs." : "You're already sharing your chats with the devs.";
    const past = backfill ? " I'm sending them what I still have of our past texts now, too." : "";
    return `${already} ${WHAT_IT_MEANS}${past}${inGroup ? ` ${GROUP_RULE}${chat}` : ""} ${HOW_TO_STOP}`;
  }
  if (sharing === "off") {
    const done = answer.changed ? "Done, I've stopped sharing your chats with the devs." : "You weren't sharing your chats with the devs, so nothing changes.";
    const before = answer.changed ? " What was already shared stays with them." : "";
    return `${done} ${SCORES_ONLY}${before}${team}`;
  }
  return answer.sharing
    ? `Yes, you're sharing your chats with the devs. ${WHAT_IT_MEANS}${inGroup ? ` ${GROUP_RULE}${chat}` : ""} ${HOW_TO_STOP}`
    : `No, you're not sharing your chats with the devs. ${SCORES_ONLY}${team} ${HOW_TO_START}`;
}
