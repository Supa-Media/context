/**
 * `recordChange` — the one call every write makes afterwards: the activity
 * file entry, the audit trail, and the tree-change announcement to whoever
 * can see the path.
 */

/**
 * The activity file's format, shared with the control plane.
 *
 * The gateway records what an AI client does; the console records what a
 * person does; both append to one file in the customer's bucket. Two copies of
 * "what counts as a change worth mentioning" would drift within a month, so
 * the rules live in `packages/shared` — the same arrangement `storageLayout`
 * already has, and for the same reason. It is `.cjs` because this Worker
 * cannot import the package's TypeScript (see `packages/shared/src/links.ts`).
 */
import { ACTIVITY_PATH, mayBeReportable as mayBeActivity, nextFile as nextActivityFile } from "../../../../packages/shared/src/activity.cjs";
import { AUDIT_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { isRoutinePath } from "../../../../packages/shared/src/routines.cjs";
import { effectiveVisibility, GROUP_SCOPE_PATTERN, isPlumbing, PRIVACY_KEY } from "../privacy/engine.js";
import { generatedCollaborationBase, writeGeneratedNote } from "../notes/sealing.js";
import { loadPrivacyState, persistExactVisibility } from "../privacy/state.js";
import { timestampSlug } from "../notes/paths.js";
import { sendsTreeHint, treeHintOf } from "./changes.js";
import { followChangeAfterResponse, indexWrittenNotesAfterResponse } from "../search/writeProjection.js";
import { treeEditsOf, treeTouchOf } from "../tree/record.js";
import { rememberChaos, within } from "../chaos/report.js";
import { CHAOS_ACTIONS, changeChaos } from "../chaos/change.js";
import { keepHistoryActivityLater } from "../history/record.js";

export async function recordChange(store, action, actorScope, paths, details = {}) {
  const at = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry = { at, action, actor_scope: actorScope, paths, details };
  // Who, not just what tier. `actor_scope: "team"` is useless once "team" is
  // four people and one of them wants to know which of their colleagues — or
  // which of their AI clients — moved a note.
  if (store.actor) {
    entry.actor_user_id = store.actor.userId;
    entry.actor_client_id = store.actor.clientId;
    entry.workspace_id = store.actor.workspaceId;
  }
  await store.put(`${AUDIT_PREFIX}${timestampSlug(new Date(at))}-${id}.json`, JSON.stringify(entry));
  await recordActivity(store, { action, paths, details, at });
  announceTreeChange(store, action, paths, details);
  announceWebsiteChange(store, action, paths);
  announceRoutineChange(store, paths);
  await indexChangedNotes(store, action, paths, details);
}

/**
 * Actions whose paths are notes a search should find as they now are.
 *
 * `written`: every path holds new text. `moved`: `[source, destination]`, the
 * source gone and the destination new. `movedPairs`: `[source, destination]`
 * repeated, the shape `move_notes` records. Folder moves are `folderMoved`:
 * their paths are prefixes, so the R2 index leaves a folder's worth of notes
 * to a listing (the next full pass does it), and fast search renames the
 * folder's rows in place.
 */
export const INDEX_ON_CHANGE = new Map([
  ["update_note", "written"],
  ["create_note", "written"],
  ["remember_fact", "written"],
  ["save_context", "written"],
  ["meeting_note", "written"],
  ["propose_note", "written"],
  ["rewrite_references", "written"],
  ["inbox_capture", "written"],
  ["inbox_update", "written"],
  ["calendar_sync", "written"],
  ["move_note", "moved"],
  ["archive_note", "moved"],
  ["move_notes", "movedPairs"],
  ["move_folder", "folderMoved"],
  ["set_visibility", "retiered"],
  ["set_folder_visibility", "retiered"],
]);

/**
 * Writes whose writer projects the note into fast search and search by
 * meaning itself, with the text in hand (`projectWrittenNoteAfterResponse`):
 * following them here too would read and project every save twice. Every
 * other action in `INDEX_ON_CHANGE` is followed (`followChangeAfterResponse`).
 */
export const PROJECTED_BY_WRITER = new Set(["update_note", "create_note", "remember_fact"]);

/** `[old, new]` pairs from a flat list, the first `count` of them. */
function pairsOf(paths, count) {
  const pairs = [];
  for (let index = 0; index + 1 < paths.length && pairs.length < count; index += 2) {
    pairs.push([paths[index], paths[index + 1]]);
  }
  return pairs;
}

/**
 * What one change asks of the search derivatives: the R2 index's notes, and
 * what fast search and search by meaning must follow, or `null` for nothing.
 *
 * A folder move that is still only logical (`status: "logical_active"`) or
 * queued is not followed until it has landed: until then the bucket holds the
 * old layout, and that is what every derivative is read from.
 */
export function searchChangeOf(action, paths, details) {
  const kind = INDEX_ON_CHANGE.get(action);
  if (!kind || !Array.isArray(paths) || paths.length === 0) return null;
  const named = paths.filter((path) => typeof path === "string" && path);
  if (named.length === 0) return null;
  // The etag a writer recorded is the stored object's, and it lets the pass
  // skip a note already indexed at that version. Only where it names one path.
  const etag = typeof details?.etag === "string" ? details.etag : "";

  if (kind === "written") {
    return {
      notes: named.map((path) => ({ path, version: named.length === 1 ? etag : "" })),
      follow: PROJECTED_BY_WRITER.has(action) ? null : { written: named },
    };
  }
  // Access changed and text did not: fast search moves the rows to the new
  // tier with no read, and the bucket's index, which filters every hit through
  // `canSee`, has nothing to redo.
  if (kind === "retiered") return { notes: [], follow: { retiered: named } };
  if (kind === "moved") {
    const [source, destination] = named;
    if (!destination) return null;
    return {
      notes: [
        { path: source, removed: true },
        { path: destination, version: etag },
      ],
      follow: { moved: [[source, destination]] },
    };
  }
  if (kind === "movedPairs") {
    // A partial move records its applied pairs first, then the destinations
    // it copied without removing their sources (`recordPartialMove`).
    const applied = details?.partial === true ? Number(details?.moved) || 0 : Math.floor(named.length / 2);
    const pairs = pairsOf(named, applied);
    const stranded = named.slice(pairs.length * 2);
    return {
      notes: [
        ...pairs.flatMap(([source, destination]) => [
          { path: source, removed: true },
          { path: destination, version: "" },
        ]),
        ...stranded.map((path) => ({ path, version: "" })),
      ],
      follow: { moved: pairs, written: stranded },
    };
  }
  // folderMoved. Queued or still logical, the bucket holds the old layout.
  if (details?.status === "logical_active" || details?.queued === true || details?.partial === true) return null;
  if (named.length !== 2) return null;
  return { notes: [], follow: { moved: [[named[0], named[1]]] } };
}

/**
 * Re-index what this change touched, so it is searchable now rather than at
 * the next full pass a search happens to start. Behind the response, and it
 * never throws: the change itself has already landed.
 */
async function indexChangedNotes(store, action, paths, details) {
  const change = searchChangeOf(action, paths, details);
  if (change === null) return;
  try {
    if (change.notes.length > 0) await indexWrittenNotesAfterResponse(store, change.notes);
    if (change.follow !== null) await followChangeAfterResponse(store, change.follow);
  } catch {
    // A derivative that is one note late, never a failed write.
  }
}

/**
 * Who may be told the tree changed. The gateway's copy of
 * `apps/convex/functions/lib/treeAudiences.ts`, over this engine's own
 * `effectiveVisibility` — see that file for the reasoning: a timestamp served
 * to somebody who cannot see a change would date it for them.
 */
function treeAudiencesOf(paths, known, rules, overrides) {
  const audiences = new Set();
  const reach = (visibility) => {
    if (visibility === "team" || GROUP_SCOPE_PATTERN.test(visibility)) audiences.add(visibility);
  };
  for (const raw of paths) {
    const path = String(raw).replace(/\/+$/, "");
    if (path === "" || isPlumbing(path)) continue;
    audiences.add("private");
    reach(effectiveVisibility(path, rules, overrides));
    const under = `${path}/`;
    for (const rule of rules) if (rule.prefix.startsWith(under)) reach(rule.vis);
    for (const [key, visibility] of overrides) if (key.startsWith(under)) reach(visibility);
  }
  for (const visibility of known) {
    audiences.add("private");
    reach(visibility);
  }
  return [...audiences].sort();
}

/**
 * Tell the consoles showing this context that its tree changed — deferred,
 * best-effort, and never able to fail the change, exactly as `reportActivity`
 * is. Only a session-bound store has a reporter; see `reportTreeChange`.
 */
function announceTreeChange(store, action, paths, details) {
  const touch = treeTouchOf(action, paths, details);
  const edited = treeEditsOf(action, paths, details);
  const reports = sendsTreeHint(action, details) && typeof store.reportTreeChange === "function";
  if (touch === null && edited.length === 0 && !reports) return;
  // Started now, so the tool's answer can report the chaos score
  // (`chaos/report.js`). It counts from the tree's keys as they were before
  // this change, so the control plane is told only once it has answered, or
  // once the answer has waited as long as a tool's would.
  const scored = CHAOS_ACTIONS.has(action) ? changeChaos(store, touch).catch(() => null) : null;
  if (scored !== null) rememberChaos(store, scored);
  const work = (async () => {
    if (scored !== null) await within(scored);
    // The Convex tree re-checks what the change named (`reportTreeTouch`).
    if (touch !== null && typeof store.reportTreeTouch === "function") {
      // A visibility change rewrote the manifest, whatever path it recorded:
      // the control plane refreshes its copy of the rules only for a touch
      // that names that file (`treeTouchOf`, `lib/nodes/touch.ts`).
      const files = touch.files ?? [];
      await store.reportTreeTouch({
        paths: touch.paths ?? [],
        files: touch.privacy === true && !files.includes(PRIVACY_KEY) ? [...files, PRIVACY_KEY] : files,
        // So pins and recents follow an agent's moves (`lib/placesFollow.ts`).
        ...(Array.isArray(touch.moves) ? { moves: touch.moves.map(([from, to]) => ({ from, to })) } : {}),
        left: touch.left,
      });
    } else if (edited.length > 0 && typeof store.reportTreeTouch === "function") {
      // A save of a note's text: its new version, gathered with others (`treeEditsOf`).
      await store.reportTreeTouch({ paths: [], files: [], edited });
    }
    if (!reports) return;
    const hint = treeHintOf(action, Array.isArray(paths) ? paths : [], details);
    const state = await loadPrivacyState(store);
    if (state.error) return;
    const audiences = treeAudiencesOf(hint.paths, hint.known, state.rules, state.overrides);
    if (audiences.length > 0) await store.reportTreeChange(audiences);
  })().catch(() => {});
  if (typeof store.defer !== "function") return;
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
}

/**
 * The published folder, as the control plane spells it.
 *
 * Restated here rather than imported: this Worker's only runtime dependency is
 * `@context/collaboration`, so it cannot reach `@context/shared`, and the
 * control-plane copy is `websites/changes.ts`. The same restatement
 * `features/site/host.ts` makes of the router's `isPlatformHost`, for the same
 * reason.
 */
const WEBSITE_ROOT = "website";

function touchesWebsite(path) {
  const normalized = String(path).replace(/^\/+|\/+$/g, "");
  return normalized === WEBSITE_ROOT || normalized.startsWith(`${WEBSITE_ROOT}/`);
}

/** Changes that can take a note away from whoever could read it: a move, or a privacy change. */
const NARROWING_ACTIONS = new Set([
  "move_note",
  "move_notes",
  "move_folder",
  "archive_note",
  "set_visibility",
  "set_folder_visibility",
]);

/** At most this many paths go in one website report, the control plane's own bound. */
const MAX_WEBSITE_PATHS = 50;

/**
 * The paths of a change that may narrow a site from outside `website/`, or
 * `[]`. A page can publish a folder it names with `folder:`, which this
 * Worker cannot see, so it names the paths and the control plane asks its
 * route index whether they reach the site. `privacy.md` written by any
 * action decides every page.
 */
function websiteNarrowingPaths(action, paths) {
  const named = paths.map((path) => String(path).replace(/^\/+|\/+$/g, "")).filter((path) => path !== "");
  if (!NARROWING_ACTIONS.has(action) && !named.includes(PRIVACY_KEY)) return [];
  return named.length > MAX_WEBSITE_PATHS ? [PRIVACY_KEY] : named;
}

/**
 * Tell the control plane its route index no longer describes the bucket.
 *
 * ## Why this is not folded into `announceTreeChange`
 *
 * That one is gated on `TREE_ACTIONS`, a whitelist of changes to the *shape*
 * of the tree, and it is right to be: editing a note's body moves nothing.
 * The website index is a derivative of the bytes, so the case it most needs to
 * hear about is exactly the one that list leaves out — `update_note`, which is
 * both an MCP client rewriting a page's frontmatter and a live editing session
 * flushing one. It also judges a move by its destination alone, and a page
 * moved *out* of the folder has to invalidate too. So this reads the raw paths
 * and asks one question of them.
 *
 * **Both ends, and only this folder** — or a move or privacy change
 * anywhere, with its paths (`websiteNarrowingPaths`), which the control plane
 * checks against the notes the site publishes. It rebuilds the whole index
 * when it hears this, and since that scan reads every published page,
 * reporting an ordinary note write would be a full scan after every save.
 *
 * Deferred, best-effort and unable to fail the change, like its neighbours: a
 * missed report costs the freshness the quarter-hourly sweep restores.
 */
function announceWebsiteChange(store, action, paths) {
  if (typeof store.reportWebsiteChange !== "function" || !Array.isArray(paths)) return;
  const named = websiteNarrowingPaths(action, paths);
  if (named.length === 0 && !paths.some(touchesWebsite)) return;
  const work = Promise.resolve(store.reportWebsiteChange(named.length === 0 ? undefined : named)).catch(() => {});
  if (typeof store.defer !== "function") return;
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
}

/** At most this many paths go in one report; the control plane re-lists anyway. */
export const MAX_ROUTINE_PATHS = 50;

/**
 * Tell the control plane a routine may have been added, changed, moved or
 * deleted, and who did it: a routine runs as the person who last wrote it.
 *
 * A routine path is one under either root, `tex/routines/` or `routines/`, or
 * the `tex` folder itself (`isRoutinePath`, `packages/shared/src/routines.cjs`).
 * Paths and the acting user, never text. The control plane re-reads both
 * roots itself before it schedules anything, so a report is a nudge and a
 * writer, not a fact it trusts about the file. Deferred and
 * best-effort like its neighbours; a missed one costs the freshness the
 * control plane's periodic re-read restores.
 */
export function announceRoutineChange(store, paths) {
  if (typeof store.reportRoutineChange !== "function" || !Array.isArray(paths)) return;
  const touched = paths
    .map((path) => String(path).replace(/^\/+|\/+$/g, ""))
    .filter((path) => isRoutinePath(path))
    .slice(0, MAX_ROUTINE_PATHS);
  if (touched.length === 0) return;
  const work = Promise.resolve(store.reportRoutineChange(touched, store.actor?.userId ?? null)).catch(() => {});
  if (typeof store.defer !== "function") return;
  try {
    store.defer(work);
  } catch {
    // A host whose `waitUntil` refuses the work simply does not report.
  }
}

/**
 * The same change again, as a line in a note somebody reads.
 *
 * ## Why this is a second write and not a rendering of the first
 *
 * `.context/audit/` is one object per change, which is the right shape for a
 * record that must never be rewritten and the wrong shape for a list somebody
 * opens: answering "what happened this week" from it means listing and reading
 * hundreds of small objects, which is what `list_changes` does and why it is
 * slow enough to be an agent's tool rather than a screen's. `activity.md` is
 * the same facts kept in the shape a reader wants, and it is a *note* — in the
 * customer's bucket, in Markdown, openable in Obsidian, carried out by any
 * export — because a feed that only exists inside our console is a feed we
 * have taken custody of.
 *
 * It is a derivative, and it is allowed to be lossy: what falls off the end of
 * the file is still in the audit trail, and the file can be rebuilt from it.
 *
 * ## It may never fail a change
 *
 * A note write that succeeded and then reported failure because its footnote
 * did not land is a worse outcome than a missing line, every time. Everything
 * here is inside a catch, and the only consequence of a failure is that the
 * line is absent.
 *
 * ## Private at rest, whatever folder it sits in
 *
 * The file names paths from every corner of the context, so it is stored
 * `private` on every write — the ACL is re-asserted rather than assumed,
 * because a folder default that later turns `team` must not quietly hand a
 * member the owner's index of private filenames. What a member gets instead is
 * `read_activity`, which renders the lines they may see. Both halves are
 * proven in `test/activity.test.mjs`.
 */
async function recordActivity(store, change) {
  try {
    // Before the read, not after it. Most changes are not reportable at all —
    // a proposal, a sync job's arrival, a write under `.context/` — and the
    // expensive half of recording one is the read that used to happen before
    // this question was asked.
    if (!mayBeActivity(change.action, change.paths)) return;
    const actor = store.actor
      ? { name: store.actor.name || null, client: store.actor.client || null }
      : null;
    // Two attempts, not a loop. The second is for the ordinary race — two
    // clients writing notes in the same second — and a third would be a queue
    // this file has no business growing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await store.get(ACTIVITY_PATH);
      const stored = existing ? await existing.text() : "";
      let collaborationBase = null;
      try {
        collaborationBase = existing
          ? await generatedCollaborationBase(store, ACTIVITY_PATH, stored)
          : null;
      } catch {
        continue;
      }
      const current = collaborationBase?.text ?? stored;
      const next = nextActivityFile(current, { ...change, actor });
      // The common answer: nothing substantial, or a line that already says it.
      if (!next) return;
      // The activity file names private paths and is always private. Validate
      // and tighten that ACL before either write authority commits its bytes.
      const state = await loadPrivacyState(store);
      if (
        !state.error &&
        effectiveVisibility(ACTIVITY_PATH, state.rules, state.overrides) !== "private"
      ) {
        await persistExactVisibility(store, ACTIVITY_PATH, "private", state.rules);
      }
      const conditional =
        existing === null
          ? store.capabilities?.conditionalCreate === true
            ? { absent: true }
            : null
          : store.capabilities?.conditionalWrite === true
            ? { etagMatches: existing.etag }
            : null;
      let put;
      try {
        put = collaborationBase
          ? await writeGeneratedNote(store, ACTIVITY_PATH, next.text, collaborationBase)
          : conditional
            ? await store.put(ACTIVITY_PATH, next.text, { onlyIf: conditional })
            : await store.put(ACTIVITY_PATH, next.text);
      } catch {
        continue;
      }
      if (put === null) continue;
      // The replay's index of these lines, behind the response (`history/record.js`).
      keepHistoryActivityLater(store, next.entries, typeof put?.etag === "string" ? put.etag : null);
      /*
        THE FILE IS PRIVATE, AND THAT IS CHECKED RATHER THAN ASSUMED.

        `privacy.md`'s format requires `default_visibility: private`, so a file
        at the root inherits private in every manifest that parses — which is
        why this costs nothing in the ordinary case and reads as belt to that
        brace. The case it is actually for is the one a person can create by
        hand: an exact-note override publishing `activity.md` to the team,
        typed into the manifest in Obsidian, which would hand every member an
        index of every private filename in the context.

        Re-asserted on any write that finds it published rather than only on
        creation, because a file published after it existed is exactly the
        shape a create-time check misses. The manifest is read only here, on a
        write that is actually happening — never on the common path, where
        `nextActivityFile` has already decided there is nothing to say.
      */
      /*
        Across the boundary: this context changed, at this tier. It is what
        lights the dot on this workspace's mark in somebody else's console, and
        it carries nothing about *what* changed — see `reportActivity`.

        The tier goes with it because a member who is not the owner is served
        the team-tier stamp: a private line that moved their dot would tell
        them the exact time of a change the file, the tree and `list_changes`
        all refuse them. `next.entry.vis` is the entry's own flag, the one
        already written into the line.
      */
      try {
        store.reportActivity?.(next.entry.vis === "team");
      } catch {
        // A reporter that throws synchronously is still not a failed change.
      }
      return;
    }
  } catch {
    // See the header: a change is never failed by its own footnote.
  }
}
