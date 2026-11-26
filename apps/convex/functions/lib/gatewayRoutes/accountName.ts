/**
 * `POST /gateway/account/name`: the person's own name on their account, read or changed from their own chat with Tex
 * (`functions/accountName.ts`). `{ accessToken }` reads it; `{ accessToken, name }` sets it.
 *
 * Only a person's own texting grant reaches it, so a group chat can never rename anyone. Answers
 * `{ status: "done", name }`, `{ status: "refused" }`, `{ status: "invalid" }` or `{ status: "bad_request" }`.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { cleanName } from "../../accountName";

export async function gatewayAccountNameHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  if (accessToken === null) return json({ status: "bad_request" });
  const owner = await ctx.runQuery(internal.functions.accountName.textedOwner, { hashedAccessToken: await hashToken(accessToken) });
  if (owner === null) return json({ status: "refused" });
  if (body.name === undefined) return json({ status: "done", name: owner.name });
  const name = cleanName(body.name);
  if (name === null) return json({ status: "invalid" });
  await ctx.runMutation(internal.functions.accountName.writeName, { userId: owner.userId, name });
  // Ids only: never the name.
  console.log(JSON.stringify({ event: "account.name_set_by_text", userId: owner.userId }));
  return json({ status: "done", name });
}
