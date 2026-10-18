/**
 * The two doors Google pushes through, and what each does once it is open.
 *
 * Both are factories, like every route in `http.ts`, so that the check is
 * something the route *is*: `__tests__/structure/httpRoutes.test.ts`
 * enumerates them and `__tests__/googlePush/routes.test.ts` proves each
 * refuses a delivery it cannot authenticate.
 *
 *  - `pubsubPushRoute`: Gmail and Chat, through our Pub/Sub push
 *    subscription. The key is a Google-signed OIDC token naming our push
 *    service account and this endpoint as its audience (`oidc.ts`).
 *  - `calendarChannelRoute`: Calendar's web hook. The key is the random
 *    channel token we handed Google when the channel was opened, checked
 *    against its stored hash; there is no other credential Calendar offers.
 *
 * Neither reads mail, and neither answers with anything but a status: a
 * notification can only make a connection due sooner (`functions/googlePush.ts`).
 */

import { internal } from "../../../_generated/api";
import { httpAction } from "../../../_generated/server";
import type { ActionCtx } from "../../../_generated/server";
import { badRequest, readJsonBody, unauthorized } from "../gatewayAuth";
import { pubsubPushIdentity } from "./config";
import { sha256Hex } from "./ensure";
import { pubsubTokenIsValid } from "./oidc";

/** Acknowledged: Pub/Sub and Calendar both treat any 2xx as delivered. */
function delivered(): Response {
  return new Response(null, { status: 204 });
}

export function pubsubPushRoute(
  handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    // No identity configured is a deployment without push: every delivery
    // is refused, never allowed.
    const identity = pubsubPushIdentity();
    if (identity === null) return unauthorized();
    const signed = await pubsubTokenIsValid({
      authorization: request.headers.get("authorization"),
      audience: identity.audience,
      serviceAccount: identity.serviceAccount,
    });
    if (!signed) return unauthorized();
    const body = await readJsonBody(request);
    if (body === null) return badRequest();
    return await handler(ctx, body);
  });
}

export function calendarChannelRoute(handler: (ctx: ActionCtx) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const channelId = request.headers.get("x-goog-channel-id") ?? "";
    const token = request.headers.get("x-goog-channel-token") ?? "";
    const resourceState = request.headers.get("x-goog-resource-state") ?? "";
    if (channelId.length === 0 || channelId.length > 64 || token.length === 0 || token.length > 256) {
      return unauthorized();
    }
    const { accepted } = await ctx.runMutation(
      internal.functions.googlePush.acceptCalendarNotification,
      { channelId, tokenHash: await sha256Hex(token), resourceState },
    );
    if (!accepted) return unauthorized();
    return await handler(ctx);
  });
}

function decodeBase64Json(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(atob(data));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One Pub/Sub delivery. Gmail's carries `{ emailAddress, historyId }` as its
 * data; a Workspace Events delivery is a CloudEvent whose attributes name the
 * subscription it came from. Anything else is acknowledged and dropped, so a
 * shape we do not understand is not retried forever.
 */
export async function pubsubPushHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const message = body.message;
  if (message === null || typeof message !== "object") return delivered();
  const { attributes, data } = message as { attributes?: Record<string, unknown>; data?: unknown };

  const eventType = attributes?.["ce-type"];
  if (typeof eventType === "string") {
    const source = attributes?.["ce-source"];
    const match =
      typeof source === "string"
        ? /^\/\/workspaceevents\.googleapis\.com\/(subscriptions\/[A-Za-z0-9_-]{1,200})$/.exec(source)
        : null;
    if (match !== null) {
      await ctx.runMutation(internal.functions.googlePush.pokeFromPubsub, {
        chatSubscription: match[1]!,
        chatLifecycle: eventType.startsWith("google.workspace.events.subscription."),
      });
    }
    return delivered();
  }

  const gmail = decodeBase64Json(data);
  const address = gmail?.emailAddress;
  if (typeof address === "string" && address.length <= 320 && address.includes("@")) {
    await ctx.runMutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: address });
  }
  return delivered();
}

export async function calendarPushHandler(_ctx: ActionCtx): Promise<Response> {
  return delivered();
}
