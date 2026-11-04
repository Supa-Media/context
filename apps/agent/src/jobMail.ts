/**
 * Note mail handed to a running background job the moment it is sent (owner,
 * 2026-11-04: "agents Tex started message each other instantly";
 * `docs/decisions/note-mail.md`).
 *
 * The gateway writes the line into the note first, then finds the mailboxes
 * on that note joined from a job's turn and calls `TexRoutines.mailDeliver`
 * (`texRoutineDue.ts`) once per recipient (`apps/mcp/src/mail/deliver.js`).
 * That reaches this job's own object (`job:<id>`), which keeps the line with
 * the person's later texts (`STEERS_KEY`) and sends it into the part running
 * now through `/agent/steer` with a `mail` marker, so the part takes it in
 * after its next tool call, shown as another agent's words that vouch for
 * nothing (`apps/mcp/src/agent/steer.js` `mailLine`). One the part never took
 * is shown to the next part.
 *
 * An interrupt (the gateway lets only Tex's own turn send one) is the same
 * line, marked: the part is told to drop the step it is on. A machine part
 * hands it to the runner as protocol `interrupt` instead (01's seam).
 *
 * Nothing here is the person's words: a mail line never becomes a follow-up
 * text, and never counts as their yes to anything.
 */

import type { InboxStorage } from "./inbox";
import type { JobMail, JobSteer } from "./jobs";

const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAILBOX = /^mb_[a-z0-9]{8,32}$/;
const NAME = /^(?:[a-z0-9][a-z0-9-]{0,23}|@[a-z0-9][a-z0-9-]{0,63})$/;
const KINDS = new Set(["note", "ask", "interrupt"]);
/** A mail line's text, as long as the gateway keeps one. */
export const MAX_MAIL_TEXT = 4_000;

/** One line delivered to one job, as `TexRoutines.mailDeliver` takes it. */
export type MailDelivery = { jobId: string; mailboxId: string; to: string; mail: JobMail & { at: string; text: string } };

/** A delivery read strictly; null for anything else. */
export function readMailDelivery(value: unknown): MailDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { jobId, mailboxId, to, mail } = value as Record<string, unknown>;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId) || typeof mailboxId !== "string" || !MAILBOX.test(mailboxId)) return null;
  if (typeof to !== "string" || !NAME.test(to) || !mail || typeof mail !== "object" || Array.isArray(mail)) return null;
  const { path, at, from, app, kind, text } = mail as Record<string, unknown>;
  if (typeof path !== "string" || path === "" || path.length > 1024 || /[\u0000-\u001f]/.test(path)) return null;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || typeof from !== "string" || !NAME.test(from)) return null;
  if (typeof kind !== "string" || !KINDS.has(kind) || typeof text !== "string" || text.trim() === "") return null;
  const cleanApp = typeof app === "string" ? app.replace(/[\u0000-\u001f()]/g, " ").trim().slice(0, 40) : "";
  return {
    jobId,
    mailboxId,
    to,
    mail: { path, at, from, kind: kind as JobMail["kind"], text: text.trim().slice(0, MAX_MAIL_TEXT), ...(cleanApp ? { app: cleanApp } : {}) },
  };
}

/** The steer a delivered line becomes: its id names the line, so one delivered twice is kept once. */
export function mailSteer(delivery: MailDelivery): JobSteer {
  const { at, from, kind, path, app, text } = delivery.mail;
  const id = `mail:${Date.parse(at)}:${from.replace(/^@/, "")}`.slice(0, 128);
  return { id, text, mail: { from, kind, path, ...(app ? { app } : {}) } };
}

/**
 * `POST /job-mail` in the job's object: keep the line and send it into the
 * running part. False once the job has ended (the line stays in the note).
 */
export async function mailJob(storage: InboxStorage, delivery: MailDelivery, steer: (storage: InboxStorage, steer: JobSteer) => Promise<boolean>): Promise<boolean> {
  return await steer(storage, mailSteer(delivery));
}

/** `POST /job-mail` in the job's object: the body read strictly (400 when it is not a delivery), then `mailJob`'s answer as `{taken}`. */
export async function jobMailResponse(storage: InboxStorage, body: unknown, steer: (storage: InboxStorage, steer: JobSteer) => Promise<boolean>): Promise<Response> {
  const delivery = readMailDelivery(body);
  if (delivery === null) return new Response(null, { status: 400 });
  return Response.json({ taken: await mailJob(storage, delivery, steer) });
}
