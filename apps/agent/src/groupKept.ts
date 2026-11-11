/**
 * The chat's last "ready" answer, kept so the next tag from the same person, with the same people in the chat, skips
 * the control plane (`docs/decisions/texting-assistant/texting-in-objects.md`, "Group chats too"; the owner,
 * 2026-11-04: "please make sure you speed up both group chats and 1:1 texts").
 *
 * What makes reuse safe: the token is checked again by the gateway on every call (the grant must still be live and
 * its chat must still share what it reads), so a kept answer never reaches more than a fresh one would. What it can
 * get wrong is a name, a guest label or the style for one message: the control plane is asked again behind the turn
 * (without minting), its answer replaces the kept one, and any answer but "ready" drops it, so the next tag asks first.
 * Only a plain tag reuses: a command or a routine always asks, as does another sender, a
 * change of who is in the chat, or a token past `REUSE_MS` (it lives `TEXTS_GROUP_GRANT_TTL_MS`, 15 minutes, and a
 * turn may run a few of them).
 */

import type { InboxStorage } from "./inbox";
import type { ControlAnswer } from "./groupControl";
import { peopleHash } from "./groupChat";

export const KEPT_KEY = "gready";
/** How long a kept token is handed to a new turn. Its grant lives fifteen minutes. */
export const REUSE_MS = 8 * 60_000;

type Ready = Extract<ControlAnswer, { status: "ready" }>;
type Kept = { sender: string; people: string; at: number; answer: Ready };

/** The kept answer for this sender and these people, while its token is young enough; null otherwise. */
export async function keptAnswer(storage: InboxStorage, line: string, sender: string, people: readonly string[], now: number): Promise<Ready | null> {
  const kept = await storage.get<Kept>(KEPT_KEY);
  if (kept === undefined || kept.sender !== sender || now - kept.at < 0 || now - kept.at >= REUSE_MS) return null;
  if (kept.people !== (await peopleHash(line, people))) return null;
  if (kept.answer.accessToken === undefined) return null;
  // The introduction is one-shot and was given with the answer that minted this token.
  return { ...kept.answer, intro: false };
}

/** Keep a freshly minted answer for the next tag. Anything without a token is not kept. */
export async function keepAnswer(storage: InboxStorage, line: string, sender: string, people: readonly string[], answer: ControlAnswer, now: number): Promise<void> {
  if (answer.status !== "ready" || answer.accessToken === undefined) return void (await storage.delete(KEPT_KEY));
  await storage.put<Kept>(KEPT_KEY, { sender, people: await peopleHash(line, people), at: now, answer: { ...answer, intro: false } });
}

/**
 * The control plane's answer to a reused turn, asked behind it: a "ready" one refreshes what is kept (the token and
 * its age stay), anything else drops it.
 */
export async function refreshKept(storage: InboxStorage, answer: ControlAnswer | null): Promise<void> {
  const kept = await storage.get<Kept>(KEPT_KEY);
  if (kept === undefined) return;
  if (answer === null || answer.status !== "ready") return void (await storage.delete(KEPT_KEY));
  await storage.put<Kept>(KEPT_KEY, { ...kept, answer: { ...answer, accessToken: kept.answer.accessToken, intro: false } });
}

/** Forget the kept answer: a command or anything else that changes the chat. */
export async function dropKept(storage: InboxStorage): Promise<void> {
  await storage.delete(KEPT_KEY);
}
