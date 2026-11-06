/**
 * The folders Tex may work in on this Mac, read and saved by the page with
 * its own console grant (`/machines/app/{list,set}`), the only client the
 * gateway lets change a computer (`apps/mcp/src/machines/appRoutes.js`). The
 * Mac app only opens its folder picker and names its own id (bridge version
 * 12): version 11 saved from the shell with the Mac's own connection, which
 * the gateway refuses, so a pick was lost and the row read "Checking…"
 * (Dev2, 2026-11-04).
 *
 * The Mac registered in one of the person's workspaces, so each is tried in
 * turn, the personal one first, until one lists this Mac; the one found is
 * kept.
 */

import { machineFoldersFrom } from "@context/desktop-bridge";
import { machineAppUrl } from "./texMachineGateway";

export interface MachineFolderStore {
  /** This Mac's folders as the gateway keeps them, or `null` when it can't be read. */
  read(machineId: string): Promise<string[] | null>;
  /** Saves these folders; what the gateway kept, or `null` when it refused. */
  save(machineId: string, folders: string[]): Promise<string[] | null>;
}

export interface FolderStoreOptions {
  endpoint: string;
  /** The person's workspaces, the one to try first first. */
  workspaceIds: readonly string[];
  token: (workspaceId: string) => Promise<string>;
  fetch?: typeof fetch;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);

export function gatewayFolderStore(options: FolderStoreOptions): MachineFolderStore {
  const doFetch = options.fetch ?? fetch;
  let home: string | null = null;

  async function post(route: "list" | "set", workspaceId: string, body: Rec): Promise<Rec | null> {
    const url = machineAppUrl(options.endpoint, route);
    if (url === null) return null;
    try {
      const token = await options.token(workspaceId);
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, workspaceId }),
      });
      if (!response.ok) return null;
      const answer = rec(await response.json().catch(() => null));
      return answer?.ok === true ? answer : null;
    } catch {
      return null;
    }
  }

  async function find(machineId: string): Promise<{ workspaceId: string; folders: string[] } | null> {
    const order = home === null ? options.workspaceIds : [home, ...options.workspaceIds.filter((id) => id !== home)];
    for (const workspaceId of order) {
      const answer = await post("list", workspaceId, {});
      const machines = Array.isArray(answer?.machines) ? answer.machines : [];
      const mine = machines.map(rec).find((m) => m?.id === machineId);
      if (mine) {
        home = workspaceId;
        return { workspaceId, folders: machineFoldersFrom(mine.folders ?? []) ?? [] };
      }
    }
    return null;
  }

  return {
    async read(machineId) {
      return (await find(machineId))?.folders ?? null;
    },
    async save(machineId, folders) {
      const found = await find(machineId);
      if (found === null) return null;
      const answer = await post("set", found.workspaceId, { machineId, patch: { folders } });
      return machineFoldersFrom(rec(answer?.machine)?.folders);
    },
  };
}
