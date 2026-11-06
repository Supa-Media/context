/**
 * Which of a person's own computers a background job runs on
 * (docs/decisions/texting-assistant/machines.md). The texted turn names one
 * when it starts a job (`start_background_job`'s `on_computer`), and this
 * finds it among the machines in the workspaces the person's own texting
 * grant reaches, or, in a group chat, among those lent to it. A chat's own turn reads them beside its history, so it is
 * told they are there (`forTurn.js`). Whether the job may run there is still the workspace object's call
 * at each part (`admit`), under the owner's rules.
 */

import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { lentToChat, TEXTS_CLIENT_ID } from "./reach.js";
import { WORK_FOLDER } from "../workspaceStore/machines.js";

/** Workspaces read for computers: the person's own first, then the ones they help run. */
const MAX_WORKSPACES = 6;
const TOOLS = new Set(["claude", "codex"]);
const REPO = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})?$/;

/**
 * Where the computers are read: the workspace objects, or `MACHINE_STORE` when a
 * deployment binds one in their place, as the benchmark's world does with its
 * invented computers (`bench/world.mjs`). It answers only these reads.
 */
const machineEnv = (env) => (env?.MACHINE_STORE ? { WORKSPACE_STORE: env.MACHINE_STORE } : env);

const read = async (env, workspaceId, op, fields) => {
  const stub = workspaceStub(machineEnv(env), workspaceId);
  if (stub === null) return null;
  try {
    const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
    return await response.json();
  } catch {
    return null;
  }
};

const listed = (workspaceId, machine) => ({ workspaceId, id: machine.id, name: machine.name, online: machine.online === true, tools: machine.tools ?? [], folders: machine.folders ?? [], ownerId: machine.ownerId, os: machine.os ?? machine.facts?.os ?? null, ...(Number.isSafeInteger(machine.limits?.slots) ? { slots: machine.limits.slots } : {}) });

/**
 * The computers this session may name: `{workspaceId, id, name, online, tools, folders, ownerId}`. A person's own
 * texts: own workspace first. A group chat: the computers lent to it (`reach.js`).
 */
export async function machinesFor(env, session, controlPlane = null) {
  if (!machineEnv(env)?.WORKSPACE_STORE) return [];
  const lent = controlPlane === null ? null : await lentToChat(controlPlane, session);
  if (lent !== null) {
    const found = await Promise.all(lent.map(async ({ workspaceId, machineId }) => {
      const answer = await read(env, workspaceId, "ws.machine.get", { id: machineId });
      return answer?.ok === true ? [listed(workspaceId, answer.machine)] : [];
    }));
    return found.flat();
  }
  if (session.actorClientId !== TEXTS_CLIENT_ID) return [];
  const places = (session.workspaces || [])
    .filter((entry) => entry.homeOnly !== true && entry.setupOnly !== true && (entry.workspaceId === session.workspaceId || entry.role === "owner" || entry.role === "editor"))
    .sort((a, b) => Number(b.workspaceId === session.workspaceId) - Number(a.workspaceId === session.workspaceId))
    .slice(0, MAX_WORKSPACES);
  const lists = await Promise.all(
    places.map(async ({ workspaceId }) => {
      const answer = await read(env, workspaceId, "ws.machine.list", {});
      return answer?.ok === true ? answer.machines.map((machine) => listed(workspaceId, machine)) : [];
    }),
  );
  return lists.flat();
}

const plain = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * The computer and how to run on it, from what the turn asked: `{machine}` or `{error}` in words the model acts on.
 * `ask` is `{name, tool?, folder?, repo?}`; a lone computer is found without its name.
 */
export function pickMachine(machines, ask) {
  const named = plain(ask?.name);
  const owned = machines;
  if (owned.length === 0) return { error: ask?.group === true ? "Nobody has lent this chat a computer. Run it in the cloud instead, or tell them a computer's owner can lend it here in Tex's settings." : "They have no computer paired with Tex. Run it in the cloud instead, or tell them they can pair one in Tex's settings." };
  const found = named === "" ? (owned.length === 1 ? owned[0] : null) : (owned.find((machine) => plain(machine.name) === named || machine.id === ask.name) ?? owned.find((machine) => plain(machine.name).includes(named)) ?? null);
  const names = owned.map((machine) => `"${machine.name}"${machine.online ? "" : " (offline)"}`).join(", ");
  if (found === null) return { error: `Name one of their computers: ${names}.` };
  const tool = TOOLS.has(ask?.tool) ? ask.tool : found.tools[0];
  if (!found.tools.includes(tool)) return { error: `"${found.name}" can run ${found.tools.join(" or ") || "no coding tool yet"}.` };
  // None of theirs chosen: the computer's own work folder in its app data, so a sign-in or scratch job needs no setup (owner, 2026-11-05).
  const namedFolder = typeof ask?.folder === "string" && ask.folder.trim() !== "" ? ask.folder.trim() : null;
  const folder = namedFolder ?? found.folders[0] ?? WORK_FOLDER;
  if (folder !== WORK_FOLDER && !found.folders.includes(folder)) return { error: found.folders.length === 0 ? `"${found.name}" has no folder of theirs for Tex yet: leave the folder out and it works in its own folder there, or they add one on its page.` : `On "${found.name}" Tex may work only in ${found.folders.join(", ")}.` };
  // A repo is a name under the folder (`context`, `Supa-Media/context`), never a path that climbs out of it.
  const repo = typeof ask?.repo === "string" && REPO.test(ask.repo.trim()) ? ask.repo.trim() : undefined;
  // `computer`: its id and slots, which the chat counts a job there against (`agent/jobSlots.js`).
  return { machine: { workspaceId: found.workspaceId, machineId: found.id, name: found.name, tool, folder, ...(repo ? { repo } : {}) }, computer: { id: found.id, slots: found.slots } };
}
