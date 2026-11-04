/**
 * `ws.write.move`: a move or rename made in the workspace object in one transaction, with the access narrowing the
 * move needs (`accessMove.js` `narrowForMoves`) written first in the same transaction and mirrored first.
 *
 * Only the plain case is taken here. A move the control plane decides with more than the rows (a folder doing a job,
 * or one inside one, such as the Inbox's or Tex's own folders; a top-level folder, whose name can give it a job; a
 * name that twins another but for case) answers `DEFER`, and so does a workspace whose access set the object may not
 * yet decide by (`NOT_READY` from the narrowing). The caller then sends the move to the control plane as before. A
 * move into Archive is taken: the mirror marks its twins in Convex (`mirrorTree.ts`).
 *
 * `trash: true` is the one hidden move a caller may ask for by name: hiding a note among the old copies
 * (`.context/old-copies/...`). The trash itself is `ws.write.trash`. A hidden move changes nobody's access, so it is
 * not narrowed.
 *
 * `archive: {root, roots}` in place of `to` archives `from`: the object names the destination itself, under the folder
 * doing the Archive's job as this reader sees it, or else `root` (the rules' archive), at the first free numbered name,
 * so an archive is one trip with no `jobs` ask before it. It answers `NO_ARCHIVE` with neither, `ARCHIVED` for a note
 * already under the job's folder or any of `roots`, `HIDDEN_DESTINATION` for a destination the caller could not see,
 * and `to` beside an ok answer.
 *
 * Like an access write, a move does not wait for the mirror (`WAIT_FOR_MIRROR`, the owner's 0.1 s call): readers still
 * on Convex's rows may show the old place for the mirror's round trip.
 */

import { WAIT_FOR_MIRROR } from "./accessWrite.js";
import { narrowForMoves } from "./accessMove.js";
import { auditOf, judgeOf, refused, treeChange } from "./treeWrites.js";
import { OLD_COPIES_ROOT, treeOps } from "./treeOps.js";
import { WriteOpRefused } from "./writeRefusal.js";
import { folderJobsAnswer } from "./jobsAnswer.js";
import { folderVisibleAtScope } from "./listing.js";
import { archiveDestination, numberedName } from "../../../../packages/shared/src/archiveMirror.cjs";

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

/** `ws.write.move`: `{from, to | archive, expectedEtag?, trash?, scope, groups?, userId?, sealsChatHomes?}`. */
function move(ctx, body) {
  const archiving = body.archive !== undefined;
  if (!text(body.from) || (archiving ? body.to !== undefined : !text(body.to))) throw new WriteOpRefused("a move names where from and where to");
  if (archiving && !archiveAsk(body.archive)) throw new WriteOpRefused("an archive names its root and roots");
  if (!optional(body.expectedEtag, text)) throw new WriteOpRefused("an expected etag is text");
  if (!optional(body.trash, (value) => typeof value === "boolean")) throw new WriteOpRefused("trash is a boolean");
  if (archiving && body.trash === true) throw new WriteOpRefused("an archive is not a hidden move");
  if (!optional(body.sealsChatHomes, (value) => typeof value === "boolean")) throw new WriteOpRefused("sealsChatHomes is a boolean");
  if (!optional(body.groups, groupList)) throw new WriteOpRefused("groups are a list of names");
  if (!optional(body.userId, (value) => value === null || text(value))) throw new WriteOpRefused("a user id is text");
  const trash = body.trash === true;
  // The only hidden place a move may name is the old copies; the trash has its own op.
  if (trash && !body.to.startsWith(`${OLD_COPIES_ROOT}/`)) throw new WriteOpRefused("a hidden move goes among the old copies");
  const judge = judgeOf(ctx, body);
  const ops = treeOps(ctx.sql);
  return archiving ? archiveTo(ctx, body, judge, ops) : moveTo(ctx, body, body.to, judge, ops, trash);
}

/** `{root: string | null, roots: string[]}`. */
function archiveAsk(value) {
  return value !== null && typeof value === "object" && (value.root === null || text(value.root)) &&
    Array.isArray(value.roots) && value.roots.length <= 16 && value.roots.every(text);
}

