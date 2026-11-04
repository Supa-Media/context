/**
 * The id layer's row questions, answered by the workspace's object where its notes live there
 * (`workspaceStore/api.js` `rows.lookup` / `rows.resolve`), and by the control plane for everything the object
 * cannot answer alone.
 *
 * The object judges each path with the same `canSee` and the reader's own scope and row tokens, and answers only
 * what the reader may see. The control plane's answer is wider (a built-in folder's default name, a move in flight,
 * a Tex home for a new note, a gone row, a note the reader may not see), so every path the object does not find is
 * asked there, in one call, as before. A note the reader sees is the common case and costs one call to the object.
 *
 * Every reader goes to the object, judged by its own audience's rules there (`workspaceStore/serve.js` `judgeFor`): a
 * member by the member rules, a guest (`READS_AS_GUEST` in the session's names) by the guest rules, and a Tex guest
 * chat (`READS_AS_CHAT`) by the guest rules as its own names render them (`workspaceStore/chatRules.js`), the same
 * rendering the control plane gives it. A chat whose names are not known is asked of the control plane.
 * Any failure of the object falls back to the control plane for the whole question, and is logged.
 *
 * Whether the object is behind (a change committed in the control plane and not yet pushed, such as a share just
 * taken back): the object says so itself. A writer that may narrow leaves a mark there before it commits, and an
 * answer given while one is still open says `behind: true` (`workspaceStore/marks.js`); the binding's `notesBehind`,
 * read once when the store was built, says so too. The control plane is no longer asked beside every object call
 * (2026-11-02): every narrowing writer, background jobs included, opens its mark first, and the production report of
 * writes that did not (`workspaceObjectMarks.report`) was empty before this went.
 */

import { narrowNote } from "../controlPlane/noteIds.js";
import { isPlumbing, READS_AS_CHAT, READS_AS_GUEST } from "../privacy/engine.js";
import { HOMES } from "../workspaceStore/api.js";
import { OBJECT_FACT_ASKS } from "../workspaceStore/facts.js";

/** Whether a session's names read the workspace as a member: no guest or chat marker (row tokens are a member's). */
export function readsAsMember(names) {
  return audienceOf(names) === "member";
}

/** Which rules a session's names read a workspace by: a chat's, a guest's, or a member's. A chat marker wins. */
export function audienceOf(names) {
  const all = new Set(names ?? []);
  if (all.has(READS_AS_CHAT)) return "chat";
  if (all.has(READS_AS_GUEST)) return "guest";
  return "member";
}

/**
 * One object row as the id layer takes a control-plane entry, through the same check (`narrowNote`): a key that is
 * not a note's id key (a Tex note's, say) is not taken here, and the control plane answers for it.
 */
function entryOf(row) {
  if (row.kind === "folder") return { state: "folder" };
  const entry = narrowNote({ state: "keyed", key: row.key, etag: row.etag, ...(typeof row.noteId === "string" ? { noteId: row.noteId } : {}) });
  // The note's Markdown, where an edit's lookup asked for it (`workspaceStore/lookupBody.js`): only ever for this key.
  const body = row.body;
  if (entry === null || !body || typeof body.text !== "string" || body.meta?.key !== entry.key || typeof body.meta.etag !== "string") return entry;
  return { ...entry, body: { meta: body.meta, text: body.text } };
}

/**
 * Whether this session's row questions may go to its object, and how: `null` where they may not (no object, notes not
 * at home there, an unknown scope, a chat whose names are not known, or a change the object has not taken yet, which
 * the binding's `notesBehind` says), else the reader as the object judges it and the per-call behind check.
 *
 * @param {{client: object|null, home?: string|null, behind?: boolean, scope: string, names: Iterable<string>, chatNames?: string[]|null, workspaceId?: string, userId?: string|null, log?: (event: string, fields: object) => void}} options
 */
