/**
 * `POST /gateway/chat/send`: one Google Chat message, sent as the person whose
 * token this is, to a person (a direct message) or into a space
 * (`lib/googleChatSend.ts`). `POST /gateway/chat/spaces`: the spaces they are
 * in, by name, so their AI can find the one they mean.
 *
 * Send body `{ accessToken, expectedWorkspaceId, message, check? }`. Answers
 * `{ ok: true, from, place }`, where `place` is `{ person }` or `{ space }` as
 * Chat names it (with `check`, nothing is sent), or `{ ok: false, refused }`.
 *
 * The gateway calls this only for a message the person said yes to, word for
 * word (`apps/mcp/src/tools/googleChatGate.js`), and asks with `check` first
 * so the person is shown the place by the name Chat gives it, never one the
 * model chose. Decided here: the connection is one of the token's person's
 * own that granted every Chat send scope, the limits hold, and a space named
 * by its name in Chat matches exactly one. Nothing of the message is stored
 * or logged; Google's error body can quote it, so only a status is.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";
import type { ChatMessage, ChatRefusal } from "../googleChatSend";
import { SPACE_NAME, chatFailure, listedSpaces, matchingSpaces, readChatMessage } from "../googleChatSend";

const CHAT_API = "https://chat.googleapis.com/v1";

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "google_chat", ...fields }));
}

type Place = { person: string } | { space: string };
type Resolved = { ok: true; space: string | null; place: Place } | { ok: false; refused: ChatRefusal };

async function chatCall(accessToken: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await timeoutFetch(`${CHAT_API}/${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: body as Record<string, unknown> | null };
}

/** Every space the person is in, a page at a time, up to a bound. */
async function allSpaces(accessToken: string): Promise<{ ok: true; items: unknown[] } | { ok: false; refused: ChatRefusal }> {
  const items: unknown[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({ pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const answer = await chatCall(accessToken, `spaces?${query}`);
    if (!answer.ok) {
      log({ outcome: "http_error", stage: "list", status: answer.status });
      return { ok: false, refused: chatFailure(answer.status, answer.body) };
    }
    if (Array.isArray(answer.body?.spaces)) items.push(...answer.body.spaces);
    pageToken = typeof answer.body?.nextPageToken === "string" ? answer.body.nextPageToken : "";
    if (pageToken === "") break;
  }
  return { ok: true, items };
}

/**
 * Where the message goes: the direct message with a person (null when there
 * is none yet, which sending starts), or exactly one space.
 */
async function resolvePlace(accessToken: string, message: ChatMessage): Promise<Resolved> {
  if (message.to !== null) {
    const found = await chatCall(accessToken, `spaces:findDirectMessage?name=${encodeURIComponent(`users/${message.to}`)}`);
    if (found.ok && typeof found.body?.name === "string") return { ok: true, space: found.body.name, place: { person: message.to } };
    if (found.status === 404 && chatFailure(404, found.body) !== "chat_not_enabled") return { ok: true, space: null, place: { person: message.to } };
    log({ outcome: "http_error", stage: "find_dm", status: found.status });
    return { ok: false, refused: chatFailure(found.status, found.body) };
  }
  const space = message.space!;
  if (SPACE_NAME.test(space)) {
    const found = await chatCall(accessToken, space);
    if (found.ok && typeof found.body?.name === "string") {
      const shown = typeof found.body.displayName === "string" && found.body.displayName.trim() !== "" ? found.body.displayName.trim() : space;
      return { ok: true, space: found.body.name, place: { space: shown } };
    }
    if (found.status === 404 || found.status === 403) {
      const why = chatFailure(found.status, found.body);
      return { ok: false, refused: why === "unavailable" ? "space_not_found" : why };
    }
    log({ outcome: "http_error", stage: "get_space", status: found.status });
    return { ok: false, refused: chatFailure(found.status, found.body) };
  }
  const listed = await allSpaces(accessToken);
  if (!listed.ok) return listed;
  const matches = matchingSpaces(listed.items, space);
  if (matches.length === 0) return { ok: false, refused: "space_not_found" };
  if (matches.length > 1) return { ok: false, refused: "ambiguous" };
  return { ok: true, space: matches[0]!.name, place: { space: matches[0]!.displayName } };
}

/** The direct message with a person, started now: they had none with the person yet. */
async function startDirectMessage(accessToken: string, to: string): Promise<{ ok: true; space: string } | { ok: false; refused: ChatRefusal }> {
  const made = await chatCall(accessToken, "spaces:setup", {
    method: "POST",
    body: { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: `users/${to}`, type: "HUMAN" } }] },
  });
  if (made.ok && typeof made.body?.name === "string") return { ok: true, space: made.body.name };
  log({ outcome: "http_error", stage: "setup_dm", status: made.status });
  const why = chatFailure(made.status, made.body);
  return { ok: false, refused: made.status === 400 || made.status === 404 ? "person_not_found" : why };
}

