/**
 * "ASK ME FIRST" IN THE GROUP CHAT ITSELF (Dev2, 2026-11-04: "it should send
 * it to the groupchat actually, and wait for the owner to thumbs it up").
 *
 * A job a group chat sends to a lent computer whose owner asks first used to
 * wait on a card in the owner's app, which nobody was told about. Now:
 *
 *  - the first time a job's ask is made (`ws.machine.assign` answers
 *    `ask_first` with `fresh`), the gateway answers the job with this line,
 *    naming the owner by handle; the job hands it to the chat's Tex as its
 *    report's `ask` (`apps/agent/src/machineTurn.ts`), which texts it word for
 *    word (`agent/jobReport.js` `reportReply`);
 *  - a 👍 or ❤️ on it from the computer's owner, and only the owner, is the
 *    yes, and a 👎 the no (`machineThumb`, before any other approval is read:
 *    `agent/texEntryPoint/settleAYesOrNo.js`). The job, waiting on the ask,
 *    starts on its next look.
 *
 * Whose thumb it is comes from the turn's grant (a group turn runs on the
 * sender's own grant), never from the words; the words only choose which
 * ask, by its title. A guest's tapback runs on the binder's grant and is
 * never the owner's. The card in the app answers the same ask as before.
 */

import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { folded } from "../agent/folded.js";
import { jobChatOf, lentToChat } from "./reach.js";

/** What every machine ask says, and what the Worker's thumbs read as an ask (`apps/agent/src/thumbs.ts` `ASK`). */
export const MACHINE_ASK_OPENING = "Give this a 👍 and I'll start";
const HANDLE = /^[a-z0-9][a-z0-9_-]{0,38}$/i;
const MAX_TITLE = 120;

function plain(text, max) {
  return String(text ?? "").replace(/["\s]+/g, " ").trim().slice(0, max);
}

/**
 * The ask the chat is texted, in the gateway's words: the job by its title, the computer by its name, its owner by
 * handle when the asker's chat knows them.
 */
export function machineAskLine({ title, machineName, ownerHandle = null }) {
  const owner = typeof ownerHandle === "string" && HANDLE.test(ownerHandle) ? ownerHandle : null;
  const what = `"${plain(title, MAX_TITLE) || "this job"}" on ${owner ? `@${owner}'s` : "the"} computer "${plain(machineName, 60) || "computer"}"`;
  return `${owner ? `@${owner}: ` : ""}${MACHINE_ASK_OPENING} ${what}. Only ${owner ? `@${owner}` : "its owner"} can OK it; a 👎 says no.`;
}

/** The owner's handle among the asking chat's people, or null. */
export async function ownerHandleIn(controlPlane, session, ownerId) {
  if (typeof session?.texChatId !== "string" || typeof ownerId !== "string") return null;
  // A handle is a nicety: any failure to read the chat's people leaves the line naming no one.
  const people = await Promise.resolve().then(() => controlPlane.texMachineChatPeople(session.actorUserId, session.texChatId)).catch(() => null);
  const owner = (people ?? []).find((person) => person?.userId === ownerId && typeof person.handle === "string");
  return owner && HANDLE.test(owner.handle) ? owner.handle : null;
}

async function call(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
  return await response.json();
}

/**
 * A tapback in a group chat on one of these asks, from the owner of the computer it waits on: answers that ask.
 * `{ yes, title, name }` when it did; null for any other tapback, anyone else's, or no such ask waiting.
 */
export async function machineThumb(env, session, quoted, controlPlane, { guest = false } = {}) {
  const yes = quoted?.tapback === "Liked" || quoted?.tapback === "Loved";
  if (guest || (!yes && quoted?.tapback !== "Disliked")) return null;
  const words = folded(quoted.words);
  if (!words.includes(folded(MACHINE_ASK_OPENING))) return null;
  const chat = jobChatOf(session);
  if (chat === null || !env.WORKSPACE_STORE) return null;
  // Only the computers this person lent this chat: their own, read from the control plane, never from the words.
  const lent = ((await lentToChat(controlPlane, session)) ?? []).filter((entry) => entry.ownerId === session.actorUserId);
  for (const entry of lent) {
    const got = await call(env, entry.workspaceId, "ws.machine.get", { id: entry.machineId }).catch(() => null);
    const machine = got?.ok === true ? got.machine : null;
    if (machine === null || machine.ownerId !== session.actorUserId) continue;
    // The ask this text was: from this chat, on this computer, its title and the computer's name in the words.
    // Compared as the line cut them (`machineAskLine`), and never on an empty title or name.
    const name = folded(plain(machine.name, 60));
    const titled = (waiting) => folded(plain(waiting.title, MAX_TITLE));
    const ask = (machine.asks ?? []).find((waiting) => waiting.chat === chat && typeof waiting.title === "string" && titled(waiting) !== "" && name !== "" && words.includes(titled(waiting)) && words.includes(name));
    if (ask === undefined) continue;
    const answered = await call(env, entry.workspaceId, "ws.machine.answer", { id: machine.id, askId: ask.id, yes }).catch(() => null);
    if (answered?.ok !== true) continue;
    return { yes, title: plain(ask.title, MAX_TITLE), name: plain(machine.name, 60) };
  }
  return null;
}

/** What Tex says to the owner's tapback, in the gateway's words. */
export function machineThumbLine({ yes, title, name }) {
  // "can run", not "is running": a job that stopped waiting starts on its next try (`apps/agent/src/machineTurn.ts`).
  return yes ? `Thanks, "${title}" can run on ${name} now.` : `OK, "${title}" won't run on ${name}.`;
}
