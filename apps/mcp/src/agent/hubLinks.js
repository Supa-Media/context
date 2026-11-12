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

/**
 * What the chat's Tex page holds, told to the turn with its address, so Tex
 * offers the page whenever someone asks about something on it (the owner,
 * 2026-11-04: "it should know what is in the hub page so if someone asks,
 * what are you working on? or do you have our conversation history, or what
 * do you know about me, or connecting a new computer, or what settings are
 * available etc, tex can offer the hub link"). Each place has its own path
 * (`apps/mobile/features/tex/page/texPlace.ts`), so the link lands on it.
 *
 * Built from `chatHubUrl`, never from the request; "" with no page to name.
 * "What are you working on" keeps its card (`[card threads]`), which already
 * carries this address (`sendTheReply.js`), so the link is not said twice.
 */
export function hubPrompt(hub, { group = false } = {}) {
  if (typeof hub !== "string" || hub === "") return "";
  const at = (view) => `${hub}/${view}`;
  const places = [
    `what you're working on and each job's steps (${at("jobs")})`,
    `what you thought and did for each text (${at("thinking")})`,
    `the whole chat history as you see it (${at("history")})`,
    group ? `what you know about the group, to fix or remove (${at("about")})` : `what you know about them, to fix or remove (${at("about")})`,
    `routines, to switch off or remove (${at("routines")})`,
    `check-ins, to change, cancel or add (${at("checkins")})`,
    `your browser, to watch or take over (${at("computer")})`,
    group
      ? `computers lent to this chat (${at("machines")}); each person connects a computer of their own on their own Tex page`
      : `their own computers, and connecting a new one (${at("connect")})`,
    group
      ? `this chat's instructions for how you talk, which you also change when someone here asks (${at("settings")})`
      : `their instructions for how you talk, which you also change when they ask, and signing out of websites (${at("settings")})`,
  ];
  return (
    `\n\n${group ? "This group's" : "Their"} Tex page is ${hub}, signed in, open only to ${group ? "the people in this chat" : "them"}. ` +
    `It shows what you keep and do for ${group ? "the group" : "them"}: ${places.join("; ")}. ` +
    "When someone asks about one of these (what you're doing, whether you have the conversation, what you know, a computer, a setting), answer in a line and give that place's link. " +
    "For what you're working on, [card threads] already carries the page: don't write the link as well. Never make up another address for it."
  );
}
