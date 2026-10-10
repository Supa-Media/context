/**
 * `POST /gateway/vault/request`: a link for the person to save, share or see
 * a vault entry themselves (`functions/vault.ts`). Answers `{url}` or `{url: null}`.
 *
 * The clearance is the editor one an agent's website publish spends: the
 * token resolves to a live grant on its own, and the workspace and person come
 * off that grant. The link it builds opens only for that person, signed in.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { APP_ORIGIN_ENV_VAR, json, randomOpaqueToken, stringField } from "../gatewayAuth";

/** The app page a vault link opens: `apps/mobile/app/vault/[token].tsx`. */
export const VAULT_LINK_ROUTE = "/vault";

export async function gatewayVaultRequestHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const kind = body.kind === "add" || body.kind === "share" || body.kind === "view" ? body.kind : null;
  if (accessToken === null || expected === null || kind === null) return json({ url: null });
  const origin = appOrigin();
  if (origin === null) return json({ url: null });

  const cleared = await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  if (cleared === null) return json({ url: null });

  const token = randomOpaqueToken(24);
  const entryId = stringField(body, "entryId");
  const handle = stringField(body, "handle");
  // A rate-limited caller is answered like any refusal, not with a 500.
  const status = await ctx
    .runMutation(internal.functions.vault.issueVaultRequest, {
      workspaceId: cleared.workspaceId,
      userId: cleared.actorUserId,
      kind,
      ...(entryId === null ? {} : { entryId }),
      ...(handle === null ? {} : { handle }),
      hashedToken: await hashToken(token),
    })
    .catch(() => "refused" as const);
  return json({ url: status === "issued" ? `${origin}${VAULT_LINK_ROUTE}/${token}` : null });
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
