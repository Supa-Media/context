/**
 * Which computers a job's grant reaches (docs/decisions/texting-assistant/machines.md):
 *
 * - A person's own texts (`context_texts`): every computer in the workspaces
 *   their grant covers as a member, their own first.
 * - A group chat (`context_texts_group`): only the computers their owners lent
 *   that chat ("use my Studio Mac here"), read from the control plane at each
 *   call (`texMachinesForChat`), live and with their owner still in the chat.
 *   A group's grant reaches only its shared workspace, never a person's own,
 *   so a lent laptop is reached through the lending, not the grant.
 *
 * Who in the chat may send it work, and whether its owner asks first, is the
 * computer's own rule in its workspace object (`machines.js` `admit`), under
 * the chat's key from `jobChatOf`.
 */

export const TEXTS_CLIENT_ID = "context_texts";
export const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/** The chat a job's ask comes from, as the owner's rules name it: `texts-<user>` for their own texts, `group-<key>` for a group. */
export function jobChatOf(session) {
  if (session.actorClientId === TEXTS_CLIENT_ID) return `texts-${session.actorUserId}`;
  if (session.actorClientId === TEXTS_GROUP_CLIENT_ID && CHAT_KEY.test(session.texChatId ?? "")) return groupChatId(session.texChatId);
  return null;
}

/** A group chat's key in a computer's rules: within the 64 characters a rule's key may have. */
export function groupChatId(groupKey) {
  return `group-${groupKey.slice(0, 58)}`;
}

/** The computers lent to this group chat, or null when the session is not a group's. */
export async function lentToChat(controlPlane, session) {
  if (session.actorClientId !== TEXTS_GROUP_CLIENT_ID || !CHAT_KEY.test(session.texChatId ?? "")) return null;
  const lent = await controlPlane.texMachinesForChat(session.texChatId).catch(() => []);
  return lent.filter((entry) => ID.test(entry?.workspaceId ?? "") && ID.test(entry?.machineId ?? ""));
}

/**
 * The workspace a job's call names, when this grant reaches a computer there, or null. A person's own texts reach
 * the workspaces they are a member of; a group reaches only those a lent computer is in (and, given `machineId`, only
 * that computer).
 */
export async function reachedWorkspace(session, controlPlane, workspaceId, machineId = null) {
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return null;
  const lent = await lentToChat(controlPlane, session);
  if (lent !== null) {
    const hit = lent.find((entry) => entry.workspaceId === workspaceId && (machineId === null || entry.machineId === machineId));
    return hit ? { workspaceId } : null;
  }
  const covered = (session.workspaces || []).find((entry) => entry.workspaceId === workspaceId);
  if (!covered || covered.homeOnly === true || covered.setupOnly === true) return null;
  return covered;
}
