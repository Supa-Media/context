/**
 * The workspace object's write ops (`docs/decisions/storage-and-credentials/object-row-writes.md`). Each is
 * `(ctx, body) => {answer, change?, narrows}`, run inside the object's storage transaction by `serveWrites.js`:
 * `ctx` is `{rows, now, lookupLive}`. `change` is what the mirror gets (`workspaceStore/mirrorOutbox.js`);
 * `narrows` says whether the answer waits for the mirror (taking access away does; a save does not).
 */

import { writeAccess } from "./accessWrite.js";

export class WriteOpRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteOpRefused";
  }
}

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

/** The write ops by name. Every name starts with `ws.write.`. */
export const WRITE_OPS = Object.freeze({
  "ws.write.wrote": wrote,
  "ws.write.access": writeAccess,
});
