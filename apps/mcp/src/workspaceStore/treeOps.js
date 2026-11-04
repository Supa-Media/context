/**
 * File operations on a workspace object's tree rows (`workspaceStore/rows.js` owns `ws_rows`): create a folder,
 * move or rename, trash, restore and delete, each one synchronous run of SQL, so the object commits it whole
 * (a Durable Object keeps every write made without an `await` between them as one transaction). The object is the
 * writer of record for an object-home workspace (`docs/decisions/storage-and-credentials/object-row-writes.md`);
 * these are the rules `apps/convex/functions/lib/nodes/rowMove.ts`, `rowTrash.ts` and `archiveTwins.ts` apply to
 * Convex's `nodes`, over the object's own rows. Pure over a `sql` with the Durable Object's shape, as `rows.js` is.
 *
 * What differs from Convex's move, and why:
 *  - No cap and no pages. A folder move rewrites every path under it here, in one transaction: a workspace's rows
 *    fit in its object (10 GB), so nothing is chunked, and no move is ever half done for another to trip over.
 *  - A tombstone at a destination stays: rows are keyed by id, a tombstone never answers a live read, and it keeps
 *    its clock against a late push of its own id.
 *  - Privacy rules are not written here. A trash keeps the note's rules at its own name for Restore, as Convex's
 *    does; a move that narrows access is the caller's to hold until the mirror lands (`object-row-writes.md`).
 *    Whether the caller may see what it moves is asked of `judge`, which the caller builds from the rules it holds.
 *
 * Every write stamps the row's clock `at = max(now, held.at + 1)` (the contract's clock rule), and every answer
 * names the rows it changed (`rows`, as they now are) and the ids it removed with their clocks (`removed`), so the
 * object's outbox can mirror exactly those.
 */

import folderRoles from "../../../../packages/shared/src/folderRoles.cjs";
import { newNoteId } from "../store/noteIdKeys.js";

const { MAIN_ROLES, folderJobs, isRowRole, jobAt, jobOfName } = folderRoles;

export const TRASH_ROOT = ".context/trash";
export const OLD_COPIES_ROOT = ".context/old-copies";
/** Trash names tried for one stamp (`<stamp>`, `<stamp>-2`, ...) before a trash is refused, as Convex's. */
export const TRASH_ATTEMPTS = 100;
/** The folder holding Tex's group chat homes, sealed in the workspace that keeps them (`sealedChats.ts`). */
export const CHAT_HOMES_FOLDER = "tex/groups";
const MAX_PATH = 512;
const MAX_DEPTH = 64;

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** The folders above `path`, outermost first: `a/b/c.md` → `a`, `a/b`. */
const chainOf = (path) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);
export const underHiddenRoot = (path) => path.startsWith(`${TRASH_ROOT}/`) || path.startsWith(`${OLD_COPIES_ROOT}/`);
/** The trash's name for a stamp: the server's time, with `:` and `.` made safe for a path (`timestampSlug`). */
export const trashStamp = (now) => new Date(now).toISOString().replace(/[:.]/g, "-");

