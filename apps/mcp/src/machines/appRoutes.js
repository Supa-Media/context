/**
 * The app's screens for a person's own computers
 * (docs/decisions/texting-assistant/machines.md), with the signed-in app's
 * own session (`context_console`):
 *
 * - `POST /machines/app/list` `{ workspaceId }` → `{ ok, machines }`: the
 *   workspace's computers, read from its object. Whoever runs a computer (its
 *   owner or the workspace's owner) sees its
 *   settings, online state, use and running parts; any other member sees only
 *   its name, system, owner and whether it is online.
 * - `POST /machines/app/set` `{ workspaceId, machineId, patch }` → `{ ok,
 *   machine }`: change its settings (name, folders, tools, limits, computer
 *   use, trusted repos, chat rules, what it is good at). The object refuses an
 *   unknown key, and tells the runner the new rules at once.
 * - `POST /machines/app/disconnect` `{ workspaceId, machineId }` → `{ ok,
 *   ended }`: the control plane revokes its grant (and its run grants), then
 *   the object says goodbye on its socket and ends its live runs, so it stops
 *   now and not when its socket next reconnects.
 *
 * - `POST /machines/app/lend` `{ workspaceId, machineId, chat, who?, askFirst? }`
 *   → `{ ok, machine }`: its owner lends it to a group chat they are in
 *   (`chat`, the chat's key). The control plane records the lending, which is
 *   how the group's grant finds it (`reach.js`), and the object keeps who
 *   there may send it work: "Only me" unless the owner says `everyone` or
 *   names people, with "Ask me first" on unless they turn it off.
 * - `POST /machines/app/unlend` `{ workspaceId, machineId, chat }` → `{ ok }`.
 * - `POST /machines/app/raise` `{ workspaceId, machineId, minutes }` → `{ ok,
 *   machine }`: "more time today", added to today's limit and gone tomorrow.
 * - `POST /machines/app/chat-people` `{ chat }` → `{ ok, people: [{ userId,
 *   handle }] }`: a group chat's people, for one of them naming who may use
 *   their computer there (a rule names people by id).
 * - `POST /machines/app/answer` `{ workspaceId, machineId, askId, yes,
 *   always? }` → `{ ok }`: its owner's answer to "Ask me first" (the asks
 *   waiting are listed with the computer, `asks`). A yes holds for that job
 *   for the day; `always` lets that person in that chat in without asking.
 *
 * - `POST /machines/app/sign-in` `{ workspaceId, machineId, tool }` → `{ ok,
 *   machine }`: its own owner signs a coding tool in on it from the app. The
 *   runner starts the tool's sign-in and its link appears on the computer
 *   (`signIn`); then `{ workspaceId, machineId, signInId, code }` hands it the
 *   code that link's page showed. The code goes to the computer and is kept
 *   nowhere on the way.
 *
 * Pairing a computer is approved in the control plane itself
 * (`approveTexMachinePairing`); the runner's poll then adds it to the object.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { groupChatId } from "./reach.js";

const CONSOLE_CLIENT_ID = "context_console";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const MACHINE_APP_PATHS = new Set(["/machines/app/list", "/machines/app/set", "/machines/app/disconnect", "/machines/app/lend", "/machines/app/unlend", "/machines/app/answer", "/machines/app/raise", "/machines/app/chat-people", "/machines/app/sign-in"]);
const CHAT_KEY = /^[0-9a-f]{64}$/;

const forbidden = () => json({ error: "forbidden" }, 403);
const invalid = (detail) => json({ error: "invalid_request", error_description: detail }, 400);
const refused = (code) => json({ ok: false, code });

async function bodyOf(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** The workspace the body names, when this session is a live member of it (never a group's home or setup row). */
function memberOf(session, workspaceId) {
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return null;
  const row = (session.workspaces || []).find((entry) => entry.workspaceId === workspaceId);
  if (!row || row.homeOnly === true || row.setupOnly === true) return null;
  return row;
}

/**
 * Who runs a computer: its owner or the workspace's owner, as the control plane decides who may disconnect it
 * (`revokeMachineAs`). Never another editor: who may send work to a computer is its rules, and another editor
 * who could change them could let themselves onto somebody else's computer.
 */
export function runsMachine(session, row, machine) {
  return machine?.ownerId === session.actorUserId || row.role === "owner";
}

async function call(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
  return await response.json();
}

/** What another member sees of a computer they don't run. */
const glimpse = (machine) => ({ id: machine.id, name: machine.name, os: machine.os ?? null, ownerId: machine.ownerId, online: machine.online === true });

/**
 * The asks waiting on a computer this person runs, each with who asked by handle when the ask came from a group chat
 * they are in (read from the control plane, one read per chat): a card says "@ade asks", not only the chat.
 */
