/**
 * TEX'S SAVED BROWSER PROFILE AT BROWSERBASE, THE DEFAULT HOME OF ITS SIGN-INS.
 *
 * Decided by the owner, 2026-10-29 (`docs/decisions/texting-assistant/vault.md`),
 * reversing 2026-10-20/22: a Google sign-in replayed from the sealed jar
 * (`browserJar.js`) dies, since Chrome binds it to the browser's own key, so
 * each browser now opens a Browserbase Context, a saved Chrome profile, and
 * saves back into it. One per person's browser (`browserOwner`), one per
 * group chat and set of people in it (`groupBrowserOwner`), exactly where
 * each keeps its jar. The jar is still read and sealed after every run: the
 * fallback when a profile is lost, the copy a new profile starts from, and
 * what the person leaves with on Download as folders.
 *
 * The control plane makes and releases the profile and holds its id
 * (`apps/convex/functions/browserProfiles.ts`); this only asks for it, once a
 * question. The id goes to the screenshot Worker and nowhere else, never into
 * a tool result, a log or a message.
 */

const HEX64 = /^[0-9a-f]{64}$/;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * This browser's profile, or null when the turn has nowhere to keep one (no
 * control plane on the store, no owner tag). `group` is the chat, as
 * `groupOf` reads it: its hash lets the control plane release the profile of
 * the chat's earlier set of people.
 */
export function browserProfile(store, { owner, group = null } = {}) {
  const calls = store?.browserProfiles;
  if (typeof calls?.get !== "function" || typeof owner !== "string" || !HEX64.test(owner)) return null;
  // undefined: not asked yet this question; null: none.
  let held;
  return {
    /** `{ id, created }`, asked for once a question; null when there is none to be had. */
    async load() {
      if (held !== undefined) return held;
      held = null;
      try {
        const chat = group === null ? null : await sha256Hex(`tex-chat:${group.key}`);
        const answer = await calls.get(owner, chat);
        if (typeof answer?.profileId === "string" && answer.profileId) held = { id: answer.profileId, created: answer.created === true };
      } catch {
        // No profile this question: the browser starts from the jar, as before.
      }
      return held;
    },
    /** A browser opened it: it is no longer new, so the jar's cookies are not put over it again. */
    used() {
      if (held) held = { ...held, created: false };
    },
    /** Release it at Browserbase: "sign Tex out", or a profile Browserbase no longer had. */
    async forget() {
      held = null;
      try {
        await calls.forget(owner);
        return true;
      } catch {
        return false;
      }
    },
  };
}
