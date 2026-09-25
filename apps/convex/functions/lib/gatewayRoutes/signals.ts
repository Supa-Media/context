/**
 * The gateway reporting in: search-index progress, activity, tree changes, a
 * form answer to notify about, and usage counts. Each is answered identically
 * whatever it names, so none of them is an oracle.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { countField, json, nullableStringField, stringField } from "../gatewayAuth";

/**
 * The gateway telling us how far its projection has got.
 *
 * ## Proof #1 only, and what that costs
 *
 * The gateway secret and nothing else. There is no user access token here
 * because there is nobody present: a backfill runs behind a response and
 * outlives the request that started it, which is the same reason
 * `/gateway/ingest/*` cannot present a user's proof either.
 *
 * So a holder of the gateway secret can, for a workspace it names: write two
 * integers onto a row, and move one that is already backfilling to `ready`. It
 * cannot read anything, cannot learn whether the id it named exists, cannot
 * learn whether that context opted in, and cannot obtain a credential. **This
 * route returns the same bytes for every input** — an accepted report and a
 * refused one are indistinguishable — for the reason `/gateway/usage`'s header
 * gives about naming a context in a request that cannot read one.
 *
 * The refusals are not here. They are in `recordProjectionProgress`, which owns
 * the row: a context that is not opted in, a row mid-release, an unentitled
 * one, and a `failed` or `provisioning` one are all refused there, by the same
 * composed gate that decided whether the credential could be handed over in the
 * first place. A route that decided for itself would be a second opinion about
 * what "on" means.
 *
 * ## Why the counters are validated at the door as well
 *
 * `notesIndexed` and `notesPending` are rendered to an owner as a percentage.
 * A negative, a fraction, an `Infinity` or a string is refused rather than
 * coerced, here *and* in the mutation — the door is one caller and the mutation
 * is the invariant.
 *
 * `state` is optional and its only accepted value is `"ready"`. Anything else,
 * including a state this build does not know, is the same answer as no state at
 * all: a vocabulary we do not share must never move a row.
 */
export async function gatewaySearchIndexProgressHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  // Built once, returned on every path. Assembling the answer in one place is
  // what makes "every input is answered identically" a property of the code
  // rather than of three `return`s that happen to agree today.
  const answered = () => json({ ok: true });

  const workspaceId = stringField(body, "workspaceId");
  const notesIndexed = countField(body, "notesIndexed");
  const notesPending = countField(body, "notesPending");
  const state = nullableStringField(body, "state");
  if (
    workspaceId === null ||
    notesIndexed === null ||
    notesPending === null ||
    !state.ok ||
    (state.value !== null && state.value !== "ready")
  ) {
    return answered();
  }

  try {
    await ctx.runMutation(
      internal.functions.fastSearch.recordProjectionProgress,
      {
        // Cast at the boundary and checked by the validator on the other side
        // of `runMutation`, exactly as `/gateway/usage` does it: a malformed id
        // is a rejected call, not a stored row.
        workspaceId: workspaceId as Id<"workspaces">,
        notesIndexed,
        notesPending,
        ready: state.value === "ready",
      },
    );
  } catch {
    // A malformed id, or anything else. Swallowed and answered identically,
    // because the difference between "that is not an id" and "that context did
    // not want this" is the oracle this route must not be.
  }
  return answered();
}

/**
 * The gateway saying that a line landed in a context's `activity.md`.
 *
 * It exists for one pixel: the dot on *another* workspace's mark, which the
 * console draws from the workspace row rather than by opening four buckets on
 * every load. The console stamps the same field directly; this is the other
 * writer saying the same thing across a network boundary.
 *
 * **It carries a workspace id and one boolean.** What changed, who changed it
 * and where are in the customer's bucket, and a route that reported any of
 * that would be the control plane holding note metadata it has no business
 * holding (non-negotiable #1). The boolean is not about the note: it says
 * which of the two stamps may move, because a member who is not the owner is
 * served `activityTeamAt` and a private line must not tell them its time.
 * Absent reads as private, so a caller that omits it can only under-report.
 *
 * The timestamp is taken here rather than accepted from the caller, so a
 * gateway with a wrong clock cannot park a context in the future.
 *
 * Answered identically whatever happens, like its neighbours: a malformed id
 * and a context that does not exist must not be distinguishable.
 */
