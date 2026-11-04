/**
 * Which of a person's own computers a background job runs on
 * (docs/decisions/texting-assistant/machines.md). The texted turn names one
 * when it starts a job (`start_background_job`'s `on_computer`), and this
 * finds it among the machines in the workspaces the person's own texting
 * grant reaches. Read only when a job asks for a computer, never on every
 * text. Whether the job may run there is still the workspace object's call
 * at each part (`admit`), under the owner's rules.
 */

import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";

const TEXTS_CLIENT_ID = "context_texts";
/** Workspaces read for computers: the person's own first, then the ones they help run. */
const MAX_WORKSPACES = 6;
const TOOLS = new Set(["claude", "codex"]);
const REPO = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})?$/;

/** The computers this session may name: `{workspaceId, id, name, online, tools, folders, ownerId}`, own workspace first. */
export async function machinesFor(env, session) {
  if (session.actorClientId !== TEXTS_CLIENT_ID || !env.WORKSPACE_STORE) return [];
  const places = (session.workspaces || [])
    .filter((entry) => entry.homeOnly !== true && entry.setupOnly !== true && (entry.workspaceId === session.workspaceId || entry.role === "owner" || entry.role === "editor"))
    .sort((a, b) => Number(b.workspaceId === session.workspaceId) - Number(a.workspaceId === session.workspaceId))
    .slice(0, MAX_WORKSPACES);
  const lists = await Promise.all(
    places.map(async ({ workspaceId }) => {
      const stub = workspaceStub(env, workspaceId);
      if (stub === null) return [];
      try {
        const response = await callTexStore(stub, "ws.machine.list", {}, new TextEncoder().encode(JSON.stringify({ workspaceId })));
        const answer = await response.json();
        return answer?.ok === true ? answer.machines.map((machine) => ({ workspaceId, id: machine.id, name: machine.name, online: machine.online === true, tools: machine.tools ?? [], folders: machine.folders ?? [], ownerId: machine.ownerId })) : [];
      } catch {
        return [];
      }
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
  if (owned.length === 0) return { error: "They have no computer paired with Tex. Run it in the cloud instead, or tell them they can pair one in Tex's settings." };
  const found = named === "" ? (owned.length === 1 ? owned[0] : null) : (owned.find((machine) => plain(machine.name) === named || machine.id === ask.name) ?? owned.find((machine) => plain(machine.name).includes(named)) ?? null);
  const names = owned.map((machine) => `"${machine.name}"${machine.online ? "" : " (offline)"}`).join(", ");
  if (found === null) return { error: `Name one of their computers: ${names}.` };
  const tool = TOOLS.has(ask?.tool) ? ask.tool : found.tools[0];
  if (!found.tools.includes(tool)) return { error: `"${found.name}" can run ${found.tools.join(" or ") || "no coding tool yet"}.` };
  const folder = typeof ask?.folder === "string" && ask.folder.trim() !== "" ? ask.folder.trim() : found.folders[0];
  if (!found.folders.includes(folder)) return { error: found.folders.length === 0 ? `"${found.name}" has no folder Tex may work in yet: they choose one in Tex's settings.` : `On "${found.name}" Tex may work only in ${found.folders.join(", ")}.` };
  // A repo is a name under the folder (`context`, `Supa-Media/context`), never a path that climbs out of it.
  const repo = typeof ask?.repo === "string" && REPO.test(ask.repo.trim()) ? ask.repo.trim() : undefined;
  return { machine: { workspaceId: found.workspaceId, machineId: found.id, name: found.name, tool, folder, ...(repo ? { repo } : {}) } };
}