export function objectReader({ client, home, behind = false, scope, names, chatNames = null, workspaceId, userId = null, log = () => {} }) {
  const groups = [...(names ?? [])];
  const audience = audienceOf(groups);
  if (!client || home !== HOMES.OBJECT || (scope !== "private" && scope !== "team")) return null;
  if (audience === "chat" && !Array.isArray(chatNames)) return null;
  // A change the object has not taken yet (the binding's `notesBehind`): a share just taken back by a mutation that
  // could not wait for the push must not be served from the object's older rows, so the whole request asks the
  // control plane, which already has it.
  if (behind === true) {
    log("workspace_object_behind", { workspaceId });
    return null;
  }
  // `userId`: who is reading, for an object that decides access from its own members (`workspaceStore/members.js`).
  const judged = {
    scope,
    groups,
    audience,
    ...(audience === "member" && typeof userId === "string" ? { userId } : {}),
    ...(audience === "chat" ? { chatNames: [...chatNames] } : {}),
  };
  // Behind by the object's own word: a writer that may narrow opened a mark there before it committed, and the
  // change has not landed within the object's wait (`workspaceStore/marks.js`). Every narrowing writer goes first
  // (`apps/convex/functions/lib/rowWatch/objectFirst.ts`), so nobody asks the control plane beside each read.
  const settledBehind = (answer) => {
    if (answer?.behind !== true) return false;
    log("workspace_object_behind", { workspaceId, by: "object" });
    return true;
  };
  return { client, workspaceId, log, judged, settledBehind };
}

/**
 * The note facts the object answers itself (`workspaceStore/facts.js`: `props`, `links`, `neighbors`, `jobs`), asked of it
 * before the control plane's `/gateway/tree/facts`. `null` where this session does not read the object; otherwise a
 * function that answers an ask, or `null` for one the object did not serve (another ask, notes not caught up, the
 * object failing or behind), and the caller asks the control plane as before.
 *
 * @param {Parameters<typeof objectReader>[0]} options
 * @returns {((request: {ask: string}) => Promise<object|null>) | null}
 */
export function objectFirstFacts(options) {
  const reader = objectReader(options);
  if (reader === null || typeof reader.client.facts !== "function") return null;
  const { client, workspaceId, log, judged, settledBehind } = reader;
  return async (request) => {
    if (!OBJECT_FACT_ASKS.has(request?.ask)) return null;
    const started = Date.now();
    let answer;
    try {
      answer = await client.facts({ ...request, ...judged });
    } catch (error) {
      log("workspace_object_facts_failed", { workspaceId, ask: request.ask, error: String(error?.message ?? error) });
      return null;
    }
    if (settledBehind(answer)) return null;
    const served = answer?.served === true;
    log("workspace_object_facts", { workspaceId, ask: request.ask, served, ms: Date.now() - started });
    return served ? answer : null;
  };
}

/** A survey's timestamps come back as strings; the map takes Dates (`orient/render.js` `mostRecent`). */
function revivedSurvey(survey) {
  const dated = (note) => (note && typeof note.uploaded === "string" ? { ...note, uploaded: new Date(note.uploaded) } : note);
  return {
    ...survey,
    rootNotes: (survey.rootNotes ?? []).map(dated),
    recent: (survey.recent ?? []).map(dated),
    captured: (survey.captured ?? []).map((group) => ({ ...group, newest: group.newest ? dated(group.newest) : null })),
  };
}

/**
 * `orient`'s map of the workspace drawn in its object (`ws.orient.survey`) for this session's reader, or `null` where
 * this session does not read the object, and the gateway draws it. The function answers the survey, or `null` for one
 * the object did not serve (a failure, the object behind, a listing past one page), and the gateway draws it then.
 *
 * @param {Parameters<typeof objectReader>[0]} options
 * @returns {(() => Promise<object|null>) | null}
 */
export function objectFirstSurvey(options) {
  const reader = objectReader(options);
  if (reader === null || typeof reader.client.orientSurvey !== "function") return null;
  const { client, workspaceId, log, judged, settledBehind } = reader;
  return async () => {
    const started = Date.now();
    let answer;
    try {
      answer = await client.orientSurvey({ ...judged });
    } catch (error) {
      log("workspace_object_survey_failed", { workspaceId, error: String(error?.message ?? error) });
      return null;
    }
    if (settledBehind(answer)) return null;
    const served = answer?.served === true && answer.survey && typeof answer.survey === "object";
    log("workspace_object_survey", { workspaceId, served, ms: Date.now() - started });
    return served ? revivedSurvey(answer.survey) : null;
  };
}