export async function gatewayActivityHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const answered = () => json({ ok: true });
  const workspaceId = stringField(body, "workspaceId");
  if (workspaceId === null) return answered();
  try {
    await ctx.runMutation(internal.functions.files.markWorkspaceActivity, {
      workspaceId: workspaceId as Id<"workspaces">,
      at: Date.now(),
      teamVisible: body.teamVisible === true,
    });
  } catch {
    // As above: the difference between "that is not an id" and "that context
    // is not yours" is the oracle this route must not be.
  }
  return answered();
}

/**
 * That an MCP write created, moved, removed or re-scoped something in a
 * context, and which audiences could see it — so the consoles showing that
 * context re-list it now. See `functions/treeSignals.ts`.
 *
 * A workspace id and audience labels (`private`, `team`, `@name`), and nothing
 * else: no path, no count, no content. The gateway computes the audiences
 * with its own privacy engine, because only it has the bucket's `privacy.md`
 * in hand; the mutation discards anything that is not an audience label, and
 * the timestamp is taken there, not accepted from the caller.
 *
 * Answered identically whatever happens, like its neighbours.
 */
export async function gatewayTreeHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const answered = () => json({ ok: true });
  const workspaceId = stringField(body, "workspaceId");
  const audiences = Array.isArray(body.audiences)
    ? body.audiences.filter((value): value is string => typeof value === "string")
    : [];
  if (workspaceId === null || audiences.length === 0) return answered();
  try {
    await ctx.runMutation(internal.functions.treeSignals.markTreeChanged, {
      workspaceId: workspaceId as Id<"workspaces">,
      audiences: audiences.slice(0, 64),
    });
  } catch {
    // A malformed id and a context that is not there answer the same.
  }
  return answered();
}

/**
 * The gateway's half of "anytime there is a submission".
 *
 * A submission through the console or a published collect link is written by
 * `runFileOperation`, which schedules the notification itself. `submit_form`
 * is written by the gateway against the bucket directly, so this route is the
 * only way one of those reaches a mailbox.
 *
 * **It carries identifiers and never an answer.** The values are read back out
 * of the customer's bucket at delivery, as the recipient — see
 * `functions/formNotify.ts`. A route that accepted the answers would put note
 * content in a scheduled job's arguments, which are persisted until it runs.
 *
 * ## What authorises it, and what it cannot be turned into
 *
 * The gateway secret, which is `gatewayRoute`'s business, plus the fact that
 * **nothing on this route names a destination**. `to` is a `notify` value from
 * a form block; `formNotify.resolveRecipient` decides whether it names a
 * member of *this* workspace with a verified address, and refuses everything
 * else. So a leaked gateway secret buys mail to members of contexts the
 * attacker already reached, about answers already in those contexts' buckets —
 * not a send to an address of their choosing, which is the thing a
 * notification route must never become.
 *
 * `ok: true` whatever happens, and `.catch` around the schedule. The caller is
 * a deferred `waitUntil` in a Worker with nobody listening; a status code here
 * would be a fact about somebody's membership, published to whoever can reach
 * the route.
 */
export async function gatewayFormsNotifyHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const answered = () => json({ ok: true });
  const workspaceId = stringField(body, "workspaceId");
  const to = stringField(body, "to");
  const formId = stringField(body, "formId");
  const notePath = stringField(body, "notePath");
  const responsesPath = stringField(body, "responsesPath");
  const responseId = stringField(body, "responseId");
  if (
    workspaceId === null ||
    to === null ||
    formId === null ||
    notePath === null ||
    responsesPath === null ||
    responseId === null
  ) {
    return answered();
  }
  try {
    await ctx.scheduler.runAfter(0, internal.functions.formNotify.deliver, {
      workspaceId: workspaceId as Id<"workspaces">,
      to,
      formId,
      notePath,
      responsesPath,
      responseId,
    });
  } catch {
    // As with the activity route: the difference between "that is not an id"
    // and "that context is not yours" is the oracle this must not be.
  }
  return answered();
}

