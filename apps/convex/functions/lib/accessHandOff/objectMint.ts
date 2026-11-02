/**
 * A grant the control plane mints itself (the app's own sign-in, a phone's
 * cards key) for a person whose connections are decided in their object
 * (`docs/decisions/identity-and-access/access-in-objects.md`). The mint is an
 * action, so it can reach the object: the tokens name the person object
 * (`cat1.<personalWorkspaceId>.…`), Convex makes the grant row written behind
 * (its id is the connection's, and the mint's own checks run as always), and
 * the object then keeps the connection. If the object does not take it, the
 * row is revoked and the mint fails, so no token is handed out that the
 * authority does not hold.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { objectToken } from "../../../../mcp/src/workspaceStore/access.js";
import { consoleWorkspaceClient } from "../workspaceObjects/door";

/** 32 random bytes, base64url: the secret a token naming its object carries. */
function objectSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The person's personal workspace when their connections are decided in its object, else `null`. */
export async function switchedPerson(ctx: ActionCtx, userId: Id<"users">): Promise<Id<"workspaces"> | null> {
  const person = await ctx.runQuery(internal.functions.accessConnections.personOf, { userId });
  return person !== null && person.access === "object" ? person.personalWorkspaceId : null;
}

/** An access and a refresh token naming `personalWorkspaceId`'s object. */
export function objectPair(personalWorkspaceId: Id<"workspaces">): { accessToken: string; refreshToken: string } {
  return { accessToken: objectToken("access", personalWorkspaceId, objectSecret()), refreshToken: objectToken("refresh", personalWorkspaceId, objectSecret()) };
}

type Put = (rows: unknown[]) => Promise<unknown>;
export type OpenConnections = (ctx: ActionCtx, personalWorkspaceId: Id<"workspaces">) => Put | null;
const openConnections: OpenConnections = (ctx, personalWorkspaceId) => {
  const client = consoleWorkspaceClient(ctx, personalWorkspaceId) as unknown as { access?: { connections?: { put?: Put } } } | null;
  return client?.access?.connections?.put ?? null;
};

/** Give the object the grant Convex just wrote behind, or revoke it and fail the mint. */
export async function keepConnection(
  ctx: ActionCtx,
  personalWorkspaceId: Id<"workspaces">,
  grantId: Id<"oauthGrants">,
  userId: Id<"users">,
  open: OpenConnections = openConnections,
): Promise<void> {
  const row = await ctx.runQuery(internal.functions.accessConnections.connectionOf, { grantId });
  let kept = false;
  try {
    const put = row === null ? null : open(ctx, personalWorkspaceId);
    const answer = put === null ? null : await put([row]);
    kept = answer !== null && typeof answer === "object" && typeof (answer as { error?: unknown }).error !== "string";
  } catch {
    kept = false;
  }
  if (kept) return;
  await ctx.runMutation(internal.functions.accessMirror.apply, {
    workspaceId: personalWorkspaceId,
    change: { op: "revoke_connection", grantId: String(grantId), at: Date.now(), by: String(userId) },
  });
  throw new ConvexError({ code: "CONNECTION_NOT_KEPT", message: "Could not connect right now. Try again." });
}
