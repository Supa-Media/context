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
 * The Worker's inbox name for a chat, or null: a 1:1's is the person's phone number (as the line hands it over, E.164);
 * a group's is `sendblue-group:<its id>`, read from the group's directory entry in the Worker (`groupRoutines.ts`), as
 * a group routine finds its chat (`packages/tex/worker/index.ts` `runInChat`).
 */
export async function inboxNameOf(env, who, chat) {
  if (chat.kind === "1:1") return typeof who.phone === "string" && PHONE.test(who.phone) ? who.phone : null;
  if (env.TEXTING === undefined) return null;
  const found = await env.TEXTING.inboxFetch({ name: `enam:group-key:${chat.chatId}` }, new Request("https://inbox/chat-where", { method: "GET" })).catch(() => null);
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

/** `intake`: the caller's chats and where each is answered, or one moved in. */
export async function intake(env, who, input) {
  if (env?.TEX_CHAT === undefined) return refused(501, "this deployment has no chat objects");
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
