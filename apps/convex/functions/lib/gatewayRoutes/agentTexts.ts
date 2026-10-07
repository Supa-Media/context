/**
 * `POST /agent-texts/*`: the texting assistant's calls, behind its own
 * secret (`AGENT_WORKER_SECRET`, see `lib/gatewayAuth.ts`).
 *
 * Split out of `http.ts`, which declares and registers both routes with the
 * `agentWorkerRoute` factory; that factory's secret check runs before any of
 * this. Every refusal is the same quiet shape, so the Worker (or whoever stole
 * its secret) learns nothing about which numbers are linked beyond what a text
 * from that number would be told anyway.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { APP_ORIGIN_ENV_VAR, badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { TEXTS_GRANT_TTL_MS, TEXTS_LINK_ROUTE } from "../../textLinks";

/**
 * `POST /agent-texts/link` — `{ phone, code }` → `{ status: "linked", handle }`
 * or `{ status: "refused" }`.
 */
export async function agentTextsLinkHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  const code = stringField(body, "code");
  if (phone === null || code === null || code.length > 32) return badRequest();
  const result: { status: "linked"; handle: string } | { status: "refused" } =
    await ctx.runMutation(internal.functions.textLinks.consumeLinkCode, {
      phone,
      hashedCode: await hashToken(code.toUpperCase()),
    });
  return json(result);
}

/**
 * `POST /agent-texts/session` — `{ phone }` → a fresh grant for whoever linked
 * it, or `{ status: "unlinked" }`. The plaintext token is returned once and
 * only its hash is stored.
 */
export async function agentTextsSessionHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  const accessToken = `cat_${randomOpaqueToken(32)}`;
  const status: "linked" | "unlinked" = await ctx.runMutation(
    internal.functions.textLinks.applyTextsGrant,
    {
      phone,
      hashedAccessToken: await hashToken(accessToken),
      // The hash of a value nobody was given: this grant has no refresh token,
      // and a constant here would make every texting grant refreshable by one
      // guess (same reasoning as `agentGrant.ts`).
      hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
      expiresAt: Date.now() + TEXTS_GRANT_TTL_MS,
    },
  );
  return json(status === "linked" ? { status, accessToken } : { status });
}

/**
 * `POST /agent-texts/invite` — `{ phone }` → `{ status: "issued", url }`, the
 * sign-in link to text back to a phone nobody has linked, or
 * `{ status: "refused" }`. The token is in the URL once and only its hash is
 * stored; the URL is built here so the Worker needs no idea of the app's origin.
 */
export async function agentTextsInviteHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  const origin = appOrigin();
  if (origin === null) return json({ status: "refused" });
  const token = randomOpaqueToken(24);
  const status: "issued" | "refused" = await ctx.runMutation(
    internal.functions.textLinks.issueLinkInvite,
    { phone, hashedToken: await hashToken(token) },
  );
  return json(status === "issued" ? { status, url: `${origin}${TEXTS_LINK_ROUTE}/${token}` } : { status });
}

/** `POST /agent-texts/unlink` — `{ phone }` → `{ status: "unlinked" | "not_linked" }`. */
export async function agentTextsUnlinkHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  const status: "unlinked" | "not_linked" = await ctx.runMutation(
    internal.functions.textLinks.unlinkByPhone,
    { phone },
  );
  return json({ status });
}

function appOrigin(): string | null {
  const raw = process.env[APP_ORIGIN_ENV_VAR];
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
