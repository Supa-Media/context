/**
 * Text them node "send" (`texConfig.json`): the answer that goes back. A door step or the front door that answered the
 * turn itself left it in `t.response` (`answered` before any model, `ended` after one); a routine's run keeps its
 * outcome (`../../texEntryPoint/finishARoutine.js`); any other turn builds its reply (`sendTheReply.js`). Its output
 * says which, and its `background` wires fire on it: the Classifier when the turn read the chat's threads, Self-review
 * on a reply that went.
 */
import { finishARoutine } from "../../texEntryPoint/finishARoutine.js";
import { sendTheReply } from "../../texEntryPoint/sendTheReply.js";

/** What went back, as data: the words' length, whether a card or a tapback went, never the words. */
async function sentOf(response) {
  try {
    const body = await response.clone().json();
    return {
      texts: typeof body?.answer === "string" ? body.answer.length : 0,
      card: Array.isArray(body?.pictures) && body.pictures.length > 0,
      reaction: typeof body?.react === "string",
      status: response.status,
    };
  } catch {
    return { status: response?.status };
  }
}

export async function sendNode(_input, io) {
  const t = io.ctx.turn;
  const threads = typeof t.threadsSort === "function" ? ["threads"] : [];
  if (t.drafts === undefined) return { when: ["answered"], ...(await sentOf(t.response)) };
  if (t.response === undefined) t.response = await finishARoutine(t);
  if (t.response !== undefined) return { when: ["ended", ...threads], ...(await sentOf(t.response)) };
  t.response = await sendTheReply(t);
  return { when: [t.turn?.exhausted ? "exhausted" : "sent", ...threads], ...(await sentOf(t.response)) };
}
