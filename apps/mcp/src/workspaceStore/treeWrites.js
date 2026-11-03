/**
 * The tree's write ops over a workspace object: `ws.write.trash` and `ws.write.restore`. `treeOps.js` makes each move
 * in the object's rows; this module judges the caller first, with the audience's rules as `serve.js` `judgeFor` holds
 * them, and turns the answer into the op's `{answer, change, narrows}` (`writeOps.js`).
 *
 * Neither waits for the mirror (decided by the owner, 2026-11-03). Share links, websites and the console's search
 * resolve a path through Convex's rows, so for up to the mirror's lag they may still serve a note just trashed, to
 * people who could open it a moment earlier: nobody gains access, and the trash answers inside the 0.1 s bar. A
 * restore puts a note back only where it was. Judgement is by the caller's own scope, groups and user id, never by a value the caller sends about
 * itself beyond those: the gateway resolved them.
 */

import { judgeFor } from "./serve.js";
import { treeOps } from "./treeOps.js";
import { WriteOpRefused } from "./writeRefusal.js";

const MAX_TEXT = 1024;
const MAX_FILES = 1000;
const text = (value) => typeof value === "string" && value !== "" && value.length <= MAX_TEXT && !value.includes("\0");
const optional = (value, check) => value === undefined || check(value);
const groupList = (value) => Array.isArray(value) && value.every((group) => typeof group === "string");
const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/** The caller's judge over the object's rules: `sees(path)`, as `serve.js` judges a read. Refuses a scope it does not know. */
function judgeOf(ctx, body) {
  if (body.scope !== "private" && body.scope !== "team") throw new WriteOpRefused("a write names its scope: private or team");
  return judgeFor(ctx.rows, { scope: body.scope, groups: body.groups, audience: "member", userId: body.userId ?? null }, ctx.members ?? null);
}

/** Refusals are `treeOps`' reasons, named as the wire names them (`NOT_FOUND`, `HIDDEN`, `CHANGED`, `INVALID`, `TAKEN`...). */
function refused(reason) {
  const answer = { ok: false, code: reason.reason.toUpperCase(), ...(reason.currentEtag ? { currentEtag: reason.currentEtag } : {}) };
  return { answer, change: null, narrows: false };
}

const NOT_FOUND = Object.freeze({ answer: Object.freeze({ ok: false, code: "NOT_FOUND" }), change: null, narrows: false });

/** The mirror's change for a tree move: the moved row by id, the folders it stood up, and the ids it removed. */
function treeChange(moved, folders, removed, audit = null) {
  const clocks = [moved.at, ...folders.map((folder) => folder.at), ...removed.map((entry) => entry.at)];
  return {
    op: "tree",
    record: {
      moves: [moved],
      folders: folders.map((folder) => ({ id: folder.id, noteId: folder.noteId, path: folder.path, role: folder.role, at: folder.at })),
      removed,
      trash: true,
      // Who asked, so the control plane writes their audit line as its own trash and restore do.
      ...(audit === null ? {} : { audit }),
    },
    objectAt: clocks.reduce((latest, at) => Math.max(latest, at), 0),
  };
}

/** The audit line's actor, for a call that named the person it acts for; none for a call that acts for nobody. */
const auditOf = (body, action, files) => (typeof body.userId === "string" ? { actorUserId: body.userId, action, files } : null);

/** `ws.write.trash`: moves a file or folder into the trash, judged as the caller sees it now. */
function trash(ctx, body) {
  if (!text(body.path)) throw new WriteOpRefused("a trash names its path");
  if (!optional(body.expectedEtag, text)) throw new WriteOpRefused("an expected etag is text");
  if (!optional(body.plannedFiles, (value) => Array.isArray(value) && value.length <= MAX_FILES && value.every(text))) {
    throw new WriteOpRefused("planned files are a list of paths");
  }
  if (!optional(body.sealsChatHomes, (value) => typeof value === "boolean")) throw new WriteOpRefused("sealsChatHomes is a boolean");
  if (!optional(body.groups, groupList)) throw new WriteOpRefused("groups are a list of names");
  if (!optional(body.userId, (value) => value === null || text(value))) throw new WriteOpRefused("a user id is text");
  const judge = judgeOf(ctx, body);

  const result = treeOps(ctx.sql).trash({
    path: body.path,
    now: ctx.now,
    expectedEtag: body.expectedEtag,
    plannedFiles: body.plannedFiles,
    judge: (path) => judge.sees({ path }),
    sealsChatHomes: body.sealsChatHomes,
  });
  if (!result.ok) return refused(result);
  const { moved, folders, removed, count, to } = result;
  return {
    answer: { ok: true, to, count, at: moved.at },
    change: treeChange(moved, folders, removed, auditOf(body, "trash", count)),
    narrows: false,
  };
}

/**
 * `ws.write.restore`: moves a note or folder out of the trash to `to`. The caller must see `to`, the name it returns
 * to: a note it could not see at its old name is not its to bring back. Rows are judged at the names they will take
 * (the trash path maps onto `to`), since the trash itself is never a path a rule names.
 */
function restore(ctx, body) {
  if (!text(body.from)) throw new WriteOpRefused("a restore names its trash path");
  if (!text(body.to)) throw new WriteOpRefused("a restore names its destination");
  if (!optional(body.sealsChatHomes, (value) => typeof value === "boolean")) throw new WriteOpRefused("sealsChatHomes is a boolean");
  if (!optional(body.groups, groupList)) throw new WriteOpRefused("groups are a list of names");
  if (!optional(body.userId, (value) => value === null || text(value))) throw new WriteOpRefused("a user id is text");
  // A trashed name comes back where it came from (`.context/trash/<stamp>/<name>`), never anywhere else: a restore
  // elsewhere would be a move out of the trash that no rule judged, and could set a private note under a team folder.
  const origin = /^\.context\/trash\/[^/]+\/(.+)$/.exec(body.from);
  if (origin === null || origin[1] !== body.to) return { ...NOT_FOUND };
  const judge = judgeOf(ctx, body);
  if (!judge.sees({ path: body.to })) return { ...NOT_FOUND };

  const { from, to } = body;
  const named = (path) => (under(path, from) ? `${to}${path.slice(from.length)}` : path);
  const result = treeOps(ctx.sql).restore({
    from,
    to,
    now: ctx.now,
    judge: (path) => judge.sees({ path: named(path) }),
    sealsChatHomes: body.sealsChatHomes,
  });
  if (!result.ok) return refused(result);
  const { moved, folders, removed, count } = result;
  return {
    answer: { ok: true, count, at: moved.at },
    change: treeChange(moved, folders, removed, auditOf(body, "restore", count)),
    narrows: false,
  };
}

/** The tree write ops by name, merged into `WRITE_OPS` (`writeOps.js`). */
export const TREE_WRITE_OPS = Object.freeze({
  "ws.write.trash": trash,
  "ws.write.restore": restore,
});
