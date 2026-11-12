/**
 * "Done" on Tex's take-over screen (Dev2, 2026-11-12), both ways:
 *
 *  - `POST /gateway/browser-handback` `{ accessToken, browser }` → `{ doneAt }`
 *    or `{ doneAt: null }`: the gateway, for a person who pressed Done on a
 *    browser it has already shown them (`apps/mcp/src/http/texComputer.js`).
 *    The token must resolve to a live grant; `browser` is the SHA-256 of the
 *    gateway's own tag for that browser, which only the gateway can make.
 *  - `POST /agent-texts/handed-back` `{ browsers, since }` → `{ status:
 *    "waiting" }` or `{ status: "done", doneAt }`: the texting Worker, behind
 *    its secret, watching the browsers a turn texted a take-over link for
 *    (`apps/agent/src/handbackWatch.ts`).
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, stringField } from "../gatewayAuth";
import { gatewayBrowserProfileHandler } from "./browserProfile";
import { agentTextsVaultSavedHandler } from "./agentTexts";

const BROWSER = /^[0-9a-f]{64}$/;

export async function gatewayBrowserHandbackHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const browser = stringField(body, "browser");
  if (accessToken === null || browser === null || !BROWSER.test(browser)) return json({ doneAt: null });
  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return json({ doneAt: null });
  const doneAt = await ctx.runMutation(internal.functions.browserHandbacks.markHandedBack, { browser });
  return json({ doneAt });
}

export async function agentTextsHandedBackHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const browsers = body.browsers;
  const since = body.since;
  if (!Array.isArray(browsers) || browsers.length === 0 || browsers.length > 5 || browsers.some((hash) => typeof hash !== "string" || !BROWSER.test(hash))) {
    return badRequest();
  }
  if (typeof since !== "number" || !Number.isFinite(since)) return badRequest();
  return json(await ctx.runQuery(internal.functions.browserHandbacks.handedBackSince, { browsers: browsers as string[], since }));
}



/** The gateway's browser routes, registered together (`http.ts`). */
export const BROWSER_GATEWAY_ROUTES = [
  ["/gateway/browser-profile", gatewayBrowserProfileHandler],
  ["/gateway/browser-handback", gatewayBrowserHandbackHandler],
] as const;

/** The texting Worker's carry-on watches: a login saved (`vaultWatch.ts`), a browser handed back. */
export const AGENT_CARRY_ON_ROUTES = [
  ["/agent-texts/vault-saved", agentTextsVaultSavedHandler],
  ["/agent-texts/handed-back", agentTextsHandedBackHandler],
] as const;
