/**
 * A workspace object's answer to one call (`workspaceStore/api.js`).
 *
 * Bucket-shaped calls (`head`, `get`, `put`, `delete`, `list`) are Tex's
 * objects' own (`texStore/wire.js` `serveTexStore`), over the same storage.
 * The `ws.*` calls carry JSON bodies and answer JSON.
 */

import { serveMachineCall } from "./serveMachines.js";
import { canSee, PrivacyOverrides } from "../privacy/engine.js";
import { serveTexStore } from "../texStore/wire.js";
import { HOMES, isWorkspaceObjectKey, MAX_READ_IDS } from "./api.js";
import { ACCESS_HOMES, ACCESS_OPS, AccessRowRefused } from "./access.js";
import { judgedReader } from "./members.js";
import { AUDIENCES, WorkspaceRowRefused } from "./rows.js";
import { chatRulesFrom, chatTokens } from "./chatRules.js";
import { isPersonCall, servePersonCall } from "./personServe.js";
import { isTokenIndexCall, serveTokenIndex } from "./tokenIndex.js";
import { membersState, serveMembersCall } from "./serveMembers.js";
import { FactAskRefused, OBJECT_FACT_ASKS, OBJECT_FACT_ROW_ASKS } from "./facts.js";
import { childrenPage, manifestPage } from "./manifest.js";
import { orientSurvey } from "./orientSurvey.js";
import { markTokens, waitForMarks, WorkspaceMarkRefused } from "./marks.js";
import { BINDING_OPS, BindingRowRefused, serveBindingCall } from "./bindingRows.js";
import { accessCall, applyAccess } from "./serveAccess.js";
import { isWriteOp, serveWrites } from "./serveWrites.js";
import { serveCollabRead } from "./collabRead.js";
import { serveCollabCommit, serveCollabReplace } from "./collabReplace.js";
import { serveCreateNote } from "./createNote.js";
import { withOpen } from "./sessionOpen.js";
import { treeRows } from "./treeRows.js";
import { absentHere } from "./lookupMiss.js";
import { namesTaken } from "./namesTaken.js";
import { SearchAskRefused } from "./searchIndex.js";
import { MeaningAskRefused } from "./meaningIndex.js";
import { folderPathOf, folderVisibleAtScope, listFolderFromRows } from "./listing.js";
import { withLookupBody } from "./lookupBody.js";
import { restampRowVersions } from "./rowVersions.js";
import { isMailOp, MailAskRefused, serveMail } from "./mailOps.js";

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
export async function readNotes({ rows, objects, members = null }, { ids, scope, groups, audience = "member", userId = null, chatNames = null }) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READ_IDS) throw new WorkspaceRowRefused(`a read names 1 to ${MAX_READ_IDS} notes`);
  const judge = judgeFor(rows, { scope, groups, audience, userId, chatNames }, members);
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

/** Who may read here: the two audiences rules are held for, and a Tex guest chat, read by the guest rules. */
const READERS = new Set([...AUDIENCES, "chat"]);

/**
 * The check every answer about a note goes through: the audience's rules (fail closed when none are held) and
 * `canSee` over the row's path, with the grant's scope and row tokens. A chat reads by the guest rules as its own
 * names render them (`chatRules.js`); a chat with no names given sees nothing.
 */
export function judgeFor(rows, { scope, groups, audience = "member", userId = null, chatNames = null }, members = null) {
  if (!SCOPES.has(scope)) throw new WorkspaceRowRefused("a read needs its scope");
  if (!READERS.has(audience)) throw new WorkspaceRowRefused("not an audience");
  let reader = { scope, tokens: new Set(Array.isArray(groups) ? groups.filter((group) => typeof group === "string") : []) };
  // Where this object decides access, a member's reading is judged by who is a member here (`members.js`
  // `judgedReader`): a member read that names nobody, or somebody who is not a member, sees nothing. A guest's or a
  // chat's reading is not a member's: it is judged by its own, narrower rules, for the reader the gateway resolved.
  if (audience === "member" && members !== null && members.home() === ACCESS_HOMES.OBJECT) {
    reader = typeof userId === "string" ? judgedReader(members, { userId, scope, groups }) : null;
  }
  const guestHeld = audience === "chat" ? rows.rules("guest") : null;
  const tokens = audience === "chat" ? chatTokens(chatNames) : null;
  const held = audience !== "chat" ? rows.rules(audience) : guestHeld === null || tokens === null ? null : chatRulesFrom(guestHeld, tokens);
  const parsed = held === null || reader === null ? null : parsedRules(held);
  return {
    accessVersion: held?.accessVersion ?? null,
    /** The reader's scope and row tokens, and the rules as `canSee` takes them; `null` where nothing may be seen. */
    clearance: parsed === null ? null : { scope: reader.scope, names: reader.tokens },
    parsed,
    sees: (row) => row !== null && parsed !== null && canSee(row.path, reader.scope, parsed.rules, parsed.overrides, reader.tokens),
  };
}

