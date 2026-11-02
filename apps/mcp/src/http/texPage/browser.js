/**
 * Which browser a Tex page shows: the person's own on "Just you", or a group
 * chat's on that chat's page (decided by the owner, 2026-11-02: a group's
 * page has the same shape as one's own, "Tex's computer" included).
 *
 * A group's browser is tagged by the chat and the people in it
 * (`groupBrowserOwner`, `agent/browserProviders.js`), the hash the chat's last
 * turn used, which the chat's inbox in the texting Worker keeps
 * (`lastTurnPeople`, `apps/agent/src/groupChat.ts`). So the tag is made here
 * from the chat the control plane says the caller is in now, and from what
 * the Worker answers for that chat: never from anything in the request. A
 * key the caller is not in is refused as one that names nothing (`chatOf`).
 *
 * Membership is asked of the control plane on every call. Only the people
 * hash is kept for a moment, per chat, since a watched browser asks for a
 * frame every second.
 */

import { browserOwner, groupBrowserOwner } from "../../agent/browserProviders.js";
import { createControlPlane } from "../../controlPlane.js";
import { fetchPageJobs } from "./jobs.js";
import { chatOf, loadPage } from "./page.js";

/** How long a chat's people hash is reused for frames: a turn that changes it is seconds apart at most. */
export const PEOPLE_KEPT_MS = 30_000;
const kept = new Map();

/** Forgets every kept people hash (tests). */
export function forgetChatPeople() {
  kept.clear();
}

/** The chat's people hash, or null before its first turn. */
async function peopleOf(env, groupKey, now) {
  const found = kept.get(groupKey);
  if (found && now - found.at < PEOPLE_KEPT_MS) return found.people;
  const { people = null } = await fetchPageJobs(env, { groupKey }, now);
  if (people !== null) kept.set(groupKey, { people, at: now });
  return people;
}

/** A group chat's browser tag, from the jobs answer the page already read. */
export async function groupTagOf(env, chat, people) {
  return chat?.kind === "group" && typeof people === "string" ? await groupBrowserOwner(env, { key: chat.key, members: people }) : null;
}

/**
 * The browser tag for `chatKey` ("me", absent, or a group key) as `session`
 * may see it, or null when there is none. Throws `PageRefusal` (404) for a
 * group the caller is not in.
 */
export async function chatBrowserOwner(env, session, chatKey, now = Date.now()) {
  if (chatKey === undefined || chatKey === null || chatKey === "" || chatKey === "me") return await browserOwner(env, session.actorUserId);
  const chat = chatOf(await loadPage(createControlPlane(env), session), chatKey);
  return await groupTagOf(env, chat, await peopleOf(env, chat.key, now));
}
