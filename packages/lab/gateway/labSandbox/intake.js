/**
 * Moving a real chat into the gateway, one at a time, before the texting Worker hands every chat over (`INTAKE`, step 2
 * of the runtime simplification Dev2 approved on 2026-11-21: "test on your chat first, then Tex Devs, then everyone";
 * `docs/decisions/texting-assistant/chat-in-gateway.md`).
 *
 * The op `intake` on the Lab's route, for a Tex developer and only for chats of their own: their 1:1 (`me`) and the
 * group chats they are in, as `chats` lists them.
 *
 *  - `{ op: "intake" }` → `{ chats: [{ chatId, name, kind, home }] }`: where each is answered now, "gateway" or
 *    "worker" ("unknown" when its name cannot be worked out, a group Tex has no directory entry for).
 *  - `{ op: "intake", chatId, move: true }` → copies that chat in now, the same copy a handed-over text starts
 *    (`packages/tex/gateway/texChat.js` `moveIn`), and answers its home after. A chat whose Worker object is busy
 *    (a turn running) is refused and stays where it is; asked again a couple of minutes later, it moves.
 *  - `{ op: "intake", sweep: true, after?, move? }` → every chat Tex can name (each linked phone's 1:1 and each group,
 *    as the control plane lists them for staff), `SWEEP_BATCH` at a time from `after`: counts of where they are
 *    answered, and with `move: true` each one still in the Worker copied in. `next` names the following batch. Counts
 *    only, never a chat: this is how the last chats move after `INTAKE` flips, and how "none left" is proven.
 *  - `{ op: "intake", workerIds: [<object id>, ...] }` → for staff, what each of the texting Worker's SenderInbox
 *    objects still holds (`packages/tex/worker/workerCensus.ts`, at most 50 ids a call, listed from Cloudflare's API):
 *    moved, purged, empty, or here by kind, with the ids of those here. How the Worker's class is proven empty
 *    before it is deleted (Dev2 chose "sweep, then delete", 2026-11-22). With `match: true`, each object still holding
 *    data also says which kind of chat it was made from (`1:1`, `group`, `directory`, or null when no name Tex knows
 *    hashes to it) and whether the gateway holds that chat, with its masked key names; never the name.
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
 * (`packages/tex/gateway/texChat/directory.js`, which reads the texting Worker's entry once when it holds none yet), as
 * a group routine finds its chat (`packages/tex/worker/index.ts` `runInChat`).
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

/** Where a chat is answered, asked of its gateway object; `move` copies it in first. */
async function homeAt(env, name, move) {
  const stub = objectByName(env.TEX_CHAT, `chat:${name}`);
  const answer = move
    ? await stub.fetch("https://chat/move-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inbox: name }) })
    : await stub.fetch("https://chat/home", { method: "GET" });
  if (!answer.ok) return { home: "unknown" };
  const body = await answer.json().catch(() => ({}));
  return {
    home: body.home === "gateway" ? "gateway" : "worker",
    ...(Number.isFinite(body.movedAt) ? { movedAt: body.movedAt } : {}),
    ...(Number.isSafeInteger(body.keys) ? { keys: body.keys } : {}),
    ...(body.refused === true ? { refused: "The chat was busy or its copy failed; it is still answered by the texting Worker. Try again in a couple of minutes." } : {}),
  };
}

/** How many chats one sweep call looks at: each is a call to its object, and a move a copy of it. */
export const SWEEP_BATCH = 25;

/** `intake { sweep }`: one batch of every chat, counted by home, the ones still in the Worker moved when `move`. */
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
  const counts = { gateway: 0, worker: 0, moved: 0, refused: 0, unknown: 0 };
  for (const chat of batch) {
    const name = await inboxNameOf(env, { phone: chat.phone }, chat);
    if (name === null) {
      counts.unknown += 1;
      continue;
    }
    const before = await homeAt(env, name, false);
    if (before.home === "gateway") counts.gateway += 1;
    else if (before.home !== "worker") counts.unknown += 1;
    else if (input.move !== true) counts.worker += 1;
    else {
      const moved = await homeAt(env, name, true);
      if (moved.home === "gateway") counts.moved += 1;
      else counts.refused += 1;
    }
  }
  const next = after + batch.length < all.length ? after + batch.length : null;
  console.log(JSON.stringify({ event: "lab_intake_sweep", move: input.move === true, after, ...counts }));
  return json({ total: all.length, people: phones.length, groups: groups.length, after, looked: batch.length, ...counts, next });
}

