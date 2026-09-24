/**
 * The `queue` consumer: one gateway job message (today, materializing a
 * logical folder move), opened through the control plane, run, and reported
 * back — re-queued while there is work left.
 */

import { createControlPlane } from "../controlPlane.js";
import { MOVE_MATERIALIZE_BATCH } from "./limits.js";
import { moveProgressFromText } from "./jobs.js";
import { searchBudgetFor } from "../search/budget.js";
import { storeForOpenedBinding } from "../session.js";
import { toolMaterializeMove } from "../tools/moves/materialize.js";

export async function handleGatewayJobMessage(message, env) {
  const body = message?.body;
  const ticket = typeof body?.ticket === "string" ? body.ticket : null;
  if (!ticket) return;

  const controlPlane = createControlPlane(env);
  const opened = await controlPlane.openGatewayJob(ticket);
  if (opened === null) return;
  const { job } = opened;
  const store = storeForOpenedBinding(opened, job.workspaceId, env);
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

  let status = "failed";
  let error;
  let progress;
  if (job.kind === "materialize_move" && typeof job.moveId === "string") {
    const result = await toolMaterializeMove(store, "private", job.moveId, MOVE_MATERIALIZE_BATCH);
    const text = result?.content?.[0]?.text || "";
    if (result?.isError) {
      error = text;
    } else if (text.includes("complete") || text.includes("no active work")) {
      status = "complete";
    } else {
      status = "queued";
      progress = moveProgressFromText(text);
    }
  } else {
    error = "unsupported gateway job";
  }

  await controlPlane.reportGatewayJob(ticket, {
    status,
    ...(error ? { error } : {}),
    ...(progress ? { progress } : {}),
  });
  if (status === "queued" && env?.GATEWAY_JOBS && typeof env.GATEWAY_JOBS.send === "function") {
    await env.GATEWAY_JOBS.send(body);
  }
}
