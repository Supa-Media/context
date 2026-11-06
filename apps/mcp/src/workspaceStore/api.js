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
 * - **Rows**: one per tree row: `{id, noteId, path, kind, storageKey, etag, size, collaborates, uploaded, role, order, archiveOf, at}`.
 *   `at` is the writer's clock; a row older than the one held is ignored, so
 *   replays and out-of-order pushes cannot roll a row back.
 * - **Rules**: the workspace's access rules exactly as the control plane renders
 *   them for the gateway today (`store/privacyAuthority.js` `HeldRules`), one
 *   copy per audience (`member`, `guest`: a guest never sees a `team` row), with
 *   `accessVersion`; an older version is ignored. A Tex guest chat's rules are
 *   not kept: those reads stay on the control plane's path.
 * - **Paths**: each row's full path. A folder whose path changes (a move is one
 *   row) rewrites every row under it in the same call.
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
import { objectByName } from "../objectPlace.js";
import { callTexStore, texBucket } from "../texStore/wire.js";
import { personAccessClient } from "./personClient.js";

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

/**
 * Saved versions of a shared document (`packages/collaboration/src/storage.js` `REVISION_PREFIX`). Never deleted, so
 * they are most of a busy workspace's bytes (@supa: 13.1 GB of 13.3). The object keeps only each document's current
 * and pending ones, which a read needs; older ones are read from the bucket, only as an offline merge's base.
 */
export const REVISIONS = ".context/collaboration/v1/revisions/";
const DOCUMENT_STATE = /^\.context\/collaboration\/v1\/documents\/([A-Za-z0-9_-]+)\.json$/;
export const isRevisionKey = (key) => typeof key === "string" && key.startsWith(REVISIONS);
/** The document id a document-state key names (`documents/<id>.json`, never its `operations/`), else null. */
export const documentStateId = (key) => (typeof key === "string" ? DOCUMENT_STATE.exec(key)?.[1] ?? null : null);

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
  return objectByName(namespace, workspaceObjectName(workspaceId));
}

/**
 * The gateway's client for one workspace's object. `null` without the binding.
 *
 * - `bodies`: a ContextStore (`store/r2.js`) over the object's keys.
 * - `userId` (optional on every read): who is reading, judged by the object's own members where it decides access
 * - `rows.lookup({paths, scope, groups, audience, withBody?})`, `rows.resolve({noteIds, ...})` → `{rows: [{found, path, noteId, key, etag, kind, collaborates, body?}], accessVersion}`;
 *   `withBody` on a one-path lookup carries the found note's Markdown as `body: {meta, text}` (`lookupBody.js`)
 * - `read({ids, scope, groups, audience})` → `{notes: Array<{id, found: true, path, etag, contentType, text}|{id, found: false}>, accessVersion}`
 * - `visible({ids, scope, groups})` → booleans, the same check (for the parity checker)
 * - `rows.manifest({folder, cursor, scope, groups, audience})` → `{served: true, entries: [{path, etag, size, updatedAt, noteId}], cursor}`
 *   or `{served: false}`: the agent tools' listing, judged the same way (`workspaceStore/manifest.js`)
 * - `rows.put(rows)`, `rows.remove(ids, at)`, `rows.get(ids)`, `rows.list({after, limit})`
 * - `rows.snapshot({epoch, rows, last, mode})`: a whole copy in pages; `replace` swaps on the last page, `merge` upserts
 * - `rows.names({paths, canWrite})` → `{served, files, folders, behind?}`: a writer's "is that name taken?", unfiltered,
 *   only for a call the gateway attests is a writer's (`workspaceStore/namesTaken.js`)
 * - `rows.digest()` → `{rows, sha256}` over the live rows in id order (fields: id, noteId, path, kind, storageKey, etag, size, collaborates, uploaded, role, order, archiveOf)
 * Every `ws.*` call names its workspace; the object pins the first it sees and refuses any other.
 * - `facts({ask, ..., scope, groups, audience})`: a note facts ask (`props`, `links`, `neighbors`) answered from the
 *   text held here (`workspaceStore/facts.js`), in the control plane's `/gateway/tree/facts` shape; `{served: false}`
 *   before the notes live here
 * - `orientSurvey({scope, groups, audience})` → `{served: true, survey}` or `{served: false}`: `orient`'s map of the
 *   workspace for that reader, drawn in the object (`workspaceStore/orientSurvey.js`)
 * - `factRows({ask: "props"|"links"|"chaos"|"candidates"|"linking", paths?})`: the same facts unfiltered, for the control plane's own readers
 *   through the door, which judge every path themselves
 * - `rows.files({after, limit, root, audience})` → `{served, rows, cursor, rules, behind?}`: live file rows in path order and
 *   the audience's held rules, for the control plane's tree reads (`lib/nodes/objectTreeStore.ts`); `{served: false}` before home `object`
 * - `rows.listing({path, scope, groups, audience})` → `{served, listing, behind?}`: one folder at a clearance the control plane resolved
 * - `rules.put(heldRules, audience)`, `rules.get(audience)`
 * - `apply({rows, removed, at, rules: {member?, guest?}})`: rows, removals and rules in one storage transaction
 * - `state()` → `{home, backfilledAt, encryption, rows, objects, accessVersion, members: {home, members, invites, reachPending}}`; `setHome(home)`; `setEncryption("none"|"keyed")`; `markBackfilled(at)`
 * - `members.*`, `invites.*`: who belongs to the workspace (`workspaceStore/members.js`): see `membershipClient`.
 * - `collab.replace({path, key, noteId, legacyEtag?, rowEtag?, expectedEtag, text})` → `{served: true, result|error, markdown, writes, deletes}`
 *   or `{served: false, writes?, deletes?}`: a whole-note save's editing history run in the object (`collabReplace.js`)
 * - `collab.read({path, key, noteId})` → `{served: true, markdown, collaboration|error, writes, deletes}` or
 *   `{served: false}`: a note's Markdown and its editing history's text, for a read (`collabRead.js`)
 * - `open(userId)` → `{home, backfilledAt, encryption, accessHome, member, rules, binding: {sealed, at}|null, epoch}`:
 *   what a request's store is built from, in one call; `open(userId, {setupRead: true})`, Tex's setup read: the member
 *   rules narrowed to the setup's folders (`setupRules.js`) and the binding, `setupRead: true` when it could answer;
 *   `binding.put({sealed, at, epoch})` → `{kept, epoch}`,
 *   `binding.clear()` → `{epoch}` (`workspaceStore/bindingRows.js`)
 */
