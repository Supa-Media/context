/**
 * Where real chats are answered: every chat lives in the gateway's `TexChat`, born there on its first call (part C of the
 * runtime simplification, Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX; the texting Worker's
 * SenderInbox class was deleted on 2026-11-25, after a census proved every box moved or archived,
 * `docs/decisions/texting-assistant/chat-in-gateway.md`).
 *
 * The op `intake` on the Lab's route, for a Tex developer and only for chats of their own: their 1:1 (`me`) and the
 * group chats they are in, as `chats` lists them.
 *
 *  - `{ op: "intake" }` → `{ chats: [{ chatId, name, kind, home }] }`: "gateway" once the chat has had its first call,
 *    "none" before ("unknown" when its name cannot be worked out, a group Tex has no directory entry for).
 *  - `{ op: "intake", chatId }` → that one chat's home.
 *  - `{ op: "intake", sweep: true, after? }` → every chat Tex can name (each linked phone's 1:1 and each group, as the
 *    control plane lists them for staff), `SWEEP_BATCH` at a time from `after`: counts of where they are, and `next`
 *    naming the following batch. Counts only, never a chat. Asking a chat its home indexes it by id (`texChat/byId.js`).
 *
 * Nothing here answers or logs an inbox's name: a 1:1's is the person's phone number, and a group's its line's id.
 */

import { json } from "../fromGateway/http_responses.js";
import { objectByName } from "../fromGateway/objectPlace.js";

const CHAT_KEY = /^[0-9a-f]{64}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const refused = (status, error) => json({ error }, status);

/** The caller's chats, as `chats` lists them: the 1:1 first, then each group they are in. */
function chatsOf(who) {
  const groups = (Array.isArray(who.chats) ? who.chats : [])
    .filter((chat) => CHAT_KEY.test(chat?.key ?? ""))
    .map((chat) => ({ chatId: chat.key, name: String(chat.name ?? "Group chat"), kind: "group" }));
  return [{ chatId: "me", name: "You and Tex", kind: "1:1" }, ...groups];
}

/**
 * The inbox name for a chat, or null: a 1:1's is the person's phone number (as the line hands it over, E.164); a
 * group's is `sendblue-group:<its id>`, read from the group's directory entry in the gateway
 * (`packages/tex/gateway/texChat/directory.js`), as a group routine finds its chat (`packages/tex/worker/index.ts` `runInChat`).
 */
export async function inboxNameOf(env, who, chat) {
  if (chat.kind === "1:1") return typeof who.phone === "string" && PHONE.test(who.phone) ? who.phone : null;
  if (env.TEX_CHAT === undefined) return null;
  const name = `group-key:${chat.chatId}`;
  const found = await objectByName(env.TEX_CHAT, `chat:${name}`)
    .fetch("https://chat/chat-call/chat-where", { method: "GET", headers: { "x-inbox-name": name } })
    .catch(() => null);
  if (!found?.ok) return null;
  const where = await found.json().catch(() => null);
  return typeof where?.groupId === "string" && where.groupId !== "" && where.groupId.length <= 400 ? `sendblue-group:${where.groupId}` : null;
}

/** Where a chat is answered, asked of its gateway object: "gateway" once it has had its first call, else "none". */
async function homeAt(env, name) {
  const answer = await objectByName(env.TEX_CHAT, `chat:${name}`).fetch("https://chat/home", { method: "GET" });
  if (!answer.ok) return { home: "unknown" };
  const body = await answer.json().catch(() => ({}));
  return {
    home: body.home === "gateway" ? "gateway" : "none",
    ...(Number.isFinite(body.movedAt) ? { movedAt: body.movedAt } : {}),
    ...(Number.isSafeInteger(body.keys) ? { keys: body.keys } : {}),
  };
}

/** How many chats one sweep call looks at: each is a call to its object. */
export const SWEEP_BATCH = 25;

/** `intake { sweep }`: one batch of every chat, counted by home. */
async function sweep(env, input, { controlPlane, token }) {
  const listed = await controlPlane.labSandbox(token, "intakeChats", {}).catch(() => null);
  if (listed === null) return refused(503, "the control plane did not answer");
  if (listed.status === "refused") return refused(403, "Only staff sweep every chat.");
  if (listed.status !== "ok") return refused(502, `the control plane answered ${listed.status} to the chat list`);
  const phones = (Array.isArray(listed.phones) ? listed.phones : []).filter((phone) => typeof phone === "string" && PHONE.test(phone));
  const groups = (Array.isArray(listed.groups) ? listed.groups : []).filter((key) => typeof key === "string" && CHAT_KEY.test(key));
  const all = [...phones.map((phone) => ({ kind: "1:1", phone })), ...groups.map((key) => ({ kind: "group", chatId: key }))];
  const after = Number.isSafeInteger(input.after) && input.after > 0 ? input.after : 0;
  const batch = all.slice(after, after + SWEEP_BATCH);
  const counts = { gateway: 0, none: 0, unknown: 0 };
  for (const chat of batch) {
    const name = await inboxNameOf(env, { phone: chat.phone }, chat);
    if (name === null) {
      counts.unknown += 1;
      continue;
    }
    counts[(await homeAt(env, name)).home] += 1;
  }
  const next = after + batch.length < all.length ? after + batch.length : null;
  console.log(JSON.stringify({ event: "lab_intake_sweep", after, ...counts }));
  return json({ total: all.length, people: phones.length, groups: groups.length, after, looked: batch.length, ...counts, next });
}

/** `intake`: the caller's chats and where each is answered. */
export async function intake(env, who, input, plane = {}) {
  if (env?.TEX_CHAT === undefined) return refused(501, "this deployment has no chat objects");
  if (input.sweep === true) return await sweep(env, input, plane);
  const chats = chatsOf(who);
  if (input.chatId === undefined) {
    const listed = [];
    for (const chat of chats) {
      const name = await inboxNameOf(env, who, chat);
      listed.push({ ...chat, ...(name === null ? { home: "unknown" } : await homeAt(env, name)) });
    }
    return json({ chats: listed });
  }
  const chat = chats.find((c) => c.chatId === input.chatId);
  if (chat === undefined) return refused(404, 'Name one of your own chats: "me" or a group\'s chatId (intake with no chatId lists them).');
  const name = await inboxNameOf(env, who, chat);
  if (name === null) return refused(404, chat.kind === "1:1" ? "Your account has no phone number linked." : "Tex has no record of where that group is yet.");
  const home = await homeAt(env, name);
  console.log(JSON.stringify({ event: "lab_intake", kind: chat.kind, home: home.home, keys: home.keys ?? null }));
  return json({ ...chat, ...home });
}
