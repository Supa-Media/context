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
import type { SetupAnswer } from "../../textSetup";
import { SIGN_IN_LINK_ROUTE } from "../../textSignIn";

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
 * it, with the zone to answer in, or `{ status: "unlinked" }`. The plaintext token is returned once and
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
  if (status !== "linked") return json({ status });
  // Their clock, so a texted turn knows the time where they are (`localNow.js`).
  const timeZone: string = await ctx.runQuery(internal.functions.textLinks.textsTimeZone, { phone });
  // How their own Tex talks (`functions/texStyle.ts`): only what they changed, so `{}` is left out.
  const texStyle = await ctx.runQuery(internal.functions.texStyle.textsStyle, { phone });
  return json({ status, accessToken, timeZone, ...(Object.keys(texStyle).length > 0 ? { texStyle } : {}) });
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

/**
 * `POST /agent-texts/setup` — `{ phone, candidate? }` → one step of setting
 * the phone up by text (`functions/textSetup.ts`). `candidate` is the one word
 * the person texted, never the message. A finished setup carries the new
 * workspace's console link. A creation that loses a race for the handle reads
 * as `taken`; any other failure is `not_eligible`, so the Worker falls back to
 * the sign-in link rather than saying the setup worked.
 */
export async function agentTextsSetupHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  const raw = body.candidate;
  if (raw !== undefined && (typeof raw !== "string" || raw.length === 0 || raw.length > 64)) return badRequest();
  let answer: SetupAnswer;
  try {
    answer = await ctx.runMutation(internal.functions.textSetup.answerSetupText, {
      phone,
      ...(raw === undefined ? {} : { candidate: raw }),
    });
  } catch (error) {
    const code = (error as { data?: { code?: unknown } }).data?.code;
    if (code === "NAME_UNAVAILABLE") return json({ status: "rejected", reason: "taken" });
    console.log(JSON.stringify({ event: "text_setup_failed", code: typeof code === "string" ? code : "unexpected" }));
    return json({ status: "not_eligible" });
  }
  if (answer.status !== "set_up") return json(answer);
  const origin = appOrigin();
  return json(origin === null ? answer : { ...answer, url: `${origin}/console/${answer.handle}` });
}

/**
 * `POST /agent-texts/ready` — `{ phone }` → `{ status: "ready", url }` once
 * the notes of a phone set up by text are ready, with a link that signs it in
 * and opens Google's connect card (`functions/textSignIn.ts`); else
 * `{ status: "waiting" }`, or `{ status: "gone" }` to stop asking. The token is
 * in the URL once and only its hash is stored.
 */
export async function agentTextsReadyHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  const origin = appOrigin();
  if (origin === null) return json({ status: "gone" });
  const token = randomOpaqueToken(32);
  const answer: { status: "waiting" | "gone" } | { status: "ready"; next: string } = await ctx.runMutation(
    internal.functions.textSignIn.readyLink,
    { phone, tokenHash: await hashToken(token) },
  );
  if (answer.status !== "ready") return json(answer);
  return json({ status: "ready", url: `${origin}${SIGN_IN_LINK_ROUTE}/${token}` });
}

/**
 * `POST /agent-texts/gmail` — `{ phone }` → `{ status: "waiting" | "gone" }`
 * or `{ status: "connected", address, main }`: whether the Gmail Tex asked
 * for in the "notes are ready" text has connected, so the Worker can say so
 * itself (Dev2, 2026-10-20). The address is the person's own, texted only to
 * their own phone.
 */
export async function agentTextsGmailHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  if (phone === null) return badRequest();
  return json(await ctx.runQuery(internal.functions.texHome.gmailFor, { phone }));
}

/**
 * `POST /agent-texts/vault-saved` — `{ phone, since }` → `{ status: "waiting" | "gone" }`
 * or `{ status: "saved", savedAt }`: whether a login was saved on a link Tex
 * texted, so the Worker can carry the task on without a "done" from them.
 */
export async function agentTextsVaultSavedHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const phone = stringField(body, "phone");
  const since = body.since;
  if (phone === null || typeof since !== "number" || !Number.isFinite(since)) return badRequest();
  return json(await ctx.runQuery(internal.functions.vaultWatch.savedSince, { phone, since }));
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

/**
 * `POST /agent-texts/phones` — `{}` → `{ phones }`, every phone Tex may have a
 * chat with, for the new-number notice. The Worker still texts only a phone
 * whose own chat is on the old line.
 */
export async function agentTextsPhonesHandler(ctx: ActionCtx): Promise<Response> {
  const phones: string[] = await ctx.runQuery(internal.functions.textPhones.knownPhones, {});
  return json({ phones });
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
