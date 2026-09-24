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
    async reportUsage(events) {
      if (!Array.isArray(events) || events.length === 0) return { applied: 0 };
      return await post("/gateway/usage", { events });
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
