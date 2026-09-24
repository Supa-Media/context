/**
 * `POST /gateway/links/*`: a link minted, listed or taken back for an agent
 * that asked, each cleared by `ownerClearanceForGateway`.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

/**
 * `POST /gateway/links/create` — mint a link and answer with its URL.
 *
 * **The URL, never the token.** An agent that was handed a token would have to
 * assemble the address itself, and a second builder is a second opinion about
 * what a share link looks like — which is the whole complaint this answers.
 * The control plane builds it from `@context/shared`, the same function the
 * console's Copy link uses.
 *
 * The clearance is the ordinary two-factor one: this route's factory refuses
 * without the gateway secret, and `ownerClearanceForGateway` then spends the
 * *user's* access token against a live grant that has to be an owner's. One
 * `null` covers every refusal, so an agent cannot tell "not yours" from "not a
 * note" from "already encrypted".
 */
export async function gatewayLinksCreateHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const path = stringField(body, "path");
  const audience = body.audience === "members" ? "members" : "anyone";
  const kind = body.kind === "folder" ? "folder" : body.kind === "note" ? "note" : undefined;
  const short = stringField(body, "short");
  // Only the literal. Anything else — absent, misspelled, a truthy object — is
  // a read link, because "I could not read what you asked for" must never
  // resolve to the one mode that opens a write path to strangers.
  const mode = body.mode === "collect" ? "collect" : undefined;
  // Passed through as a number and normalized by `mintLinkShare`, which is the
  // one place the range lives. Anything that is not a number is simply absent.
  const collectCap = typeof body.collectCap === "number" ? body.collectCap : undefined;
  if (accessToken === null || expected === null || path === null) {
    return json({ link: null, shortRefused: null });
  }

  const result = await ctx.runAction(internal.functions.shares.gatewayCreateLink, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    path,
    audience,
    ...(kind === undefined ? {} : { kind }),
    ...(short === null ? {} : { short }),
    ...(typeof body.titleInPreview === "boolean"
      ? { titleInPreview: body.titleInPreview }
      : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(collectCap === undefined ? {} : { collectCap }),
  });
  return json({
    link: result?.link ?? null,
    shortRefused: result?.shortRefused ?? null,
  });
}

/** `POST /gateway/links/list` — every live link in this context. */
export async function gatewayLinksListHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ links: null });

  const links = await ctx.runQuery(internal.functions.shares.gatewayListLinks, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  return json({ links });
}

/** `POST /gateway/links/revoke` — take one back. */
export async function gatewayLinksRevokeHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const shareId = stringField(body, "shareId");
  if (accessToken === null || expected === null || shareId === null) {
    return json({ revoked: false });
  }

  const revoked = await ctx.runMutation(internal.functions.shares.gatewayRevokeLink, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    shareId,
  });
  return json({ revoked });
}