/** A path a tree row may take: no empty, dot or dot-dot segment, no leading or trailing slash, no NUL. */
function validPath(path) {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const fold = (path) => path.normalize("NFC").toLowerCase();
function inChatHomes(path) {
  const folded = fold(path);
  return folded === CHAT_HOMES_FOLDER || folded.startsWith(`${CHAT_HOMES_FOLDER}/`);
}
const touchesChatHomes = (path) => path !== "" && (inChatHomes(path) || CHAT_HOMES_FOLDER.startsWith(`${fold(path)}/`));
const depthInside = (path) => (inChatHomes(path) ? fold(path).split("/").length - 2 : 0);

/**
 * Whether a move (or a trash, `trash`) carries anything out of, into or across the chat homes. What stays inside
 * one home moves; a note in a home may be trashed and restored; nothing else touching them moves
 * (`apps/convex/functions/lib/nodes/sealedChats.ts`, decided by the owner, 2026-10-31).
 */
export function chatHomesMoveRefused(from, to, trash) {
  if (!touchesChatHomes(from) && !touchesChatHomes(to)) return false;
  if (trash) return !(depthInside(from) >= 2 || (depthInside(to) >= 2 && !touchesChatHomes(from)));
  if (depthInside(from) < 2 || depthInside(to) < 2) return true;
  const homeOf = (path) => fold(path).split("/").slice(0, 3).join("/");
  return homeOf(from) !== homeOf(to);
}

/** An id the object mints for a row it creates: `o_` and 32 hex characters. Every id is opaque to its readers. */
export function objectRowId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `o_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function rowOut(row) {
  return {
    id: row.id,
    noteId: row.note_id ?? null,
    path: row.path,
    kind: row.kind,
    storageKey: row.storage_key ?? null,
    etag: row.etag ?? null,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    collaborates: Number(row.collaborates) === 1,
    uploaded: row.uploaded === null || row.uploaded === undefined ? null : Number(row.uploaded),
    role: row.role ?? null,
    order: row.ord === null || row.ord === undefined ? null : Number(row.ord),
    archiveOf: row.archive_of ?? null,
    sort: row.sort ?? null,
    created: row.created === null || row.created === undefined ? null : Number(row.created),
    at: Number(row.at),
  };
}

/**
 * The tree's file operations over `sql`. `mintId()` names a row the object creates (a folder a move or a new
 * folder stands up); it defaults to the object's own id shape (`objectRowId`).
 */
export function treeOps(sql, { mintId = objectRowId } = {}) {
  const liveAt = (path) => all(sql.exec("SELECT * FROM ws_rows WHERE path = ? AND gone = 0 ORDER BY at DESC LIMIT 1", path))[0] ?? null;
  const goneFolderAt = (path) =>
    all(sql.exec("SELECT * FROM ws_rows WHERE path = ? AND gone = 1 AND kind = 'folder' ORDER BY at DESC LIMIT 1", path))[0] ?? null;
  const liveBelow = (path) =>
    // Everything under `path/` as a range on the path index ('0' is the byte after '/'): a `substr` test read every row.
    all(sql.exec("SELECT * FROM ws_rows WHERE gone = 0 AND path >= ? || '/' AND path < ? || '0' ORDER BY path", path, path));
  const anyLiveChild = (folder) =>
    all(
      sql.exec(
        "SELECT id FROM ws_rows WHERE gone = 0 AND path >= ? || '/' AND path < ? || '0' AND instr(substr(path, length(?) + 2), '/') = 0 LIMIT 1",
        folder, folder, folder,
      ),
    ).length > 0;
  /** Which folder does each job now, from the live top-level folders and every row with a job (`folderJobs`). */
  const jobsNow = () =>
    folderJobs(
      all(
        sql.exec(
          "SELECT path, role FROM ws_rows WHERE gone = 0 AND kind = 'folder' AND substr(path, 1, 9) <> '.context/' AND (instr(path, '/') = 0 OR role IS NOT NULL)",
        ),
      ).map((row) => ({ path: row.path, name: nameOf(row.path), role: row.role ?? undefined, top: !row.path.includes("/") })),
    );
  const jobOfRow = (row, jobs) => {
    if (row.kind !== "folder" || row.role === "none") return null;
    return isRowRole(row.role) ? row.role : jobAt(jobs, row.path);
  };
  const stamp = (row, now) => Math.max(now, Number(row.at) + 1);
  /**
   * Records `fields` as the object's own on row `id` at clock `at` (`rows.js` `originate`): a push from Convex read
   * before the mirror took this change keeps them, until a push that agrees with them (`ownedAgainst`). `gone` is
   * owned too, so a row the object removed or brought back stays so against an older push.
   */
  const claim = (id, fields, at) => {
    const held = all(sql.exec("SELECT own_fields FROM ws_rows WHERE id = ?", id))[0];
    const before = held?.own_fields ? JSON.parse(held.own_fields) : [];
    sql.exec("UPDATE ws_rows SET own_at = ?, own_fields = ? WHERE id = ?", at, JSON.stringify([...new Set([...before, ...fields])]), id);
  };

  /**
   * A move into or under the Archive, or of the Archive itself (`archiveTwins.ts`): the Archive stays at the top,
   * and no built-in folder goes into it. Answers the refusal, or null.
   */
  function archiveRefusal(root, to, jobs) {
    if (root.kind !== "folder") return null;
    if (jobOfRow(root, jobs) === "archive") return to.includes("/") ? "archive_stays" : null;
    const archive = jobs.jobs.archive;
    if (typeof archive !== "string" || !under(to, archive)) return null;
    const builtIn = Object.entries(jobs.jobs).some(([job, home]) => job !== "archive" && typeof home === "string" && under(home, root.path));
    return builtIn ? "built_in_archived" : null;
  }

  /** The job a folder made at `path` takes: a top-level folder named for a job nobody does, or the meetings folder. */
  function roleForNew(path, jobs, meetingsPath) {
    if (!path.includes("/")) {
      const job = jobOfName(nameOf(path));
      if (job !== null && jobs.jobs[job] === null) return job;
    }
    return meetingsPath === path && jobs.jobs.meetings === null ? "meetings" : null;
  }

  /**
   * The folders of `chain`, outermost first: kept where a live folder stands, revived where a removed one held the
   * name, made where nothing did. The caller has refused a chain with a live file in it. Answers the ids written.
   */
  function standFolders(chain, now, jobs, meetingsPath) {
    const written = [];
    for (const path of chain) {
      const live = liveAt(path);
      if (live !== null) continue;
      const gone = goneFolderAt(path);
      if (gone !== null) {
        const at = stamp(gone, now);
        sql.exec("UPDATE ws_rows SET gone = 0, at = ? WHERE id = ?", at, gone.id);
        claim(gone.id, ["path", "gone"], at);
        written.push(gone.id);
        continue;
      }
      const id = mintId();
      sql.exec(
        "INSERT INTO ws_rows (id, note_id, path, kind, role, at, own_at, own_fields, gone) VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, 0)",
        id, newNoteId(now), path, roleForNew(path, jobs, meetingsPath), now, now, JSON.stringify(["noteId", "path", "kind", "role", "gone"]),
      );
      written.push(id);
    }
    return written;
  }

  /**
   * Removes the folder at `start` once nothing live is in it, then each parent left empty above it, so no listing
   * draws a folder nothing is in. A folder with a job, or a top-level one named for one, stays (`retireEmptied`).
   */
  function retireEmptied(start, now) {
    const removed = [];
    let path = start;
    for (let depth = 0; path !== "" && depth < MAX_DEPTH; depth += 1) {
      const folder = liveAt(path);
      if (folder === null || folder.kind !== "folder" || folder.role !== null) break;
      if (!path.includes("/") && jobOfName(path) !== null) break;
      if (anyLiveChild(path)) break;
      const at = stamp(folder, now);
      sql.exec("UPDATE ws_rows SET gone = 1, at = ? WHERE id = ?", at, folder.id);
      claim(folder.id, ["gone"], at);
      removed.push({ id: folder.id, at });
      path = parentOf(path);
    }
    return removed;
  }

  const changedRows = (ids) =>
    [...new Set(ids)].flatMap((id) => all(sql.exec("SELECT * FROM ws_rows WHERE id = ? AND gone = 0", id)).map(rowOut));
  /** Whether a live file sits where a folder of `path`'s chain must stand. */
  const fileInChain = (path) => chainOf(path).some((folder) => liveAt(folder)?.kind === "file");

  const ops = {
    /** The folders doing a job now (the Inbox, Tex, the archive, ...), by path. */
    jobFolders() {
      return Object.values(jobsNow().jobs).filter((path) => typeof path === "string");
    },

    /**
     * Moves or renames the file or folder at `from` to `to`, and everything under it. Refused, with nothing
     * written: `invalid` (a name into itself, a trash flag with neither end in the trash, the trash named without
     * it, a sealed chat home, a main folder into the trash), `not_found` (no live row, or one `judge` hides),
     * `hidden` (something under it `judge` hides), `archive_stays` / `built_in_archived`, `changed` (the file's
     * etag is not `expectedEtag`, or its files are not `plannedFiles`), `unkeyed`, `taken`.
     *
     * `check`: decide every refusal and write nothing; the answer then names the rows that would move.
     * `judge(path)`: whether the caller may see a path; absent, everything is seen (a caller that judged already).
     * `sealsChatHomes`: this workspace keeps Tex's group chat homes. `meetingsPath`: the meetings setting's folder.
     */
    move({ from, to, now, trash = false, expectedEtag, plannedFiles, judge, sealsChatHomes = false, meetingsPath = null, check = false }) {
      const refuse = (reason, extra = {}) => ({ ok: false, reason, ...extra });
      if (!validPath(from) || !validPath(to) || !Number.isFinite(now)) return refuse("invalid");
      if (from === to || under(to, from) || under(from, to)) return refuse("invalid");
      const hidden = underHiddenRoot(from) || underHiddenRoot(to);
      if (trash ? !hidden : hidden || from.startsWith(".context") || to.startsWith(".context")) return refuse("invalid");
      if (sealsChatHomes && chatHomesMoveRefused(from, to, trash)) return refuse("invalid");

      const root = liveAt(from);
      if (root === null || (judge !== undefined && !judge(from))) return refuse("not_found");
      const below = liveBelow(from);
      const rows = [root, ...below];
      if (judge !== undefined && rows.some((row) => row.kind === "file" && !judge(row.path))) return refuse("hidden");
      const jobs = jobsNow();
      if (!trash) {
        const fenced = archiveRefusal(root, to, jobs);
        if (fenced !== null) return refuse(fenced);
      }
      if (expectedEtag !== undefined) {
        if (root.kind !== "file") return refuse("invalid");
        if (root.etag !== expectedEtag) return refuse("changed", root.etag === null ? {} : { currentEtag: root.etag });
      }
      const files = rows.filter((row) => row.kind === "file");
      if (plannedFiles !== undefined) {
        const live = files.map((row) => row.path).sort();
        const planned = [...plannedFiles].sort();
        if (live.length !== planned.length || live.some((path, index) => path !== planned[index])) return refuse("changed");
      }
      if (files.some((row) => row.storage_key === null || row.storage_key === undefined)) return refuse("unkeyed");
      // Every destination must be free: nothing live at it or under it, and no live file where a folder must stand.
      if (liveAt(to) !== null || liveBelow(to).length > 0 || fileInChain(to)) return refuse("taken");
      if (trash && MAIN_ROLES.includes(jobOfRow(root, jobs))) return refuse("invalid");
      // `check`: every refusal decided, nothing written, so a caller can make writes of its own before the move.
      if (check) return { ok: true, kind: root.kind, rows: rows.map((row) => ({ path: row.path, kind: row.kind, role: row.role ?? null })) };

      // Writes. Nothing above wrote, so every refusal left the rows as they were.
      // A built-in folder writes its job down before its name changes, so the job goes with it (`claimJobBeforeMove`).
      let role = root.role ?? null;
      if (!trash && root.kind === "folder" && role === null) {
        role = jobAt(jobs, root.path) ?? (meetingsPath === root.path && jobs.jobs.meetings === null ? "meetings" : null);
      }
      const written = standFolders(chainOf(to), now, jobs, meetingsPath);
      const rootAt = stamp(root, now);
      sql.exec("UPDATE ws_rows SET path = ?, role = ?, at = ? WHERE id = ?", to, role, rootAt, root.id);
      claim(root.id, ["path", "role"], rootAt);
      for (const row of below) {
        const at = stamp(row, now);
        sql.exec("UPDATE ws_rows SET path = ?, at = ? WHERE id = ?", `${to}${row.path.slice(from.length)}`, at, row.id);
        claim(row.id, ["path"], at);
      }
      const removed = retireEmptied(parentOf(from), now);
      return {
        ok: true,
        kind: root.kind,
        count: rows.length,
        files: files.map((row) => ({ from: row.path, to: `${to}${row.path.slice(from.length)}` })),
        ...(root.kind === "file" && root.etag !== null ? { etag: root.etag } : {}),
        rows: changedRows([...written, ...rows.map((row) => row.id)]),
        removed,
        // What the mirror needs: the moved row by id (Convex builds the paths beneath it), the folders stood up.
        moved: { id: root.id, kind: root.kind, from, to, at: rootAt },
        folders: changedRows(written),
      };
    },

    /**
     * Moves `path` into the trash, at `.context/trash/<stamp>/<path>`, taking `<stamp>-2`, `<stamp>-3`, ... while a
     * name is taken. The note keeps its id, text and rules for Restore. Refusals are `move`'s.
     */
    trash({ path, now, ...rest }) {
      if (!validPath(path) || path.startsWith(".context")) return { ok: false, reason: "invalid" };
      const slug = trashStamp(now);
      let answer = { ok: false, reason: "taken" };
      for (let n = 1; n <= TRASH_ATTEMPTS && !answer.ok && answer.reason === "taken"; n += 1) {
        const to = `${TRASH_ROOT}/${n === 1 ? slug : `${slug}-${n}`}/${path}`;
        answer = ops.move({ ...rest, from: path, to, now, trash: true });
        if (answer.ok) answer = { ...answer, to };
      }
      return answer;
    },

    /** Moves `from` (a name in the trash) back to `to`, the name it came from. A name a live row holds is `taken`. */
    restore({ from, to, now, ...rest }) {
      if (typeof from !== "string" || !from.startsWith(`${TRASH_ROOT}/`)) return { ok: false, reason: "invalid" };
      return ops.move({ ...rest, from, to, now, trash: true });
    },

    /**
     * Removes for good what sits in the trash (or Context's old copies) at `path`, with everything under it. A note
     * outside them is never deleted in one step: it goes to the trash first, as Convex refuses a keyed delete.
     */
    remove({ path, now, limit }) {
      if (!validPath(path) || !underHiddenRoot(path) || !Number.isFinite(now)) return { ok: false, reason: "invalid" };
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) return { ok: false, reason: "invalid" };
      const root = liveAt(path);
      if (root === null) return { ok: false, reason: "not_found" };
      const below = liveBelow(path);
      // A folder bigger than `limit` goes a page at a time, deepest rows first, so a page never leaves a row under a
      // folder it removed; the folder itself, and the emptied folders above it, go with the last page.
      if (limit !== undefined && below.length + 1 > limit) {
        const depth = (row) => row.path.split("/").length;
        const page = [...below].sort((a, b) => depth(b) - depth(a) || (a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1)).slice(0, limit);
        const removed = [];
        const files = [];
        for (const row of page) {
          const at = stamp(row, now);
          sql.exec("UPDATE ws_rows SET gone = 1, at = ? WHERE id = ?", at, row.id);
          claim(row.id, ["gone"], at);
          removed.push({ id: row.id, at });
          if (row.kind === "file") files.push({ id: row.id, noteId: row.note_id ?? null, storageKey: row.storage_key ?? null });
        }
        return { ok: true, kind: root.kind, count: removed.length, rows: [], removed, files, folders: [], more: true };
      }
      const removed = [];
      const files = [];
      for (const row of [root, ...below]) {
        const at = stamp(row, now);
        sql.exec("UPDATE ws_rows SET gone = 1, at = ? WHERE id = ?", at, row.id);
        claim(row.id, ["gone"], at);
        removed.push({ id: row.id, at });
        // What the bucket half still deletes: each file's note id and the key its bytes are at.
        if (row.kind === "file") files.push({ id: row.id, noteId: row.note_id ?? null, storageKey: row.storage_key ?? null });
      }
      removed.push(...retireEmptied(parentOf(path), now));
      return { ok: true, kind: root.kind, count: removed.length, rows: [], removed, files, folders: [], more: false };
    },

    /**
     * Makes the folder at `path` and any folder above it that is missing. A folder already there is answered as it
     * is (`created: false`); a file at the name or above it is `taken`.
     */
    createFolder({ path, now, meetingsPath = null }) {
      if (!validPath(path) || path.startsWith(".context") || !Number.isFinite(now)) return { ok: false, reason: "invalid" };
      const held = liveAt(path);
      if (held !== null) return held.kind === "folder" ? { ok: true, created: false, rows: [], removed: [], folders: [] } : { ok: false, reason: "taken" };
      if (fileInChain(path)) return { ok: false, reason: "taken" };
      const written = standFolders([...chainOf(path), path], now, jobsNow(), meetingsPath);
      const folders = changedRows(written);
      return { ok: true, created: true, rows: folders, removed: [], folders };
    },
  };
  return ops;
}
