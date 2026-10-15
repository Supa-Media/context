/**
 * The `queue` consumer: one gateway job message (today, materializing a
 * logical folder move), opened through the control plane, run, and reported
 * back — re-queued while there is work left.
 */

import { createControlPlane } from "../controlPlane.js";
import { attachChangeReporters } from "../controlPlane/changeReporters.js";
import { MOVE_AUTOMATIC_BATCH } from "./limits.js";
import { moveErrorForControlPlane, moveFinished, moveProgressFromText } from "./jobs.js";
import { searchBudgetFor } from "../search/budget.js";
import { storeForOpenedBinding } from "../session.js";
import { withPrivacyAuthority } from "../store/privacyAuthority.js";
import { toolMaterializeMove } from "../tools/moves/materialize.js";

// A control-plane or storage failure can happen after the ticket was claimed.
// Let the Queue redeliver the same message; a live lease tells it when to try
// again. A short initial delay recovers quickly when no claim happened yet.
const TRANSIENT_RETRY_SECONDS = 30;
const MOVE_RETRY_LIMIT = 5;

export function moveRetryForText(text, failures) {
  if (!/(?:materialization|reference rewrite) paused:/i.test(text) ||
      !Number.isSafeInteger(failures) || failures < 0 || failures >= MOVE_RETRY_LIMIT) return null;
  return { delaySeconds: Math.min(15 * 60, 30 * 2 ** failures), transientFailures: failures + 1 };
}

function retryMessage(message, delaySeconds) {
  if (typeof message?.retry !== "function") throw new Error("queue retry unavailable");
  message.retry({ delaySeconds: Math.max(1, Math.ceil(delaySeconds)) });
}

/**
 * @param {object} [deps] seams for tests: `materialize` stands in for `toolMaterializeMove`.
 */
export async function handleGatewayJobMessage(message, env, { materialize = toolMaterializeMove } = {}) {
  const body = message?.body;
  const ticket = typeof body?.ticket === "string" ? body.ticket : null;
  if (!ticket) return;

  try {
    const controlPlane = createControlPlane(env);
    const opened = await controlPlane.openGatewayJob(ticket);
    if (opened === null) return;
    if (typeof opened.retryAfterMs === "number") {
      const delaySeconds = Math.max(1, Math.ceil(opened.retryAfterMs / 1000 + 1));
      // A fresh delayed message resets Cloudflare's finite delivery-attempt
      // counter. A live lease can outlast its default retry allowance.
      if (typeof env?.GATEWAY_JOBS?.send === "function") {
        await env.GATEWAY_JOBS.send(body, { delaySeconds });
      } else {
        retryMessage(message, delaySeconds);
      }
      return;
    }
    const { job } = opened;
    // A move rewrites `privacy.md`'s rules, so it writes them through the
    // control plane's while those are the authority (`store/privacyAuthority.js`).
    const store = withPrivacyAuthority(
      storeForOpenedBinding(opened, job.workspaceId, env),
      controlPlane.privacyAuthority?.({ ticket }, job.workspaceId, opened.privacy ?? null),
    );
    store.searchSubrequestBudget = searchBudgetFor(env);
    store.actor = {
      workspaceId: job.workspaceId,
      userId: job.actorUserId,
      clientId: job.actorClientId,
      grantId: job.grantId,
    };
    store.reportSearchIndexProgress = (progress) =>
      controlPlane.reportSearchIndexProgress({
        ...progress,
        workspaceId: job.workspaceId,
      });
    // The same reporters a session's store has (`http/route.js`): a move this
    // job finishes is a write, and its `recordChange` re-checks the Convex
    // tree only through them. The queue has no `waitUntil`, so the deferred
    // reports are gathered and settled before the job is reported.
    const deferred = [];
    store.defer = (work) => {
      deferred.push(Promise.resolve(work).catch(() => {}));
    };
    // The ledger a queued move reads (reference repair follows earlier moves)
    // is the control plane's, proved by this job's ticket while it holds the lease.
    attachChangeReporters(store, job.workspaceId, controlPlane, {
      readLedger: () => controlPlane.readJobLedger(ticket, job.workspaceId),
    });

    let status = "failed";
    let error;
    let progress;
    let nextMessage = body;
    let nextDelaySeconds;
    if (job.kind === "materialize_move" && typeof job.moveId === "string") {
      const result = await materialize(store, "private", job.moveId, MOVE_AUTOMATIC_BATCH,
        { automatic: true });
      const text = result?.content?.[0]?.text || "";
      if (result?.isError) {
        error = moveErrorForControlPlane(text);
        const failures = Number.isSafeInteger(body.transientFailures) ? body.transientFailures : 0;
        const retry = moveRetryForText(text, failures);
        if (retry) {
          status = "queued";
          nextDelaySeconds = retry.delaySeconds;
          nextMessage = { ...body, transientFailures: retry.transientFailures };
        }
      } else if (moveFinished(text)) {
        status = "complete";
      } else {
        status = "queued";
        progress = moveProgressFromText(text);
        nextMessage = { ...body, transientFailures: 0 };
      }
    } else {
      error = "unsupported gateway job";
    }

    await Promise.all(deferred);
    await controlPlane.reportGatewayJob(ticket, {
      status,
      ...(error ? { error } : {}),
      ...(progress ? { progress } : {}),
    });
    if (status === "queued" && env?.GATEWAY_JOBS && typeof env.GATEWAY_JOBS.send === "function") {
      if (nextDelaySeconds === undefined) await env.GATEWAY_JOBS.send(nextMessage);
      else await env.GATEWAY_JOBS.send(nextMessage, { delaySeconds: nextDelaySeconds });
    }
  } catch (error) {
    // Without an explicit delay, Cloudflare may redeliver while the old lease
    // is still live. The lease response above then defers it until recovery is
    // safe. Do not acknowledge an exception and strand the only queue message.
    if (typeof message.retry !== "function") throw error;
    retryMessage(message, TRANSIENT_RETRY_SECONDS);
  }
}
