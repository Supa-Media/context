/**
 * `ws.write.access`: a row's access decided and committed in the workspace object
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`, "Access writes in the object").
 *
 * The same decision `apps/convex/functions/lib/nodes/setAccess.ts` `setAccessRow` makes, over the object's own rows
 * and grant rows (`accessRows.js`): set a row's base (`private` | `team` | `inherit`), replace or add to its grantee
 * list, or both. The object mints the access version (`max(now, held + 1)`), renders the member and guest rules from
 * the changed set and keeps them as the rules reads are judged by, all in the op's one transaction, and hands the
 * change to the mirror. A change that takes anything away (`narrows`) answers only once Convex has it.
 *
 * The object answers only what it can decide alone. Anything else is a code the gateway takes as "ask the control
 * plane" (`NOT_READY`, `NO_ROW`), never as a refusal:
 *
 * - `NOT_READY`: no access set held, a chunked move part way, or the set's last parity check against Convex's rules
 *   was not equal at the version held (an object whose own rendering was never shown equal never judges by it).
 * - `NO_ROW`: a list change at a path with no live row, or a row of the other kind. A base on a path with no row is
 *   kept here as pending access (`writePending`) until `ws.write.adopt` or a push gives the path its row.
 *
 * Refusals, as Convex gives them: `CONFLICT` (the caller's `expectedVersion` is not the held one), `FORBIDDEN` (a list
 * change by anyone but an owner, any change by a `member`, or a change touching the sealed chat homes by any client
 * but theirs), `NOT_FOUND` (an `accounts` grant outside the pinned workspace, or one to edit), `INVALID`.
 *
 * Grantees arrive resolved (`{kind, id, role}`, kinds `user` | `group` | `email` | `members` | `accounts`): resolving a
 * handle is the control plane's.
 */

import { CHAT_HOMES_FOLDER, PENDING_TTL_MS } from "./accessRows.js";
import { WriteOpRefused } from "./writeRefusal.js";
import { handleKey } from "./handleCache.js";

/** The client the chat homes are kept under (`lib/nodes/sealedChats.ts` `CHAT_HOMES_CLIENT_ID`). */
export const CHAT_HOMES_CLIENT_ID = "context_chat_homes";
const BASES = new Set(["private", "team", "inherit"]);
const KINDS = new Set(["user", "group", "email", "members", "accounts"]);
const ROLES = new Set(["view", "edit"]);
const ACTOR_ROLES = new Set(["owner", "editor", "member"]);
const MAX_GRANTEES = 100;
/**
 * Whether a narrowing answers only once Convex has it. Off: every read the gateway serves is judged by this object,
 * and the owner's bar is 0.1 s for every write (2026-11-03), which a Convex round trip cannot meet. The cost is a
 * window of about the mirror's round trip in which a reader still on Convex (the app's Convex listing) may still show
 * what was taken away; it closes as those readers move to the object.
 */
export const WAIT_FOR_MIRROR = false;

const text = (value, max = 1024) => typeof value === "string" && value !== "" && value.length <= max && !value.includes("\0");
const fold = (path) => path.normalize("NFC").toLowerCase().replace(/^\/+|\/+$/g, "");
const refusal = (code, extra = {}) => ({ answer: { ok: false, code, ...extra }, change: null, narrows: false });

/** Whether a change at `path` touches the chat homes: the folder, beneath it, or a folder it sits in. */
export function touchesChatHomes(path) {
  const folded = fold(path);
  const root = fold(CHAT_HOMES_FOLDER);
  if (folded === "") return false;
  return folded === root || folded.startsWith(`${root}/`) || root.startsWith(`${folded}/`);
}

const keyOf = (grantee) => `${grantee.kind}:${grantee.kind === "email" ? grantee.id.trim().toLowerCase() : grantee.id}`;

