/**
 * The session a person's background job runs as, by who asked: an in-app chat
 * (`appChat.ts`) by its user id (`/agent-texts/app-session`), a phone by its
 * number (`/agent-texts/session`).
 *
 * A job keeps who asked as its origin's `phone` (`jobs.ts` `JobOrigin`), which
 * for an in-app chat is the chat id `app:<userId>`. Asking the control plane
 * for that "phone" found nobody, so every job started from the app ended in its
 * first pass as "unlinked", silently, having run nothing and logged nothing
 * (2026-11-21, "Daniel 6 study notes"). Every place a person's job opens its
 * session goes through here: its parts (`jobRun.ts`), its own calls beside a
 * part (`jobToken`) and a job on their computer (`machineTurn.ts`).
 *
 * Only the chat object the gateway placed for an app chat starts jobs under its
 * id (`inbox.ts` `jobsFor`), so an origin of `app:<userId>` was written by a turn
 * that already ran as that user. An `app:` id that names no user has no session.
 */

import { appUserOf, namesAppChat } from "./appChat";
import { openAppSession, openSession, type Fetch, type SessionAnswer } from "./clients";

export type PersonSessionDeps = { fetch: Fetch; controlPlaneOrigin: string; workerSecret: string };

export async function openPersonSession(deps: PersonSessionDeps, asker: string): Promise<SessionAnswer> {
  if (!namesAppChat(asker)) return openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, asker);
  const userId = appUserOf(asker);
  if (userId === null) return { status: "unlinked" };
  return openAppSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, userId);
}
