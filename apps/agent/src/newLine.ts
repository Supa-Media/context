/**
 * Telling everyone still on Tex's old Linq line that Tex has a new number
 * (Dev2, 2026-10-18: "send a message to all the active old lines … my number
 * is moved to XYZ. Text me there instead").
 *
 *     Run by hand (`.github/workflows/tell-texters-new-number.yml`)
 *       │
 *       ├─▶ control plane: every phone Tex may know (/agent-texts/phones)
 *       └─▶ SenderInbox for each phone: one text, in the old chat that
 *             phone itself started, and only once
 *
 * Tex never texts anyone first: a phone with no remembered chat, or whose
 * last chat is already on the new line, is not texted. A dry run counts who
 * would be told and texts nobody. Logs carry counts, never a phone.
 */

import { post, record, ServiceError, type Fetch } from "./clients";
import { CHAT_KEY, NEW_LINE_TOLD_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import { lineFor, lineSeam, type LineDeps } from "./line";
import { isSendblueChat } from "./sendblue";
import { sendRecorded } from "./texSends";
import { archiveSentence, formatNumber } from "../../../packages/shared/src/texNumber.cjs";

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_PHONES = 5_000;
const CONCURRENCY = 5;

/** The number and archive-day wording, shared with the gateway's old-number node (`packages/shared/src/texNumber.cjs`). */
export { archiveSentence, formatNumber };

export function newNumberText(number: string, archiveOn?: string | null): string {
  return `Tex here. I have a new number: ${formatNumber(number)}. Text me there from now on; this number is going away. Same Tex, same notes.${archiveSentence(archiveOn)}`;
}

/** What one phone came to. */
export type Told = "told" | "would" | "already" | "on_new_line" | "no_chat" | "failed";

export type NewLineDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  /** Tell one phone, through that phone's own inbox. */
  tellPhone: (phone: string, body: { text: string; dryRun: boolean }) => Promise<Told>;
};

/** Every phone, a few at a time; returns how many came to each outcome. */
export async function tellEveryone(
  deps: NewLineDeps,
  opts: { number: string; dryRun: boolean; archiveOn?: string | null },
): Promise<Record<Told, number> & { phones: number }> {
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/phones`, deps.workerSecret, {});
  const listed = record(json).phones;
  if (status !== 200 || !Array.isArray(listed)) throw new ServiceError("control_plane", status);
  const phones = [...new Set(listed.filter((phone): phone is string => typeof phone === "string" && E164.test(phone)))].slice(0, MAX_PHONES);

  const counts: Record<Told, number> = { told: 0, would: 0, already: 0, on_new_line: 0, no_chat: 0, failed: 0 };
  const text = newNumberText(opts.number, opts.archiveOn);
  let next = 0;
  const worker = async () => {
    while (next < phones.length) {
      const phone = phones[next++];
      let outcome: Told;
      try {
        outcome = await deps.tellPhone(phone, { text, dryRun: opts.dryRun });
      } catch {
        outcome = "failed";
      }
      counts[outcome]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, phones.length) }, worker));
  return { phones: phones.length, ...counts };
}

// ── The Durable Object's side ─────────────────────────────────────────────

/** Text this sender the new number, in the old-line chat they started, once. */
export async function tellNewLine(
  storage: InboxStorage,
  body: { text: string; dryRun: boolean },
  deps: LineDeps & { now: () => number },
): Promise<Told> {
  if ((await storage.get<number>(NEW_LINE_TOLD_KEY)) !== undefined) return "already";
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (!chat || typeof chat.chatId !== "string" || chat.chatId === "" || chat.channel === "simulator") return "no_chat";
  if (isSendblueChat(chat.chatId)) return "on_new_line";
  if (body.dryRun) return "would";
  try {
    await sendRecorded(storage, lineFor(lineSeam(deps), chat.chatId), { chatId: chat.chatId, text: body.text, key: `new-line:${chat.chatId}` }, { source: "new_line", now: deps.now });
  } catch {
    return "failed";
  }
  await storage.put(NEW_LINE_TOLD_KEY, deps.now());
  return "told";
}

// ── The Worker's door ─────────────────────────────────────────────────────

/** `Authorization: Bearer <AGENT_WORKER_SECRET>`, compared in constant time; an unset or short secret opens nothing. */
export async function bearerMatches(secret: string | undefined, header: string | null): Promise<boolean> {
  const expected = (secret ?? "").trim();
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1]?.trim();
  if (expected.length < 16 || !given) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(expected), digest(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** `{ number, send, archiveOn? }` from the request; `send` must be exactly true to text anyone; a day that is not one is dropped. */
export function parseTellRequest(body: unknown): { number: string; dryRun: boolean; archiveOn: string | null } | null {
  const fields = record(body);
  if (typeof fields.number !== "string" || !E164.test(fields.number)) return null;
  const archiveOn = typeof fields.archiveOn === "string" && archiveSentence(fields.archiveOn) !== "" ? fields.archiveOn : null;
  return { number: fields.number, dryRun: fields.send !== true, archiveOn };
}