export function workspaceClient(env, workspaceId) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const ask = async (op, fields = {}) => await (await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ ...fields, workspaceId })))).json();
  return {
    bodies: new R2Store(texBucket(stub)),
    read: async ({ ids, scope, groups = [], audience = "member", userId = null, chatNames = null }) => await ask("ws.read", { ids, scope, groups, audience, ...(userId ? { userId } : {}), ...(Array.isArray(chatNames) ? { chatNames } : {}) }),
    visible: async ({ ids, scope, groups = [], audience = "member", userId = null }) => (await ask("ws.visible", { ids, scope, groups, audience, ...(userId ? { userId } : {}) })).visible,
    rows: {
      put: async (rows) => await ask("ws.rows.put", { rows }),
      remove: async (ids, at) => await ask("ws.rows.remove", { ids, at }),
      get: async (ids) => await ask("ws.rows.get", { ids }),
      lookup: async ({ paths, scope, groups = [], audience = "member", userId = null, chatNames = null, withBody = false }) => await ask("ws.rows.lookup", { paths, scope, groups, audience, ...(userId ? { userId } : {}), ...(Array.isArray(chatNames) ? { chatNames } : {}), ...(withBody === true ? { withBody: true } : {}) }),
      resolve: async ({ noteIds, scope, groups = [], audience = "member", userId = null, chatNames = null }) => await ask("ws.rows.resolve", { noteIds, scope, groups, audience, ...(userId ? { userId } : {}), ...(Array.isArray(chatNames) ? { chatNames } : {}) }),
      list: async ({ after = null, limit = 1000 } = {}) => await ask("ws.rows.list", { after, limit }),
      listing: async (/** @type {{path: string, scope: string, groups?: string[], audience?: string}} */ options) =>
        await ask("ws.rows.listing", { path: options.path, scope: options.scope, groups: options.groups ?? [], audience: options.audience ?? "member" }),
      files: async (/** @type {{after?: string | null, limit?: number, root?: string | null, audience?: string}} */ options = {}) =>
        await ask("ws.rows.files", { after: options.after ?? null, limit: options.limit ?? 1000, root: options.root ?? null, audience: options.audience ?? "member" }),
      manifest: async ({ folder = "", cursor = null, scope, groups = [], audience = "member", userId = null, chatNames = null }) =>
        await ask("ws.rows.manifest", { folder, ...(cursor ? { cursor } : {}), scope, groups, audience, ...(userId ? { userId } : {}), ...(Array.isArray(chatNames) ? { chatNames } : {}) }),
      children: async ({ folders, scope, groups = [], audience = "member", userId = null, chatNames = null }) =>
        await ask("ws.rows.children", { folders, scope, groups, audience, ...(userId ? { userId } : {}), ...(Array.isArray(chatNames) ? { chatNames } : {}) }),
      snapshot: async ({ epoch, rows, last = false, mode = "replace" }) => await ask("ws.rows.snapshot", { epoch, rows, last, mode }),
      digest: async () => await ask("ws.rows.digest"),
      names: async ({ paths, canWrite }) => await ask("ws.rows.names", { paths, canWrite: canWrite === true }),
    },
    facts: async (request) => await ask("ws.facts", request),
    orientSurvey: async (request) => await ask("ws.orient.survey", request),
    factRows: async (request) => await ask("ws.facts.rows", request),
    rules: {
      put: async (rules, audience = "member") => await ask("ws.rules.put", { rules, audience }),
      get: async (audience = "member") => await ask("ws.rules.get", { audience }),
    },
    apply: async ({ rows = [], removed = [], at = null, rules = {} }) => await ask("ws.apply", { rows, removed, at, rules }),
    // Write ops (`workspaceStore/writeOps.js`); `ask` names the workspace in every body.
    write: {
      wrote: async (record) => await ask("ws.write.wrote", record),
      access: async (change) => await ask("ws.write.access", change),
      dropGrantee: async (body) => await ask("ws.write.dropGrantee", body),
      narrowMoves: async (body) => await ask("ws.write.narrowMoves", body),
      adopt: async (note) => await ask("ws.write.adopt", note),
      trash: async (body) => await ask("ws.write.trash", body),
      restore: async (body) => await ask("ws.write.restore", body),
      erase: async (body) => await ask("ws.write.erase", body),
      move: async (body) => await ask("ws.write.move", body),
    },
    // A whole-note save's editing history, run in the object (`workspaceStore/collabReplace.js`).
    collab: {
      replace: async (fields) => await ask("ws.collab.replace", fields),
      // A note's Markdown and its editing history's text, for a read (`workspaceStore/collabRead.js`).
      read: async (fields) => await ask("ws.collab.read", fields),
      create: async (fields) => await ask("ws.create", fields),
    },
    ...membershipClient(ask),
    state: async () => await ask("ws.state"),
    setHome: async (home) => await ask("ws.home", { home }),
    setEncryption: async (state) => await ask("ws.encryption", { state }),
    markBackfilled: async (at) => await ask("ws.backfilled", { at }),
    open: async (userId, { setupRead = false } = {}) => await ask("ws.open", setupRead === true ? { userId, setupRead: true } : { userId }),
    // The object's own word index (`searchIndex.js`): a search's queries, and a catch-up pass behind a response.
    search: async (asks) => await ask("ws.search", { asks }),
    searchBuild: async () => await ask("ws.search.build"),
    // The object's own meaning index (`meaningIndex.js`): the passages closest to a query's fingerprint, and a build.
    meaningQuery: async (vector, { tiers = null } = {}) => await ask("ws.meaning.query", { vector, tiers }),
    meaningBuild: async () => await ask("ws.meaning.build"),
    meaningSnippets: async (asks, chars) => await ask("ws.meaning.snippets", { asks, chars }),
    binding: {
      put: async ({ sealed, at, epoch }) => await ask("ws.binding.put", { sealed, at, epoch }),
      clear: async () => await ask("ws.binding.clear"),
    },
    // A personal workspace's object is its person's too (`workspaceStore/access.js`).
    access: personAccessClient(ask, workspaceId),
  };
}