/**
 * A writer's "is that name taken?" (`ask: "names"`, `tree/names.js`) asked of the object before the control plane
 * (`workspaceStore/namesTaken.js`). The answer is unfiltered, so only a session that may write here asks: `canWrite`
 * is the control plane's own rule (owner or editor, with `context:write`), decided by the gateway and attested to the
 * object. `null` where this session does not ask the object; otherwise a function answering `{served, files, folders}`,
 * or `null` for an ask it did not serve (a count, a failure, the object behind), and the caller asks the control plane.
 *
 * @param {Parameters<typeof objectReader>[0] & {canWrite?: boolean}} options
 * @returns {((request: {ask: string, paths?: string[], count?: boolean}) => Promise<object|null>) | null}
 */
export function objectFirstNames(options) {
  if (options?.canWrite !== true) return null;
  const reader = objectReader(options);
  if (reader === null || reader.judged.audience !== "member" || typeof reader.client.rows?.names !== "function") return null;
  const { client, workspaceId, log, settledBehind } = reader;
  return async (request) => {
    // The note cap's count stays the control plane's (`servedCount.ts`).
    if (request?.ask !== "names" || request.count === true || !Array.isArray(request.paths) || request.paths.length === 0) return null;
    let answer;
    try {
      answer = await client.rows.names({ paths: request.paths, canWrite: true });
    } catch (error) {
      log("workspace_object_names_failed", { workspaceId, error: String(error?.message ?? error) });
      return null;
    }
    if (settledBehind(answer) || answer?.served !== true || !Array.isArray(answer.files) || !Array.isArray(answer.folders)) return null;
    return { served: true, files: answer.files, folders: answer.folders };
  };
}

/**
 * The `lookup` and `resolve` hooks for `withIdLayout`, object first. `hooks` are the control plane's.
 *
 * @param {{lookup: (paths: string[]) => Promise<object>, resolve?: (ids: string[]) => Promise<object>}} hooks
 * @param {{client: object|null, home?: string|null, behind?: boolean, scope: string, names: Iterable<string>, chatNames?: string[]|null, userId?: string|null, log?: (event: string, fields: object) => void}} options
 */
