/**
 * What Gmail itself holds as attached, read back after an email with files
 * was sent or saved as a draft (a review of a chat, 2026-10-27: Tex said a
 * draft had "the screenshot attached" when it had the wrong one, then an
 * empty file). The gateway tells the AI each file by name and size as Gmail
 * shows it, so "attached" is said from Gmail's answer, never from the call
 * having gone out.
 *
 * Best effort: a read that fails answers null, and the caller says the email
 * went with nothing confirmed rather than refusing one Gmail already took.
 */

import { timeoutFetch } from "./filesFns/forwardSyncSupport";

const GMAIL_MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages/";
const GMAIL_DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts/";
const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** Deep enough for mixed > alternative > related; a message nested further is not one this sent. */
const MAX_DEPTH = 6;

export type AttachedFile = { filename: string; size: number };

type Part = { filename?: unknown; body?: { size?: unknown; attachmentId?: unknown }; parts?: unknown };

/** Every part of a Gmail `format=full` payload that carries a file name, with the size Gmail counts. */
export function attachedParts(payload: unknown, depth = 0): AttachedFile[] {
  if (!payload || typeof payload !== "object" || depth > MAX_DEPTH) return [];
  const part = payload as Part;
  const own: AttachedFile[] =
    typeof part.filename === "string" && part.filename !== ""
      ? [{ filename: part.filename.slice(0, 200), size: typeof part.body?.size === "number" && part.body.size >= 0 ? part.body.size : 0 }]
      : [];
  const children = Array.isArray(part.parts) ? part.parts.flatMap((child) => attachedParts(child, depth + 1)) : [];
  return [...own, ...children];
}

/**
 * The files Gmail holds on what it just took: `created` is Gmail's answer to
 * the send (a message) or the draft (a draft wrapping one).
 */
export async function attachedInGmail(accessToken: string, created: unknown, draft: boolean): Promise<AttachedFile[] | null> {
  const answer = (created ?? {}) as { id?: unknown };
  const id = typeof answer.id === "string" && GMAIL_ID.test(answer.id) ? answer.id : null;
  if (id === null) return null;
  try {
    const response = await timeoutFetch(`${draft ? GMAIL_DRAFTS : GMAIL_MESSAGES}${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const read = (await response.json()) as { payload?: unknown; message?: { payload?: unknown } };
    const payload = draft ? read.message?.payload : read.payload;
    return payload ? attachedParts(payload) : null;
  } catch {
    return null;
  }
}
