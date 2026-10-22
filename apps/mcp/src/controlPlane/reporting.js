/** Names one tree touch carries per kind; more is sent as `dirty`. */
const TREE_TOUCH_NAMES = 50;

/**
 * Fire-and-forget reporting calls: usage counters, search-index progress,
 * activity, tree-change and form-submission notices. Every one of these is a
 * call whose failure is nobody's problem — swallowed at the call site — and
 * every one carries identifiers and counts only, never note content.
 */
export function createReportingMethods({ post }) {
  return {
    /**
     * Tell the control plane that some counted things happened.
     *
     * **The only call on this client whose failure is nobody's problem.** Every
     * other method resolves a session, opens a credential or moves a grant, and
     * a failure there is a failed request. This one moves a number on an
     * operator's dashboard, so it is called behind the response and its
     * rejection is swallowed at the call site — a search that worked but was
     * not counted is a good outcome, and a search that failed because the
     * counter was down is not.
     *
     * **What crosses is a name and a number.** `events` carries a metric name
     * from the control plane's closed vocabulary and an optional workspace id
     * this gateway just resolved a grant to. There is no field here for a
     * path, a query, a note title or a timestamp, and there must never be one:
     * what a person searched for is theirs, and their own audit trail — in
     * their own bucket — is where a record of it legitimately lives.
     *
     * @param {{metric: string, workspaceId?: string, count?: number}[]} events
     */
    async reportUsage(events, hourly = []) {
      const counted = Array.isArray(events) ? events : [];
      const breakdown = Array.isArray(hourly) ? hourly : [];
      if (counted.length === 0 && breakdown.length === 0) return { applied: 0 };
      // `hourly` is the Premium breakdown (`reportBoundaryUsage`): ids, a model
      // string, a method word and counts, under the same rule as `events`.
      return await post("/gateway/usage", {
        events: counted,
        ...(breakdown.length > 0 ? { hourly: breakdown } : {}),
      });
    },

    /**
     * Say how long one search took and which index answered, for the search
     * timing log (`apps/convex/functions/searchTimings.ts`).
     *
     * `reportUsage`'s rule again: called behind the response, its rejection
     * swallowed, and what crosses is a workspace id, a word from a closed list,
     * a boolean and a number. Never the query, a path, or a count of what the
     * workspace holds.
     *
     * @param {{workspaceId: string, answeredBy: string, found: boolean, ms: number}} timing
     */
    async reportSearchTiming(timing) {
      if (!timing || typeof timing.workspaceId !== "string" || !timing.workspaceId) return null;
      return await post("/gateway/search-timing", {
        workspaceId: timing.workspaceId,
        answeredBy: timing.answeredBy,
        found: Boolean(timing.found),
        ms: timing.ms,
      });
    },

    /**
     * Say how far this workspace's search projection has got.
     *
     * The second call on this client whose failure is nobody's problem, for
     * the same reason as `reportUsage`: it moves a number on somebody's
     * settings screen, and a search that worked but was not counted is a good
     * outcome.
     *
     * **What crosses is counts and, when there is one, a failure code from our
     * own closed set.** There is no field here for a path, a note title, a
     * query or a provider's error text, and there must never be one — the
     * counts are a census of notes and nothing else, which is why the control
     * plane keeps them owner-only.
     *
     * `undefined` members are dropped by `JSON.stringify`, so an ordinary pass
     * sends exactly `{workspaceId, notesIndexed, notesPending}`.
     *
     * @param {{workspaceId: string, notesIndexed: number, notesPending: number,
     *          state?: "ready", errorCode?: string}} progress
     */
    async reportSearchIndexProgress(progress) {
      if (!progress || typeof progress.workspaceId !== "string" || !progress.workspaceId) {
        // A per-workspace figure with no workspace is a wrong number in the one
        // direction nobody would think to check.
        return null;
      }
      return await post("/gateway/search-index/progress", {
        workspaceId: progress.workspaceId,
        notesIndexed: progress.notesIndexed,
        notesPending: progress.notesPending,
        state: progress.state,
        errorCode: progress.errorCode,
      });
    },

    /**
     * Say that a line landed in this context's `activity.md`.
     *
     * A workspace id and a tier, and it could not be more: what changed, who
     * changed it and where are in the customer's bucket, and this route exists
     * for a single pixel — the dot on another workspace's mark, which the
     * console draws from the workspace row rather than by opening every bucket
     * it can reach. The control plane takes the timestamp itself.
     *
     * The tier is not a fact about the note. It says which of the two stamps
     * on the workspace row may move: a member who is not the owner reads the
     * team-tier one, so that a private line never tells them its time. False
     * is the safe answer and the default.
     *
     * @param {string} workspaceId
     * @param {boolean} teamVisible
     */
    async reportActivity(workspaceId, teamVisible) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      return await post("/gateway/activity", {
        workspaceId,
        teamVisible: teamVisible === true,
      });
    },

    /**
     * Say that this context's file tree changed, and which audiences —
     * `private`, `team`, `@name` — could see the change. Labels and an id and
     * nothing else: no path, no count, no content (non-negotiable #1). The
     * control plane takes the timestamp itself. See `announceTreeChange`.
     *
     * Labels only, as before. The names a change touched go by `reportTreeTouch`.
     *
     * @param {string} workspaceId
     * @param {string[]} audiences
     */
    async reportTreeChange(workspaceId, audiences) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      const labels = Array.isArray(audiences)
        ? audiences.filter((audience) => typeof audience === "string").slice(0, 64)
        : [];
      if (labels.length === 0) return null;
      return await post("/gateway/tree", { workspaceId, audiences: labels });
    },

    /**
     * Say which paths and files a recorded change named, so the Convex tree
     * (`apps/convex/functions/lib/nodes/`) re-checks them.
     *
     * **Names now cross this call, for the tree.** That is the owner's decision
     * of 2026-10-12 (`docs/decisions/app-and-console/convex-tree.md`): the
     * control plane keeps each workspace's file and folder names, and this is
     * how a write of ours reaches that copy. Note text never crosses it, and no
     * field here takes it. More than 50 names of either kind sends no names at
     * all and `dirty: true`, which asks for a sweep instead.
     *
     * `moves` are the change's moves, old name to new, so pins and recents
     * follow them; past the same cap they are left out, and those places
     * simply stop showing.
     *
     * @param {string} workspaceId
     * `edited` are notes whose text alone changed (a save in the editor):
     * the control plane gathers them for a few seconds and re-checks them
     * together, so their new versions reach the tree, and the devices that
     * follow its change log, without a re-check per typing pause.
     *
     * `left` says who could see each key a move took away, before it: the
     * move clears the source's exception first, so the tree's gone rows
     * narrow to this rather than the rules after the move.
     *
     * @param {{paths?: string[], files?: string[], moves?: {from: string, to: string}[], edited?: string[], left?: {path: string, audiences: string[]}[]}} touch
     */
    async reportTreeTouch(workspaceId, touch) {
      if (typeof workspaceId !== "string" || !workspaceId || !touch) return null;
      const paths = Array.isArray(touch.paths) ? touch.paths.filter((path) => typeof path === "string") : [];
      const files = Array.isArray(touch.files) ? touch.files.filter((file) => typeof file === "string") : [];
      const moves = Array.isArray(touch.moves)
        ? touch.moves.filter((move) => typeof move?.from === "string" && typeof move?.to === "string")
          .map(({ from, to }) => ({ from, to }))
        : [];
      const edited = Array.isArray(touch.edited) ? touch.edited.filter((file) => typeof file === "string") : [];
      const left = Array.isArray(touch.left)
        ? touch.left.filter((entry) => typeof entry?.path === "string" && Array.isArray(entry.audiences))
          .map(({ path, audiences }) => ({ path, audiences: audiences.filter((audience) => typeof audience === "string") }))
        : [];
      if (paths.length === 0 && files.length === 0 && edited.length === 0) return null;
      const dirty = paths.length > TREE_TOUCH_NAMES || files.length > TREE_TOUCH_NAMES || edited.length > TREE_TOUCH_NAMES;
      return await post("/gateway/tree/touch", {
        workspaceId,
        paths: dirty ? [] : paths,
        files: dirty ? [] : files,
        dirty,
        ...(moves.length === 0 || moves.length > TREE_TOUCH_NAMES ? {} : { moves }),
        ...(dirty || edited.length === 0 ? {} : { edited }),
        // Only narrows the gone rows of what left; a sweep judges by the rules alone.
        ...(dirty || left.length === 0 || left.length > TREE_TOUCH_NAMES ? {} : { left }),
      });
    },

    /**
     * Say that a write of ours moved the bytes under `website/`, so the
     * control plane's route index is no longer a description of them.
     *
     * **An id and nothing else** — the same bar `reportTreeChange` holds
     * itself to, and strictly less than the control plane already stores about
     * that folder, since reconciling the index puts every published route's
     * path and title in it.
     *
     * The console's writes say this through `runFileOperation`'s barrier. Ours
     * had no way to, which left the index describing bytes that had moved: the
     * resolver re-reads the page it serves, so a restricted page's body was
     * safe, but the menu beside it is drawn from the index and is handed to
     * anyone who asks for any address on the site.
     *
     * A move or a privacy change outside the folder names its `paths` as
     * well, the names the tree touch already carries: a page can publish a
     * folder it names with `folder:`, and only the control plane's index
     * knows which.
     *
     * @param {string} workspaceId
     * @param {string[]} [paths]
     */
    async reportWebsiteChange(workspaceId, paths) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      return await post("/gateway/website", {
        workspaceId,
        ...(Array.isArray(paths) && paths.length > 0 ? { paths } : {}),
      });
    },

    /**
     * That a write touched a routine root (`tex/routines/` or `routines/`),
     * the paths it touched and who wrote them. Paths and an id, never text:
     * the control plane re-reads the roots before it schedules anything
     * (`docs/decisions/routines.md`).
     *
     * @param {string} workspaceId
     * @param {string | null} userId
     * @param {string[]} paths
     */
    async reportRoutineChange(workspaceId, userId, paths) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      if (!Array.isArray(paths) || paths.length === 0) return null;
      return await post("/gateway/routines", {
        workspaceId,
        ...(typeof userId === "string" && userId ? { userId } : {}),
        paths,
      });
    },

    /**
     * That a form took an answer, and who the block says to tell.
     *
     * **Identifiers only.** No field values, no submitter, no timestamp — the
     * control plane reads the answer back out of the customer's bucket when it
     * delivers, through `canSee` as the recipient. Two reasons, and the second
     * is the one that decides it: a mail assembled from what this worker sent
     * would be a mail about a submission rather than about the file, and this
     * payload would otherwise be note content crossing into the control plane,
     * where a scheduled job persists its arguments. Non-negotiable #1 is
     * absolute about that, and a short window is still the wrong side of it.
     *
     * `to` is the block's raw `notify` value, already shape-checked by
     * `parseFormBlocks`. It names a person; the control plane decides whether
     * that person is a member here and holds a verified address, and there is
     * no address this worker could send that would reach a stranger.
     */
    async notifyFormSubmission(workspaceId, submission) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      return await post("/gateway/forms/notify", { workspaceId, ...submission });
    },
  };
}
