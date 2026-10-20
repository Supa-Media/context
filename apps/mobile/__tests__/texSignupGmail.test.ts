import { describe, expect, test } from "@jest/globals";
import { messagesHref, TEXT_ROUTE } from "../features/tex/launch/routes";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  forgetGmailFirst,
  googleWarning,
  newGmail,
  readGmailFirst,
  readGmailReturn,
  rememberGmailFirst,
} from "../features/auth/gmailFirst/gmailFirst";
import { personalGmailWhy } from "../features/auth/gmailFirst/GmailFirstScreen";
import { safeNextRoute } from "../features/auth/redirect";

/**
 * tex.lc signed in and Gmail first (Dev2, 2026-10-20): the small rules the
 * pages rest on.
 */
describe("Open Messages", () => {
  test("types hi for somebody who has never texted Tex, and nothing after", () => {
    expect(messagesHref("+15555550177", true)).toBe("sms:+15555550177?&body=hi");
    expect(messagesHref("+15555550177", false)).toBe("sms:+15555550177");
  });
});

describe("signing in on tex.lc comes back to /text", () => {
  test("/text is a next the sign-in page keeps", () => {
    expect(safeNextRoute(TEXT_ROUTE)).toBe("/text");
  });
});

describe("the page Google returns to", () => {
  test("names the Gmail that was not there before, and waits while the binding lands", () => {
    expect(newGmail(["a@gmail.com"], ["a@gmail.com"])).toBeNull();
    expect(newGmail(["a@gmail.com"], ["a@gmail.com", "b@work.example"])).toBe("b@work.example");
    expect(newGmail([], ["a@gmail.com"])).toBe("a@gmail.com");
  });

  test("Google's warning says tap on a phone and click on a computer", () => {
    expect(googleWarning(true)).toContain("tap Advanced, then Go to Context");
    expect(googleWarning(false)).toContain("click Advanced");
  });
});

/*
  Number first, then the personal Gmail (Dev, 2026-10-20): somebody who signed
  up through a work domain is asked for it after setup, and Google brings them
  back to the link they opened.
*/
describe("a work-domain sign-up's personal Gmail", () => {
  function withSessionStorage(run: () => void) {
    const store = new Map<string, string>();
    const holder = globalThis as { sessionStorage?: unknown };
    const before = holder.sessionStorage;
    holder.sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    try {
      run();
    } finally {
      holder.sessionStorage = before;
    }
  }

  test("comes back to the page it left, and only to a path on this site", () => {
    withSessionStorage(() => {
      rememberGmailFirst("personal", "/console/@pw?note=1-projects%2Fprep.md");
      expect(readGmailFirst()).toBe("personal");
      expect(readGmailReturn()).toBe("/console/@pw?note=1-projects%2Fprep.md");
      rememberGmailFirst("personal", "//evil.example/x");
      expect(readGmailReturn()).toBe("/console");
      rememberGmailFirst("primary");
      expect(readGmailReturn()).toBe("/console");
      rememberGmailFirst("personal", "/console/@pw");
      forgetGmailFirst();
      expect(readGmailFirst()).toBeNull();
      expect(readGmailReturn()).toBe("/console");
    });
  });

  test("says it keeps the account theirs if they leave the domain", () => {
    expect(personalGmailWhy("publicworship.life")).toBe(
      "Use the one you check most. It keeps your account yours if you leave publicworship.life.",
    );
    expect(personalGmailWhy(null)).toContain("if your work email goes away");
  });

  test("the layout asks for it after setup and before anything else is drawn", () => {
    const source = readFileSync(join(__dirname, "../app/(app)/_layout.tsx"), "utf8");
    const setup = source.indexOf("<AccountSetupScreen");
    const gate = source.indexOf("<PersonalEmailGate");
    expect(setup).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(setup);
    expect(gate).toBeLessThan(source.indexOf("needsOnboarding({"));
    expect(source).toContain("needsPersonalEmail === true");
  });
});
