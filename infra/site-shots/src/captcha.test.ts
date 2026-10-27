import { describe, expect, it } from "vitest";
import { CAPTCHA_PROBE, captchaPending, invisibleCaptcha, settleCaptcha } from "./captcha";

const clear = { widget: false, answered: false, wall: false };

/** A clock that moves only when the settle loop waits. */
function clock() {
  let t = 0;
  return { now: () => t, wait: async (ms: number) => void (t += ms) };
}

describe("captchaPending", () => {
  it("counts an unanswered widget and a bot wall, never an answered widget or a plain page", () => {
    expect(captchaPending({ ...clear, widget: true })).toBe(true);
    expect(captchaPending({ ...clear, wall: true })).toBe(true);
    expect(captchaPending({ ...clear, widget: true, answered: true })).toBe(false);
    expect(captchaPending(clear)).toBe(false);
    expect(captchaPending(null)).toBe(false);
  });
});

describe("settleCaptcha", () => {
  it("answers null without waiting when the page has no captcha", async () => {
    const c = clock();
    expect(await settleCaptcha(async () => clear, c)).toBeNull();
    expect(c.now()).toBe(0);
  });

  it("waits for Browserbase's solver and says solved once the widget is answered", async () => {
    const c = clock();
    const seen = [{ ...clear, widget: true }, { ...clear, widget: true }, { ...clear, widget: true, answered: true }];
    let i = 0;
    expect(await settleCaptcha(async () => seen[Math.min(i++, seen.length - 1)], c)).toBe("solved");
    expect(c.now()).toBe(2_000);
  });

  it("gives up after the wait and says unsolved", async () => {
    const c = clock();
    expect(await settleCaptcha(async () => ({ ...clear, wall: true }), { ...c, waitMs: 5_000 })).toBe("unsolved");
    expect(c.now()).toBe(5_000);
  });

  it("treats a probe the page refused, or an answer that is not the probe's, as no captcha", async () => {
    expect(await settleCaptcha(async () => Promise.reject(new Error("the page threw")), clock())).toBeNull();
    expect(await settleCaptcha(async () => true, clock())).toBeNull();
  });

  it("returns only booleans from the page, never its words", () => {
    const page = (title: string, words: string, boxes: Array<{ value: string }> = [], frames: Array<{ src: string }> = []) => ({
      title,
      body: { innerText: words },
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "iframe" ? frames.map((f) => ({ ...f, getBoundingClientRect: () => ({ width: 300, height: 80 }) })) : boxes,
    });
    const run = (document: unknown) => new Function("document", `return ${CAPTCHA_PROBE}`)(document);
    expect(run(page("Just a moment...", "account 4471 secret"))).toEqual({ widget: false, answered: false, wall: true, invisible: false });
    expect(run(page("Shop", "hello", [{ value: "" }], [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x" }]))).toEqual({ widget: true, answered: false, wall: false, invisible: false });
    expect(run(page("Shop", "hello", [{ value: "tok" }], [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x" }]))).toEqual({ widget: true, answered: true, wall: false, invisible: false });
    expect(run(page("Shop", "hello", [], [{ src: "https://www.google.com/recaptcha/api2/anchor?size=invisible" }]))).toEqual({ widget: false, answered: false, wall: false, invisible: true });
  });

  it("knows a picture check by its words and an AWS WAF puzzle by its frame (Instacart, 2026-10-24)", () => {
    const page = (words: string, frames: Array<{ src: string }> = []) => ({
      title: "Instacart",
      body: { innerText: words },
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "iframe" ? frames.map((f) => ({ ...f, getBoundingClientRect: () => ({ width: 300, height: 300 }) })) : [],
    });
    const run = (document: unknown) => new Function("document", `return ${CAPTCHA_PROBE}`)(document);
    expect(run(page("Let's confirm you're human. Select all images with a bus")).wall).toBe(true);
    expect(run(page("Please solve this puzzle to continue")).wall).toBe(true);
    expect(run(page("Sign in", [{ src: "https://abc.token.awswaf.com/captcha" }])).widget).toBe(true);
    expect(run(page("Your cart: 26 items, select all to remove"))).toEqual({ widget: false, answered: false, wall: false, invisible: false });
  });
});

describe("invisibleCaptcha", () => {
  it("finds a captcha that shows nothing until a form is sent, by its badge or its script (the owner's registration form, 2026-10-27)", async () => {
    const page = (found: string | null) => ({
      title: "Register",
      body: { innerText: "Register for the conference" },
      querySelector: (selector: string) => (found !== null && selector.includes(found) ? {} : null),
      querySelectorAll: () => [],
    });
    const run = (document: unknown) => async () => new Function("document", `return ${CAPTCHA_PROBE}`)(document);
    expect(await invisibleCaptcha(run(page(".grecaptcha-badge")))).toBe(true);
    expect(await invisibleCaptcha(run(page("recaptcha/enterprise.js")))).toBe(true);
    expect(await invisibleCaptcha(run(page(null)))).toBe(false);
    expect(await invisibleCaptcha(async () => Promise.reject(new Error("the page threw")))).toBe(false);
  });
});