/**
 * `POST /gateway/usage` — the gateway telling the control plane that some
 * counted things happened.
 *
 * **What may cross this boundary is a name from a closed list and a number.**
 * No path, no query, no note title, no client-supplied timestamp: the day is
 * decided here, from this deployment's clock, so a caller cannot backdate or
 * spread activity. `record` drops any metric it does not recognize, so a
 * gateway on a different build than this control plane skews a figure rather
 * than writing a name of its choosing into the table.
 *
 * The workspace ids are the gateway's own — it has just resolved a grant to
 * get them — and they are validated as ids by the mutation's argument
 * validator. An id for a workspace that does not exist writes a counter row
 * nothing joins to; it cannot read or affect one.
 *
 * **A failure here is answered 200.** This route exists to make a dashboard
 * less blank, and the gateway calls it behind its own response. Returning an
 * error would put a retry, a log line and eventually an operator's attention
 * on a counter, which is a worse outcome than a number being slightly low.
 */
export async function gatewayUsageHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawEvents = Array.isArray(body.events) ? body.events : [];
  const events: { metric: string; workspaceId?: Id<"workspaces">; count?: number }[] =
    [];
  for (const entry of rawEvents) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const metric = stringField(record, "metric");
    if (metric === null) continue;
    const workspaceId = stringField(record, "workspaceId");
    const count = record.count;
    events.push({
      metric,
      // Cast at the boundary, checked by the validator on the other side of
      // `runMutation` — a malformed id is a rejected call, not a stored row.
      workspaceId: workspaceId === null ? undefined : (workspaceId as Id<"workspaces">),
      count: typeof count === "number" ? count : undefined,
    });
  }

  if (events.length === 0) return json({ applied: 0 });

  try {
    const result = await ctx.runMutation(internal.functions.usage.record, {
      events,
      surface: "mcp",
    });
    return json(result);
  } catch {
    // See the header: a counter must never be the reason a tool call is
    // retried. The gateway is not waiting on this and has nothing to do with
    // the answer.
    return json({ applied: 0 });
  }
}

/**
 * That a gateway write moved the bytes under `website/`, so the control
 * plane's route index is no longer a description of them.
 *
 * ## Why this route has to exist at all
 *
 * The index is a derivative of bucket objects and **two processes write those
 * objects**. A console write goes through `runFileOperation`, whose barrier
 * marks the index stale (`websites/changes.ts`). The gateway writes the same
 * bucket itself — an MCP client saving a page, a live editing session flushing
 * one — and had no way to say so, which made `routeGeneration` a fact about
 * one code path while reading like a fact about the data.
 *
 * The resolver's own re-read covers the page it serves: it compares the
 * effective etag and refuses on any mismatch, so a restricted page's body was
 * never served stale. It does not cover the **menu**, which is built from
 * index rows and returned beside every answer, including to a caller with no
 * session asking for a path that does not exist. Verifying the menu the same
 * way is not an option — `sourceEtag` is the effective note etag from a read,
 * precisely so a collaboration sidecar advancing without rewriting the
 * Markdown cannot leave changed frontmatter live, so it cannot be compared
 * against a listing and checking it would mean reading every page in the menu
 * on every public request.
 *
 * ## What it carries, and why that is allowed
 *
 * A workspace id. No path, no count, no content, the same bar
 * `/gateway/tree` holds itself to — and strictly less than the control plane
 * already stores about this folder, since reconciliation puts every published
 * route's path and title in `websiteRouteIndex`.
 *
 * A holder of the gateway secret can, for a workspace it names, make that
 * workspace re-scan its own published folder. It learns nothing: the answer is
 * the same whatever it names, and the scan reads nothing back to it.
 */
export async function gatewayWebsiteHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const answered = () => json({ ok: true });
  const workspaceId = stringField(body, "workspaceId");
  if (workspaceId === null) return answered();
  try {
    // Refuses unless the index is currently complete, and schedules the one
    // rebuild that a burst of saves shares. A site that is off does nothing.
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: workspaceId as Id<"workspaces">,
    });
  } catch {
    // A malformed id and a context that is not there answer the same.
  }
  return answered();
}
