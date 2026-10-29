/**
 * One Google Chat conversation the person named, read live from their own
 * account for their own AI: the newest messages of one space by its
 * `spaces/…` id, or of the direct message with one person by their email.
 * Reached as `POST /gateway/chat/recent` with `space` or `to` in the body
 * (`googleChatRead.ts`), beside the check-ins' look at what was written to
 * them.
 *
 * Body `{ accessToken, expectedWorkspaceId, space? , to?, limit? }`, exactly
 * one of `space` and `to`. Answers `{ ok: true, from, place, messages }`,
 * oldest first, each `{ id, from, mine, at, text }`, or `{ ok: false,
 * refused }`.
 *
 * Bounded on purpose. Only the one conversation named: never every space,
 * never one found by a display name somebody else chose, never a direct
 * message started to find one. At most `MAX_SPACE_MESSAGES` messages, the
 * newest, in one page. Decided here and in `claimChatSpaceRead`: the
 * personal workspace's owner, with private access, through a connection
 * whose AI grant reads Chat. Google answers only for a space the person is a
 * member of. Nothing of a message is stored or logged; only statuses are.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";
import { SPACE_NAME, chatFailure } from "../googleChatSend";
import { learnSelf } from "./googleChatRead";

const CHAT_API = "https://chat.googleapis.com/v1";
export const MAX_SPACE_MESSAGES = 50;
const DEFAULT_SPACE_MESSAGES = 20;
const MAX_TEXT = 2_000;
const MAX_NAME = 80;
const ADDRESS = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;

type Entry = Record<string, unknown>;

export interface SpaceChatMessage {
  id: string;
  from: string;
  mine: boolean;
  at: string;
  text: string;
}

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "google_chat_space_read", ...fields }));
}

async function chatGet(accessToken: string, path: string) {
  const response = await timeoutFetch(`${CHAT_API}/${path}`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body: body as Entry | null };
}

function clean(value: unknown, most: number): string {
  // Lines kept: a message's own line breaks are part of what it says.
  const text = typeof value === "string" ? value.replace(CONTROL, " ").replace(/[ \t]+/g, " ").trim() : "";
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

/** What the body names: `{ space }` or `{ to }`, and how many, or null when it is not one conversation. */
export function conversationOf(body: Entry): { space: string; to: null; limit: number } | { space: null; to: string; limit: number } | null {
  const space = typeof body.space === "string" ? body.space.trim() : null;
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : null;
  if ((space === null) === (to === null)) return null;
  if (space !== null && !SPACE_NAME.test(space)) return null;
  if (to !== null && (to.length > 254 || !ADDRESS.test(to))) return null;
  const asked = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : DEFAULT_SPACE_MESSAGES;
  const limit = Math.min(Math.max(asked, 1), MAX_SPACE_MESSAGES);
  return space !== null ? { space, to: null, limit } : { space: null, to: to!, limit };
}

/** One message as the AI reads it, or null for one with nothing to read. */
export function shownMessage(message: Entry, self: ReturnType<typeof learnSelf>): SpaceChatMessage | null {
  const text = clean(message.argumentText ?? message.text, MAX_TEXT);
  if (text === "" || typeof message.name !== "string" || typeof message.createTime !== "string") return null;
  const sender = (message.sender ?? {}) as Entry;
  const email = typeof sender.email === "string" ? sender.email.trim().toLowerCase() : "";
  const mine = (email !== "" && email === self.address) || (self.name !== null && sender.name === self.name);
  const name = clean(sender.displayName, MAX_NAME);
  return { id: message.name, from: mine ? "you" : name || (sender.type === "BOT" ? "an app" : "someone"), mine, at: message.createTime, text };
}

export async function gatewayChatSpaceReadHandler(ctx: ActionCtx, body: Entry): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  const wanted = conversationOf(body);
  if (wanted === null) return json({ ok: false, refused: "invalid" });

  const room = await ctx.runMutation(internal.functions.googleChatSend.claimChatSpaceRead, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  if (!room.ok) {
    log({ outcome: "refused", reason: room.refused });
    return json({ ok: false, refused: room.refused });
  }
  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { role: "agent" as const, connectionId: room.connectionId });
  if (minted === null) return json({ ok: false, refused: "reconnect_required" });
  try {
    let space: string;
    let place: { space: string } | { person: string };
    if (wanted.to !== null) {
      // Found, never started: reading a conversation must not create one.
      const found = await chatGet(minted.accessToken, `spaces:findDirectMessage?name=${encodeURIComponent(`users/${wanted.to}`)}`);
      if (!found.ok || typeof found.body?.name !== "string" || !SPACE_NAME.test(found.body.name)) {
        const why = chatFailure(found.status, found.body);
        log({ outcome: "refused", reason: "no_direct_message", status: found.status });
        return json({ ok: false, refused: found.status === 404 && why === "unavailable" ? "person_not_found" : why });
      }
      space = found.body.name;
      place = { person: wanted.to };
    } else {
      const found = await chatGet(minted.accessToken, wanted.space);
      if (!found.ok || typeof found.body?.name !== "string") {
        const why = chatFailure(found.status, found.body);
        log({ outcome: "refused", reason: "space", status: found.status });
        return json({ ok: false, refused: (found.status === 404 || found.status === 403) && why === "unavailable" ? "space_not_found" : why });
      }
      space = wanted.space;
      const shown = typeof found.body.displayName === "string" ? clean(found.body.displayName, MAX_NAME) : "";
      place = { space: shown || (found.body.spaceType === "DIRECT_MESSAGE" ? "a direct message" : wanted.space) };
    }
    const query = new URLSearchParams({ pageSize: String(wanted.limit), orderBy: "createTime desc" });
    const answer = await chatGet(minted.accessToken, `${space}/messages?${query}`);
    if (!answer.ok) {
      log({ outcome: "http_error", stage: "messages", status: answer.status });
      return json({ ok: false, refused: chatFailure(answer.status, answer.body) });
    }
    const listed = Array.isArray(answer.body?.messages) ? (answer.body.messages as Entry[]).slice(0, wanted.limit) : [];
    const self = learnSelf(room.address, listed);
    const messages = listed
      .map((message) => shownMessage(message, self))
      .filter((message): message is SpaceChatMessage => message !== null)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    log({ outcome: "read", messages: messages.length, by: wanted.to !== null ? "person" : "space" });
    return json({ ok: true, from: room.address, place, messages });
  } catch {
    log({ outcome: "transport_error" });
    return json({ ok: false, refused: "unavailable" });
  }
}
