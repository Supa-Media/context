import { describe, expect, test } from "@jest/globals";
import { firstTouchFromLocation, firstTouchOf, landingSegmentOf, referrerOriginOf, SIGNUP_CHANNELS, signupChannelOf } from "@context/shared";

/**
 * The one sign-up channel classifier (`packages/shared/src/signupChannel.ts`) and the first touch it reads. The
 * server half (storing it on the account and exporting it) is `apps/convex/__tests__/signupChannels.test.ts`; the
 * sheet merge is `apps/mcp/test/dataSyncUsage.test.mjs`.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `firstTouchFromLocation` keeping `url.href` as the referrer: "keeps the referrer's origin only" fails.
 * 2. `landingSegmentOf` returning the raw first segment: "never a token or a handle" fails.
 * 3. Moving the AI check after search: "gemini.google.com is ai, google.com is search" fails.
 */

const at = (referrer: string, href = "https://context.lc/") => signupChannelOf(firstTouchFromLocation(href, referrer));

describe("the acceptance cases", () => {
  test("google.com is search, chatgpt.com is ai, t.co is social, no referrer is direct", () => {
    expect(at("https://www.google.com/")).toBe("search");
    expect(at("https://chatgpt.com/c/123?q=secret")).toBe("ai");
    expect(at("https://t.co/abcdef")).toBe("social");
    expect(at("")).toBe("direct");
  });
});

describe("the classifier", () => {
  test.each([
    ["https://chat.openai.com/", "ai"],
    ["https://www.perplexity.ai/search?q=x", "ai"],
    ["https://claude.ai/chat/1", "ai"],
    ["https://copilot.microsoft.com/", "ai"],
    ["https://grok.com/", "ai"],
    ["https://google.co.uk/", "search"],
    ["https://www.google.de/", "search"],
    ["https://www.bing.com/", "search"],
    ["https://duckduckgo.com/", "search"],
    ["https://search.brave.com/", "search"],
    ["https://search.yahoo.com/", "search"],
    ["https://www.ecosia.org/", "search"],
    ["https://kagi.com/", "search"],
    ["https://x.com/someone", "social"],
    ["https://twitter.com/", "social"],
    ["https://www.linkedin.com/", "social"],
    ["https://old.reddit.com/r/x", "social"],
    ["https://m.youtube.com/", "social"],
    ["https://l.instagram.com/", "social"],
    ["https://www.threads.net/", "social"],
    ["https://l.facebook.com/", "social"],
    ["https://news.ycombinator.com/", "other"],
    ["https://mail.google.com/", "other"],
  ])("%s is %s", (referrer, channel) => {
    expect(at(referrer)).toBe(channel);
  });

  test("gemini.google.com is ai, google.com is search", () => {
    expect(at("https://gemini.google.com/app")).toBe("ai");
    expect(at("https://google.com/")).toBe("search");
  });

  test("a host that only ends like one of the lists is not it", () => {
    expect(at("https://notgoogle.com/")).toBe("other");
    expect(at("https://fakex.com/")).toBe("other");
    expect(at("https://claude.ai.evil.example/")).toBe("other");
    expect(at("https://google.com.evil.example/")).toBe("other");
  });

  test("utm_source naming an AI is ai, utm_medium=social is social, any other utm is other", () => {
    expect(at("", "https://context.lc/?utm_source=chatgpt.com")).toBe("ai");
    expect(at("", "https://context.lc/?utm_source=OpenAI")).toBe("ai");
    expect(at("", "https://context.lc/?utm_source=perplexity")).toBe("ai");
    expect(at("", "https://context.lc/?utm_source=claude")).toBe("ai");
    expect(at("", "https://context.lc/?utm_source=meta&utm_medium=social")).toBe("social");
    expect(at("", "https://context.lc/?utm_source=newsletter")).toBe("other");
    expect(at("", "https://context.lc/?ref=producthunt")).toBe("other");
  });

  test("an invitation, a shared note or a server-known invite is invite, after the referrer lists", () => {
    expect(at("", "https://context.lc/invite/tok")).toBe("invite");
    expect(at("", "https://context.lc/s/tok")).toBe("invite");
    expect(signupChannelOf({}, { invited: true })).toBe("invite");
    expect(signupChannelOf(undefined, { invited: true })).toBe("invite");
    expect(signupChannelOf({ referrer: "https://www.google.com" }, { invited: true })).toBe("search");
  });

  test("Tex and AI clients: a sign-up with no web touch, or one that landed on their pages with nothing else", () => {
    expect(signupChannelOf(undefined, { via: "tex" })).toBe("tex");
    expect(signupChannelOf(undefined, { via: "agent" })).toBe("agent");
    expect(at("", "https://context.lc/texts/tok")).toBe("tex");
    expect(at("", "https://context.lc/authorize?client_id=x")).toBe("agent");
    expect(at("https://claude.ai/", "https://context.lc/authorize?client_id=x")).toBe("ai");
  });

  test("nothing known is null, never a guess", () => {
    expect(signupChannelOf(undefined)).toBeNull();
  });

  test("every answer is one of the channels", () => {
    for (const referrer of ["", "https://x.com/", "https://weird.example/", "https://google.com/"]) {
      expect(SIGNUP_CHANNELS).toContain(at(referrer));
    }
  });
});

describe("the first touch", () => {
  test("keeps the referrer's origin only, and the three parameters, never another query key", () => {
    const touch = firstTouchFromLocation("https://context.lc/invite/secret-token?utm_source=X&utm_medium=Social&ref=HN&email=a@b.c&utm_campaign=c", "https://user:pw@www.google.com/search?q=private+words");
    expect(touch).toEqual({ referrer: "https://www.google.com", source: "x", medium: "social", ref: "hn", path: "/invite" });
    expect(JSON.stringify(touch)).not.toMatch(/secret|private|email|pw/);
  });

  test("our own pages are no referrer", () => {
    expect(firstTouchFromLocation("https://context.lc/a", "https://context.lc/").referrer).toBeUndefined();
    expect(firstTouchFromLocation("https://context.lc/a", "https://tex.lc/", ["tex.lc"]).referrer).toBeUndefined();
  });

  test("the landing segment is from a fixed list: never a token or a handle", () => {
    expect(landingSegmentOf("/")).toBe("/");
    expect(landingSegmentOf("/s/abc123")).toBe("/s");
    expect(landingSegmentOf("/seyi")).toBe("/other");
    expect(landingSegmentOf("/Invite/x")).toBe("/invite");
    expect(landingSegmentOf("no-slash")).toBeUndefined();
  });

  test("a sent touch is cleaned again: only an http(s) origin, short fields, known paths", () => {
    expect(firstTouchOf({ referrer: "javascript:alert(1)", source: " ".repeat(3), path: "/seyi", extra: "x" })).toEqual({});
    expect(firstTouchOf({ source: "a".repeat(500) })?.source).toHaveLength(100);
    expect(firstTouchOf("nope")).toBeUndefined();
    expect(referrerOriginOf("https://www.google.com/search?q=x")).toBe("https://www.google.com");
    expect(referrerOriginOf("ftp://x.example/")).toBeUndefined();
  });
});
