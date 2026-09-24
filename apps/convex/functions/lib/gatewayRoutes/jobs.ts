/**
 * `POST /gateway/jobs/*`: minting, opening and reporting on queued gateway
 * work.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, randomOpaqueToken, stringField } from "../gatewayAuth";

export async function gatewayJobsCreateHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const job = body.job && typeof body.job === "object" && !Array.isArray(body.job)
    ? body.job as Record<string, unknown>
    : null;
  const kind = job?.kind === "materialize_move" ? "materialize_move" : null;
  const moveId = typeof job?.moveId === "string" ? job.moveId : undefined;
  if (accessToken === null || expected === null || kind === null) {
    return json({ ticket: null });
  }

  const ticket = randomOpaqueToken();
  const created = await ctx.runMutation(internal.functions.controlPlane.createGatewayJob, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    hashedTicket: await hashToken(ticket),
    kind,
    moveId,
  });
  return json({ ticket: created ? ticket : null });
}

export async function gatewayJobsOpenHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const ticket = stringField(body, "ticket");
  if (ticket === null) return json({ job: null });
  const opened = await ctx.runAction(internal.functions.controlPlane.openGatewayJob, {
    hashedTicket: await hashToken(ticket),
  });
  return json({ job: opened });
}

export async function gatewayJobsReportHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const ticket = stringField(body, "ticket");
  const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
    ? body.result as Record<string, unknown>
    : null;
  const status =
    result?.status === "queued" || result?.status === "complete" || result?.status === "failed"
      ? result.status
      : null;
  const rawProgress =
    result?.progress && typeof result.progress === "object" && !Array.isArray(result.progress)
      ? result.progress as Record<string, unknown>
      : null;
  const progress =
    rawProgress !== null &&
    (rawProgress.phase === "copying" || rawProgress.phase === "deleting") &&
    typeof rawProgress.completed === "number" &&
    Number.isInteger(rawProgress.completed) &&
    rawProgress.completed >= 0 &&
    typeof rawProgress.total === "number" &&
    Number.isInteger(rawProgress.total) &&
    rawProgress.total > 0 &&
    rawProgress.completed <= rawProgress.total
      ? {
          phase: rawProgress.phase as "copying" | "deleting",
          completed: rawProgress.completed,
          total: rawProgress.total,
        }
      : null;
  if (ticket !== null && status !== null) {
    try {
      await ctx.runMutation(internal.functions.controlPlane.reportGatewayJob, {
        hashedTicket: await hashToken(ticket),
        result: {
          status,
          ...(typeof result?.error === "string" ? { error: result.error } : {}),
          ...(progress === null ? {} : { progress }),
        },
      });
    } catch {
      // Reporting is not a read path and not a credential path; every refusal
      // answers the same way so the ticket cannot be probed from the outside.
    }
  }
  return json({ ok: true });
}
