/**
 * The session one text runs under, answered by the person object and never by Convex
 * (`docs/decisions/texting-assistant/texting-in-objects.md`).
 *
 * The texting Worker asks over a service binding to the gateway's `TexTexts` entrypoint (`src/index.js`), which has no
 * public URL: only a Worker in this account that was given the binding can call it, so the call needs no secret of
 * its own. It sends the phone and the personal workspace id its inbox remembers. The id is a locator, never proof:
 * the phone is hashed here (HMAC under a key derived from the gateway secret, so no object holds the number) and the
 * person object answers only for a hash it holds itself. Every miss is `{status: "unlinked"}`, and the Worker then
 * asks Convex as it always has, so a person not switched yet, or an inbox with a stale id, is never cut off.
 *
 * A hit mints a fifteen-minute `cat1.<personalWorkspaceId>.<secret>` token, which the object keeps as a `context_texts`
 * connection, and answers with the zone and style. Convex keeps its copy of the grant in one write before the answer
 * (`textsOpened`), with the audit row and the re-arming of the dream, check-in and housekeeping: one call where the old
 * path made four, and none of its reads (zone, style, identity) left on the way.
 */

import { sha256Hex } from "../controlPlane/client.js";
import { createControlPlane } from "../controlPlane.js";
import { objectToken } from "../workspaceStore/access.js";
import { workspaceClient } from "../workspaceStore/api.js";
import { timedAccessStep } from "../workspaceStore/personClient.js";
import { TEXTING_TOKEN_MS } from "../workspaceStore/personTexting.js";
import { randomToken } from "../oauth/responses.js";
import { PHONE, textingPhoneHash } from "./textingPhone.js";

export { textingPhoneHash };

/** The path the Worker posts to on the `TexTexts` binding. */
export const TEXTS_SESSION_PATH = "/texts/session";

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 1024;

const UNLINKED = () => Response.json({ status: "unlinked" });

async function readAsk(request) {
  if (request.method !== "POST") return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object") return null;
    const { phone, personalWorkspaceId } = body;
    if (typeof phone !== "string" || !PHONE.test(phone)) return null;
    if (typeof personalWorkspaceId !== "string" || !WORKSPACE_ID.test(personalWorkspaceId)) return null;
    return { phone, personalWorkspaceId };
  } catch {
    return null;
  }
}

const defaultObjects = (env, personalWorkspaceId) => workspaceClient(env, personalWorkspaceId)?.access ?? null;
const defaultCopy = (env) => (fields) => createControlPlane(env).textsOpened(fields);

/**
 * The `TexTexts` entrypoint's fetch. `objects` and `copy` are seams for tests: the person object's access client and
 * Convex's copy of the grant.
 */
export async function openTextsSession(request, env, ctx, { objects = defaultObjects, copy = defaultCopy, now = Date.now } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== TEXTS_SESSION_PATH) return new Response(null, { status: 404 });
  const ask = await readAsk(request);
  if (ask === null) return new Response(null, { status: 400 });
  const phoneHash = await textingPhoneHash(env?.GATEWAY_SECRET, ask.phone);
  if (phoneHash === null) return UNLINKED();
  const person = objects(env, ask.personalWorkspaceId);
  if (person === null || typeof person.texting?.open !== "function") return UNLINKED();
  const accessToken = objectToken("access", ask.personalWorkspaceId, randomToken(32));
  const tokenHash = await sha256Hex(accessToken);
  // A refresh hash nobody holds: a texting token is never refreshed, a new text opens a new one.
  const refreshHash = await sha256Hex(randomToken(32));
  const at = now();
  const expiresAt = at + TEXTING_TOKEN_MS;
  let answer;
  try {
    answer = await timedAccessStep(env, "person.texting.open", ask.personalWorkspaceId, () => person.texting.open({ phoneHash, tokenHash, refreshHash, expiresAt, at }));
  } catch {
    // An object that cannot answer is the same miss: the Worker asks Convex, which is slower and never wrong.
    return UNLINKED();
  }
  if (answer?.status !== "linked" || typeof answer.grantId !== "string" || typeof answer.workspaceId !== "string") return UNLINKED();
  // Convex keeps its copy of the grant before the token goes out: every control-plane route that takes the token
  // (the model cap, the vault, mail, pages) resolves it from that copy. Convex also checks the phone is still linked
  // and texting not paused, so a record the object has not caught up on never opens a session. Its "unlinked", or a
  // failure, is the same miss as the object's: the token was never handed out, and the Worker asks Convex the old way.
  const opened = { personalWorkspaceId: ask.personalWorkspaceId, phone: ask.phone, grantId: answer.grantId, workspaceId: answer.workspaceId, hashedAccessToken: tokenHash, expiresAt, at };
  try {
    const kept = await timedAccessStep(env, "texts.opened.copy", ask.personalWorkspaceId, () => copy(env)(opened));
    if (kept?.status !== "linked") return UNLINKED();
  } catch {
    // Ids only, never the token or its hash.
    console.warn(JSON.stringify({ event: "texts_opened_copy_failed", personalWorkspaceId: ask.personalWorkspaceId, grantId: answer.grantId }));
    return UNLINKED();
  }
  return Response.json({
    status: "linked",
    accessToken,
    personalWorkspaceId: ask.personalWorkspaceId,
    ...(typeof answer.timeZone === "string" ? { timeZone: answer.timeZone } : {}),
    ...(answer.settings !== null && typeof answer.settings === "object" ? { settings: answer.settings } : {}),
  });
}
