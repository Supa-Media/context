/**
 * A workspace object's membership calls (`ACCESS_OPS` `ws.members.*`, `ws.invites.*`, `ws.access.home`, and
 * `ws.invites.find`, `ws.reach.flush`), over `members.js`. `serve.js` hands every `ws.*` call here first.
 *
 * **Writes that cross objects** (`access.js` `writeBoth`): this object is the authority for membership, so a member
 * change lands here first and is in force at once: in home `object` a removed person's next read here is refused.
 * The person's own object (`workspace:<personalWorkspaceId>`, whose `reach` lists every workspace they are in) is told
 * in the same call. The call answers done only when it landed; if it did not, the change is kept owed here (sent
 * again on an alarm and on the next membership call) and the call answers `503 copy_behind`, so the caller, which may
 * try again with the same `at`, never takes it as done.
 *
 * A whole copy (`snapshot`) owes the person objects nothing: copying every person's reach is its own step.
 */

import { ACCESS_OPS, AccessRowRefused, ROW_KEYS } from "./access.js";

const IDENTITY = "identity";
const HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `{tokenHash}` → `{invite}` or `{invite: null}`: the invitation an accept presents, by its token's sha256. */
export const INVITE_FIND = "ws.invites.find";
/** `{}` → `{pending}`: send what the reach outbox still owes. */
export const REACH_FLUSH = "ws.reach.flush";

/** This workspace's handle and kind, for a person's reach row; null until a member write has said. */
function identityOf(store) {
  const held = store.members.getMeta(IDENTITY);
  return held && typeof held.slug === "string" && typeof held.kind === "string" ? held : null;
}

function keepIdentity(store, workspace) {
  if (workspace === undefined || workspace === null) return;
  if (typeof workspace !== "object" || !HANDLE.test(workspace.slug ?? "") || (workspace.kind !== "personal" && workspace.kind !== "shared")) {
    throw new AccessRowRefused("a workspace is named by its handle and kind");
  }
  store.members.setMeta(IDENTITY, { slug: workspace.slug, kind: workspace.kind });
}

/**
 * Send what the reach outbox owes, oldest first. `store.reach(personalWorkspaceId)` is the person object's client
 * (`{call(op, body)}`, throwing on an answer that is not 2xx; `error.refused` for a 422). A refused write is dropped
 * (sending it again would be refused again) and logged. Answers how many are still owed.
 */
export async function flushReach(store) {
  const members = store.members;
  const owed = members.pending();
  if (owed.length === 0) return 0;
  const log = typeof store.log === "function" ? store.log : (event, fields) => console.log(JSON.stringify({ event, ...fields }));
  let left = 0;
  for (const entry of owed) {
    const started = Date.now();
    // Ids and a fixed reason only: never a person's name, email or groups.
    const fields = { op: entry.op, tries: entry.tries + 1 };
    try {
      const client = typeof store.reach === "function" ? store.reach(entry.person) : null;
      if (client === null) throw new Error("no person object");
      await client.call(entry.op, entry.body);
      members.settled(entry.seq);
      log("workspace_reach_sent", { ...fields, ms: Date.now() - started });
    } catch (error) {
      if (error?.refused === true) {
        members.settled(entry.seq);
        log("workspace_reach_refused", { ...fields, ms: Date.now() - started });
        continue;
      }
      members.failed(entry.seq);
      left += 1;
      log("workspace_reach_owed", { ...fields, ms: Date.now() - started });
    }
  }
  if (left > 0 && typeof store.retryLater === "function") {
    try {
      await store.retryLater();
    } catch {
      // The next membership call sends it again.
    }
  }
  return left;
}

