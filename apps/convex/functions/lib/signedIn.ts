import { getAuthUserId as userIdFromToken } from "@convex-dev/auth/server";
import type { Auth } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { liveSessionOf } from "./emailProof";

/**
 * Who is signed in: the person, and only while their session is live.
 *
 * `@convex-dev/auth`'s own `getAuthUserId` reads the JWT's subject and nothing
 * else, so a token issued before sign-out kept working until it expired, up
 * to an hour (CASA evidence, 2026-10-28). Signing out deletes the session
 * row, and this checks that row on every call: a deleted, expired or
 * someone-else's session answers null, as if no token was sent. In a query
 * the row joins its read set, so a live subscription re-runs and goes blank
 * the moment its session is signed out.
 *
 * Every Convex function takes the person from here. Importing the library's
 * `getAuthUserId` anywhere else is refused by `signedIn.test.ts`.
 *
 * A query or mutation reads the row itself. An action or HTTP action has no
 * database, so it asks `liveSession.isLive`, which runs under the same
 * identity.
 */
export async function getAuthUserId(ctx: SignedInCtx): Promise<Id<"users"> | null> {
  const userId = await userIdFromToken(ctx);
  if (userId === null) return null;
  if ("db" in ctx) return (await liveSessionOf(ctx as QueryCtx, userId)) === null ? null : userId;
  return (await ctx.runQuery(internal.functions.liveSession.isLive, {})) ? userId : null;
}

type SignedInCtx =
  | { auth: Auth; db: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { auth: Auth; runQuery: (reference: any, args: Record<string, never>) => Promise<boolean> };

/** The signed-in person, or `NOT_AUTHENTICATED`: `getAuthUserId` with a refusal. */
export async function requireAuthId(ctx: SignedInCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  return userId;
}