function checkGrantees(list) {
  if (!Array.isArray(list) || list.length > MAX_GRANTEES) throw new WriteOpRefused("grantees come as a list of at most " + MAX_GRANTEES);
  const out = new Map();
  for (const grantee of list) {
    if (!grantee || typeof grantee !== "object" || !KINDS.has(grantee.kind) || !ROLES.has(grantee.role)) throw new WriteOpRefused("not a grantee");
    const id = grantee.kind === "members" || grantee.kind === "accounts" ? grantee.kind : grantee.id;
    if (!text(id, 320)) throw new WriteOpRefused("a grantee names who it is");
    const clean = { kind: grantee.kind, id: grantee.kind === "email" ? id.trim().toLowerCase() : id, role: grantee.role };
    out.set(keyOf(clean), clean);
  }
  return [...out.values()];
}

/** Every grantee `before` held is still held with at least the same role. */
function keepsEveryone(before, after) {
  const now = new Map(after.map((grantee) => [keyOf(grantee), grantee.role]));
  return before.every((grantee) => {
    const role = now.get(keyOf(grantee));
    return role !== undefined && (grantee.role === "view" || role === "edit");
  });
}

const sameList = (a, b) => {
  const held = new Map(a.map((grantee) => [keyOf(grantee), grantee.role]));
  return a.length === b.length && b.every((grantee) => held.get(keyOf(grantee)) === grantee.role);
};

/**
 * `ctx`: `{rows, access, now}` (`serveWrites.js`). `body`: `{path, base?, grantees?, mode?: "set" | "add",
 * expectedVersion?, kind?, actor: {role, userId?, clientId?}}`.
 */
