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
import { AUDIENCES, WorkspaceRowRefused } from "./rows.js";

const CALL = "x-tex-call";

/** Tell a tree watcher what changed (`paths: null` is everything); a watcher's failure is never the call's. */
function changed(store, change) {
  if (typeof store.onTreeChange !== "function") return;
  try {
    store.onTreeChange(change);
  } catch {
    // The watcher catches up on its next change; the write has landed.
  }
}
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
export async function readNotes({ rows, objects }, { ids, scope, groups, audience = "member" }) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_IDS) throw new WorkspaceRowRefused(`a read names 1 to ${MAX_READ_IDS} notes`);
  const judge = judgeFor(rows, { scope, groups, audience });
  const notes = [];
  for (const id of ids) {
    const row = typeof id === "string" ? rows.byNoteId(id) : null;
    const key = row?.storageKey ?? (typeof id === "string" ? `notes/${id}.md` : null);
    const visible = judge.sees(row);
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
  return { notes, accessVersion: judge.accessVersion };
}

/**
 * The check every answer about a note goes through: the audience's rules (fail closed when none are held) and
 * `canSee` over the row's path, with the grant's scope and row tokens.
 */
function judgeFor(rows, { scope, groups, audience = "member" }) {
  if (!SCOPES.has(scope)) throw new WorkspaceRowRefused("a read needs its scope");
  if (!AUDIENCES.has(audience)) throw new WorkspaceRowRefused("not an audience");
  const tokens = new Set(Array.isArray(groups) ? groups.filter((group) => typeof group === "string") : []);
  const held = rows.rules(audience);
  const parsed = held === null ? null : parsedRules(held);
  return {
    accessVersion: held?.accessVersion ?? null,
    sees: (row) => row !== null && parsed !== null && canSee(row.path, scope, parsed.rules, parsed.overrides, tokens),
  };
}

/** Rows by path or by note id, as the gateway's note-id lookup and resolve answer them; one it may not see is absent. */
function lookUp(rows, fields, by) {
  const asked = Array.isArray(fields[by === "path" ? "paths" : "noteIds"]) ? fields[by === "path" ? "paths" : "noteIds"] : null;
  if (asked === null || asked.length === 0 || asked.length > MAX_READ_IDS) throw new WorkspaceRowRefused(`a lookup names 1 to ${MAX_READ_IDS}`);
  const judge = judgeFor(rows, fields);
  return {
    accessVersion: judge.accessVersion,
    rows: asked.map((value) => {
      const row = typeof value === "string" ? (by === "path" ? rows.byPath(value) : rows.byNoteId(value)) : null;
      if (!judge.sees(row)) return { [by === "path" ? "path" : "noteId"]: value, found: false };
      return { found: true, path: row.path, noteId: row.noteId, key: row.storageKey ?? (row.noteId ? `notes/${row.noteId}.md` : null), etag: row.etag, kind: row.kind, collaborates: row.collaborates };
    }),
  };
}

/** The paths a row change touches, before and after, for a tree watcher (`store.onTreeChange`). */
function pathsTouched(rows, ids, incoming = []) {
  const before = rows.get(ids).map((row) => row.path);
  return [...new Set([...before, ...incoming.map((row) => row?.path).filter((path) => typeof path === "string")])];
}

/**
 * `store` is `{rows: workspaceRows(sql), objects: texObjects(sql), onTreeChange?}`. `onTreeChange({paths, rules})`
 * runs after a row or rules change lands (the app's live tree), and never fails the call.
 */
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
    rows.pinWorkspace(fields.workspaceId);
    switch (op) {
      case "ws.read":
        return Response.json(await readNotes(store, fields));
      case "ws.visible":
        return Response.json({ visible: (await readNotes(store, fields)).notes.map((note) => note.found === true || typeof note.elsewhere === "string") });
      case "ws.rows.snapshot": {
        const answer = rows.snapshot(fields);
        if (answer.swapped || fields.mode === "merge") changed(store, { paths: null, rules: false });
        return Response.json(answer);
      }
      case "ws.rows.digest":
        return Response.json(await rows.digest());
      case "ws.rows.put": {
        const paths = Array.isArray(fields.rows) ? pathsTouched(rows, fields.rows.map((row) => row?.id), fields.rows) : [];
        const answer = rows.put(fields.rows);
        changed(store, { paths, rules: false });
        return Response.json(answer);
      }
      case "ws.rows.remove": {
        const paths = Array.isArray(fields.ids) ? pathsTouched(rows, fields.ids) : [];
        const answer = rows.remove(fields.ids, fields.at);
        changed(store, { paths, rules: false });
        return Response.json(answer);
      }
      case "ws.apply": {
        // Rows, removals and rules in one storage transaction: rules are keyed by path, so a move's rows and rules
        // must land together or the moved rows are judged by the old rules in between.
        const run = typeof store.transact === "function" ? store.transact : (work) => work();
        for (const audience of Object.keys(fields.rules ?? {})) if (!AUDIENCES.has(audience)) throw new WorkspaceRowRefused("not an audience");
        const paths = [
          ...(Array.isArray(fields.rows) ? pathsTouched(rows, fields.rows.map((row) => row?.id), fields.rows) : []),
          ...(Array.isArray(fields.removed) ? pathsTouched(rows, fields.removed) : []),
        ];
        const answer = run(() => {
          const kept = Array.isArray(fields.rows) && fields.rows.length > 0 ? rows.put(fields.rows).kept : 0;
          const removed = Array.isArray(fields.removed) && fields.removed.length > 0 ? rows.remove(fields.removed, fields.at).removed : 0;
          const rules = {};
          for (const [audience, held] of Object.entries(fields.rules ?? {})) rules[audience] = rows.putRules(held, audience);
          return { kept, removed, rules };
        });
        changed(store, { paths, rules: Object.values(answer.rules).some((rule) => rule.kept) });
        return Response.json(answer);
      }
      case "ws.rows.lookup":
        return Response.json(lookUp(rows, fields, "path"));
      case "ws.rows.resolve":
        return Response.json(lookUp(rows, fields, "noteId"));
      case "ws.rows.get":
        return Response.json({ rows: rows.get(fields.ids) });
      case "ws.rows.list":
        return Response.json(rows.list(fields));
      case "ws.rules.put": {
        const answer = rows.putRules(fields.rules, fields.audience ?? "member");
        if (answer.kept) changed(store, { paths: null, rules: true });
        return Response.json(answer);
      }
      case "ws.rules.get":
        return Response.json({ rules: rows.rules(fields.audience ?? "member") });
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
