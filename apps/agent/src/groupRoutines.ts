/**
 * A shared workspace's chat routine, the texting Worker's half (decided by the
 * owner, 2026-10-27; `docs/decisions/texting-assistant/chat-routines.md`).
 *
 *     Cron: the control plane hands out a due chat routine, naming its
 *     chat by key and its writer's phone
 *       │
 *       ├─▶ `group-key:<key>` object: which line and group that chat is
 *       │   (kept there by the chat's own object the first time it heard
 *       │   from it; the control plane keeps only the key)
 *       └─▶ the chat's own queue: one turn, as if its writer had tagged Tex
 *           with "it's time for this routine", re-checked like any tag
 *           (who is in the chat now, the workspace it is bound to), and
 *           answered into the chat, never into a phone. Its outcome is
 *           reported from there.
 *
 * Nothing here keeps the answer or the routine's words.
 */

import type { GroupMessage } from "./sendblueGroups";

/** The object that knows where a chat is, named by its key alone. */
export function chatDirectoryName(groupKey: string): string {
  return `group-key:${groupKey}`;
}

/** Set in a chat's own object once it has told the directory where it is. */
export const WHERE_KEPT_KEY = "gwhere";

/** In a chat's directory entry: where it is. */
export const CHAT_WHERE_KEY = "chatwhere";

/** Where a chat is: Tex's line and Sendblue's group. */
export type ChatWhere = { line: string; groupId: string };

const E164 = /^\+[1-9]\d{6,14}$/;

export function chatWhereOf(value: unknown): ChatWhere | null {
  const where = value as Partial<ChatWhere> | null;
  if (where === null || typeof where !== "object") return null;
  if (typeof where.line !== "string" || !E164.test(where.line)) return null;
  if (typeof where.groupId !== "string" || where.groupId === "" || where.groupId.length > 200) return null;
  return { line: where.line, groupId: where.groupId };
}

/** A due chat routine handed to its chat's queue. */
export type ChatRoutineRun = ChatWhere & { runId: string; path: string; phone: string };

export function chatRoutineRunOf(value: unknown): ChatRoutineRun | null {
  const run = value as Partial<ChatRoutineRun> | null;
  const where = chatWhereOf(value);
  if (where === null || run === null) return null;
  if (typeof run.runId !== "string" || !/^run_[A-Za-z0-9_-]{1,64}$/.test(run.runId)) return null;
  if (typeof run.path !== "string" || run.path === "" || run.path.length > 512) return null;
  if (typeof run.phone !== "string" || !E164.test(run.phone)) return null;
  return { ...where, runId: run.runId, path: run.path, phone: run.phone };
}

/** What a chat routine's turn is asked: its writer's tag, in words only this Worker writes. */
export function chatRoutineQuestion(path: string): string {
  return (
    `(It's time for this chat's routine, ${path}. Read that note and do what it says now, for everyone here, ` +
    "as if it had just been asked. If it only wants a word when there is something to say and there isn't, answer exactly SKIP.)"
  );
}

/** The message a run is queued as: from its writer, threaded under nothing, with no picture. */
export function chatRoutineMessage(run: ChatRoutineRun): GroupMessage {
  return {
    kind: "group-message",
    eventId: `routine:${run.runId}`,
    groupId: run.groupId,
    line: run.line,
    from: run.phone,
    participants: [],
    messageId: "",
    text: chatRoutineQuestion(run.path),
    routine: { runId: run.runId, path: run.path },
  };
}

/** An answer that means "nothing to say": SKIP on its own. */
export function saysSkip(text: string): boolean {
  return /^\W*skip\W*$/i.test(text.trim());
}
