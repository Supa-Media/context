import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachedPage } from "./cdp";
import { ANOTHER_WAY, GOOGLE_STEP_SOURCE, PASSWORD_WAY, findPressSource, pastGooglePasskey, type GoogleStep, type WayKind } from "./googleChallenge";
import { PASSKEY_STEP_SOURCE } from "./passkeys";

/**
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `pastGooglePasskey` call removed from ./browserbaseRoute.ts → "presses
 *     past Google's passkey step to the password way" (./browserbase.test.ts)
 *     fails.
 *   The "options" branch dropped from `pastGooglePasskey` → "presses \"Try
 *     another way\", then picks the password way" fails.
 *   The selection-page exclusion dropped from `PASSKEY_STEP_SOURCE` → "the
 *     list of ways is not the passkey step" fails.
 */

/** A Google sign-in page: its address and its HTML, every element laid out and visible. */
function googlePage(href: string, html: string) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const el of document.querySelectorAll("*")) {
    Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 100, height: 40 }) });
    Object.defineProperty(el, "innerText", { get: () => (el.textContent ?? "").trim() });
    Object.defineProperty(el, "scrollIntoView", { value: () => undefined });
  }
  const run = <T>(source: string): T => new Function("location", "document", `return ${source}`)(new URL(href), document) as T;
  return { run };
}

const PASSKEY_HTML = `<h1>Verify it's you</h1><p>Use your passkey to confirm it's really you</p><button>Try again</button><button>Try another way</button>`;
const OPTIONS_HTML = `<h1>Choose how you want to sign in:</h1><ul>
  <li><div role="link" data-challengetype="54">Use your passkey</div></li>
  <li><div role="link" data-challengetype="39">Tap Yes on your phone or tablet</div></li>
  <li><div role="link" data-challengetype="9">Get a verification code at (•••) •••-••12</div></li>
  <li><div role="link" data-challengetype="11">Enter your password</div></li>
  <li><div role="link">Get help</div></li></ul>`;

describe("where a page is in Google's sign-in", () => {
  it("names the passkey step, and the list of ways with each way's kind and no words of its own", () => {
    expect(googlePage("https://accounts.google.com/v3/signin/challenge/pk", PASSKEY_HTML).run(GOOGLE_STEP_SOURCE)).toEqual({ step: "passkey", ways: [] });
    const options = googlePage("https://accounts.google.com/v3/signin/challenge/selection", OPTIONS_HTML).run<{ step: string; ways: string[] }>(GOOGLE_STEP_SOURCE);
    expect(options.step).toBe("options");
    expect(options.ways).toEqual(["passkey", "phone_prompt", "code", "password", "help"]);
    expect(JSON.stringify(options)).not.toMatch(/12|•/);
  });

  it("the list of ways is not the passkey step, though it names a passkey", () => {
    const page = googlePage("https://accounts.google.com/v3/signin/challenge/selection", OPTIONS_HTML);
    expect(page.run(PASSKEY_STEP_SOURCE)).toBe(false);
    expect(googlePage("https://accounts.google.com/v3/signin/challenge/x", OPTIONS_HTML).run(PASSKEY_STEP_SOURCE)).toBe(false);
  });

  it("is nothing off Google's sign-in", () => {
    expect(googlePage("https://example.com/challenge/pk", PASSKEY_HTML).run(GOOGLE_STEP_SOURCE)).toBeNull();
    expect(googlePage("https://accounts.google.com/v3/signin/challenge/pwd", "<input type=password>").run(GOOGLE_STEP_SOURCE)).toEqual({ step: "password", ways: [] });
  });

  it("finds \"Try another way\" and the password way to press, and nothing else by those names", () => {
    expect(googlePage("https://accounts.google.com/x", PASSKEY_HTML).run(findPressSource(ANOTHER_WAY))).toEqual({ x: 60, y: 40 });
    expect(googlePage("https://accounts.google.com/x", OPTIONS_HTML).run(findPressSource(PASSWORD_WAY))).toEqual({ x: 60, y: 40 });
    expect(googlePage("https://accounts.google.com/x", `<button>Try again</button>`).run(findPressSource(ANOTHER_WAY))).toBeNull();
  });
});

/** An attached page walking Google's steps: each press moves it to the next. */
function walking(steps: Array<{ step: GoogleStep; ways: WayKind[] } | null>, presses: Record<string, boolean>) {
  let at = 0;
  const pressed: string[] = [];
  const page: AttachedPage = {
    async send() {
      return {} as never;
    },
    async evaluate<T>(source: string) {
      if (source === GOOGLE_STEP_SOURCE) return steps[at] as T;
      for (const [name, pattern] of Object.entries({ another_way: ANOTHER_WAY, password: PASSWORD_WAY })) {
        if (source === findPressSource(pattern)) {
          if (!presses[name]) return null as T;
          pressed.push(name);
          at += 1;
          return { x: 1, y: 1 } as T;
        }
      }
      throw new Error("unexpected");
    },
    async settle() {},
  };
  return { page, pressed };
}

describe("past Google's passkey step", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  afterEach(() => log.mockClear());

  it("presses \"Try another way\", then picks the password way", async () => {
    const { page, pressed } = walking(
      [{ step: "passkey", ways: [] }, { step: "options", ways: ["passkey", "code", "password"] }, { step: "password", ways: [] }],
      { another_way: true, password: true },
    );
    expect(await pastGooglePasskey(page)).toEqual({ before: "passkey", after: "password", ways: ["passkey", "code", "password"], pressed: ["another_way", "password"] });
    expect(pressed).toEqual(["another_way", "password"]);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "site_shots_google_step", before: "passkey", after: "password" });
  });

  it("leaves a list with no password way for the assistant to read", async () => {
    const { page } = walking([{ step: "passkey", ways: [] }, { step: "options", ways: ["phone_prompt", "code"] }], { another_way: true, password: true });
    expect(await pastGooglePasskey(page)).toEqual({ before: "passkey", after: "options", ways: ["phone_prompt", "code"], pressed: ["another_way"] });
  });

  it("presses nothing on a page that is not the passkey step or the list, and nothing at all off Google", async () => {
    const pwd = walking([{ step: "password", ways: [] }], { another_way: true, password: true });
    expect(await pastGooglePasskey(pwd.page)).toEqual({ before: "password", after: "password", ways: [], pressed: [] });
    expect(pwd.pressed).toEqual([]);
    log.mockClear();
    const off = walking([null], { another_way: true });
    expect(await pastGooglePasskey(off.page)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("never presses the password way on a list Tex came back to itself, so a code can be picked", async () => {
    const { page, pressed } = walking([{ step: "options", ways: ["code", "password"] }, { step: "password", ways: [] }], { another_way: true, password: true });
    expect(await pastGooglePasskey(page)).toEqual({ before: "options", after: "options", ways: ["code", "password"], pressed: [] });
    expect(pressed).toEqual([]);
  });

  it("says when the passkey step had no other way to press", async () => {
    const { page } = walking([{ step: "passkey", ways: [] }], { another_way: false });
    expect(await pastGooglePasskey(page)).toEqual({ before: "passkey", after: "passkey", ways: [], pressed: [] });
  });
});
