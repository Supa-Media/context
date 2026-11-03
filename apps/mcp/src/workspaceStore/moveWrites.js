/**
 * `ws.write.move`: a move or rename made in the workspace object in one transaction, with the access narrowing the
 * move needs (`accessMove.js` `narrowForMoves`) written first in the same transaction and mirrored first.
 *
 * Only the plain case is taken here. A move the control plane decides with more than the rows (a folder doing a job,
 * or one inside one, such as the Inbox's or Tex's own folders; a top-level folder, whose name can give it a job; a
 * name that twins another but for case) answers `DEFER`, and so does a workspace whose access set the object may not
 * yet decide by (`NOT_READY` from the narrowing). The caller then sends the move to the control plane as before.
 *
 * `trash: true` is the one hidden move a caller may ask for by name: hiding a note among the old copies
 * (`.context/old-copies/...`). The trash itself is `ws.write.trash`. A hidden move changes nobody's access, so it is
 * not narrowed.
 *
 * Like an access write, a move does not wait for the mirror (`WAIT_FOR_MIRROR`, the owner's 0.1 s call): readers still
 * on Convex's rows may show the old place for the mirror's round trip.
 */

import { WAIT_FOR_MIRROR } from "./accessWrite.js";
import { narrowForMoves } from "./accessMove.js";
import { auditOf, judgeOf, refused, treeChange } from "./treeWrites.js";
import { OLD_COPIES_ROOT, treeOps } from "./treeOps.js";
import { WriteOpRefused } from "./writeRefusal.js";

const MAX_TEXT = 1024;
const text = (value) => typeof value === "string" && value !== "" && value.length <= MAX_TEXT && !value.includes("\0");
const optional = (value, check) => value === undefined || check(value);
const groupList = (value) => Array.isArray(value) && value.every((group) => typeof group === "string");
const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const answerOnly = (code) => ({ answer: { ok: false, code }, change: null, narrows: false });

/** A live row at a path that differs from one in `to`'s chain only by case: the control plane decides twins. */
function twinsByCase(sql, to) {
  const segments = to.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const path = segments.slice(0, depth).join("/");
    const rows = sql.exec("SELECT path FROM ws_rows WHERE gone = 0 AND lower(path) = lower(?) LIMIT 5", path).toArray();
    if (rows.some((row) => row.path !== path)) return true;
  }
  return false;
}

/** Whether the control plane, not the object, decides this move (see the module note). */
function deferred(ctx, ops, { from, to, trash, rows }) {
  if (trash) return false;
  const root = rows[0];
  if (rows.some((row) => row.role !== null && row.role !== "none")) return true;
  const jobs = ops.jobFolders();
  if (jobs.some((folder) => under(folder, from))) return true;
  if (root.kind === "folder" && (jobs.includes(parentOf(from)) || !to.includes("/"))) return true;
  return twinsByCase(ctx.sql, to);
}

/** `ws.write.move`: `{from, to, expectedEtag?, trash?, scope, groups?, userId?, sealsChatHomes?}`. */
function move(ctx, body) {
  if (!text(body.from) || !text(body.to)) throw new WriteOpRefused("a move names where from and where to");
  if (!optional(body.expectedEtag, text)) throw new WriteOpRefused("an expected etag is text");
  if (!optional(body.trash, (value) => typeof value === "boolean")) throw new WriteOpRefused("trash is a boolean");
  if (!optional(body.sealsChatHomes, (value) => typeof value === "boolean")) throw new WriteOpRefused("sealsChatHomes is a boolean");
  if (!optional(body.groups, groupList)) throw new WriteOpRefused("groups are a list of names");
  if (!optional(body.userId, (value) => value === null || text(value))) throw new WriteOpRefused("a user id is text");
  const trash = body.trash === true;
  // The only hidden place a move may name is the old copies; the trash has its own op.
  if (trash && !body.to.startsWith(`${OLD_COPIES_ROOT}/`)) throw new WriteOpRefused("a hidden move goes among the old copies");
  const judge = judgeOf(ctx, body);
  // A caller moves what it sees, to a name it sees: a note may not be set where its mover could not find it again.
  if (!trash && !judge.sees({ path: body.to })) return answerOnly("NOT_FOUND");

  const ops = treeOps(ctx.sql);
  const asked = {
    from: body.from,
    to: body.to,
    now: ctx.now,
    trash,
    expectedEtag: body.expectedEtag,
    judge: (path) => judge.sees({ path }),
    sealsChatHomes: body.sealsChatHomes,
  };
  const checked = ops.move({ ...asked, check: true });
  if (!checked.ok) return refused(checked);
  if (deferred(ctx, ops, { from: body.from, to: body.to, trash, rows: checked.rows })) return answerOnly("DEFER");

  // The narrowing is written before the rows move (it reads the row at `from`), and goes to the mirror first.
  let narrowing = null;
  if (!trash) {
    const narrowed = narrowForMoves(ctx, [{ from: body.from, to: body.to }]);
    if (!narrowed.ready) return answerOnly("DEFER");
    narrowing = narrowed.change;
  }
  const result = ops.move(asked);
  // Every refusal was decided by the check above in this same transaction, so this cannot refuse; if it ever does,
  // throwing rolls the narrowing back with it.
  if (!result.ok) throw new WriteOpRefused(`the move refused after its check: ${result.reason}`);
  const { moved, folders, removed, count, etag } = result;
  const change = treeChange(moved, folders, removed, auditOf(body, "move", count), trash);
  return {
    answer: { ok: true, from: body.from, to: body.to, count, at: moved.at, ...(etag === undefined ? {} : { etag }) },
    changes: narrowing === null ? [change] : [narrowing, change],
    narrows: WAIT_FOR_MIRROR,
    ...(narrowing === null ? {} : { rules: true }),
  };
}

/** The move op by name, merged into `WRITE_OPS` (`writeOps.js`). */
export const MOVE_WRITE_OPS = Object.freeze({ "ws.write.move": move });
