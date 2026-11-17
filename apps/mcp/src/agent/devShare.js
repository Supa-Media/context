/**
 * WHETHER THIS CHAT IS SHARED WITH THE DEVELOPERS WHO BUILD TEX (Dev2, 2026-11-17).
 *
 * A group chat is listed in the Lab's "Shared with developers" when everyone here with an account has said yes or is
 * on the team, and at least one said yes (`apps/convex/functions/lib/texLabShared.ts`). No turn was told, so Tex told
 * a chat that had been shared for a day that "Dev2 can't see this chat", and then made up who could say yes. The
 * control plane now names the state on every group turn (`devShareOf` there), the Worker passes it on as handles only
 * (`apps/agent/src/groupControl.ts`), and the front door is told it when its `ctx` reads the `devShare` module.
 *
 * It names who said yes and who hasn't, never a rule: what keeps a chat out is what the control plane counted.
 */

import { texConfigOf, texStep } from "./texConfig.js";

/** The module in the front door's `ctx` that turns this on. */
export const DEV_SHARE_MODULE = "devShare";

const HANDLE = /^[a-z0-9][a-z0-9-]{0,64}$/;
const MAX_NAMES = 64;
const SOMEONE = "someone";

/** Whether this turn's config (a Lab draft's in a Lab test chat) has the front door read the chat's sharing. */
export function devShareOn(env) {
  try {
    const ctx = texStep("fd", texConfigOf(env))?.ctx;
    return Array.isArray(ctx) && ctx.includes(DEV_SHARE_MODULE);
  } catch {
    return false;
  }
}

/** The state as the Worker sent it, or null: handles only, a boolean `shared`. */
export function devShareOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.shared !== "boolean") return null;
  // "someone" is a person without a handle (the control plane's word): kept once per person, never deduped or tagged.
  const handles = (list) => {
    if (!Array.isArray(list)) return [];
    const named = list.filter((name) => typeof name === "string" && HANDLE.test(name));
    return [...new Set(named.filter((name) => name !== SOMEONE)), ...named.filter((name) => name === SOMEONE)].slice(0, MAX_NAMES);
  };
  return { shared: value.shared, by: handles(value.by), waiting: handles(value.waiting) };
}

const at = (names) => names.map((name) => (name === SOMEONE ? "someone without a handle" : `@${name}`)).join(", ");

/** The words a group turn is told, or "" when the turn knows nothing about it. */
export function devSharePrompt(devShare) {
  const state = devShareOf(devShare);
  if (state === null) return "";
  const switchLine =
    "Each person here with an account turns their own sharing on or off by saying \"Tex, share my chats with the devs\" or \"Tex, stop sharing with the devs\"; nobody can do it for someone else. ";
  if (state.shared) {
    return (
      "\n\nSHARED WITH THE DEVELOPERS: this chat is shared with the developers who build Tex" +
      (state.by.length > 0 ? ` (${at(state.by)} said yes)` : "") +
      ". They can read its history and replay your turns in their Lab, read only; nothing is sent to them, and nothing more needs doing for them to see it. " +
      switchLine
    );
  }
  return (
    "\n\nSHARED WITH THE DEVELOPERS: this chat is not shared with the developers who build Tex. " +
    (state.waiting.length > 0 ? `Still to say yes: ${at(state.waiting)}. ` : "") +
    (state.by.length > 0 ? `Already said yes: ${at(state.by)}. ` : "") +
    switchLine
  );
}
