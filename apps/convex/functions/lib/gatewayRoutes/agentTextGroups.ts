/**
 * `POST /agent-texts/group`: a tagged message, or a command, in an iMessage
 * group chat Tex is in (`functions/textGroups.ts`). Behind the texting Worker's
 * own secret, like the rest of `/agent-texts/*` (`agentTexts.ts`).
 *
 * `{ line, groupId, sender, participants, command?, mint? }` →
 * the chat's answer, with a fresh grant's token when one was minted. The
 * token is returned once and only its hash is stored. `groupId` is hashed with
 * the line before it reaches the database.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { groupKeyOf, MAX_GROUP_PARTICIPANTS, TEXTS_GROUP_GRANT_TTL_MS, type GroupAnswer } from "../../textGroups";

/** Sendblue's group ids are uuids; anything much longer is not one. */
const MAX_GROUP_ID = 200;

type Command =
  | { kind: "stop" }
  | { kind: "start" }
  | { kind: "invite"; slug: string; role?: "editor" | "member" }
  | { kind: "share_mail"; address: string; query?: string }
  | { kind: "unshare_mail"; address?: string };

function readCommand(value: unknown): Command | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "stop" || kind === "start") return { kind };
  if (kind === "share_mail" || kind === "unshare_mail") return readMailCommand(kind, value as Record<string, unknown>);
  const slug = (value as { slug?: unknown }).slug;
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 65) return null;
  if (kind === "invite") {
    const role = (value as { role?: unknown }).role;
    if (role === undefined) return { kind, slug };
    return role === "editor" || role === "member" ? { kind, slug, role } : null;
  }
  return null;
}

/** A mailbox shared with the chat, or no longer (`lib/textGroupMail.ts`). Bounds only; the mutation decides. */
function readMailCommand(kind: "share_mail" | "unshare_mail", value: Record<string, unknown>): Command | null {
  const address = value.address;
  const query = value.query;
  if (address !== undefined && (typeof address !== "string" || address.length === 0 || address.length > 254)) return null;
  if (query !== undefined && (typeof query !== "string" || query.length > 300)) return null;
  if (kind === "unshare_mail") return address === undefined ? { kind } : { kind, address };
  if (address === undefined) return null;
  return query === undefined ? { kind, address } : { kind, address, query };
}

export async function agentTextsGroupHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const sender = stringField(body, "sender");
  const participants = body.participants;
  const command = readCommand(body.command);
  if (line === null || groupId === null || sender === null || groupId.length > MAX_GROUP_ID || command === null) return badRequest();
  if (!Array.isArray(participants) || participants.length > MAX_GROUP_PARTICIPANTS * 2) return badRequest();
  // An entry that isn't a string still counts as somebody, never as nobody.
  const listed = participants.map((entry) => (typeof entry === "string" ? entry.slice(0, 320) : "?"));
  const mint = body.mint === true && command === undefined;
  const accessToken = `cat_${randomOpaqueToken(32)}`;
  const answer: GroupAnswer = await ctx.runMutation(internal.functions.textGroups.applyGroupTurn, {
    line,
    groupKey: await groupKeyOf(line, groupId),
    sender,
    participants: listed,
    ...(command !== undefined ? { command } : {}),
    mint,
    ...(body.routine === true ? { routine: true } : {}),
    hashedAccessToken: await hashToken(accessToken),
    // The hash of a value nobody was given: this grant has no refresh token.
    hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    expiresAt: Date.now() + TEXTS_GROUP_GRANT_TTL_MS,
  });
  if (answer.status === "ready" && answer.minted) return json({ ...answer, accessToken });
  return json(answer);
}
