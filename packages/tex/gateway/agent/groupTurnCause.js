/**
 * What a group turn is told about why it runs (Dev2, 2026-11-17), out of `groupTurn.js`, which re-exports it.
 * The cause comes from the Worker (`packages/tex/worker/groupCause.ts`); see
 * docs/decisions/texting-assistant/turn-told-from-state.md.
 */
import { shownWho, taggerLabel } from "./groupNames.js";

/** What an invited person's tag adds to the group words: they can ask anything, and sends go from a member. */
export const INVITED_TAGGER_LINE = invitedLine("The person who tagged you");

/** Someone with no account in a chat that reads only its home: not invited anywhere, so nothing goes from them. */
export const NOT_ON_CONTEXT_LINE =
  "They aren't on Context, so nothing goes from an account of theirs: an email or calendar change they ask for goes from someone here who is, on that person's 👍 or yes. ";

/** The same, for whoever texted: a turn nobody tagged must not be told someone did (`judged`). */
function invitedLine(who) {
  return (
    `${who} is invited to this workspace and not on Context yet; they can ask you for anything here. ` +
    "An email or calendar change goes only from the account of someone here who is on Context: pass as with their handle, and only their 👍 or yes sends it. "
  );
}

/**
 * What a turn whose cause is missing is told (Dev2, 2026-11-17: "not known" when the field is missing, never a stock
 * sentence): before, it was told "@<sponsor> tagged you.", and a chat's own check-in answered "Yeah, what do you need?".
 */
export const CAUSE_NOT_KNOWN =
  "Why this turn runs is not known: it may be a text, the chat's own check-in or a follow-up. Never say anyone tagged you, asked you or why you're answering; if nothing in the newest texts is for you, call send with action say_nothing.";

/** Why a group turn runs, as the Worker names it (`packages/tex/worker/groupCause.ts`). */
export const TURN_CAUSES = Object.freeze(["check_in", "routine", "job_report", "cross_chat", "vault_saved", "browser_handed_back", "reaction", "tagged", "named", "judged"]);

/**
 * Who tagged Tex this time, said in their turn (`turnPrompt.js` preamble), never the cached system prompt: it
 * changes with the tagger. What the turn is told about why it runs (Dev2, 2026-11-17). Only a text that names Tex is said to tag it: a chat's
 * own check-in was told "@jo tagged you" and answered "Yeah, what do you need?", and a follow-up the judge picked up
 * was explained as "you'd just tagged me". A turn with no cause is told that it is not known (`CAUSE_NOT_KNOWN`), and a
 * tag with no sender says who is not known; `turnFactClaims.test.mjs` fails when a line claims what its field doesn't hold.
 */
export function taggedLine(group) {
  const cause = TURN_CAUSES.includes(group?.cause) ? group.cause : null;
  if (cause === null) return CAUSE_NOT_KNOWN;
  if (cause === "check_in") return "Nobody texted you: this is the chat's own check-in, run on its schedule. Its words say what to look at and when to stay quiet.";
  if (cause === "routine") return "Nobody texted you: this is one of the chat's routines, run on its schedule.";
  if (cause === "job_report") return "Nobody texted you: work you started for this chat reported back.";
  if (cause === "cross_chat") return "Nobody here texted you: another of your chats with these people asked this one something.";
  if (cause === "vault_saved") return "Nobody texted you: someone here saved the login you asked for in the vault.";
  if (cause === "browser_handed_back") return "Nobody texted you: someone here pressed Done on the browser you handed them.";
  const who = group.from ? taggerLabel(group) : group.asker ? shownWho(group, group.asker).replace(/^@/, "") : "";
  if (cause === "reaction") return who ? `${who} reacted to one of your texts.` : "Someone reacted to one of your texts; who is not known.";
  if (cause === "judged") {
    return (
      `${who ? `${who}'s newest text` : "The newest text"} doesn't name you: it was handed to you because it looked like a reply to you or a follow-up on your last answer. ` +
      "Nobody tagged you, so never say they did; if it wasn't for you, call send with action say_nothing." +
      (group.guestTagger ? ` ${(group.homeOnly ? NOT_ON_CONTEXT_LINE : invitedLine("The person who texted")).trim()}` : "")
    );
  }
  const guest = group.asker ? shownWho(group, group.asker).replace(/^@/, "") : "";
  // `tagged` or `named`: a text names you. Who sent it is said only from a field, else that it is not known.
  // A chat that reads only its home invites nobody to a workspace: someone with no account is a guest here, and said so.
  if (group.homeOnly) return group.from ? `@${group.from} tagged you.` : guest ? `A guest in this chat, ${guest}, tagged you. ${NOT_ON_CONTEXT_LINE.trim()}` : "A guest in this chat tagged you; which guest is not known.";
  return (group.from ? `${taggerLabel(group)} tagged you.` : guest ? `${guest} tagged you.` : "A text here tagged you; who sent it is not known.") + (group.guestTagger ? ` ${INVITED_TAGGER_LINE.trim()}` : "");
}
