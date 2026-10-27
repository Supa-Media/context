/**
 * Telling somebody new that their Gmail connected (Dev2, 2026-10-20: go
 * straight to Gmail, the first one a personal Gmail used as their main email,
 * then ask about more).
 *
 * The "notes are ready" text (`ready.ts`) asks them to connect their personal
 * Gmail. Once it has gone, the sender's inbox watches for that Gmail
 * (`GMAIL_KEY`): its alarm asks the control plane until one is connected,
 * then texts the chat they set up from, so nobody has to come back and say
 * "done". The text says which address is now their main email and asks about
 * other Gmails; their answer is the next turn, which the onboarding skill
 * picks up.
 *
 * No model writes this text. Kept: the phone (this object is already named
 * after it), the chat id and times, never the address. Given up silently
 * after a day, the life of the link that was texted.
 */

import { post, record as asRecord, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import { lineFor, type LineDeps } from "./line";
import { record } from "./simulator";
import { noteTold } from "./told";

export const GMAIL_KEY = "gmail";
/** Opening the link, signing in to Google and coming back takes a minute at least. */
export const GMAIL_FIRST_MS = 60_000;
/** Looks this often while they are most likely still on the page… */
export const GMAIL_SOON_MS = 30_000;
export const GMAIL_SOON_FOR_MS = 30 * 60_000;
/** …then this often, until the link they were texted has expired. */
export const GMAIL_LATER_MS = 5 * 60_000;
export const GMAIL_GIVE_UP_MS = 24 * 60 * 60_000;

export const GMAIL_COPY = {
  main: (address: string) =>
    `Got it, ${address} is your main email now. I'm reading your mail to get to know you. Do you have any other Gmails, like for work or a side project? I can read those too.`,
  connected: (address: string) =>
    `Got it, I can read ${address} now. I'm reading your mail to get to know you. Do you have any other Gmails, like for work or a side project? I can read those too.`,
};

type Owed = { phone: string; chatId: string; channel?: "simulator"; since: number; nextAt: number };

export type GmailWatchDeps = LineDeps & {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  now: () => number;
};

/** Called once the ready text went: watch for the Gmail it asked for. */
export async function watchForGmail(
  storage: InboxStorage,
  owed: { phone: string; chatId: string; channel?: "simulator" },
  now: number,
): Promise<void> {
  const nextAt = now + GMAIL_FIRST_MS;
  await storage.put<Owed>(GMAIL_KEY, { ...owed, since: now, nextAt });
  await armBy(storage, nextAt);
}

/** From the alarm: look once if a look is due, text when a Gmail connected, and keep the alarm for the next. */
export async function checkGmail(storage: InboxStorage, deps: GmailWatchDeps): Promise<void> {
  const owed = await storage.get<Owed>(GMAIL_KEY);
  if (owed === undefined) return;
  const now = deps.now();
  if (now < owed.nextAt) {
    await armBy(storage, owed.nextAt);
    return;
  }
  if (now - owed.since >= GMAIL_GIVE_UP_MS) {
    await storage.delete(GMAIL_KEY);
    return;
  }
  let answer: GmailAnswer = { status: "waiting" };
  try {
    answer = await fetchGmail(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, owed.phone);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  if (answer.status === "gone") {
    await storage.delete(GMAIL_KEY);
    return;
  }
  if (answer.status === "waiting") {
    await lookAgain(storage, owed, now);
    return;
  }
  const text = answer.main ? GMAIL_COPY.main(answer.address) : GMAIL_COPY.connected(answer.address);
  try {
    if (owed.channel === "simulator") await record(storage, "in", text, now);
    else await lineFor(deps, owed.chatId).sendText(owed.chatId, text, `gmail:${owed.since}`);
  } catch {
    // The line refused or was unreachable: the idempotency key keeps a retry single.
    await lookAgain(storage, owed, now);
    return;
  }
  // The next turn's history is owed this text, by name (`told.ts`).
  await noteTold(storage, answer.main ? "gmail_main" : "gmail", owed.chatId, now);
  await storage.delete(GMAIL_KEY);
}

async function lookAgain(storage: InboxStorage, owed: Owed, now: number): Promise<void> {
  const nextAt = now + (now - owed.since < GMAIL_SOON_FOR_MS ? GMAIL_SOON_MS : GMAIL_LATER_MS);
  await storage.put<Owed>(GMAIL_KEY, { ...owed, nextAt });
  await armBy(storage, nextAt);
}

type GmailAnswer = { status: "connected"; address: string; main: boolean } | { status: "waiting" } | { status: "gone" };

const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** `POST /agent-texts/gmail`. Only something shaped like one address is ever texted. */
export async function fetchGmail(fetcher: Fetch, origin: string, secret: string, phone: string): Promise<GmailAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/gmail`, secret, { phone });
  if (status === 404) return { status: "waiting" };
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = asRecord(json);
  if (body.status === "connected" && typeof body.address === "string" && ADDRESS.test(body.address)) {
    return { status: "connected", address: body.address, main: body.main === true };
  }
  return body.status === "gone" ? { status: "gone" } : { status: "waiting" };
}

/** Set the alarm for `at` unless one is already due sooner. */
async function armBy(storage: InboxStorage, at: number): Promise<void> {
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if (current === null || current === undefined || current > at) await storage.setAlarm(at);
}
