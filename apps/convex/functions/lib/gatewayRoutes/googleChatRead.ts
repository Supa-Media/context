/**
 * `POST /gateway/chat/recent`: the Google Chat messages written to the person
 * since a moment, read live from their own account for Tex's check-ins
 * (`apps/mcp/src/agent/checkInSources.js`; owner, 2026-10-23: "add slack and
 * google chat - but only say something if you can muster together helpful
 * actions/responses").
 *
 * Body `{ accessToken, expectedWorkspaceId, since }`. Answers `{ ok: true,
 * from, messages }`, newest first, each `{ id, space, type, from, at, text }`,
 * or `{ ok: false, refused }`.
 *
 * What counts as written to them: every message from someone else in a
 * direct message or group chat, and in a named space only a message that
 * mentions them. The spaces read are the few most recently active since
 * `since`, so one look is a bounded number of calls. Decided here: the
 * connection is one of the token's person's own that granted reading
 * (`functions/googleChatSend.ts` `claimChatRead`). Nothing of a message is
 * stored or logged; only statuses are.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";
import { SPACE_NAME, chatFailure } from "../googleChatSend";

const CHAT_API = "https://chat.googleapis.com/v1";
/** Spaces read in one look, most recently active first. */
export const MAX_CHAT_SPACES = 8;
/** Messages read per space, and answered in all. */
const PER_SPACE = 10;
export const MAX_CHAT_MESSAGES = 10;
const MAX_TEXT = 600;
const MAX_NAME = 80;
/** A look never reaches further back than this, whatever `since` says. */
const MAX_BACK_MS = 3 * 24 * 60 * 60 * 1000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

type Entry = Record<string, unknown>;

export interface RecentChatMessage {
  id: string;
  space: string;
  type: string;
  from: string;
  at: string;
  text: string;
}

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "google_chat_read", ...fields }));
}

async function chatGet(accessToken: string, path: string) {
  const response = await timeoutFetch(`${CHAT_API}/${path}`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: body as Entry | null };
}

function clean(value: unknown, most: number): string {
  const text = typeof value === "string" ? value.replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "";
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

/** The spaces active after `since`, most recent first, at most `MAX_CHAT_SPACES`. */
export function activeSpaces(items: unknown, since: number): Array<{ name: string; displayName: string; type: string }> {
  if (!Array.isArray(items)) return [];
  return (items as Entry[])
    .filter((space) => typeof space.name === "string" && SPACE_NAME.test(space.name))
    .map((space) => ({ space, at: Date.parse(String(space.lastActiveTime ?? "")) }))
    .filter(({ at }) => Number.isFinite(at) && at > since)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CHAT_SPACES)
    .map(({ space }) => ({
      name: space.name as string,
      displayName: clean(space.displayName, MAX_NAME),
      type: typeof space.spaceType === "string" ? space.spaceType : "",
    }));
}

/**
 * Who the person is in Chat. Chat names people by a numeric `users/{id}`, and
 * the only call that turns an address into one, `spaces.members.get`, needs a
 * memberships scope the connect does not ask for (Google's discovery
 * document), so Google would refuse it and every look would find nothing.
 * Chat's `User` resource fills `email` for a message's `sender` and for
 * users in its `annotations` under user authentication, for members of the
 * space, which the person always is of their own spaces. So the person is matched by the
 * address Google's id token gave the connection, and their canonical id is
 * learned from any message of theirs in the same look. Google account `sub`
 * is never taken for a Chat id: nothing in Google's documentation says the
 * two are the same number.
 */
export interface ChatSelf {
  address: string;
  name: string | null;
}

const USER_NAME = /^users\/[^/\s]+$/;

/** A user's address, or null for none, blank or not a string. */
function emailOf(user: Entry): string | null {
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  return email === "" ? null : email;
}

/** A user's canonical `users/{id}`, or null for anything else. */
function userNameOf(user: Entry): string | null {
  return typeof user.name === "string" && USER_NAME.test(user.name) ? user.name : null;
}

/** The person's canonical `users/{id}`, from any message they wrote, matched by address. */
export function learnSelf(address: string, messages: readonly Entry[]): ChatSelf {
  const own = address.trim().toLowerCase();
  for (const message of messages) {
    const sender = (message.sender ?? {}) as Entry;
    const name = userNameOf(sender);
    if (own !== "" && emailOf(sender) === own && name !== null) return { address: own, name };
  }
  return { address: own, name: null };
}

