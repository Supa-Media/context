/**
 * The workspace object's write ops (`docs/decisions/storage-and-credentials/object-row-writes.md`). Each is
 * `(ctx, body) => {answer, change?, narrows}`, run inside the object's storage transaction by `serveWrites.js`:
 * `ctx` is `{rows, sql, members, now, lookupLive, mintId}`: the rows and the object's SQL, the membership store (or null) that
 * judges a member's reading, the clock, a lookup of the live row at a path, and `mintId` for a row the object makes. `change` is what the mirror gets (`workspaceStore/mirrorOutbox.js`);
 * `narrows` says whether the answer waits for the mirror (taking access away does; a save does not).
 */

import { writeAccess } from "./accessWrite.js";
import { TREE_WRITE_OPS } from "./treeWrites.js";
import { WriteOpRefused } from "./writeRefusal.js";
import { effectiveVisibility, isPlumbing, PrivacyOverrides } from "../privacy/engine.js";
import { idKeyFor, isNoteId } from "../store/noteIdKeys.js";

export { WriteOpRefused };

const MAX_TEXT = 1024;
const text = (value) => typeof value === "string" && value !== "" && value.length <= MAX_TEXT && !value.includes("\0");
const optionalText = (value) => value === undefined || text(value);
const NOT_FOUND = Object.freeze({ answer: Object.freeze({ ok: false, code: "NOT_FOUND" }), change: null, narrows: false });

/** `ws.write.wrote`: a file's bytes were written to storage; its row takes the new etag and size. */
function wrote(ctx, body) {
  if (!text(body.path)) throw new WriteOpRefused("a write names its path");
  if (!text(body.key)) throw new WriteOpRefused("a write names its storage key");
  if (!text(body.etag)) throw new WriteOpRefused("a write names its etag");
  if (body.size !== undefined && !(Number.isFinite(body.size) && body.size >= 0)) throw new WriteOpRefused("a size is a number of bytes");
  if (body.at !== undefined && !Number.isFinite(body.at)) throw new WriteOpRefused("a clock is a finite number");
  if (typeof body.keyed !== "boolean") throw new WriteOpRefused("a write says whether it is keyed");
  if (!optionalText(body.keyEtag)) throw new WriteOpRefused("a key etag is text");

  const found = ctx.lookupLive(body.path);
  if (found === null || found.kind !== "file") return { ...NOT_FOUND };
  // A write to another key than the row's (the row moved on to a new key since) is the control plane's to judge.
  if (typeof found.storageKey === "string" && found.storageKey !== body.key) return { ...NOT_FOUND };
  const row = ctx.rows.originate({ id: found.id, fields: { etag: body.etag, ...(body.size !== undefined ? { size: body.size } : {}) } }, ctx.now);
  if (row === null) return { ...NOT_FOUND };

  const record = {
    path: found.path,
    key: body.key,
    etag: body.etag,
    ...(body.size !== undefined ? { size: body.size } : {}),
    ...(body.at !== undefined ? { at: body.at } : {}),
    keyed: body.keyed,
    ...(body.keyEtag !== undefined ? { keyEtag: body.keyEtag } : {}),
  };
  return { answer: { ok: true, at: row.at }, change: { op: "wrote", record, objectAt: row.at }, narrows: false };
}

/** The answer for a new note the object leaves to the control plane: nothing was written, and the caller asks there. */
const DEFER = Object.freeze({ answer: Object.freeze({ ok: false, code: "DEFER" }), change: null, narrows: false });
/** A path's visibility under the rules the object holds, read as `serve.js` `parsedRules` reads them for `canSee`. */
function heldVisibility(held, path) {
  const overrides = new PrivacyOverrides();
  for (const note of held.notes) overrides.set(note.path, note.visibility);
  return effectiveVisibility(path, held.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides);
}
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * `ws.write.adopt`: a new note's row, made here at the object's clock, for bytes the gateway just wrote at the note's
 * own id key. Only the plain case is taken; every other answers DEFER and the control plane adopts it as before:
 *  - the key is the id key for the path (a Tex home's key is the control plane's), and the path is not plumbing;
 *  - its folder is a live folder here (standing up folders, and a built-in folder's default name, are not done here);
 *  - nothing live holds the path, and no live row holds the note id (a name taken is the control plane's to name);
 *  - the note is no wider here than the writer asked (`tier`): a note meant to be private is adopted only where the
 *    rules held here already make it private, so no reader of the object sees it before its narrowing lands.
 */
function adopt(ctx, body) {
  if (!text(body.path)) throw new WriteOpRefused("an adoption names its path");
  if (!isNoteId(body.noteId)) throw new WriteOpRefused("an adoption names its note id");
  if (!text(body.key)) throw new WriteOpRefused("an adoption names its storage key");
  if (!text(body.etag)) throw new WriteOpRefused("an adoption names its etag");
  if (body.size !== undefined && !(Number.isFinite(body.size) && body.size >= 0)) throw new WriteOpRefused("a size is a number of bytes");
  if (!Number.isFinite(body.at)) throw new WriteOpRefused("an adoption carries its clock");
  if (body.tier !== "private" && body.tier !== "team") throw new WriteOpRefused("an adoption names the tier it was written for");

  const { path, noteId, key } = body;
  if (isPlumbing(path) || key !== idKeyFor(noteId, path)) return { ...DEFER };
  const parent = parentOf(path);
  if (parent !== "") {
    const folder = ctx.lookupLive(parent);
    if (folder === null || folder.kind !== "folder") return { ...DEFER };
  }
  if (ctx.lookupLive(path) !== null || ctx.rows.byNoteId(noteId) !== null) return { ...DEFER };
  const held = ctx.rows.rules("member");
  if (held === null) return { ...DEFER };
  if (body.tier === "private" && heldVisibility(held, path) !== "private") return { ...DEFER };

  const row = ctx.rows.originateNew(
    { id: ctx.mintId(), noteId, path, kind: "file", storageKey: key, etag: body.etag, ...(body.size !== undefined ? { size: body.size } : {}) },
    ctx.now,
  );
  const record = { path, noteId, key, etag: body.etag, ...(body.size !== undefined ? { size: body.size } : {}), at: body.at, objectId: row.id };
  return { answer: { ok: true, adopted: true, at: row.at }, change: { op: "adopt", record, objectAt: row.at }, narrows: false };
}

/** The write ops by name. Every name starts with `ws.write.`. */
export const WRITE_OPS = Object.freeze({
  "ws.write.wrote": wrote,
  "ws.write.access": writeAccess,
  "ws.write.adopt": adopt,
  ...TREE_WRITE_OPS,
});
