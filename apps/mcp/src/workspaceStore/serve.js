/**
 * A workspace object's answer to one call (`workspaceStore/api.js`).
 *
 * Bucket-shaped calls (`head`, `get`, `put`, `delete`, `list`) are Tex's
 * objects' own (`texStore/wire.js` `serveTexStore`), over the same storage.
 * The `ws.*` calls carry JSON bodies and answer JSON.
 */

import { canSee, PrivacyOverrides } from "../privacy/engine.js";
import { serveTexStore } from "../texStore/wire.js";
import { isWorkspaceObjectKey, MAX_READ_IDS } from "./api.js";
import { WorkspaceRowRefused } from "./rows.js";

const CALL = "x-tex-call";
const SCOPES = new Set(["private", "team"]);

function opOf(request) {
  try {
    return JSON.parse(decodeURIComponent(request.headers.get(CALL) ?? "null"))?.op ?? null;
  } catch {
    return null;
  }
}

/** The held rules as `canSee` takes them: folder rules and per-note overrides (as `store/privacyAuthority.js` renders them). */
export function parsedRules(rules) {
  const overrides = new PrivacyOverrides();
  for (const note of rules.notes) overrides.set(note.path, note.visibility);
  return { rules: rules.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides };
}

/**
 * Notes by id, with the permission check in the same place as the text. A
 * refused note and a missing one answer alike, after the same storage read.
 * No rules held means nothing is shown: the object fails closed.
 */
export async function readNotes({ rows, objects }, { ids, scope, groups }) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_IDS) throw new WorkspaceRowRefused(`a read names 1 to ${MAX_READ_IDS} notes`);
  if (!SCOPES.has(scope)) throw new WorkspaceRowRefused("a read needs its scope");
  const tokens = new Set(Array.isArray(groups) ? groups.filter((group) => typeof group === "string") : []);
  const held = rows.rules();
  const parsed = held === null ? null : parsedRules(held);
  const notes = [];
  for (const id of ids) {
    const row = typeof id === "string" ? rows.byNoteId(id) : null;
    const key = row?.storageKey ?? (typeof id === "string" ? `notes/${id}.md` : null);
    const visible = row !== null && parsed !== null && canSee(row.path, scope, parsed.rules, parsed.overrides, tokens);
    const local = key !== null && isWorkspaceObjectKey(key);
    // Read whether or not the caller may see it, so a refusal costs what a miss costs.
    const found = local ? objects.get(key, {}) : null;
    if (!visible) notes.push({ id, found: false });
    else if (!local) notes.push({ id, found: false, elsewhere: key });
    else if (found === null || found.body === undefined) notes.push({ id, found: false });
    else {
      notes.push({
        id,
        found: true,
        path: row.path,
        etag: found.etag,
        contentType: found.httpMetadata?.contentType ?? null,
        text: new TextDecoder().decode(found.body),
      });
    }
  }
  return { notes, accessVersion: held?.accessVersion ?? null };
}

/** `store` is `{rows: workspaceRows(sql), objects: texObjects(sql)}`. */
export async function serveWorkspaceStore(store, request) {
  const op = opOf(request);
  if (typeof op !== "string" || !op.startsWith("ws.")) return await serveTexStore(store.objects, request);
  let fields;
  try {
    fields = JSON.parse((await request.text()) || "{}");
  } catch {
    return Response.json({ error: "bad_call" }, { status: 400 });
  }
  const { rows } = store;
  try {
    switch (op) {
      case "ws.read":
        return Response.json(await readNotes(store, fields));
      case "ws.rows.put":
        return Response.json(rows.put(fields.rows));
      case "ws.rows.remove":
        return Response.json(rows.remove(fields.ids, fields.at));
      case "ws.rows.get":
        return Response.json({ rows: rows.get(fields.ids) });
      case "ws.rows.list":
        return Response.json(rows.list(fields));
      case "ws.rules.put":
        return Response.json(rows.putRules(fields.rules));
      case "ws.rules.get":
        return Response.json({ rules: rows.rules() });
      case "ws.state":
        return Response.json({
          home: rows.home(),
          backfilledAt: rows.backfilledAt(),
          rows: rows.count(),
          accessVersion: rows.rules()?.accessVersion ?? null,
        });
      case "ws.home":
        return Response.json({ home: rows.setHome(fields.home) });
      case "ws.backfilled":
        return Response.json({ backfilledAt: rows.markBackfilled(fields.at) });
      default:
        return Response.json({ error: "unknown_op" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof WorkspaceRowRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
}
