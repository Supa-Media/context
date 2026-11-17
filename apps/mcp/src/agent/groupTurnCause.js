/**
 * What a group turn is told about why it runs (Dev2, 2026-11-17), out of `groupTurn.js`, which re-exports it.
 * The cause comes from the Worker (`apps/agent/src/groupCause.ts`); see
 * docs/decisions/texting-assistant/turn-told-from-state.md.
 */
import { shownWho, taggerLabel } from "./groupNames.js";

/** What an invited person's tag adds to the group words: they can ask anything, and sends go from a member. */
export const INVITED_TAGGER_LINE =
  "The person who tagged you is invited to this workspace and not on Context yet; they can ask you for anything here. " +
  "An email or calendar change goes only from the account of someone here who is on Context: pass as with their handle, and only their 👍 or yes sends it. ";

/** Why a group turn runs, as the Worker names it (`apps/agent/src/groupCause.ts`). */
export const TURN_CAUSES = Object.freeze(["check_in", "routine", "job_report", "cross_chat", "vault_saved", "browser_handed_back", "reaction", "tagged", "named", "judged"]);

/**
 * Who tagged Tex this time, said in their turn (`turnPrompt.js` preamble), never the cached system prompt: it
 * changes with the tagger. What the turn is told about why it runs (Dev2, 2026-11-17). Only a text that names Tex is said to tag it: a chat's
 * own check-in was told "@jo tagged you" and answered "Yeah, what do you need?", and a follow-up the judge picked up
 * was explained as "you'd just tagged me". A turn with no cause (an older Worker) is told as before.
 */
export function taggedLine(group) {
  const cause = group?.cause ?? null;
  if (cause === "check_in") return "Nobody texted you: this is the chat's own check-in, run on its schedule. Its words say what to look at and when to answer SKIP.";
  if (cause === "routine") return "Nobody texted you: this is one of the chat's routines, run on its schedule.";
  if (cause === "job_report") return "Nobody texted you: work you started for this chat reported back.";
  if (cause === "cross_chat") return "Nobody here texted you: another of your chats with these people asked this one something.";
  if (cause === "vault_saved") return "Nobody texted you: someone here saved the login you asked for in the vault.";
  if (cause === "browser_handed_back") return "Nobody texted you: someone here pressed Done on the browser you handed them.";
  const who = group.from ? taggerLabel(group) : group.asker ? shownWho(group, group.asker).replace(/^@/, "") : "";
  if (cause === "reaction") return who ? `${who} reacted to one of your texts.` : "Someone reacted to one of your texts.";
  if (cause === "judged") {
    return (
      `${who ? `${who}'s newest text` : "The newest text"} doesn't name you: it was handed to you because it looked like a reply to you or a follow-up on your last answer. ` +
      "Nobody tagged you, so never say they did; if it wasn't for you, call send with action say_nothing." +
      (group.guestTagger && !group.guestChat ? ` ${INVITED_TAGGER_LINE.trim()}` : "")
    );
  }
  const guest = group.asker ? shownWho(group, group.asker).replace(/^@/, "") : "";
  if (group.guestChat) return group.from ? `@${group.from} tagged you.` : guest ? `A guest in this chat, ${guest}, tagged you.` : "A guest in this chat tagged you.";
  return (group.from ? `${taggerLabel(group)} tagged you.` : guest ? `${guest} tagged you.` : "Someone tagged you.") + (group.guestTagger ? ` ${INVITED_TAGGER_LINE.trim()}` : "");
}