async function namedAsks(machines, session, controlPlane) {
  const keys = [...new Set(machines.flatMap((machine) => (machine.asks ?? []).map((ask) => ask.chatKey)).filter((key) => typeof key === "string" && CHAT_KEY.test(key)))].slice(0, 10);
  const handles = new Map();
  await Promise.all(keys.map(async (key) => {
    const people = await controlPlane.texMachineChatPeople(session.actorUserId, key).catch(() => null);
    for (const person of people ?? []) if (typeof person?.userId === "string" && typeof person.handle === "string" && person.handle !== "") handles.set(`${key}:${person.userId}`, person.handle);
  }));
  return machines.map((machine) => ({ ...machine, asks: (machine.asks ?? []).map(({ chatKey, ...ask }) => ({ ...ask, askerHandle: handles.get(`${chatKey}:${ask.askerId}`) ?? null })) }));
}

async function list(env, session, body, controlPlane) {
  const row = memberOf(session, body.workspaceId);
  if (row === null) return refused("unknown_workspace");
  const answer = await call(env, row.workspaceId, "ws.machine.list", {});
  if (answer === null) return json({ error: "machines_unavailable" }, 501);
  if (answer.ok !== true) return refused(answer.code ?? "server_error");
  // A sign-in's link is the computer's own owner's: a workspace owner who runs it sees that one is under way, not the link.
  const own = (machine) => (machine.ownerId === session.actorUserId || !machine.signIn ? machine : { ...machine, signIn: { ...machine.signIn, url: undefined } });
  const run = answer.machines.filter((machine) => runsMachine(session, row, machine)).map((machine) => ({ ...own(machine), runs: true }));
  const named = new Map((await namedAsks(run, session, controlPlane)).map((machine) => [machine.id, machine]));
  return json({ ok: true, machines: answer.machines.map((machine) => named.get(machine.id) ?? glimpse(machine)) });
}

/** A chat's people with their ids, for its member choosing who may use their computer there; nothing for anyone else. */
async function chatPeople(session, body, controlPlane) {
  if (typeof body.chat !== "string" || !CHAT_KEY.test(body.chat)) return invalid("chat");
  const people = await controlPlane.texMachineChatPeople(session.actorUserId, body.chat);
  return people === null ? refused("unknown_chat") : json({ ok: true, people: people.map(({ userId, handle }) => ({ userId, handle })) });
}

/** "More time today" on a computer this person runs: today's limit only, gone tomorrow. */
async function raise(env, session, body) {
  if (!Number.isSafeInteger(body.minutes) || body.minutes < 1 || body.minutes > 24 * 60) return invalid("minutes");
  const found = await runnable(env, session, body);
  if (found === null) return refused("unknown_machine");
  const answer = await call(env, found.row.workspaceId, "ws.machine.raise", { id: found.machine.id, minutes: body.minutes });
  return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
}

/** The computer, when this session may run it; null reads the same as no such computer. */
async function runnable(env, session, body) {
  const row = memberOf(session, body.workspaceId);
  if (row === null || typeof body.machineId !== "string" || !ID.test(body.machineId)) return null;
  const answer = await call(env, row.workspaceId, "ws.machine.get", { id: body.machineId });
  if (answer?.ok !== true || !runsMachine(session, row, answer.machine)) return null;
  return { row, machine: answer.machine };
}

async function set(env, session, body) {
  if (body.patch === null || typeof body.patch !== "object" || Array.isArray(body.patch)) return invalid("patch");
  const found = await runnable(env, session, body);
  if (found === null) return refused("unknown_machine");
  const answer = await call(env, found.row.workspaceId, "ws.machine.set", { id: found.machine.id, patch: body.patch });
  return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
}

async function disconnect(env, session, body, controlPlane) {
  const found = await runnable(env, session, body);
  if (found === null) return refused("unknown_machine");
  // The control plane decides too (`revokeMachineAs`): its owner or the workspace's owner. Its grant goes first,
  // so a computer that is not told (offline, or the object unreachable) still can't reconnect.
  const revoked = await controlPlane.texMachineRevoke(found.machine.id, session.actorUserId);
  if (revoked === null || revoked.workspaceId !== found.row.workspaceId) return refused("not_allowed");
  const answer = await call(env, found.row.workspaceId, "ws.machine.remove", { id: found.machine.id, reason: "revoked" }).catch(() => null);
  return json({ ok: true, ended: answer?.ok === true ? answer.ended.length : 0 });
}