/** `intake { workerIds }`: the Worker's objects by id, counted by what they hold; staff only, as `sweep` is. */
async function workerCensus(env, input, { controlPlane, token }) {
  if (typeof env?.TEXTING?.census !== "function") return refused(501, "this deployment has no texting Worker to count");
  const listed = await controlPlane.labSandbox(token, "intakeChats", {}).catch(() => null);
  if (listed === null) return refused(503, "the control plane did not answer");
  if (listed.status === "refused") return refused(403, "Only staff count the Worker's objects.");
  if (listed.status !== "ok") return refused(502, `the control plane answered ${listed.status} to the chat list`);
  if (input.workerIds.length > 50 || input.workerIds.some((id) => typeof id !== "string" || !CHAT_KEY.test(id))) return refused(400, "workerIds: at most 50 object ids, each 64 hex.");
  if (input.match !== true) return json(await env.TEXTING.census({ ids: input.workerIds }));
  // Every name Tex can work out for a chat: each linked phone's 1:1, each group's directory entry and its group chat.
  // The Worker hashes them and answers, for each object still holding data, which one it was made from by index; the
  // names never leave the gateway, and the answer says only what kind of chat matched and whether the gateway holds it.
  const phones = (Array.isArray(listed.phones) ? listed.phones : []).filter((phone) => typeof phone === "string" && PHONE.test(phone));
  const groups = (Array.isArray(listed.groups) ? listed.groups : []).filter((key) => typeof key === "string" && CHAT_KEY.test(key));
  const candidates = phones.map((phone) => ({ name: phone, match: "1:1" }));
  for (const key of groups) {
    // Reading the entry in the gateway copies the Worker's in when the gateway has none (`texChat/directory.js`).
    const groupName = await inboxNameOf(env, {}, { kind: "group", chatId: key }).catch(() => null);
    candidates.push({ name: `group-key:${key}`, match: "directory", held: groupName !== null });
    if (groupName !== null) candidates.push({ name: groupName, match: "group" });
  }
  const counts = await env.TEXTING.census({ ids: input.workerIds, names: candidates.map((candidate) => candidate.name) });
  const hereObjects = [];
  for (const object of counts.hereObjects ?? []) {
    const { named, ...rest } = object;
    const candidate = Number.isSafeInteger(named) ? candidates[named] : undefined;
    if (candidate === undefined) {
      hereObjects.push({ ...rest, match: null });
      continue;
    }
    const inGateway = candidate.match === "directory" ? candidate.held : (await homeAt(env, candidate.name, false)).home === "gateway";
    hereObjects.push({ ...rest, match: candidate.match, inGateway });
  }
  return json({ ...counts, hereObjects, names: { people: phones.length, groups: groups.length } });
}

/** `intake`: the caller's chats and where each is answered, or one moved in. */
export async function intake(env, who, input, plane = {}) {
  if (env?.TEX_CHAT === undefined) return refused(501, "this deployment has no chat objects");
  if (input.sweep === true) return await sweep(env, input, plane);
  if (Array.isArray(input.workerIds)) return await workerCensus(env, input, plane);
  const chats = chatsOf(who);
  if (input.chatId === undefined) {
    const listed = [];
    for (const chat of chats) {
      const name = await inboxNameOf(env, who, chat);
      listed.push({ ...chat, ...(name === null ? { home: "unknown" } : await homeAt(env, name, false)) });
    }
    return json({ chats: listed });
  }
  const chat = chats.find((c) => c.chatId === input.chatId);
  if (chat === undefined) return refused(404, 'Name one of your own chats: "me" or a group\'s chatId (intake with no chatId lists them).');
  const name = await inboxNameOf(env, who, chat);
  if (name === null) return refused(404, chat.kind === "1:1" ? "Your account has no phone number linked." : "Tex has no record of where that group is yet.");
  const home = await homeAt(env, name, input.move === true);
  console.log(JSON.stringify({ event: "lab_intake", kind: chat.kind, move: input.move === true, home: home.home, keys: home.keys ?? null }));
  return json({ ...chat, ...home });
}
