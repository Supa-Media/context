/**
 * Telling somebody set up by text that their notes are ready (Dev2,
 * 2026-10-18: "it should take a couple of minutes, I'll let you know when
 * I'm ready").
 *
 * Setup starts their bucket and says Tex will text when it is done. This is
 * that text. The sender's inbox remembers that it owes one (`READY_KEY`) and
 * its alarm asks the control plane every `READY_EVERY_MS` until the notes are
 * ready, then texts the chat they set up from: a fixed line and a link that
 * signs them in and opens Google's connect card (`textSignIn.ts` in Convex).
 *
 * No model writes this text or sees the link, and nothing else is kept: the
 * phone (this object is already named after it), the chat id, and times.
 * Tex only texts people who texted it first, on the line they texted, and they did.
 */

import { post, record as asRecord, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import { lineFor, type LineDeps } from "./line";
import { record } from "./simulator";
import { noteTold } from "./told";

export const READY_KEY = "ready";
/** The first look, about when a new bucket usually answers. */
export const READY_FIRST_MS = 60_000;
export const READY_EVERY_MS = 30_000;
/** Past this the person is told to text in a while, and nothing more is owed. */
export const READY_GIVE_UP_MS = 20 * 60_000;

export const READY_COPY = {
  ready:
    "You're good to go! Want to connect your Google, so I can get to know you from your email? Open the link below. It signs you in and asks for an email to protect your account, then tap Connect Google. Google will say it hasn't verified Context yet. That's expected: tap Advanced, then Go to Context. Text me when it's done.",
  late: "Your notes are taking longer than usual to set up. Text me in a few minutes and we'll pick up from there.",
};

/** `sent` counts the texts already sent, so a retry repeats none on a line with no idempotency key. */
type Owed = { phone: string; chatId: string; channel?: "simulator"; since: number; nextAt: number; sent?: number };

export type ReadyDeps = LineDeps & {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  now: () => number;
};

/** Called when setup started a bucket: owe this chat the ready text. */
export async function oweReadyText(
  storage: InboxStorage,
  owed: { phone: string; chatId: string; channel?: "simulator" },
  now: number,
): Promise<void> {
  const nextAt = now + READY_FIRST_MS;
  await storage.put<Owed>(READY_KEY, { ...owed, since: now, nextAt });
  await armBy(storage, nextAt);
}

/** From the alarm: look once if a look is due, text when ready, and keep the alarm for the next. */
export async function checkReady(storage: InboxStorage, deps: ReadyDeps): Promise<void> {
  const owed = await storage.get<Owed>(READY_KEY);
  if (owed === undefined) return;
  const now = deps.now();
  if (now < owed.nextAt) {
    await armBy(storage, owed.nextAt);
    return;
  }
  let answer: ReadyAnswer = { status: "waiting" };
  try {
    answer = await fetchReady(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, owed.phone);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  if (answer.status === "gone") {
    await storage.delete(READY_KEY);
    return;
  }
  const late = answer.status === "waiting" && now - owed.since >= READY_GIVE_UP_MS;
  if (answer.status === "waiting" && !late) {
    const nextAt = now + READY_EVERY_MS;
    await storage.put<Owed>(READY_KEY, { ...owed, nextAt });
    await armBy(storage, nextAt);
    return;
  }
  const texts = answer.status === "ready" ? [READY_COPY.ready, answer.url] : [READY_COPY.late];
  let sent = owed.sent ?? 0;
  try {
    for (const [index, text] of texts.entries()) {
      if (index < sent) continue;
      if (owed.channel === "simulator") await record(storage, "in", text, now);
      else await lineFor(deps, owed.chatId).sendText(owed.chatId, text, `ready:${owed.since}:${index}`);
      sent = index + 1;
    }
  } catch {
    // The line refused or was unreachable: look again shortly. Each text keeps
    // its idempotency key on Linq, and `sent` skips what already went on any
    // line; a fresh link is minted next time and the unsent one simply expires.
    const nextAt = now + READY_EVERY_MS;
    await storage.put<Owed>(READY_KEY, { ...owed, nextAt, sent });
    await armBy(storage, nextAt);
    return;
  }
  // The next turn's history is owed this text, by name (`told.ts`).
  await noteTold(storage, answer.status === "ready" ? "ready" : "ready_late");
  await storage.delete(READY_KEY);
}

type ReadyAnswer = { status: "ready"; url: string } | { status: "waiting" } | { status: "gone" };

/** `POST /agent-texts/ready`. Only an https link to a path is ever texted. */
export async function fetchReady(fetcher: Fetch, origin: string, secret: string, phone: string): Promise<ReadyAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/ready`, secret, { phone });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = asRecord(json);
  if (body.status === "ready" && typeof body.url === "string" && /^https:\/\/[^\s/]+\/\S+$/.test(body.url)) {
    return { status: "ready", url: body.url };
  }
  return body.status === "gone" ? { status: "gone" } : { status: "waiting" };
}

/** Set the alarm for `at` unless one is already due sooner. */
async function armBy(storage: InboxStorage, at: number): Promise<void> {
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if (current === null || current === undefined || current > at) await storage.setAlarm(at);
}
