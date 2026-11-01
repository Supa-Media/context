/**
 * The workspace object's contract: one Durable Object per workspace that
 * holds its notes' text, its tree rows and its access rules, and answers a
 * read with the permission check and the text in one call (decided by the
 * owner, 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * This file is the one place the shape is written down. The object's side is
 * `workspaceStore/serve.js`; the gateway's client is `workspaceClient` below;
 * the store routing that sends note bodies there is `store/workspaceRouting.js`.
 *
 * What lives in the object:
 * - **Bodies**: `notes/<noteId>.md` and everything under `.context/collaboration/`,
 *   R2-shaped (keys, etags, conditional writes, chunked values), the same
 *   storage as Tex's objects (`texStore/objects.js`). Files (`files/…`) do not.
 * - **Rows**: one per tree row: `{id, noteId, path, kind, storageKey, etag, size, collaborates, at}`.
 *   `at` is the writer's clock; a row older than the one held is ignored, so
 *   replays and out-of-order pushes cannot roll a row back.
 * - **Rules**: the workspace's access rules exactly as the control plane renders
 *   them for the gateway today (`store/privacyAuthority.js` `HeldRules`), with
 *   `accessVersion`; an older version is ignored.
 * - **State**: `home` (where bodies are read from: `bucket` | `dual` | `object`),
 *   `backfilledAt`, counts.
 *
 * Nothing in the object decides who the caller is: the gateway has already
 * resolved the grant and passes its `scope` (`private` | `team`) and the row
 * tokens it holds (`groups`). The object runs `canSee` from
 * `privacy/engine.js`, unchanged, over its own rows and rules.
 *
 * A refused note and a missing note get the same answer (`{id, found: false}`)
 * after the same work, so a read cannot tell them apart (non-negotiable #5).
 */

import { R2Store } from "../store/r2.js";
import { callTexStore, texBucket } from "../texStore/wire.js";

/** Where a workspace's note bodies are read from. */
export const HOMES = Object.freeze({ BUCKET: "bucket", DUAL: "dual", OBJECT: "object" });
const HOME_VALUES = new Set(Object.values(HOMES));
export const isHome = (value) => HOME_VALUES.has(value);

/** The most notes one `read` call answers. */
export const MAX_READ_IDS = 500;
/** The most rows one `rows.put` call carries. */
export const MAX_ROWS_PER_PUT = 2000;

const NOTE_KEY = /^notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;
const COLLABORATION = ".context/collaboration/";

/** A key whose bytes live in the workspace object: a note's text or its shared-editing history. */
export function isWorkspaceObjectKey(key) {
  return typeof key === "string" && (NOTE_KEY.test(key) || (key.startsWith(COLLABORATION) && !key.includes("..") && !key.includes("\0")));
}

/** The one object name per workspace. Exported so a test can pin that two workspaces never share one. */
export function workspaceObjectName(workspaceId) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new TypeError("a workspace object belongs to one workspace");
  return `workspace:${workspaceId}`;
}

/** The workspace's object stub, `null` without the binding. Placed in eastern North America, beside most of its readers. */
export function workspaceStub(env, workspaceId) {
  const namespace = env?.WORKSPACE_STORE;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  const id = namespace.idFromName(workspaceObjectName(workspaceId));
  return namespace.get(id, { locationHint: "enam" });
}

/**
 * The gateway's client for one workspace's object. `null` without the binding.
 *
 * - `bodies`: a ContextStore (`store/r2.js`) over the object's keys.
 * - `read({ids, scope, groups})` → `{notes: Array<{id, found: true, path, etag, contentType, text}|{id, found: false}>, accessVersion}`
 * - `rows.put(rows)`, `rows.remove(ids, at)`, `rows.get(ids)`, `rows.list({after, limit})`
 * - `rules.put(heldRules)`, `rules.get()`
 * - `state()` → `{home, backfilledAt, rows, objects, accessVersion}`; `setHome(home)`; `markBackfilled(at)`
 */
export function workspaceClient(env, workspaceId) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const ask = async (op, fields = {}) => await (await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify(fields)))).json();
  return {
    bodies: new R2Store(texBucket(stub)),
    read: async ({ ids, scope, groups = [] }) => await ask("ws.read", { ids, scope, groups }),
    rows: {
      put: async (rows) => await ask("ws.rows.put", { rows }),
      remove: async (ids, at) => await ask("ws.rows.remove", { ids, at }),
      get: async (ids) => await ask("ws.rows.get", { ids }),
      list: async ({ after = null, limit = 1000 } = {}) => await ask("ws.rows.list", { after, limit }),
    },
    rules: {
      put: async (rules) => await ask("ws.rules.put", { rules }),
      get: async () => await ask("ws.rules.get"),
    },
    state: async () => await ask("ws.state"),
    setHome: async (home) => await ask("ws.home", { home }),
    markBackfilled: async (at) => await ask("ws.backfilled", { at }),
  };
}
