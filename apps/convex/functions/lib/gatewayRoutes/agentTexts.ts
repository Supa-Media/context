/**
 * `POST /agent-texts/*`: the texting assistant's two calls, behind its own
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
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { TEXTS_GRANT_TTL_MS } from "../../textLinks";

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
