/**
 * Telling the gateway a conversation with Tex has ended, so it can score how
 * it went (the owner, 2026-10-24; `apps/mcp/src/agent/selfReview.js`,
 * docs/decisions/texting-assistant/self-review.md).
 *
 * Nobody says goodbye to an assistant they text, so a conversation has ended
 * once nobody has texted for `REVIEW_QUIET_MS`. Every answered turn starts
 * the watch over (`watchConversation`), in the chat's own object: a person's
 * phone, or a group chat's. When the alarm finds it due, the watch is dropped
 * and the gateway is asked once (`POST /agent/review`) with a token minted
 * the way a turn's is, so the review runs as that conversation's own grant
 * and reads nothing else. Whether its words may leave is the control plane's
 * call, never this Worker's.
 *
 * Kept: the phone, or a group's line, id, sender and participants, for those
 * quiet minutes only, as a turn already has them; never a word. Best effort:
 * a review that could not be asked costs a score, never a text.
 */

import { openSession, post, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import { chatBefore, peopleHash, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";

export const REVIEW_KEY = "review-watch";
/** How long a chat stays quiet before its conversation counts as ended. */
export const REVIEW_QUIET_MS = 20 * 60_000;

type GroupWatch = Pick<GroupMessage, "kind" | "eventId" | "groupId" | "line" | "from" | "participants" | "messageId">;

export type Watch =
  | { kind: "one"; phone: string; dueAt: number }
  | { kind: "group"; message: GroupWatch; people: string[]; dueAt: number };

export type ReviewDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  now: () => number;
  /** A group's token, minted as a tagged turn's is (`groupInbox.ts` `askControlPlane`). */
  mintGroup?: (message: GroupMessage, people: string[]) => Promise<{ accessToken: string; handle?: string; names: { phone: string; handle: string }[] } | null>;
};

/** After an answered turn: the conversation ends `REVIEW_QUIET_MS` from now, unless somebody texts first. */
export async function watchConversation(storage: InboxStorage, watch: { kind: "one"; phone: string } | { kind: "group"; message: GroupMessage; people: string[] }, now: number): Promise<void> {
  const dueAt = now + REVIEW_QUIET_MS;
  const kept: Watch =
    watch.kind === "one"
      ? { kind: "one", phone: watch.phone, dueAt }
      : {
          kind: "group",
          // Who and where, never what was said.
          message: {
            kind: "group-message",
            eventId: watch.message.eventId,
            groupId: watch.message.groupId,
            line: watch.message.line,
            from: watch.message.from,
            participants: watch.message.participants,
            messageId: watch.message.messageId,
          },
          people: watch.people,
          dueAt,
        };
  await storage.put<Watch>(REVIEW_KEY, kept);
  await armBy(storage, dueAt);
}

/** From the alarm: ask for the review once the chat has been quiet long enough. True when it was asked. */
export async function checkReview(storage: InboxStorage, deps: ReviewDeps): Promise<boolean> {
  const watch = await storage.get<Watch>(REVIEW_KEY);
  if (watch === undefined) return false;
  const now = deps.now();
  if (now < watch.dueAt) {
    await armBy(storage, watch.dueAt);
    return false;
  }
  // Dropped first: one review per quiet spell, whatever happens next.
  await storage.delete(REVIEW_KEY);
  try {
    if (watch.kind === "one") {
      const session = await openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, watch.phone);
      if (session.status !== "linked") return logReview("unlinked");
      return await ask(deps, session.accessToken, { conversation: "texts" });
    }
    if (deps.mintGroup === undefined) return logReview("no_group");
    const message = { ...watch.message, text: "" } as GroupMessage;
    const minted = await deps.mintGroup(message, watch.people);
    if (minted === null) return logReview("not_ready");
    // What the chat said after Tex's last answer is part of how it ended ("sharrap", a sigh); read, never dropped.
    const said = await chatBefore(storage, message, now, now);
    const handles = new Map(minted.names.map(({ phone, handle }) => [phone, handle]));
    const group = {
      key: await sha256Hex(`${message.line}:${message.groupId}`),
      members: await peopleHash(message.line, watch.people),
      ...(minted.handle ? { from: minted.handle } : {}),
      people: [...new Set(handles.values())].filter(Boolean),
      chat: said.lines.filter((line) => line.text).map((line) => ({ from: handles.get(line.from) ?? "", text: line.text })),
    };
    return await ask(deps, minted.accessToken, { group });
  } catch (error) {
    return logReview(error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error");
  }
}

async function ask(deps: ReviewDeps, accessToken: string, body: Record<string, unknown>): Promise<boolean> {
  const { status } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/review`, accessToken, body);
  logReview(status === 200 ? "asked" : `gateway:${status}`);
  return status === 200;
}

/** One line per outcome, never a phone or a word. */
function logReview(outcome: string): false {
  console.log(JSON.stringify({ event: "review_watch", outcome }));
  return false;
}

/** Set the alarm for `at` unless one is already due sooner. */
async function armBy(storage: InboxStorage, at: number): Promise<void> {
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if (current === null || current === undefined || current > at) await storage.setAlarm(at);
}
