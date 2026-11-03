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
  return narrowNote({ state: "keyed", key: row.key, etag: row.etag, ...(typeof row.noteId === "string" ? { noteId: row.noteId } : {}) });
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

  const lookup = async (paths) => {
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
      if (entry === null) missing.push(path);
      else notes[path] = entry;
    });
    if (missing.length === 0) return { keyed: true, notes, texHomes: {} };
    const rest = await hooks.lookup(missing);
    return { keyed: rest.keyed === true, notes: { ...rest.notes, ...notes }, texHomes: rest.texHomes ?? {} };
  };

  if (typeof hooks.resolve !== "function") return { ...hooks, lookup };
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
  return { ...hooks, lookup, resolve };
}
