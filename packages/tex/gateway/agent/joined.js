/**
 * TEX SAYS HELLO WHEN IT IS ADDED TO A GROUP (Dev2, 2026-11-25). The texting Worker queues one turn of the group's own
 * with `event: "joined"` and no words of anyone's (`packages/tex/worker/groupJoined.ts`); node `joined`
 * (`graph/nodes/joined.js`) gives it this line, and the Front door writes the hello from it.
 *
 * The line is the gateway's, marked as not a text from anyone, and asks for nothing that reaches anyone else. Its
 * example is Dev2's own wording (2026-11-25), "something along the lines of" it, never to be said word for word.
 */

export const JOINED_EVENT = "joined";

export const JOINED_QUESTION =
  "(Not a text from anyone here. Context sent this by itself: you were just added to this group chat. " +
  "Say hello to everyone in one short text, something along the lines of \"Hey all, I'm Tex. I can plan, look things up, set reminders, run polls, or handle errands for the group. " +
  "Anything personal stays in your own 1:1 with me.\" Say it in your own words for this chat. Ask nobody anything, name nobody's notes or private details, and do no work yet.)";

/** The line a group's hello turn is asked. */
export function joinedQuestion() {
  return JOINED_QUESTION;
}