/** Queue the person-object write a member's change owes: `{personalWorkspaceId, rows}` or `{personalWorkspaceId, keys, at}`. */
function owe(store, workspaceId, member, removed, at) {
  const person = member.personalWorkspaceId;
  if (removed) {
    store.members.owe(person, workspaceId, ACCESS_OPS.REACH_REMOVE, { personalWorkspaceId: person, keys: [ROW_KEYS.reach({ workspaceId })], at });
    return;
  }
  const identity = identityOf(store);
  if (identity === null) throw new AccessRowRefused("a member write names the workspace's handle and kind first (`workspace`)");
  const row = { workspaceId, slug: identity.slug, kind: identity.kind, role: member.role, groups: member.groups, at: member.at };
  store.members.owe(person, workspaceId, ACCESS_OPS.REACH_PUT, { personalWorkspaceId: person, rows: [row] });
}

async function answered(store, result) {
  const left = await flushReach(store);
  if (left === 0) return Response.json(result);
  return Response.json({ error: "copy_behind", ...result, pending: left }, { status: 503 });
}

/**
 * The answer to a membership call, or `null` for a call that is not one. `store.members` is `workspaceMembers(sql)`;
 * `store.transact(work)` runs `work` in one storage transaction.
 */
export async function serveMembersCall(store, op, fields) {
  const members = store.members;
  if (!members) return null;
  const transact = typeof store.transact === "function" ? store.transact : (work) => work();
  const workspaceId = fields.workspaceId;
  switch (op) {
    case ACCESS_OPS.MEMBERS_PUT: {
      const kept = transact(() => {
        keepIdentity(store, fields.workspace);
        // Refused before anything is written: a person's reach row needs the workspace's handle and kind.
        if (identityOf(store) === null) throw new AccessRowRefused("a member write names the workspace's handle and kind first (`workspace`)");
        const rows = members.put("members", fields.rows);
        for (const member of rows) owe(store, workspaceId, member, false);
        return rows;
      });
      return await answered(store, { kept: kept.length });
    }
    case ACCESS_OPS.MEMBERS_REMOVE: {
      const removed = transact(() => {
        // Who they were, read before the tombstone: their person object is where the removal is owed.
        const before = Array.isArray(fields.userIds) ? fields.userIds.map((userId) => members.member(userId)).filter(Boolean) : [];
        const keys = new Set(members.remove("members", fields.userIds, fields.at));
        for (const member of before) if (keys.has(member.userId)) owe(store, workspaceId, member, true, fields.at);
        return keys.size;
      });
      return await answered(store, { removed });
    }
    case ACCESS_OPS.MEMBER_GET:
      return Response.json({ member: members.member(fields.userId) });
    case ACCESS_OPS.MEMBERS_LIST:
      return Response.json(members.list("members", fields));
    case ACCESS_OPS.MEMBERS_SNAPSHOT:
      return Response.json(transact(() => members.snapshot("members", fields)));
    case ACCESS_OPS.MEMBERS_DIGEST:
      return Response.json(await members.digest("members"));
    case ACCESS_OPS.INVITES_PUT:
      return Response.json({ kept: transact(() => members.put("invites", fields.rows)).length });
    case ACCESS_OPS.INVITES_REMOVE:
      return Response.json({ removed: transact(() => members.remove("invites", fields.ids, fields.at)).length });
    case ACCESS_OPS.INVITES_LIST:
      return Response.json(members.list("invites", fields));
    case ACCESS_OPS.INVITES_SNAPSHOT:
      return Response.json(transact(() => members.snapshot("invites", fields)));
    case ACCESS_OPS.INVITES_DIGEST:
      return Response.json(await members.digest("invites"));
    case INVITE_FIND:
      return Response.json({ invite: members.inviteByToken(fields.tokenHash) });
    case ACCESS_OPS.ACCESS_HOME:
      return Response.json({ home: members.setHome(fields.home) });
    case REACH_FLUSH:
      return Response.json({ pending: await flushReach(store) });
    default:
      return null;
  }
}

/** The membership part of `ws.state`. */
export function membersState(store) {
  return store.members ? store.members.state() : null;
}