/** Rows by path or by note id, as the gateway's note-id lookup and resolve answer them; one it may not see is absent. */
function lookUp(rows, fields, by, members = null) {
  const asked = Array.isArray(fields[by === "path" ? "paths" : "noteIds"]) ? fields[by === "path" ? "paths" : "noteIds"] : null;
  if (asked === null || asked.length === 0 || asked.length > MAX_READ_IDS) throw new WorkspaceRowRefused(`a lookup names 1 to ${MAX_READ_IDS}`);
  const judge = judgeFor(rows, fields, members);
  return {
    accessVersion: judge.accessVersion,
    rows: asked.map((value) => {
      // Several live rows for one note id: no single one is its path, so none is named (the control plane answers, as
      // it does for an id held twice). Says nothing else, and not whether any of them is one the reader may see.
      if (by === "noteId" && typeof value === "string" && rows.liveNoteIdCount(value) > 1) return { noteId: value, found: false, ambiguous: true };
      const row = typeof value === "string" ? (by === "path" ? rows.byPath(value) : rows.byNoteId(value)) : null;
      // Nothing at all at the path, and nothing reroutes it (`lookupMiss.js`): the gateway may make the note without asking.
      if (by === "path" && row === null && absentHere(rows, value)) return { path: value, found: false, absent: true };
      if (!judge.sees(row)) return { [by === "path" ? "path" : "noteId"]: value, found: false };
      return { found: true, path: row.path, noteId: row.noteId, key: row.storageKey ?? (row.noteId ? `notes/${row.noteId}.md` : null), etag: row.etag, kind: row.kind, collaborates: row.collaborates };
    }),
  };
}

/**
 * A reader's answer, once no change is coming (`marks.js`): it waits for an open mark's push, and says
 * `behind: true` when the push is still out, so the gateway asks the control plane instead.
 */
async function settledAnswer(store, answer) {
  const behind = await waitForMarks(store.marks ?? null);
  const settled = await answer();
  return behind ? { ...settled, behind: true } : settled;
}

/**
 * A note facts ask (`workspaceStore/facts.js`), judged like a read: the reader's audience, scope and row tokens over
 * this object's rows and rules. Served only once the notes live here (home `object`): before that the text here may
 * be behind the bucket's, and the control plane answers.
 */
function answerFacts(store, fields) {
  if (!store.facts || store.rows.home() !== HOMES.OBJECT || !OBJECT_FACT_ASKS.has(fields.ask)) return { served: false };
  const judge = judgeFor(store.rows, fields, store.members ?? null);
  const sees = (path) => judge.sees({ path });
  // A folder is seen as the listing shows it (`folderVisibleAtScope`), over the same rules and the reader's clearance.
  const folderSees = (path) => judge.parsed !== null && folderVisibleAtScope(path, judge.clearance, judge.parsed.rules, judge.parsed.overrides);
  // Held rules nobody can judge by (no rules, or a member the object does not know) are the control plane's to answer.
  if ((fields.ask === "jobs" || fields.ask === "forwarding") && judge.parsed === null) return { served: false };
  // The ledger is not a note fact: its copy is kept beside them (`forwardingRows.js`).
  if (fields.ask === "forwarding") return store.forwarding ? store.forwarding.answer(fields, sees, folderSees) : { served: false };
  return store.facts[fields.ask](fields, sees, folderSees);
}

/**
 * One folder's listing for the control plane's own `list` (`ws.rows.listing`, through the door): at the clearance the
 * control plane already resolved (`scope`, its granted `groups`) and by the audience's rules, as the live tree socket
 * lists it (`treeSockets.js`). `{served: false}` where no rules are held for the audience: the control plane answers.
 */
