/**
 * What the app's access socket (`accessSockets.js`) reads and writes in a person's own object (the personal
 * workspace's object, `workspace:<personalWorkspaceId>`): the workspaces they are in, what is shared with them by name,
 * and their connected AI clients (thread F of access-in-objects, decided by the owner, 2026-11-01;
 * `docs/decisions/identity-and-access/access-in-objects.md`). Thread B's tables (`personRows.js`) hold the rows.
 *
 * Nothing is served before the object decides for its person (`person.home()` is `object`); until then the app reads
 * Convex. Every read and write checks the reader is the person this object is pinned to (`admit`), so the gateway
 * picking the wrong object could never show one person another's rows.
 *
 * Only the person's own rows are here. An owner's view of every member's connections in a shared workspace stays on
 * Convex: narrowing it to their own would change who sees what, which is the owner's decision, not this file's.
 *
 * The one write is taking a connection back (`revoke_connection`): this object is the authority for a connection
 * (`access.js`, writes across objects), so it is revoked here first and the control plane's copy written behind it,
 * asked again with the same clock; still failing, the write answers `copy_behind` though the revocation stands.
 */

import { ACCESS_HOMES } from "./access.js";
import { withoutHashes } from "./personRows.js";

/** As `MAX_GRANTS_RETURNED` and the session's workspace cap in the control plane. */
const MAX_RETURNED = 200;
const MIRROR_TRIES = 3;
/** The app's own client: an expired one has no refresh token and is no connection (`grants.listGrants`). */
const CONSOLE_CLIENT_ID = "context_console";

const refused = (code) => Object.assign(new Error(code), { code });

/**
 * @param {{person: ReturnType<import("./personRows.js").personRows>}} store
 * @param {{mirror?: (personalWorkspaceId: string, change: object) => Promise<void>, now?: () => number}} deps
 */
export function personAccessTopics(store, deps = {}) {
  const person = store.person;
  const now = deps.now ?? (() => Date.now());
  const decides = () => person.home() === ACCESS_HOMES.OBJECT && person.person() !== null;
  const mine = (reader) => reader.side === "person" && person.person() === reader.userId;

  const mirrored = async (workspaceId, change) => {
    for (let attempt = 0; attempt < MIRROR_TRIES; attempt += 1) {
      try {
        return await deps.mirror(workspaceId, change);
      } catch {
        // Asked again below.
      }
    }
    throw refused("copy_behind");
  };

  const topics = {
    reach: {
      served: decides,
      // Workspaces only: a group chat's key and the pinned workspace a texting session adds are not the app's.
      rows: () =>
        person
          .live("reach")
          .filter((row) => row.workspaceId !== undefined && !row.pinned)
          .slice(0, MAX_RETURNED)
          .map((row) => ({ workspaceId: row.workspaceId, slug: row.slug, kind: row.kind, role: row.role, groups: row.groups, at: row.at })),
    },
    shared_to_me: {
      served: decides,
      rows: () =>
        person
          .live("shared")
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_RETURNED),
    },
    connections: {
      served: decides,
      // Live connections, newest first: what the app's always-open subscriptions read (`listGrants`, `activeOnly`).
      rows: () =>
        person
          .live("connections")
          .filter((row) => row.status === "active" && !(row.clientId === CONSOLE_CLIENT_ID && row.expiresAt <= now()))
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_RETURNED)
          .map(({ previousRefreshHash, expiresAt, ...row }) => withoutHashes(row)),
    },
  };

  const ops = {
    async revoke_connection(reader, { grantId }) {
      if (!decides()) throw refused("not_served");
      if (!mine(reader)) throw refused("forbidden");
      if (typeof grantId !== "string" || grantId === "") throw refused("bad_grant");
      const held = person.live("connections").find((row) => row.grantId === grantId);
      if (held === undefined || held.status !== "active") return { revoked: false };
      if (typeof deps.mirror !== "function") throw refused("not_served");
      const at = Math.max(now(), held.at + 1);
      const { revoked } = person.revoke(grantId, at);
      await mirrored(reader.workspaceId, { op: "revoke_connection", grantId, at, by: reader.userId });
      return { revoked };
    },
  };

  return {
    topics,
    ops,
    // The person side is only ever its own person's; the workspace side is decided by the member tables.
    admit: (reader) => reader.side !== "person" || !decides() || mine(reader),
  };
}