/**
 * Whether a user is the person, someone else, or cannot be told apart: a
 * user with neither a matching id nor any address may be the person
 * themselves, so it never counts as someone else.
 */
function whoIs(user: Entry, self: ChatSelf): "self" | "other" | "unknown" {
  const email = emailOf(user);
  const name = userNameOf(user);
  if ((email !== null && email === self.address) || (name !== null && name === self.name)) return "self";
  if (email !== null || (self.name !== null && name !== null)) return "other";
  return "unknown";
}

/**
 * Whether a message is to the person: anything someone else wrote in a DM or
 * group chat, or a mention of them in a space. Never their own words, so a
 * check-in can't read back what Tex sent as them; a sender it cannot tell
 * from the person is left out.
 */
export function writtenToThem(message: Entry, spaceType: string, self: ChatSelf): boolean {
  const sender = (message.sender ?? {}) as Entry;
  if (sender.type === "BOT") return false;
  if (whoIs(sender, self) !== "other") return false;
  if (spaceType === "DIRECT_MESSAGE" || spaceType === "GROUP_CHAT") return true;
  const annotations = Array.isArray(message.annotations) ? (message.annotations as Entry[]) : [];
  return annotations.some(
    (note) => note.type === "USER_MENTION" && whoIs(((note.userMention as Entry | undefined)?.user ?? {}) as Entry, self) === "self",
  );
}

export async function gatewayChatRecentHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  const now = Date.now();
  const given = typeof body.since === "number" && Number.isFinite(body.since) ? body.since : now - 24 * 60 * 60 * 1000;
  const since = Math.max(given, now - MAX_BACK_MS);

  const room = await ctx.runMutation(internal.functions.googleChatSend.claimChatRead, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  if (!room.ok) return json({ ok: false, refused: room.refused });
  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { role: "agent" as const, connectionId: room.connectionId });
  if (minted === null) return json({ ok: false, refused: "reconnect_required" });
  try {
    const listed = await chatGet(minted.accessToken, `spaces?${new URLSearchParams({ pageSize: "1000" })}`);
    if (!listed.ok) {
      log({ outcome: "http_error", stage: "list", status: listed.status });
      return json({ ok: false, refused: chatFailure(listed.status, listed.body) });
    }
    const spaces = activeSpaces(listed.body?.spaces, since);
    if (spaces.length === 0) return json({ ok: true, from: room.address, messages: [] });
    const filter = `createTime > "${new Date(since).toISOString()}"`;
    const read: Array<{ space: (typeof spaces)[number]; messages: Entry[] }> = [];
    for (const space of spaces) {
      const query = new URLSearchParams({ pageSize: String(PER_SPACE), orderBy: "createTime desc", filter });
      const answer = await chatGet(minted.accessToken, `${space.name}/messages?${query}`);
      if (!answer.ok) {
        log({ outcome: "http_error", stage: "messages", status: answer.status });
        continue;
      }
      read.push({ space, messages: Array.isArray(answer.body?.messages) ? (answer.body.messages as Entry[]) : [] });
    }
    const self = learnSelf(room.address, read.flatMap(({ messages }) => messages));
    if (self.name === null) log({ outcome: "self_by_address" });

    const found: RecentChatMessage[] = [];
    for (const { space, messages } of read) {
      for (const message of messages) {
        if (!writtenToThem(message, space.type, self)) continue;
        const text = clean(message.argumentText ?? message.text, MAX_TEXT);
        if (text === "" || typeof message.name !== "string" || typeof message.createTime !== "string") continue;
        found.push({
          id: message.name,
          space: space.displayName,
          type: space.type,
          from: clean(((message.sender ?? {}) as Entry).displayName, MAX_NAME),
          at: message.createTime,
          text,
        });
      }
    }
    found.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    log({ outcome: "read", spaces: spaces.length, messages: Math.min(found.length, MAX_CHAT_MESSAGES) });
    return json({ ok: true, from: room.address, messages: found.slice(0, MAX_CHAT_MESSAGES) });
  } catch {
    log({ outcome: "transport_error" });
    return json({ ok: false, refused: "unavailable" });
  }
}
