/**
 * `POST /gateway/connect/request` and `POST /gateway/connect/call`: an agent's
 * two doors into a connector (`functions/connections.ts`,
 * `docs/decisions/connectors.md`).
 *
 * Both clear the token the way a vault link does: it resolves to a live grant
 * on its own, and the workspace and person come off that grant, never the
 * body. A request answers `{url}` or `{url: null, reason}`; a call answers
 * the provider's own answer or a refusal word.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { httpsAppOrigin, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { providerAvailable, providerOf } from "../providers/registry";
import { CONNECT_LINK_ROUTE } from "../connections/links";

async function clear(ctx: ActionCtx, body: Record<string, unknown>) {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return null;
  return await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
}

export async function gatewayConnectRequestHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const spec = providerOf(body.provider);
  if (spec === null) return json({ url: null, reason: "unknown_provider" });
  const origin = httpsAppOrigin();
  if (origin === null || !providerAvailable(spec)) return json({ url: null, reason: "unavailable" });
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ url: null, reason: "refused" });
  const token = randomOpaqueToken(24);
  // A rate-limited caller is answered like any refusal, not with a 500.
  const status = await ctx
    .runMutation(internal.functions.connections.issueConnectLink, {
      provider: spec.id,
      workspaceId: cleared.workspaceId,
      userId: cleared.actorUserId,
      clientId: cleared.clientId,
      hashedToken: await hashToken(token),
    })
    .catch(() => "refused" as const);
  if (status !== "issued") return json({ url: null, reason: "refused" });
  return json({ url: `${origin}${CONNECT_LINK_ROUTE}/${spec.id}/${token}`, name: spec.name });
}

const METHOD = /^[a-z]+(?:\.[a-zA-Z]+){1,3}$/;

export async function gatewayConnectCallHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const spec = providerOf(body.provider);
  const method = stringField(body, "method");
  const args = body.args === undefined ? {} : body.args;
  if (spec === null || method === null || !METHOD.test(method) || typeof args !== "object" || args === null || Array.isArray(args)) {
    return json({ ok: false, refused: "method_not_allowed" });
  }
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ ok: false, refused: "not_connected" });
  const team = stringField(body, "team");
  if (spec.kind !== "slack") {
    try {
      return json(
        await ctx.runAction(internal.functions.connectionApps.callApp, {
          provider: spec.id,
          workspaceId: cleared.workspaceId,
          actorUserId: cleared.actorUserId,
          clientId: cleared.clientId,
          method,
          args: args as Record<string, unknown>,
        }),
      );
    } catch (error) {
      // Said to Tex so a person's "it didn't respond" can be traced; an error here names a step, never a token.
      const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "unknown";
      console.error(JSON.stringify({ event: "connect_call_failed", provider: spec.id, method, message }));
      return json({ ok: false, refused: "unavailable", message: `Context failed calling it (${message})` });
    }
  }
  const outcome = await ctx.runAction(internal.functions.connections.callProvider, {
    provider: spec.id,
    workspaceId: cleared.workspaceId,
    actorUserId: cleared.actorUserId,
    clientId: cleared.clientId,
    method,
    args: args as Record<string, unknown>,
    ...(team === null ? {} : { team }),
  });
  return json(outcome);
}

/**
 * `POST /gateway/connect/apps`: every app this deployment connects, and which
 * the person has connected, so Tex knows what it reaches through an app's own
 * API and what it still has to sign in to with its browser. Names and states
 * only; no token is opened.
 */
export async function gatewayConnectAppsHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ apps: [] });
  const apps = await ctx.runQuery(internal.functions.connectionApps.appsForPerson, {
    workspaceId: cleared.workspaceId,
    actorUserId: cleared.actorUserId,
    clientId: cleared.clientId,
  });
  return json({ apps });
}
