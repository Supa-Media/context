/**
 * "DONE" HANDS THE BROWSER BACK AND TEX CARRIES ON (Dev2, 2026-11-12: "it
 * should notify tex so it continues on, maybe some type of animation to show
 * tex taking over").
 *
 * A turn that texted a take-over link names the browser it handed over in its
 * answer (`handbackWatch`): a SHA-256 of the browser's tag
 * (`browserOwner`, `groupBrowserOwner`), which names nobody. The texting
 * Worker watches the control plane for that browser
 * (`apps/agent/src/handbackWatch.ts`). Done on the take-over screen marks it
 * (`http/texComputer.js` `/tex/computer/done`, for a person the screen
 * already shows that browser to), and the Worker asks for a turn with
 * `event: "browser_handed_back"` and no words, in the chat that texted the
 * link, a group chat's included, as a saved login's turn is (`vaultSaved.js`).
 *
 * That turn's question is the line below, never anything the Worker sends.
 */

export const HANDED_BACK_QUESTION =
  "(Not a text from them. Context sent this by itself: someone in this chat pressed Done on the browser you handed over, so it's yours again. " +
  "Read the page now and carry on with the task straight away: finish what's left and press the page's own button; don't ask whether they finished or wait for a text. " +
  "If what you handed over is still on the page (the same captcha, sign-in or code), say in one line that it's still there, and keep the browser where it is. " +
  "Text the chat what you did, as you would have once they said done.)";

/** The question for a turn the body names as a hand-back, or null for any other turn. Only a chat's own turn (1:1 or group) may name it. */
export function handedBackQuestion(body, { texting, job }) {
  if (!texting || job !== null) return null;
  return body?.event === "browser_handed_back" ? HANDED_BACK_QUESTION : null;
}

/** The hex SHA-256 of a browser's tag, or null for anything that isn't one. */
export async function browserHash(tag) {
  if (typeof tag !== "string" || !/^[0-9a-f]{64}$/.test(tag)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`browser-handback:${tag}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `{ handbackWatch }` for a turn that handed its browser over, else nothing (`texEntryPoint/sendTheReply.js`). */
export async function handbackField(opened) {
  const hash = await browserHash(opened?.browser?.handedOverTag?.() ?? null);
  return hash === null ? {} : { handbackWatch: hash };
}