/**
 * The membership half of the client (`access.js` `ACCESS_OPS`, served by `workspaceStore/serveMembers.js`).
 * `members` (keyed by `userId`) and `invites` (keyed by `id`) each have:
 * - `put(rows)` → `{kept}`: rows older than the ones held are skipped. `members.put(rows, {workspace: {slug, kind}})`
 *   names the workspace once, so each person's object can be told; it answers only once every person object took the
 *   change, and throws (the object answered `503 copy_behind`) while one is owed: the object sends it again, and the
 *   caller retries with the same `at`.
 * - `remove(keys, at)` → `{removed}`: tombstones at `at`; a removed member is refused here at once (home `object`).
 * - `list({after, limit})` → `{rows, next}`; `digest()` → `{count, sha}` (`access.js` `accessDigest`)
 * - `snapshot({epoch, rows, last, mode: "replace"|"merge"})`: a whole copy in pages; owes no person object
 * Plus `members.get(userId)` → `{member}`, `members.setHome("convex"|"object")` (`state().members.home`),
 * `members.flushReach()` → `{pending}`, and `invites.find(tokenHash)` → `{invite}`.
 */
function membershipClient(ask) {
  const table = (name, removeKey) => ({
    put: async (rows, extra = {}) => await ask(`ws.${name}.put`, { rows, ...extra }),
    remove: async (keys, at) => await ask(`ws.${name}.remove`, { [removeKey]: keys, at }),
    list: async ({ after = null, limit = 1000 } = {}) => await ask(`ws.${name}.list`, { after, limit }),
    digest: async () => await ask(`ws.${name}.digest`),
    snapshot: async ({ epoch, rows, last = false, mode = "replace" }) => await ask(`ws.${name}.snapshot`, { epoch, rows, last, mode }),
  });
  return {
    members: {
      ...table("members", "userIds"),
      get: async (userId) => await ask("ws.members.get", { userId }),
      setHome: async (home) => await ask("ws.access.home", { home }),
      flushReach: async () => await ask("ws.reach.flush"),
    },
    invites: { ...table("invites", "ids"), find: async (tokenHash) => await ask("ws.invites.find", { tokenHash }) },
  };
}
