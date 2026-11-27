/**
 * A one-off notice from staff to every person with a 1:1 chat with Tex (Dev2, 2026-11-26: a Thanksgiving text to
 * every Tex user). The words are staff's own, handed in with the request; no wording lives here.
 *
 *     Run by hand (`.github/workflows/tell-texters-notice.yml`)
 *       │
 *       ├─▶ control plane: every phone Tex may know (/agent-texts/phones)
 *       └─▶ the chat for each phone: one text, in the 1:1 chat that phone itself started, once per notice key
 *
 * Only a phone whose own 1:1 chat is on one of the lines the request names is texted; group chats are never reached
 * (they live in their own objects). A dry run counts who would be told, by line, and texts nobody. Logs carry counts,
 * never a phone.
 */

import { post, record, ServiceError, type Fetch } from "./clients";
import { CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import { lineFor, lineSeam, type LineDeps } from "./line";
import { namesAppChat } from "./appChat";
import { isPhotonChatId } from "./photonLine";
import { isSendblueChat } from "./sendblue";
import { isWhapiChat } from "./whapi";
import { sendRecorded } from "./texSends";

const E164 = /^\+[1-9]\d{6,14}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PHONES = 5_000;
const MAX_TEXT = 1_000;
const CONCURRENCY = 5;

export const NOTICE_LINES = ["photon", "sendblue", "whapi", "linq"] as const;
export type NoticeLine = (typeof NOTICE_LINES)[number];

/** What one phone came to. */
export type Noticed = "told" | "would" | "already" | "other_line" | "no_chat" | "failed";

export type NoticeRequest = { text: string; key: string; lines: NoticeLine[]; dryRun: boolean };

/** `{ text, key, lines, send }`; `send` must be exactly true to text anyone. */
export function parseNoticeRequest(body: unknown): NoticeRequest | null {
  const fields = record(body);
  const text = typeof fields.text === "string" ? fields.text.trim() : "";
  if (text === "" || text.length > MAX_TEXT) return null;
  if (typeof fields.key !== "string" || !KEY.test(fields.key)) return null;
  if (!Array.isArray(fields.lines) || fields.lines.length === 0) return null;
  const lines = [...new Set(fields.lines)];
  if (!lines.every((line): line is NoticeLine => (NOTICE_LINES as readonly unknown[]).includes(line))) return null;
  return { text, key: fields.key, lines, dryRun: fields.send !== true };
}

/** The line a 1:1 chat id is on. */
export function lineOfChat(chatId: string): NoticeLine {
  if (isPhotonChatId(chatId)) return "photon";
  if (isWhapiChat(chatId)) return "whapi";
  if (isSendblueChat(chatId)) return "sendblue";
  return "linq";
}

export const noticeToldKey = (key: string) => `notice-told:${key}`;

export type NoticeDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  /** Tell one phone, through that phone's own inbox. */
  tellPhone: (phone: string, body: NoticeRequest) => Promise<{ told: Noticed; line?: NoticeLine }>;
};

export type NoticeCounts = Record<Noticed, number> & { phones: number; byLine: Record<NoticeLine, number> };

/** Every phone, a few at a time; how many came to each outcome, and how many chats are on each line. */
export async function noticeEveryone(deps: NoticeDeps, asked: NoticeRequest): Promise<NoticeCounts> {
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/phones`, deps.workerSecret, {});
  const listed = record(json).phones;
  if (status !== 200 || !Array.isArray(listed)) throw new ServiceError("control_plane", status);
  const phones = [...new Set(listed.filter((phone): phone is string => typeof phone === "string" && E164.test(phone)))].slice(0, MAX_PHONES);

  const counts: Record<Noticed, number> = { told: 0, would: 0, already: 0, other_line: 0, no_chat: 0, failed: 0 };
  const byLine: Record<NoticeLine, number> = { photon: 0, sendblue: 0, whapi: 0, linq: 0 };
  let next = 0;
  const worker = async () => {
    while (next < phones.length) {
      const phone = phones[next++];
      let outcome: { told: Noticed; line?: NoticeLine };
      try {
        outcome = await deps.tellPhone(phone, asked);
      } catch {
        outcome = { told: "failed" };
      }
      counts[outcome.told]++;
      if (outcome.line !== undefined) byLine[outcome.line]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, phones.length) }, worker));
  return { phones: phones.length, ...counts, byLine };
}

// ── The Durable Object's side ─────────────────────────────────────────────

/** Text this sender the notice, in the 1:1 chat they started, once per key. */
export async function tellNotice(
  storage: InboxStorage,
  body: NoticeRequest,
  deps: LineDeps & { now: () => number },
): Promise<{ told: Noticed; line?: NoticeLine }> {
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (!chat || typeof chat.chatId !== "string" || chat.chatId === "" || chat.channel === "simulator" || namesAppChat(chat.chatId)) return { told: "no_chat" };
  const line = lineOfChat(chat.chatId);
  if ((await storage.get<number>(noticeToldKey(body.key))) !== undefined) return { told: "already", line };
  if (!body.lines.includes(line)) return { told: "other_line", line };
  if (body.dryRun) return { told: "would", line };
  try {
    await sendRecorded(storage, lineFor(lineSeam(deps), chat.chatId), { chatId: chat.chatId, text: body.text, key: `notice:${body.key}:${chat.chatId}` }, { source: "notice", now: deps.now });
  } catch {
    return { told: "failed", line };
  }
  await storage.put(noticeToldKey(body.key), deps.now());
  return { told: "told", line };
}