export function writeAccess(ctx, body) {
  if (!text(body.path)) throw new WriteOpRefused("an access write names its path");
  if (body.base !== undefined && !BASES.has(body.base)) throw new WriteOpRefused("a base is private, team or inherit");
  if (body.kind !== undefined && body.kind !== "file" && body.kind !== "folder") throw new WriteOpRefused("a row is a file or a folder");
  const mode = body.mode ?? "set";
  if (mode !== "set" && mode !== "add") throw new WriteOpRefused("an access write sets or adds");
  if (body.expectedVersion !== undefined && !Number.isFinite(body.expectedVersion)) throw new WriteOpRefused("a version is a number");
  const actor = body.actor ?? {};
  if (!ACTOR_ROLES.has(actor.role)) throw new WriteOpRefused("an access write names its actor's role");
  if (actor.userId !== undefined && !text(actor.userId, 64)) throw new WriteOpRefused("not an account id");
  if (actor.clientId !== undefined && !text(actor.clientId, 256)) throw new WriteOpRefused("not a client id");
  const named = namedGrantees(ctx, body);
  if (named.missing.length > 0) return refusal("RESOLVE", { handles: named.missing });
  const listed = body.grantees === undefined && named.grantees.length === 0 ? undefined : [...(body.grantees ?? []), ...named.grantees];
  const asked = listed === undefined ? undefined : checkGrantees(listed);
  if (body.base === undefined && asked === undefined) throw new WriteOpRefused("an access write changes a base or a list");
  if (mode === "add" && (asked === undefined || body.base !== undefined)) throw new WriteOpRefused("adding names grantees and no base");

  const set = judgingSet(ctx);
  if (set === null) return refusal("NOT_READY");
  if (body.expectedVersion !== undefined && body.expectedVersion !== set.version) return refusal("CONFLICT", { version: set.version });
  if (set.sealsChats && touchesChatHomes(body.path) && actor.clientId !== CHAT_HOMES_CLIENT_ID) return refusal("FORBIDDEN");

  const row = ctx.rows.byPath(body.path);
  if (row === null) return writePending(ctx, body, set, actor, asked);
  if (body.kind !== undefined && row.kind !== body.kind) return refusal("NO_ROW");

  const listChanges = asked !== undefined || body.base === "inherit";
  if (actor.role === "member" || (listChanges && actor.role !== "owner")) return refusal("FORBIDDEN");
  if ((asked ?? []).some((grantee) => grantee.kind === "accounts" && (!set.accounts || grantee.role !== "view"))) return refusal("NOT_FOUND");

  const token = row.noteId ?? row.id;
  const held = set.rows.find((record) => record.token === token && record.kind === row.kind) ?? null;
  const heldBase = held?.base ?? null;
  const heldList = held?.grantees ?? [];
  const nextBase = body.base === undefined ? heldBase : body.base === "inherit" ? null : body.base;
  let nextList;
  if (mode === "add") nextList = checkGrantees([...heldList, ...asked]);
  else nextList = asked ?? (body.base === "inherit" ? [] : heldList);
  if (nextList.length > MAX_GRANTEES) return refusal("INVALID");

  // Already so. A retry of a change still on its way to the mirror (a `MIRROR_PENDING` answer, retried) waits for it
  // like the change did, so a narrowing is never reported done before Convex has it.
  if (nextBase === heldBase && sameList(heldList, nextList)) {
    return { answer: { ok: true, version: set.version }, change: null, narrows: WAIT_FOR_MIRROR && ctx.mirrorPending?.() === true };
  }

  const version = Math.max(ctx.now, set.version + 1);
  ctx.access.writeRecord({ token, kind: row.kind, path: row.path, base: nextBase, grantees: nextList }, version);
  keepRules(ctx, version);
  // Whether this may hide something from someone: anything but a base made `team` (or kept) with nobody's grant taken
  // or lowered. Every gateway read is judged by this object, which already has it. Whether the answer also waits for
  // Convex's readers (`WAIT_FOR_MIRROR`) is the owner's 0.1 s call (2026-11-03): by default it does not.
  const narrowing = !((nextBase === heldBase || nextBase === "team") && keepsEveryone(heldList, nextList));
  const narrows = narrowing && WAIT_FOR_MIRROR;
  // What changed, as well as where it ended: the mirror applies the change onto Convex's row as Convex holds it, so a
  // list change Convex took that this object has not seen yet is kept, never overwritten by this object's older list.
  const heldRoles = new Map(heldList.map((grantee) => [keyOf(grantee), grantee.role]));
  const nextKeys = new Set(nextList.map(keyOf));
  const added = nextList.filter((grantee) => heldRoles.get(keyOf(grantee)) !== grantee.role);
  const removed = heldList.filter((grantee) => !nextKeys.has(keyOf(grantee)));
  const record = {
    rowId: row.id,
    baseChanged: nextBase !== heldBase,
    listChanged: added.length > 0 || removed.length > 0,
    added,
    removed,
    noteId: row.noteId ?? null,
    path: row.path,
    kind: row.kind,
    base: nextBase,
    grantees: nextList,
    baseVersion: set.version,
    version,
    ...(actor.userId !== undefined ? { actorUserId: actor.userId } : {}),
    ...(actor.clientId !== undefined ? { clientId: actor.clientId } : {}),
  };
  return { answer: { ok: true, version }, change: { op: "access", record: { ...record, narrowing }, objectAt: version }, narrows, rules: true };
}

/**
 * People named by handle (`body.handles`: `[{handle, role}]`, for `mode: "add"`), resolved from the handles this
 * object has been told (`handleCache.js`), with `body.resolved` (`[{handle, kind, id}]`, the control plane's answer
 * the gateway passes back after a `RESOLVE`) kept first. `missing`: the handles nobody has resolved yet; the op then
 * answers `RESOLVE` and writes nothing.
 */
