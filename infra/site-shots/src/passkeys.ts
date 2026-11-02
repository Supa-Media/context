/**
 * Passkeys off in Tex's browser (a tester's chat, 2026-10-29). Google asked
 * for a passkey on sign-in, and Chrome answered the page's request with its
 * own passkey window: browser furniture, not part of the page, so it is
 * missing from every picture of the page (./view.ts), yet it holds the tab.
 * "Try another way" sat under it, and neither Tex nor the person who took the
 * browser over could press it. A passkey lives on the person's own devices,
 * and a request from this browser never reaches them, so the request is
 * never worth making here.
 *
 * So every page this browser opens is told there are no passkeys: asking for
 * one (or making one) fails at once the way a person's "cancel" does, and
 * the page's own checks hear that no passkey is on this device. Google then
 * offers its other ways (password, a code), and its passkey step, if it is
 * still shown, fails over to them instead of waiting on a window nobody sees.
 *
 * Registered on every attach (./cdp.ts `attachPage`): a script added through
 * one DevTools connection lasts only as long as it. A page that loaded before
 * then may already be holding Chrome's window open; when that page is a
 * passkey step, it is loaded again, which closes the window, and the fresh
 * copy asks no more.
 */

import type { AttachedPage } from "./cdp";

/**
 * Set on a page once the source below has run, so a second run does nothing.
 *
 * Every script on every page this browser opens can read it, so it names
 * nothing: a key that said what this browser is would undo the native-looking
 * wrapper below, letting a site tell the assistant from the person whose
 * accounts it is signed into. It is in the global registry because the source
 * runs afresh in each document and has to find its own earlier run; the string
 * is arbitrary and long enough that no page sets it by chance.
 */
const MARK = 'Symbol.for("b7f2a91c4d")';

/**
 * Run as page code, in the page's own world (its scripts are the ones that
 * ask). Each replacement wraps the real function in a Proxy, so it still
 * reads as the browser's own to a site that checks.
 */
export const PASSKEYS_OFF_SOURCE = `(() => {
  try {
    if (window[${MARK}]) return;
    Object.defineProperty(window, ${MARK}, { value: true });
    const refuse = () => Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    const wrap = (owner, name, replace) => {
      const real = owner && owner[name];
      if (typeof real !== "function") return;
      Object.defineProperty(owner, name, { value: new Proxy(real, { apply: (target, self, args) => replace(target, self, args) }), writable: true, configurable: true });
    };
    const asksForPasskey = (args) => Boolean(args[0] && typeof args[0] === "object" && args[0].publicKey);
    if (typeof CredentialsContainer === "function") {
      for (const name of ["get", "create"]) {
        wrap(CredentialsContainer.prototype, name, (real, self, args) => (asksForPasskey(args) ? refuse() : Reflect.apply(real, self, args)));
      }
    }
    if (typeof PublicKeyCredential === "function") {
      for (const name of ["isUserVerifyingPlatformAuthenticatorAvailable", "isConditionalMediationAvailable"]) {
        wrap(PublicKeyCredential, name, () => Promise.resolve(false));
      }
      wrap(PublicKeyCredential, "getClientCapabilities", () => Promise.resolve({}));
    }
  } catch {}
})()`;

/** Whether the source above has run on the page now open. */
export const PASSKEYS_OFF_CHECK = `Boolean(window[${MARK}])`;

/** Google's passkey step: its address, or its own words when the address is not one we know. */
export const PASSKEY_STEP_SOURCE = `(() => {
  try {
    if (location.hostname !== "accounts.google.com") return false;
    if (/\\/challenge\\/(?:pk|passkey)\\b/i.test(location.pathname)) return true;
    const words = (document.body && document.body.innerText) || "";
    // Google's list of ways names "Use your passkey" as one of them; that list is not the step.
    if (/\\/challenge\\/selection\\b/i.test(location.pathname) || /choose how you want to sign in/i.test(words)) return false;
    return /complete sign-?in using your passkey|use your passkey/i.test(words);
  } catch { return false; }
})()`;

/** How long a passkey step loaded again is given to settle. */
const RELOAD_SETTLE_MS = 8_000;

/**
 * Turn passkeys off for this connection's life, on the page now open and on
 * every one it opens next; and load a passkey step again when it was showing
 * from before, so Chrome's window over it closes.
 */
export async function turnOffPasskeys(page: AttachedPage): Promise<void> {
  const already = await page.evaluate<boolean>(PASSKEYS_OFF_CHECK).catch(() => true);
  await page.send("Page.enable").catch(() => undefined);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PASSKEYS_OFF_SOURCE, runImmediately: true }).catch(() => undefined);
  if (already) return;
  // runImmediately is new in Chrome; the page open now is told directly too.
  await page.evaluate(PASSKEYS_OFF_SOURCE).catch(() => undefined);
  if (!(await page.evaluate<boolean>(PASSKEY_STEP_SOURCE).catch(() => false))) return;
  console.log(JSON.stringify({ event: "site_shots_passkey_step_reloaded" }));
  await page.send("Page.reload").catch(() => undefined);
  await page.settle(RELOAD_SETTLE_MS);
}
