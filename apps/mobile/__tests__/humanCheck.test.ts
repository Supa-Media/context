/**
 * @jest-environment jsdom
 */

/**
 * THE CHECK IS ABSENT UNLESS BOTH ENDS ARE CONFIGURED, AND ABSENT MEANS CLOSED.
 *
 * `apps/convex/functions/lib/turnstile.ts` refuses every submission when
 * `TURNSTILE_SECRET_KEY` is unset, and argues at length why that is the
 * production branch rather than scaffolding. This is the same rule at the
 * other end of the same pair: with no `EXPO_PUBLIC_TURNSTILE_SITE_KEY` there
 * is nothing that can produce a token, and the page must say so **instead of**
 * drawing fields.
 *
 * `shareCollect.test.ts` stubs this module to test the form around it. This
 * file is the unstubbed one, because a stub that says "available" would pass
 * whatever the real default was — and the real default is the one that ships
 * to a self-hoster who never set a key.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN_CHECK_AVAILABLE } from "../features/share/HumanCheck";

const SHARE_DIR = join(__dirname, "..", "features", "share");

describe("with no site key set", () => {
  test("the check reports itself unavailable, which is what closes the form", () => {
    // No `EXPO_PUBLIC_TURNSTILE_SITE_KEY` in this environment, deliberately:
    // it is the shape of a deployment that never configured one.
    expect(process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? "").toBe("");
    expect(HUMAN_CHECK_AVAILABLE).toBe(false);
  });
});

describe("the two builds of the check", () => {
  const web = readFileSync(join(SHARE_DIR, "HumanCheck.web.tsx"), "utf8");
  const native = readFileSync(join(SHARE_DIR, "HumanCheck.tsx"), "utf8");

  test("the native one can never report itself available", () => {
    // There is no Turnstile widget outside a browser and the server refuses a
    // submission with no verified token — correctly, because a defence that
    // depends on which client asked is not one. So this is a constant, and a
    // constant is what a reader of this file can check.
    expect(native).toContain("export const HUMAN_CHECK_AVAILABLE = false;");
  });

  test("...and says what to do rather than failing quietly", () => {
    expect(native).toContain("Open this link in a web browser");
  });

  test("the web one reads its key from the environment, never from source", () => {
    // This repository is public. The site key is public by construction — it
    // is in the markup of every page that runs a widget — but it is an account
    // identifier, and `CLAUDE.md` keeps those out of the tree.
    expect(web).toContain("process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY");
    expect(web).not.toMatch(/sitekey:\s*"/);
  });

  test("...and talks to Cloudflare and nowhere else", () => {
    const urls = [...web.matchAll(/https?:\/\/[^"'\s)]+/g)].map((match) => match[0]);
    for (const url of urls) {
      expect([url, url.startsWith("https://challenges.cloudflare.com/")]).toEqual([url, true]);
    }
    expect(urls.length).toBeGreaterThan(0);
  });

  test("...and the widget is rebuilt after a send, because a token is single-use", () => {
    // Cloudflare spends a token on the first verification. Without the reset,
    // a second answer through one page fails on the check rather than on
    // whatever went wrong the first time.
    expect(web).toContain("resetKey");
    expect(web).toMatch(/\}, \[resetKey\]\)/);
  });
});