function namedGrantees(ctx, body) {
  if (body.handles === undefined) return { grantees: [], missing: [] };
  if (!Array.isArray(body.handles) || body.handles.length > MAX_GRANTEES || (body.mode ?? "set") !== "add") {
    throw new WriteOpRefused("handles come as a list, to add");
  }
  if (body.resolved !== undefined) {
    if (!Array.isArray(body.resolved) || body.resolved.length > MAX_GRANTEES || !ctx.handles?.put(body.resolved, ctx.now)) {
      throw new WriteOpRefused("not a list of resolved handles");
    }
  }
  const grantees = [];
  const missing = [];
  for (const entry of body.handles) {
    if (!entry || handleKey(entry.handle) === null || !ROLES.has(entry.role)) throw new WriteOpRefused("not a handle");
    const resolved = ctx.handles?.get(entry.handle, ctx.now) ?? null;
    if (resolved === null) missing.push(entry.handle);
    else grantees.push({ kind: resolved.kind, id: resolved.id, role: entry.role });
  }
  return { grantees, missing };
}

/**
 * The access set the object may decide by, or null (`NOT_READY`): none held, a chunked move part way, or a rendering
 * never shown equal to the control plane's rules at the version held (unless the object minted that version itself).
 */
export function judgingSet(ctx) {
  const set = ctx.access?.set() ?? null;
  if (set === null || set.moving > 0) return null;
  const parity = ctx.access.parity();
  const shownEqual =
    ctx.access.minted() === set.version ||
    (parity?.version === set.version && parity.audiences?.member?.equal === true && parity.audiences?.guest?.equal === true);
  return shownEqual ? set : null;
}

/** The member and guest rules rendered from the access set just changed, kept as the rules reads are judged by. */
export function keepRules(ctx, version) {
  // Both audiences carry the member rules' etag, as the control plane's `authority` gives them.
  const member = ctx.access.render("member", undefined, ctx.now);
  const guest = ctx.access.render("guest", undefined, ctx.now);
  const etag = rulesEtag(member, version);
  ctx.rows.putRules({ ...member, etag }, "member");
  ctx.rows.putRules({ ...guest, etag }, "guest");
}

/**
 * A base on a path with no row yet (a note saved private is given its tier before its bytes are put): kept as pending
 * access in the object, as `setPendingAccess` keeps it in the control plane, and rendered at once, so the path is
 * closed before its row exists and `ws.write.adopt` can take the note here. Only a base can wait: a list needs its row
 * (`NO_ROW`, which the control plane answers `NOT_FOUND`). `inherit` drops a waiting entry.
 */
function writePending(ctx, body, set, actor, asked) {
  if ((asked !== undefined && asked.length > 0) || body.base === undefined) return refusal("NO_ROW");
  if (actor.role === "member") return refusal("FORBIDDEN");
  const kind = body.kind ?? "file";
  const base = body.base === "inherit" ? null : body.base;
  const waiting = set.pending.find((entry) => entry.path === body.path && entry.at >= ctx.now - PENDING_TTL_MS) ?? null;
  if (waiting === null ? base === null : waiting.base === base && waiting.kind === kind) {
    return { answer: { ok: true, version: set.version }, change: null, narrows: false };
  }
  const version = Math.max(ctx.now, set.version + 1);
  const written = ctx.access.writePending({ path: body.path, kind, base }, version, ctx.now);
  if (written.ok !== true) return refusal(written.code);
  keepRules(ctx, version);
  // Only a private entry is rendered (`judgedAccessRows`): it alone takes anything from anyone.
  const narrowing = base === "private";
  const record = {
    path: body.path,
    kind,
    base,
    baseVersion: set.version,
    version,
    narrowing,
    ...(actor.userId !== undefined ? { actorUserId: actor.userId } : {}),
    ...(actor.clientId !== undefined ? { clientId: actor.clientId } : {}),
  };
  return { answer: { ok: true, version }, change: { op: "accessPending", record, objectAt: version }, narrows: narrowing && WAIT_FOR_MIRROR, rules: true };
}

/**
 * The rules' etag as the control plane spells it (`readerRules.ts` `privacyEtagFrom`): a 32-bit FNV-1a of the sorted
 * folders and notes, then the access version.
 */
export function rulesEtag({ folders, notes }, version) {
  const source = JSON.stringify([folders, notes]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `rows:${hash.toString(16)}.${version}`;
}