/** How many numbered names an archive tries, as `firstFreePath` does. */
const ARCHIVE_NAMES = 100;

/** An archive of `body.from` (see the module note): the destination named here, then the move as any other. */
function archiveTo(ctx, body, judge, ops) {
  const source = ctx.lookupLive(body.from);
  // Asked first, so an absent note or one the caller cannot see is "not found" before anything about the archive.
  if (!source || !judge.sees({ path: body.from })) return answerOnly("NOT_FOUND");
  // The folder doing the Archive's job, as this reader sees it (the `jobs` ask's own answer, `facts.js`).
  if (judge.parsed === null) return answerOnly("DEFER");
  const folders = ctx.sql.exec("SELECT path, kind, role FROM ws_rows WHERE gone = 0 AND kind = 'folder'").toArray();
  const folderSees = (path) => folderVisibleAtScope(path, judge.clearance, judge.parsed.rules, judge.parsed.overrides);
  const job = folderJobsAnswer(folders.map((row) => ({ path: row.path, kind: row.kind, role: typeof row.role === "string" ? row.role : null })), folderSees).jobs.archive ?? null;
  const root = job ?? body.archive.root;
  if (root === null) return answerOnly("NO_ARCHIVE");
  if ([...(job === null ? [] : [job]), ...body.archive.roots].some((folder) => under(body.from, folder))) return answerOnly("ARCHIVED");
  const first = archiveDestination(root, body.from);
  for (let n = 1; n <= ARCHIVE_NAMES; n += 1) {
    const to = n === 1 ? first : `${parentOf(first)}/${numberedName(first.slice(first.lastIndexOf("/") + 1), n)}`;
    if (!judge.sees({ path: to })) return answerOnly("HIDDEN_DESTINATION");
    const result = moveTo(ctx, body, to, judge, ops, false);
    if (result.answer.code !== "TAKEN") return result;
  }
  return answerOnly("TAKEN");
}

/** The move of `body.from` to `to`, checked, then made with its narrowing in this transaction. */
function moveTo(ctx, body, to, judge, ops, trash) {
  // A caller moves what it sees, to a name it sees: a note may not be set where its mover could not find it again.
  if (!trash && !judge.sees({ path: to })) return answerOnly("NOT_FOUND");

  const asked = {
    from: body.from,
    to,
    now: ctx.now,
    trash,
    expectedEtag: body.expectedEtag,
    judge: (path) => judge.sees({ path }),
    sealsChatHomes: body.sealsChatHomes,
  };
  const checked = ops.move({ ...asked, check: true });
  if (!checked.ok) return refused(checked);
  if (deferred(ctx, ops, { from: body.from, to, trash, rows: checked.rows })) return answerOnly("DEFER");

  // The narrowing is written before the rows move (it reads the row at `from`), and goes to the mirror first.
  let narrowing = null;
  if (!trash) {
    const narrowed = narrowForMoves(ctx, [{ from: body.from, to }]);
    if (!narrowed.ready) return answerOnly("DEFER");
    narrowing = narrowed.change;
  }
  const result = ops.move(asked);
  // Every refusal was decided by the check above in this same transaction, so this cannot refuse; if it ever does,
  // throwing rolls the narrowing back with it.
  if (!result.ok) throw new WriteOpRefused(`the move refused after its check: ${result.reason}`);
  const { moved, folders, removed, count, etag, files } = result;
  const change = treeChange(moved, folders, removed, auditOf(body, "move", count), trash);
  return {
    // `files`: every file moved, from and to, for a caller that follows them (the search projection, old copies).
    answer: { ok: true, from: body.from, to, count, at: moved.at, files, ...(etag === undefined ? {} : { etag }) },
    changes: narrowing === null ? [change] : [narrowing, change],
    narrows: WAIT_FOR_MIRROR,
    ...(narrowing === null ? {} : { rules: true }),
  };
}

/** The move op by name, merged into `WRITE_OPS` (`writeOps.js`). */
export const MOVE_WRITE_OPS = Object.freeze({ "ws.write.move": move });