function listingAnswer(store, fields) {
  if (!SCOPES.has(fields.scope)) throw new WorkspaceRowRefused("a listing needs its scope");
  if (!READERS.has(fields.audience ?? "member") || fields.audience === "chat") throw new WorkspaceRowRefused("not an audience");
  const folder = folderPathOf(fields.path);
  if (folder === null) throw new WorkspaceRowRefused("not a folder path");
  const held = store.rows.rules(fields.audience ?? "member");
  if (held === null) return { served: false };
  const tree = treeRows(store.sql);
  const { rows: children, more } = tree.children(folder);
  const clearance = { scope: fields.scope, names: new Set(Array.isArray(fields.groups) ? fields.groups.filter((group) => typeof group === "string") : []) };
  return { served: true, listing: listFolderFromRows({ folder, clearance, held, children, more, own: tree.own(folder), roots: tree.jobRows(), sortAt: (path) => tree.sortAt(path) }) };
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
export async function serveWorkspaceStore(store, request, timing = {}) {
  const op = opOf(request);
  if (typeof op !== "string" || !(op.startsWith("ws.") || isPersonCall(op) || isTokenIndexCall(op))) {
    // A note's text written or removed reaches the word index by its own triggers (`searchIndex.js`).
    return serveTexStore(store.objects, request);
  }
  let fields;
  try {
    fields = JSON.parse((await request.text()) || "{}");
  } catch {
    return Response.json({ error: "bad_call" }, { status: 400 });
  }
  const { rows } = store;
  // An old refresh token's index object (`workspaceStore/tokenIndex.js`): never a workspace, so it pins none.
  if (isTokenIndexCall(op) && store.sql) return serveTokenIndex(store.sql, op, fields);
  // A person object's calls (`workspaceStore/access.js`): the personal workspace's reach, shares and connections.
  if (isPersonCall(op) && store.person) {
    const answered = await servePersonCall(store, op, fields);
    // A session asked with its store's open, where both are this object's (`sessionOpen.js`).
    return op === ACCESS_OPS.SESSION ? await withOpen(store, answered, fields) : answered;
  }
  // Write ops: the change and its mirror entry land in one transaction; they check and pin their workspace themselves (`serveWrites.js`).
  // `timing` is the object's `fetch`'s view of the call (`serveWrites.js` `timesOf`).
  if (isWriteOp(op)) return await serveWrites(store, op, fields, undefined, undefined, timing);
  try {
    rows.pinWorkspace(fields.workspaceId);
    const membership = await serveMembersCall(store, op, fields);
    if (membership !== null) return membership;
    // The computers this workspace owns and their runs (`serveMachines.js`).
    const machine = await serveMachineCall(store, op, fields);
    if (machine !== null) return machine;
    // The sealed binding and the one call a request's store is opened from (`bindingRows.js`).
    // `ws.open` waits for an open mark like every read, and says whether one is still open (`marks.js`), so the
    // gateway need not ask the control plane whether the object is behind before a read (`store/objectBinding.js`).
    const waitStarted = Date.now();
    const behind = op === BINDING_OPS.OPEN ? await waitForMarks(store.marks ?? null) : false;
    const opened = serveBindingCall(store, op, fields, ACCESS_HOMES.OBJECT, { behind });
    // How long the open waited for a mark's push, for the gateway's log line (`sessionStore.js` `openBinding`).
    if (opened !== null && op === BINDING_OPS.OPEN && opened.ok) return Response.json({ ...(await opened.json()), waitedMs: Date.now() - waitStarted });
    if (opened !== null) return opened;
    // The grant rows and the rules rendered from them (`serveAccess.js`).
    const access = accessCall(store, op, fields);
    if (access !== null) return access;
    // A note's mail, judged as a read is (`mailOps.js`).
    if (isMailOp(op)) return Response.json(await serveMail(store, op, fields, judgeFor(rows, fields, store.members ?? null)));
    switch (op) {
      case "ws.read": {
        const behind = await waitForMarks(store.marks ?? null);
        const answer = await readNotes(store, fields);
        return Response.json(behind ? { ...answer, behind: true } : answer);
      }
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
        // The marks this push carries the change of: closed with its rows, never before them.
        const closing = fields.close === undefined ? [] : markTokens(fields.close);
        if (closing.length > 0 && !store.marks) throw new WorkspaceRowRefused("this object keeps no marks");
        const paths = [
          ...(Array.isArray(fields.rows) ? pathsTouched(rows, fields.rows.map((row) => row?.id), fields.rows) : []),
          ...(Array.isArray(fields.removed) ? pathsTouched(rows, fields.removed) : []),
        ];
        const answer = run(() => {
          const kept = Array.isArray(fields.rows) && fields.rows.length > 0 ? rows.put(fields.rows).kept : 0;
          const removed = Array.isArray(fields.removed) && fields.removed.length > 0 ? rows.remove(fields.removed, fields.at).removed : 0;
          const rules = {};
          // Rules at or below a version this object minted were rendered before its own access write reached the control
          // plane: never taken, or a late push would undo that write (`accessWrite.js`).
          const minted = store.access?.minted() ?? null;
          for (const [audience, held] of Object.entries(fields.rules ?? {})) {
            rules[audience] = minted !== null && Number(held?.accessVersion) <= minted ? { kept: false, accessVersion: minted } : rows.putRules(held, audience);
          }
          // The access set the rules were rendered from, kept and checked against the rules now held (this push's, or
          // its first call's), in the same transaction.
          const access = fields.access === undefined ? null : applyAccess(store, fields.access, { member: rows.rules("member"), guest: rows.rules("guest") });
          const closed = closing.length > 0 ? store.marks.close(closing).closed : 0;
          return { kept, removed, rules, ...(access !== null ? { access } : {}), ...(closing.length > 0 ? { closed } : {}) };
        });
        changed(store, { paths, rules: Object.values(answer.rules).some((rule) => rule.kept) });
        return Response.json(answer);
      }
      case "ws.rows.lookup":
        // An edit's one lookup carries its note's Markdown too (`withBody`, `lookupBody.js`), for this reader's found row only.
        return Response.json(await settledAnswer(store, () => withLookupBody(store, lookUp(rows, fields, "path", store.members ?? null), fields)));
      case "ws.rows.resolve":
        return Response.json(await settledAnswer(store, () => lookUp(rows, fields, "noteId", store.members ?? null)));
      case "ws.rows.names":
        // A writer's "is that name taken?", unfiltered (`namesTaken.js`); before the notes live here, the control plane's.
        if (rows.home() !== HOMES.OBJECT || !store.sql) return Response.json({ served: false });
        return Response.json(await settledAnswer(store, () => namesTaken(rows, store.sql, fields)));
      case "ws.facts":
        return Response.json(await settledAnswer(store, () => answerFacts(store, fields)));
      case "ws.orient.survey":
        // `orient`'s map of this workspace for one reader, drawn here (`orientSurvey.js`): the listing and the facts it
        // takes are this object's own `ws.rows.manifest` and `ws.facts`, judged the same way.
        if (!store.facts || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        return Response.json(
          await settledAnswer(store, () => orientSurvey(rows, judgeFor(rows, fields, store.members ?? null), (request) => answerFacts(store, { ...fields, ...request })))
        );
      case "ws.search":
        // The gateway's search, over this object's own word index (`searchIndex.js`); its `canSee` filters the rows.
        if (!store.search || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        return Response.json(store.search.search(fields.asks));
      case "ws.search.build": {
        if (!store.search || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        const waiting = store.search.catchUp();
        return Response.json({ served: waiting !== null, waiting });
      }
      case "ws.meaning.query":
        // The gateway's search by meaning, over this object's own index (`meaningIndex.js`); its `canSee` filters it.
        if (!store.meaning || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        return Response.json(store.meaning.query(fields.vector, { tiers: fields.tiers ?? null, topK: fields.topK ?? undefined }));
      case "ws.meaning.build": {
        if (!store.meaning || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        let built;
        try {
          built = await store.meaning.catchUp();
        } catch (error) {
          // The model failed; what changed stays on the log for the next build. Our code and the provider's number
          // only, for the build's log line (`../workspaceStore.js`), never a message.
          const codes = Array.isArray(error?.providerCodes) ? error.providerCodes.filter(Number.isSafeInteger) : [];
          const hint = typeof error?.hint === "string" ? [error.hint] : [];
          const reason = typeof error?.code === "string" ? [error.code, ...codes, ...hint].join(":").toLowerCase() : "error";
          const words = typeof error?.providerWords === "string" ? { providerWords: error.providerWords } : {};
          return Response.json({ served: true, failed: true, waiting: null, reason, ...words });
        }
        return Response.json(built === null ? { served: false } : { served: true, ...built });
      }
      case "ws.meaning.snippets":
        // The passage each note found by meaning matched, read beside its text; the gateway asks only for notes its
        // `canSee` already let through.
        if (!store.meaning || rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        return Response.json({ served: true, snippets: store.meaning.snippets(fields.asks, fields.chars) });
      case "ws.forwarding.put":
        // The control plane's ledger, whole, at the version it moved to (`forwardingRows.js`), through the door.
        if (!store.forwarding) return Response.json({ kept: false });
        return Response.json(store.forwarding.put(fields));
      case "ws.facts.rows":
        // The control plane's own readers, through the door: unfiltered, as its internal queries are.
        if (!store.facts || store.rows.home() !== HOMES.OBJECT || !OBJECT_FACT_ROW_ASKS.has(fields.ask)) return Response.json({ served: false });
        return Response.json(store.facts.rows(fields));
      case "ws.rows.manifest":
        return Response.json(await settledAnswer(store, () => manifestPage(rows, fields, judgeFor(rows, fields, store.members ?? null))));
      case "ws.rows.children":
        // The name guards' one-level question (`tree/twins.js`), judged as the manifest is.
        return Response.json(await settledAnswer(store, () => childrenPage(rows, fields, judgeFor(rows, fields, store.members ?? null))));
      case "ws.mark.open":
        if (!store.marks) throw new WorkspaceRowRefused("this object keeps no marks");
        return Response.json(store.marks.open(fields.token, fields.ttlMs));
      case "ws.mark.close":
        if (!store.marks) throw new WorkspaceRowRefused("this object keeps no marks");
        return Response.json(store.marks.close(fields.tokens));
      case "ws.rows.get":
        return Response.json({ rows: rows.get(fields.ids) });
      case "ws.rows.files":
        // The control plane's tree reads, through the door: unjudged rows and the audience's rules from one call,
        // settled like a lookup, so a reader there falls back to its own rows only while this object is behind.
        if (rows.home() !== HOMES.OBJECT) return Response.json({ served: false });
        // Each row listed carries its body's version here, so a reader's copy is not taken as changed (`rowVersions.js`).
        if (store.sql) restampRowVersions(store.sql, rows);
        return Response.json(await settledAnswer(store, () => ({ served: true, ...rows.filesPage(fields), rules: rows.rules(fields.audience ?? "member") })));
      case "ws.rows.listing":
        if (rows.home() !== HOMES.OBJECT || !store.sql) return Response.json({ served: false });
        restampRowVersions(store.sql, rows);
        return Response.json(await settledAnswer(store, () => listingAnswer(store, fields)));
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
          encryption: rows.encryption(),
          rows: rows.count(),
          accessVersion: rows.rules()?.accessVersion ?? null,
          ...(store.marks ? { marks: store.marks.count() } : {}),
          ...(store.person ? { access: { home: store.person.home(), person: store.person.person() } } : {}),
          members: membersState(store),
        });
      case "ws.home":
        return Response.json({ home: rows.setHome(fields.home) });
      case "ws.encryption":
        return Response.json({ encryption: rows.setEncryption(fields.state) });
      case "ws.collab.replace":
        // A whole-note save's editing history in one call (`collabReplace.js`); `{served: false}` sends it back.
        return Response.json(await serveCollabReplace(store, fields));
      case "ws.collab.commit":
        // A live edit from the app's editor, committed here in one call (`collabReplace.js`); `{served: false}` sends it back.
        return Response.json(await serveCollabCommit(store, fields));
      case "ws.collab.read":
        // A note's Markdown and its editing history's text in one call (`collabRead.js`); `{served: false}` sends it back.
        return Response.json(await serveCollabRead(store, fields));
      case "ws.create":
        // A new note's bytes and row in one call (`createNote.js`); `{served: false}` sends it back.
        return Response.json(await serveCreateNote(store, fields));
      case "ws.backfilled":
        return Response.json({ backfilledAt: rows.markBackfilled(fields.at) });
      default:
        return Response.json({ error: "unknown_op" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof WorkspaceRowRefused || error instanceof AccessRowRefused || error instanceof WorkspaceMarkRefused || error instanceof FactAskRefused || error instanceof BindingRowRefused || error instanceof SearchAskRefused || error instanceof MeaningAskRefused || error instanceof MailAskRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
}
