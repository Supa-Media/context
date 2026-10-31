/**
 * A GROUP CHAT'S HOME IN THE PIN (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * A chat with a home keeps its memory there, in `tex/groups/<words>/` in
 * `@context-lc`, sealed so only the chat's people open it, instead of a note
 * in the workspace it is bound to that everyone there can read. The turn
 * reaches it through its own door (`http/pinnedDoors.js`), a session that
 * may change the home and nothing else (`session.js` `sessionForChatHome`),
 * and only through the calls made here: a model's tool call never names it.
 *
 * The memory itself is the note it always was (`groupMemoryNote.js`),
 * `chat-<id>.md`, named by the people in the chat as before, now in the
 * home. The plumbing copy stays in the bound workspace (`groupTurn.js`), so a
 * chat moving in keeps its history. The chat's voice and its workspace's
 * playbook stay where the turn's own tools write them, for now.
 */

import { actorFor } from "../context/identity.js";
import { callToolForSession } from "../tools/session.js";

/**
 * The chat's home, as `{ folder, dispatch }`, or `null`: no home on this
 * grant, or it could not be opened. A home that can't be opened is the old
 * note in the bound workspace, never a failed answer.
 */
export async function openChatHome(store) {
  if (typeof store?.openChatHome !== "function") return null;
  try {
    const opened = await store.openChatHome();
    const session = opened?.session;
    if (!opened?.store || typeof session?.chatHome !== "string") return null;
    opened.store.actor = actorFor(session);
    return { folder: session.chatHome, dispatch: (name, args) => callToolForSession({ name, arguments: args }, opened.store, session) };
  } catch {
    return null;
  }
}
