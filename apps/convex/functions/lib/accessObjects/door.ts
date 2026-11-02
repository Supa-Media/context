/**
 * The access tables of one workspace object, as the copy and the parity check
 * use them (`functions/accessObjects.ts`). The client is the control plane's
 * door client (`../workspaceObjects/door.ts`), which is the gateway's own
 * `workspaceClient`, so the calls are the contract's
 * (`apps/mcp/src/workspaceStore/access.js`), read here in one place:
 *
 * - scope `workspace`: `members` and `invites`, switched by `members.setHome`,
 *   read back in `state().members.home`.
 * - scope `person` (a personal workspace's object): `access.reach`,
 *   `access.sharedToMe` and `access.connections`, switched by
 *   `access.setHome` after `access.pin(userId)`, read back in
 *   `state().access.home`.
 *
 * Every table answers `snapshot({epoch, rows, last, mode})` and `digest()` →
 * `{count, sha}` (`accessDigest`). `null` when the object does not offer them
 * yet: the run counts the workspace as not ready and writes nothing.
 */

import type { AccessTable } from "./expected";

export type AccessScope = "workspace" | "person";
/** The object's own switch: it knows only who decides, never `dual` (mirroring is the control plane's business). */
export type ObjectHome = "convex" | "object";

export interface AccessTableDoor {
  snapshot(input: { epoch: string; rows: unknown[]; last: boolean; mode: "replace" | "merge" }): Promise<unknown>;
  digest(): Promise<{ count: number; sha: string }>;
}

export interface AccessDoor {
  table(name: AccessTable): AccessTableDoor;
  /** Sets the object's switch for this scope; for a person, pins `userId` first. */
  setHome(home: ObjectHome, userId: string | null): Promise<void>;
}

type Callable = (...args: never[]) => Promise<unknown>;
const isCallable = (value: unknown): value is Callable => typeof value === "function";
const isTable = (value: unknown): value is AccessTableDoor =>
  value !== null && typeof value === "object" && isCallable((value as Record<string, unknown>).snapshot) && isCallable((value as Record<string, unknown>).digest);

/** The door for `scope` over `client`, or `null` when the client does not offer that scope's tables. */
export function accessDoor(client: unknown, scope: AccessScope): AccessDoor | null {
  if (client === null || typeof client !== "object") return null;
  const source = client as Record<string, unknown>;
  if (scope === "workspace") {
    const members = source.members as Record<string, unknown> | undefined;
    const invites = source.invites;
    if (!isTable(members) || !isTable(invites) || !isCallable(members.setHome)) return null;
    return {
      table: (name) => {
        if (name === "members") return members;
        if (name === "invites") return invites;
        throw new Error("access door: not a workspace table");
      },
      setHome: async (home) => {
        await (members.setHome as (home: string) => Promise<unknown>)(home);
      },
    };
  }
  const access = source.access as Record<string, unknown> | undefined;
  if (access === undefined || access === null || typeof access !== "object") return null;
  const tables = { reach: access.reach, sharedToMe: access.sharedToMe, connections: access.connections };
  if (!isTable(tables.reach) || !isTable(tables.sharedToMe) || !isTable(tables.connections)) return null;
  if (!isCallable(access.setHome) || !isCallable(access.pin)) return null;
  return {
    table: (name) => {
      const table = (tables as Record<string, unknown>)[name];
      if (!isTable(table)) throw new Error("access door: not a person table");
      return table;
    },
    setHome: async (home, userId) => {
      if (home === "object") {
        if (userId === null) throw new Error("access door: a person object is pinned to its person");
        await (access.pin as (userId: string) => Promise<unknown>)(userId);
      }
      await (access.setHome as (home: string) => Promise<unknown>)(home);
    },
  };
}