async function mint(ctx: ActionCtx, connectionId: string) {
  return await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { connectionId: connectionId as never });
}

export async function gatewayChatSendHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const message = readChatMessage(body.message);
  const check = body.check === true;
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (message === null) return json({ ok: false, refused: "invalid" });
  const to = message.to !== null ? ("person" as const) : ("space" as const);

  const claim = async (spend: boolean) =>
    await ctx.runMutation(internal.functions.googleChatSend.claimChatSend, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected,
      to,
      spend,
    });
  const room = await claim(false);
  if (!room.ok) {
    log({ outcome: "refused", reason: room.refused, check });
    return json({ ok: false, refused: room.refused });
  }
  const minted = await mint(ctx, room.connectionId);
  if (minted === null) {
    log({ outcome: "no_token", check });
    return json({ ok: false, refused: "reconnect_required" });
  }
  try {
    const resolved = await resolvePlace(minted.accessToken, message);
    if (!resolved.ok) {
      log({ outcome: "refused", reason: resolved.refused, to, check });
      return json({ ok: false, refused: resolved.refused });
    }
    if (check) return json({ ok: true, from: room.address, place: resolved.place });
    // Spent before it is sent: one that fails after Google took it still
    // counted, the safe direction for a limit.
    const spent = await claim(true);
    if (!spent.ok) return json({ ok: false, refused: spent.refused });
    let space = resolved.space;
    if (space === null) {
      const started = await startDirectMessage(minted.accessToken, message.to!);
      if (!started.ok) return json({ ok: false, refused: started.refused });
      space = started.space;
    }
    const sent = await chatCall(minted.accessToken, `${space}/messages`, { method: "POST", body: { text: message.text } });
    log({ outcome: sent.ok ? "sent" : "http_error", to, status: sent.status });
    if (!sent.ok) return json({ ok: false, refused: chatFailure(sent.status, sent.body) });
    return json({ ok: true, from: room.address, place: resolved.place });
  } catch {
    log({ outcome: "transport_error", to, check });
    return json({ ok: false, refused: "unavailable" });
  }
}

export async function gatewayChatSpacesHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  // The same clearance as a send, spending nothing: only someone who may send may look for where.
  const room = await ctx.runMutation(internal.functions.googleChatSend.claimChatSend, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
    to: "space",
    spend: false,
  });
  if (!room.ok) return json({ ok: false, refused: room.refused });
  const minted = await mint(ctx, room.connectionId);
  if (minted === null) return json({ ok: false, refused: "reconnect_required" });
  try {
    const listed = await allSpaces(minted.accessToken);
    if (!listed.ok) return json({ ok: false, refused: listed.refused });
    return json({ ok: true, from: room.address, spaces: listedSpaces(listed.items) });
  } catch {
    return json({ ok: false, refused: "unavailable" });
  }
}
