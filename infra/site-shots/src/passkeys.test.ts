import { describe, expect, it } from "vitest";
import type { AttachedPage } from "./cdp";
import { PASSKEY_STEP_SOURCE, PASSKEYS_OFF_CHECK, PASSKEYS_OFF_SOURCE, turnOffPasskeys } from "./passkeys";

/** A page's globals the way Chrome has them, with a passkey request that never answers (Chrome's own window is up). */
function chromePage() {
  const asked: string[] = [];
  class CredentialsContainer {
    get(options?: { publicKey?: unknown; password?: boolean }) {
      asked.push(options?.publicKey ? "passkey get" : "other get");
      return options?.publicKey ? new Promise(() => undefined) : Promise.resolve("a password credential");
    }
    create(options?: { publicKey?: unknown }) {
      asked.push(options?.publicKey ? "passkey create" : "other create");
      return new Promise(() => undefined);
    }
  }
  class PublicKeyCredential {
    static isUserVerifyingPlatformAuthenticatorAvailable() {
      return Promise.resolve(true);
    }
    static isConditionalMediationAvailable() {
      return Promise.resolve(true);
    }
    static getClientCapabilities() {
      return Promise.resolve({ passkeyPlatformAuthenticator: true });
    }
  }
  const window: Record<PropertyKey, unknown> = {};
  const navigator = { credentials: new CredentialsContainer() };
  const run = <T>(source: string): T =>
    new Function("window", "navigator", "CredentialsContainer", "PublicKeyCredential", "DOMException", `return ${source}`)(
      window,
      navigator,
      CredentialsContainer,
      PublicKeyCredential,
      DOMException,
    ) as T;
  return { run, navigator, PublicKeyCredential, CredentialsContainer, asked };
}

const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise.then((value) => ({ value }), (error: Error) => ({ error: error.name })), new Promise((r) => setTimeout(() => r("still waiting"), 50))]);

describe("passkeys off in Tex's browser", () => {
  it("refuses a passkey request at once, as a person's cancel, instead of waiting on Chrome's window", async () => {
    const page = chromePage();
    expect(await settled(page.navigator.credentials.get({ publicKey: {} }))).toBe("still waiting");
    page.run(PASSKEYS_OFF_SOURCE);
    expect(await settled(page.navigator.credentials.get({ publicKey: { challenge: 1 } }))).toEqual({ error: "NotAllowedError" });
    expect(await settled(page.navigator.credentials.create({ publicKey: { challenge: 1 } }))).toEqual({ error: "NotAllowedError" });
    // Only the first get, from before, reached the browser.
    expect(page.asked).toEqual(["passkey get"]);
  });

  it("leaves a saved password's request alone", async () => {
    const page = chromePage();
    page.run(PASSKEYS_OFF_SOURCE);
    expect(await settled(page.navigator.credentials.get({ password: true }))).toEqual({ value: "a password credential" });
    expect(page.asked).toEqual(["other get"]);
  });

  it("tells the page's checks no passkey is on this device", async () => {
    const page = chromePage();
    page.run(PASSKEYS_OFF_SOURCE);
    expect(await page.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(false);
    expect(await page.PublicKeyCredential.isConditionalMediationAvailable()).toBe(false);
    expect(await page.PublicKeyCredential.getClientCapabilities()).toEqual({});
  });

  it("still reads as the browser's own function, and a second run changes nothing", async () => {
    const page = chromePage();
    expect(page.run<boolean>(PASSKEYS_OFF_CHECK)).toBe(false);
    page.run(PASSKEYS_OFF_SOURCE);
    const once = page.CredentialsContainer.prototype.get;
    page.run(PASSKEYS_OFF_SOURCE);
    expect(page.CredentialsContainer.prototype.get).toBe(once);
    expect(Function.prototype.toString.call(once)).toMatch(/\{ \[native code\] \}$/);
    expect(page.run<boolean>(PASSKEYS_OFF_CHECK)).toBe(true);
  });

  it("leaves nothing in the page that names what this browser is", () => {
    // The mark the source sets is an own property of `window`, so every script on
    // every page the browser opens can read it. Measured in Chromium: a page that
    // knows the key gets `true` back. Naming the product there would undo the
    // native-looking wrapper above — a site could tell the assistant from the
    // person whose accounts it is signed into, and act on the difference.
    for (const source of [PASSKEYS_OFF_SOURCE, PASSKEYS_OFF_CHECK]) {
      expect(source).not.toMatch(/context|\btex\b|supa|assistant|claude|passkeys-off/i);
    }
  });
});

describe("Google's passkey step", () => {
  const onPage = (href: string, words: string) =>
    new Function("location", "document", `return ${PASSKEY_STEP_SOURCE}`)(new URL(href), { body: { innerText: words } }) as boolean;

  it("is found by its address or its words, on Google's sign-in only", () => {
    expect(onPage("https://accounts.google.com/v3/signin/challenge/pk?TL=x", "")).toBe(true);
    expect(onPage("https://accounts.google.com/v3/signin/challenge/x", "Verifying it's you… Complete sign-in using your passkey")).toBe(true);
    expect(onPage("https://accounts.google.com/v3/signin/challenge/pwd", "Enter your password")).toBe(false);
    expect(onPage("https://example.com/challenge/pk", "Complete sign-in using your passkey")).toBe(false);
  });
});

/** An attached page answering the three questions `turnOffPasskeys` asks, and recording what was sent. */
function attached(state: { off: boolean; passkeyStep: boolean }) {
  const sent: string[] = [];
  const page: AttachedPage = {
    async send<T>(method: string, params?: Record<string, unknown>) {
      sent.push(method === "Page.addScriptToEvaluateOnNewDocument" ? `${method}${params?.runImmediately ? " now" : ""}` : method);
      if (method === "Page.reload") state.passkeyStep = false;
      return {} as T;
    },
    async evaluate<T>(source: string) {
      if (source === PASSKEYS_OFF_CHECK) return state.off as T;
      if (source === PASSKEYS_OFF_SOURCE) {
        sent.push("off now");
        state.off = true;
        return undefined as T;
      }
      if (source === PASSKEY_STEP_SOURCE) return state.passkeyStep as T;
      throw new Error("unexpected");
    },
    async settle() {
      sent.push("settle");
    },
  };
  return { page, sent };
}

describe("turning passkeys off on attach", () => {
  it("registers the script for every page this connection opens, and the page now open", async () => {
    const { page, sent } = attached({ off: false, passkeyStep: false });
    await turnOffPasskeys(page);
    expect(sent).toEqual(["Page.enable", "Page.addScriptToEvaluateOnNewDocument now", "off now"]);
  });

  it("loads a passkey step left from before again, so Chrome's window over it closes", async () => {
    const { page, sent } = attached({ off: false, passkeyStep: true });
    await turnOffPasskeys(page);
    expect(sent).toEqual(["Page.enable", "Page.addScriptToEvaluateOnNewDocument now", "off now", "Page.reload", "settle"]);
  });

  it("never loads a page again that already had passkeys off, so a passkey step shown since cannot loop", async () => {
    const { page, sent } = attached({ off: true, passkeyStep: true });
    await turnOffPasskeys(page);
    expect(sent).toEqual(["Page.enable", "Page.addScriptToEvaluateOnNewDocument now"]);
  });
});
