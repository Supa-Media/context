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
 * chat moving in keeps its history.
 *
 * Beside it, the chat's own notes, which the turn's model keeps as a person's
 * Tex keeps theirs: `about-us.md` (who these people are and what they are
 * about, as `tex/about-me.md` is for one person) and the chat's voice note
 * (`chatVoice.js`). The model reaches the home by naming `@context-lc` on a
 * tool call (`addressHome`): for a chat with a home that name opens the home's
 * session, whose rules let it change the home and only read the rest. The
 * workspace's playbook stays the workspace's.
 */

import { actorFor } from "../context/identity.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { callToolForSession } from "../tools/session.js";
import { readWithEtag } from "./jobLog.js";

/** The chat's note about itself, in its home. */
export const ABOUT_US = "about-us.md";

/** At most this much of it is shown each turn. */
export const MAX_ABOUT_US_CHARS = 1_500;

/**
 * The chat's home, as `{ folder, dispatch, session, store }`, or `null`: no home on this
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
    return { folder: session.chatHome, session, store: opened.store, dispatch: (name, args) => callToolForSession({ name, arguments: args }, opened.store, session) };
  } catch {
    return null;
  }
}

/**
 * `@context-lc` on a tool call opens the chat's home for the rest of this turn
 * (see the header). Only for a chat with a home, whose grant never lists or
 * addresses the pin otherwise (`session.js`), so the name meant nothing here
 * before; every other name is routed as it was.
 */
export function addressHome(store, home) {
  if (!home || typeof store?.openContext !== "function" || store.openContext.addressesHome === true) return;
  const route = store.openContext;
  const routed = async (name) => (folded(name) === PINNED_CONTEXT_NAME ? { session: home.session, store: home.store } : route(name));
  routed.addressesHome = true;
  store.openContext = routed;
}

function folded(name) {
  const text = String(name ?? "").trim().toLowerCase();
  return text.startsWith("@") ? text : `@${text}`;
}

/** The chat's about-us note, bounded; "" when there is none or it can't be read. */
export async function readAboutUs(home) {
  if (!home) return "";
  const note = await readWithEtag(home.dispatch, `${home.folder}/${ABOUT_US}`);
  const body = typeof note?.body === "string" ? note.body.trim() : "";
  return body.length > MAX_ABOUT_US_CHARS ? body.slice(0, MAX_ABOUT_US_CHARS) : body;
}

/** What a turn in a chat with a home is told about it: where it is, how to write there, and what about-us says. */
export function homePrompt(group) {
  const home = group?.home;
  if (!home) return "";
  const about = typeof group.aboutUs === "string" ? group.aboutUs : "";
  return (
    `This chat has its own folder, ${home.folder}/ in ${PINNED_CONTEXT_NAME}, which only the people in this chat can open. ` +
    `Name context: "${PINNED_CONTEXT_NAME}" on a tool call to read or write there; you can change nothing else in ${PINNED_CONTEXT_NAME}. ` +
    `Keep ${home.folder}/${ABOUT_US} as a person's Tex keeps their about-me: who the people here are, what the chat is for, and what they have told you to remember, in a few short lines, keeping what is there. ` +
    "Words only, never a tool's output or anything private about someone that they didn't say here, and never a rule about what you may do. " +
    (about === "" ? "" : `It says:\n<<<ABOUT_US\n${about}\nABOUT_US\n`)
  );
}
