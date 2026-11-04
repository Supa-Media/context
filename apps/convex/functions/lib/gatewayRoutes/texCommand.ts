/**
 * `POST /gateway/tex/command` `{ accessToken, command }`: a change to how Tex
 * acts in a chat, asked for by its agent as a tool (`functions/texCommands.ts`).
 * Behind the gateway's secret, with the turn's own access token: the chat and
 * the person acting come off that grant, never from the request. Always 200;
 * a token that resolves to nothing answers `refused`, one answer for every reason.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { MAX_INSTRUCTIONS } from "../texInstructions";

/** The longest value any command field takes: a mail address, a share's search, a level; instructions' text up to theirs. */
const MAX_FIELD = 400;

export async function gatewayTexCommandHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const command = body.command;
  if (accessToken === null || command === null || typeof command !== "object" || Array.isArray(command)) return json({ status: "bad_request" });
  const raw = command as Record<string, unknown>;
  const text = (key: string, max = MAX_FIELD) => (typeof raw[key] === "string" && (raw[key] as string).length <= max ? (raw[key] as string) : undefined);
  const kind = text("kind");
  if (kind === undefined) return json({ status: "bad_request" });
  const answer = await ctx.runMutation(internal.functions.texCommands.applyTexCommand, {
    hashedAccessToken: await hashToken(accessToken),
    command: {
      kind,
      ...(text("action") !== undefined ? { action: text("action") } : {}),
      ...(text("text", MAX_INSTRUCTIONS) !== undefined ? { text: text("text", MAX_INSTRUCTIONS) } : {}),
      ...(text("updates") !== undefined ? { updates: text("updates") } : {}),
      ...(text("engagement") !== undefined ? { engagement: text("engagement") } : {}),
      ...(text("address") !== undefined ? { address: text("address") } : {}),
      ...(text("query") !== undefined ? { query: text("query") } : {}),
      ...(typeof raw.share === "boolean" ? { share: raw.share } : {}),
    },
  });
  return json(answer);
}