/** Its own owner only: a computer is lent by the person whose computer it is, never by a workspace owner. */
async function ownComputer(env, session, body) {
  const found = await runnable(env, session, body);
  return found !== null && found.machine.ownerId === session.actorUserId ? found : null;
}

async function lend(env, session, body, controlPlane) {
  if (typeof body.chat !== "string" || !CHAT_KEY.test(body.chat)) return invalid("chat");
  const found = await ownComputer(env, session, body);
  if (found === null) return refused("unknown_machine");
  // The control plane checks they are one of the chat's people.
  const lent = await controlPlane.texMachineChatAttach(session.actorUserId, found.machine.id, body.chat);
  if (lent?.attached !== true) return refused(lent?.refused === 409 ? "too_many" : "unknown_chat");
  const who = body.who === "everyone" ? "everyone" : Array.isArray(body.who) ? body.who : "owner";
  const rule = { ...(found.machine.chats?.[groupChatId(body.chat)] ?? {}), who, askFirst: body.askFirst !== false };
  const answer = await call(env, found.row.workspaceId, "ws.machine.set", { id: found.machine.id, patch: { chats: { ...found.machine.chats, [groupChatId(body.chat)]: rule } } });
  return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
}

async function unlend(env, session, body, controlPlane) {
  if (typeof body.chat !== "string" || !CHAT_KEY.test(body.chat)) return invalid("chat");
  const found = await ownComputer(env, session, body);
  if (found === null) return refused("unknown_machine");
  // The lending goes first: once it has, the group's grant no longer finds the computer, whatever the rule says.
  if ((await controlPlane.texMachineChatDetach(session.actorUserId, found.machine.id, body.chat)) === null) return refused("unknown_machine");
  const { [groupChatId(body.chat)]: _gone, ...chats } = found.machine.chats ?? {};
  const answer = await call(env, found.row.workspaceId, "ws.machine.set", { id: found.machine.id, patch: { chats } });
  return json({ ok: answer?.ok === true });
}

async function answerAsk(env, session, body) {
  if (typeof body.askId !== "string" || !ID.test(body.askId)) return invalid("askId");
  // Only the computer's own owner answers: it is their yes "Ask me first" waits for.
  const found = await ownComputer(env, session, body);
  if (found === null) return refused("unknown_machine");
  const answer = await call(env, found.row.workspaceId, "ws.machine.answer", { id: found.machine.id, askId: body.askId, yes: body.yes === true, always: body.always === true });
  return answer?.ok === true ? json({ ok: true }) : refused(answer?.code ?? "server_error");
}

const TOOLS = new Set(["claude", "codex"]);
const SIGN_IN_ID = /^si_[0-9a-f]{24}$/;
const CODE = /^[A-Za-z0-9#_.~-]{1,512}$/;

async function signIn(env, session, body) {
  // Their own computer only: a workspace owner never signs their account in on somebody else's.
  const found = await ownComputer(env, session, body);
  if (found === null) return refused("unknown_machine");
  if (body.code === undefined) {
    if (!TOOLS.has(body.tool)) return invalid("tool");
    const answer = await call(env, found.row.workspaceId, "ws.machine.signIn", { id: found.machine.id, tool: body.tool });
    return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
  }
  if (typeof body.signInId !== "string" || !SIGN_IN_ID.test(body.signInId)) return invalid("signInId");
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!CODE.test(code)) return refused("bad_code");
  const answer = await call(env, found.row.workspaceId, "ws.machine.signIn", { id: found.machine.id, signInId: body.signInId, code });
  return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
}

/** One of `MACHINE_APP_PATHS`, for a session already resolved from the app's own token. */
export async function handleMachineApp(request, env, session, { path, controlPlane }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (session.actorClientId !== CONSOLE_CLIENT_ID) return forbidden();
  if (path !== "/machines/app/list" && path !== "/machines/app/chat-people" && !hasScope(session, SCOPE_WRITE)) return forbidden();
  if (!env.WORKSPACE_STORE) return json({ error: "machines_unavailable" }, 501);
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  if (path === "/machines/app/list") return await list(env, session, body, controlPlane);
  if (path === "/machines/app/chat-people") return await chatPeople(session, body, controlPlane);
  if (path === "/machines/app/set") return await set(env, session, body);
  if (path === "/machines/app/disconnect") return await disconnect(env, session, body, controlPlane);
  if (path === "/machines/app/lend") return await lend(env, session, body, controlPlane);
  if (path === "/machines/app/unlend") return await unlend(env, session, body, controlPlane);
  if (path === "/machines/app/answer") return await answerAsk(env, session, body);
  if (path === "/machines/app/raise") return await raise(env, session, body);
  if (path === "/machines/app/sign-in") return await signIn(env, session, body);
  return new Response(null, { status: 404 });
}
