/**
 * Where Tex points someone who asks what it is working on: the Tex hub page,
 * signed in, never a bearer link (decided by the owner, 2026-11-03: "it
 * should show the hubs context.lc/tex/@user or context.lc/tex/group/<words>
 * ... instead of random thread pages").
 *
 * - A person's own chat: `<origin>/tex/@<handle>`, their own handle, read off
 *   the grant (`ownHandle`), never off the request.
 * - A group chat: `<origin>/tex/group/<words>`, the three words of the chat's
 *   home (`tex/groups/<words>`, `chatHome.js`), opened by the turn's own
 *   grant. The page opens only for a signed-in person in that chat now, so the
 *   words in a forwarded link open nothing for anyone else.
 *
 * A chat with neither (no handle, no home) gets null, and the texting Worker
 * falls back to its own short-lived view (`apps/agent/src/jobs.ts`).
 */

import { ownHandle } from "../http/texComputer.js";
import { appOriginOf } from "./noteLinks.js";

const HANDLE = /^[a-z0-9-]{2,32}$/;
const HOME = /^tex\/groups\/([a-z]+(?:-[a-z]+){1,4})$/;

/** `<origin>/tex/@<handle>`, or null without an https origin or a handle. */
export function personHubUrl(env, session) {
  const origin = appOriginOf(env);
  const handle = String(ownHandle(session) ?? "").toLowerCase();
  return origin !== null && HANDLE.test(handle) ? `${origin}/tex/@${handle}` : null;
}

/** `<origin>/tex/group/<words>` for a home folder, or null for anything else. */
export function groupHubUrl(env, folder) {
  const origin = appOriginOf(env);
  const words = typeof folder === "string" ? HOME.exec(folder.replace(/\/+$/, ""))?.[1] : undefined;
  return origin !== null && words !== undefined ? `${origin}/tex/group/${words}` : null;
}

/** The hub for this turn's chat: the group's when it is a group turn, else the person's own. */
export function chatHubUrl(env, session, group) {
  if (group !== null && group !== undefined) return groupHubUrl(env, group.home?.folder);
  return personHubUrl(env, session);
}
