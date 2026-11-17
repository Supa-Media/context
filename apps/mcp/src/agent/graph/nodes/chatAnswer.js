/**
 * Answer the other chat, node `chatAnswer` (`texNodeShelf.json` until a Lab draft wires `answerCheck -> chatAnswer`;
 * `../../crossChat.js`). A run that answers another chat's ask texts nothing here: its checked draft goes back to the
 * chat that asked, where it starts a run of its own (Dev2's generators model, 2026-11-16). A do-ask's one signed line
 * for this group goes with it (`post_in_chat`).
 *
 * No model and no reads; logged like every node. Output `to`: "back", with `texts` for the asking chat and `post`
 * for this group, or nothing to post.
 */
import { CROSS_MAX_TEXT } from "../../crossChat.js";

const CONTROL = /^[\s\W]*(?:skip|no[ _-]?reply|quiet|silent|null|none)[\s\W]*$/i;

/** @param {{ kind: "ask", id: string, draft: string, post?: string }} input */
export async function chatAnswerNode(input) {
  const draft = String(input.draft ?? "").trim();
  const said = draft === "" || CONTROL.test(draft) ? "I couldn't find an answer to that here." : draft.slice(0, CROSS_MAX_TEXT);
  return { to: "back", id: input.id, state: "answered", texts: [said], ...(input.post ? { post: String(input.post) } : {}) };
}
