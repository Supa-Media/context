/**
 * The folders Tex may work in on this Mac, chosen in the Mac's own folder
 * picker rather than typed as paths on a web page (Dev2, 2026-11-04: "I should've
 * set this up on my laptop, at least when I have the GUI").
 *
 * The gateway keeps them on the computer's row (`/machines/app/set`, owner
 * only) and tells the runner at once. This Mac registered itself in the
 * person's own workspace, so the body names no workspace and the gateway uses
 * the session's (`machines/appRoutes.js`). The console's own token is used, as
 * for registering; nothing here reaches the page but the paths themselves.
 */

import { machineFoldersFrom } from "@context/desktop-bridge";

export interface MachineFoldersDeps {
  consoleToken: () => Promise<string | null>;
  endpoint: () => string | null;
  fetch: typeof fetch;
  /** This Mac's id on the gateway, or null before it registered. */
  machineId: () => Promise<string | null>;
  /** The folder picker: absolute paths, or null when cancelled. */
  pick: () => Promise<string[] | null>;
}

export interface MachineFolders {
  /** What the gateway keeps now, or null when it can't be read (not registered, offline, signed out). */
  read(): Promise<string[] | null>;
  /** Opens the picker; saves what was chosen. Cancel changes nothing and answers `read()`. */
  choose(): Promise<string[] | null>;
}

/** `https://…/machines/app/<route>` for the console's endpoint, or null for one that isn't https (or local http). */
export function appRouteUrl(endpoint: string, route: "list" | "set"): string | null {
  try {
    const u = new URL(endpoint);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return `${u.origin}/machines/app/${route}`;
  } catch {
    return null;
  }
}

export function createMachineFolders(deps: MachineFoldersDeps): MachineFolders {
  async function post(route: "list" | "set", body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const endpoint = deps.endpoint();
    const url = endpoint ? appRouteUrl(endpoint, route) : null;
    const token = await deps.consoleToken();
    if (!url || !token) return null;
    try {
      const response = await deps.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      return answer !== null && typeof answer === "object" && answer.ok === true ? answer : null;
    } catch {
      return null;
    }
  }

  async function read(): Promise<string[] | null> {
    const id = await deps.machineId();
    if (id === null) return null;
    const answer = await post("list", {});
    const machines = Array.isArray(answer?.machines) ? (answer.machines as Array<Record<string, unknown>>) : [];
    const mine = machines.find((m) => m !== null && typeof m === "object" && m.id === id);
    return mine ? machineFoldersFrom(mine.folders ?? []) : null;
  }

  return {
    read,
    async choose() {
      const id = await deps.machineId();
      if (id === null) return null;
      const picked = await deps.pick();
      const folders = picked === null ? null : machineFoldersFrom(picked);
      if (folders === null || folders.length === 0) return await read();
      const answer = await post("set", { machineId: id, patch: { folders } });
      const machine = answer?.machine as Record<string, unknown> | undefined;
      return machine ? machineFoldersFrom(machine.folders ?? []) : await read();
    },
  };
}