export function objectFirstHooks(hooks, options) {
  const reader = objectReader(options);
  if (reader === null) return hooks;
  const { client, workspaceId, log, judged, settledBehind } = reader;

  // `withBody`: an edit's one lookup (`idLayout.js` `oneWrite`) asks for the note's Markdown beside its row.
  const lookup = async (paths, { withBody = false } = {}) => {
    let answer;
    try {
      answer = await client.rows.lookup({ paths, ...judged, ...(withBody === true && paths.length === 1 ? { withBody: true } : {}) });
    } catch (error) {
      log("workspace_object_lookup_failed", { workspaceId, error: String(error?.message ?? error) });
      return await hooks.lookup(paths);
    }
    if (settledBehind(answer)) return await hooks.lookup(paths);
    const notes = {};
    const missing = [];
    paths.forEach((path, at) => {
      const row = answer?.rows?.[at];
      const entry = row?.found === true && row.path === path ? entryOf(row) : null;
      // Absent in the object (`workspaceStore/lookupMiss.js`): no note there, and no Tex home, without asking Convex.
      if (entry === null && row?.found === false && row.absent === true && row.path === path) return;
      if (entry === null) missing.push(path);
      else notes[path] = entry;
    });
    if (missing.length === 0) return { keyed: true, notes, texHomes: {} };
    const rest = await hooks.lookup(missing);
    return { keyed: rest.keyed === true, notes: { ...rest.notes, ...notes }, texHomes: rest.texHomes ?? {} };
  };

  /**
   * A keyed note's new version, recorded in the object first (`workspaceStore/writeOps.js` `ws.write.wrote`): the
   * object stamps its row and queues the change for Convex's mirror, so the save waits on no control-plane round trip
   * (`docs/decisions/storage-and-credentials/object-row-writes.md`). Only a member's keyed write with its size and
   * time goes there; anything else, a row the object does not hold, or an object that fails, is recorded by the
   * control plane as before.
   */
  const wrote = typeof hooks.wrote !== "function" || typeof client.write?.wrote !== "function" || judged.audience !== "member"
    ? hooks.wrote
    : async (record) => {
        if (record?.keyed !== true || !Number.isFinite(record?.size) || !Number.isFinite(record?.at)) return await hooks.wrote(record);
        let answer;
        try {
          answer = await client.write.wrote({ path: record.path, key: record.key, etag: record.etag, size: record.size, at: record.at, keyed: true });
        } catch (error) {
          log("workspace_object_wrote_failed", { workspaceId, error: String(error?.message ?? error) });
          return await hooks.wrote(record);
        }
        if (answer?.ok === true) return { recorded: true };
        return await hooks.wrote(record);
      };
  // A save run in the object records its version there in the same call (`workspaceStore/collabReplace.js`).
  if (wrote !== hooks.wrote) wrote.inObject = true;

  /**
   * A new note's row, made in the object first (`workspaceStore/writeOps.js` `ws.write.adopt`) and mirrored to Convex
   * behind. Only a member's create that names its tier goes there; the object answers DEFER for anything but the
   * plain case, and that, a failure, or a call without a tier is adopted by the control plane as before.
   */
  const adopt = typeof hooks.adopt !== "function" || typeof client.write?.adopt !== "function" || judged.audience !== "member"
    ? hooks.adopt
    : async (note) => {
        if (note?.tier !== "private" && note?.tier !== "team") return await hooks.adopt(note);
        let answer;
        try {
          answer = await client.write.adopt({
            path: note.path, noteId: note.noteId, key: note.key, etag: note.etag,
            ...(Number.isFinite(note.size) ? { size: note.size } : {}), at: note.at, tier: note.tier,
          });
        } catch (error) {
          log("workspace_object_adopt_failed", { workspaceId, error: String(error?.message ?? error) });
          return await hooks.adopt(note);
        }
        if (answer?.ok === true && answer.adopted === true) return { adopted: true, taken: null };
        // Why the object left it to the control plane: a short code, never the path (logs carry no note names).
        log("workspace_object_adopt_deferred", { workspaceId, code: answer?.code ?? null, reason: typeof answer?.reason === "string" ? answer.reason : null });
        return await hooks.adopt(note);
      };


  /**
   * The same lookup for a read: a path the object answers "not found" for, while not behind, is no note for this
   * reader, as the control plane would say (no row, gone, hidden from them), so it is not asked. A new note's Tex home
   * (`texHomes`) matters only to a write, which keeps `lookup`. A notes-home object is keyed by its own layout.
   */
  const lookupRead = async (paths) => {
    let answer;
    try {
      answer = await client.rows.lookup({ paths, ...judged });
    } catch (error) {
      log("workspace_object_lookup_failed", { workspaceId, error: String(error?.message ?? error) });
      return await hooks.lookup(paths);
    }
    if (settledBehind(answer)) return await hooks.lookup(paths);
    const notes = {};
    const missing = [];
    paths.forEach((path, at) => {
      const row = answer?.rows?.[at];
      const entry = row?.found === true && row.path === path ? entryOf(row) : null;
      if (entry !== null) notes[path] = entry;
      else if (row?.found !== false || row.path !== path) missing.push(path);
    });
    if (missing.length === 0) return { keyed: true, notes, texHomes: {} };
    const rest = await hooks.lookup(missing);
    return { keyed: rest.keyed === true, notes: { ...rest.notes, ...notes }, texHomes: rest.texHomes ?? {} };
  };

  if (typeof hooks.resolve !== "function") return { ...hooks, lookup, lookupRead, wrote, adopt };
  const resolve = async (noteIds) => {
    let answer;
    try {
      answer = await client.rows.resolve({ noteIds, ...judged });
    } catch (error) {
      log("workspace_object_resolve_failed", { workspaceId, error: String(error?.message ?? error) });
      return await hooks.resolve(noteIds);
    }
    if (settledBehind(answer)) return await hooks.resolve(noteIds);
    const paths = {};
    const missing = [];
    noteIds.forEach((noteId, at) => {
      const row = answer?.rows?.[at];
      // A path under a dot folder is not a note a person names: the control plane answers it (as `null`).
      if (row?.found === true && row.noteId === noteId && typeof row.path === "string" && row.kind !== "folder" && !isPlumbing(row.path)) paths[noteId] = row.path;
      // Not found, and not ambiguous (`serve.js` lookUp): the object has judged this reader's answer, which is `null`, so
      // the control plane is not asked. Ambiguous (two live rows) falls through, as does anything else the object did not say.
      else if (row?.found === false && row.noteId === noteId && row.ambiguous !== true) paths[noteId] = null;
      else missing.push(noteId);
    });
    if (missing.length === 0) return { paths };
    const rest = await hooks.resolve(missing);
    return { paths: { ...rest.paths, ...paths } };
  };
  return { ...hooks, lookup, lookupRead, resolve, wrote, adopt };
}
