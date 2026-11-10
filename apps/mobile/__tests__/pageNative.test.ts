/**
 * The phone's page wire (`features/console/files/pageView/pageNative.ts`):
 * the page runtime is a web view's whole document there, so a key stands in
 * for the frame check, and the view loads one page and nothing else.
 *
 * Sabotage record (2026-11-10): accepting a message with no key, letting a
 * subframe load the main page, and leaving `<` unescaped in a script each
 * failed the test named for it.
 */
import { describe, expect, test } from "@jest/globals";
import { nativePageUrls, pageKeyScript, pageLoadAllowed, pageMessageFrom, pageScriptFor } from "../features/console/files/pageView/pageNative";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";
const URLS = nativePageUrls("https://context.lc")!;

describe("what the page says", () => {
  test("a message with this view's key comes through, without the key", () => {
    expect(pageMessageFrom(JSON.stringify({ channel: "context-page", key: KEY, type: "ready" }), KEY)).toEqual({ channel: "context-page", type: "ready" });
  });

  test("a message without the key, or with another, is dropped: a box frame can reach the bridge but not the key", () => {
    expect(pageMessageFrom(JSON.stringify({ channel: "context-page", type: "edit", edits: [] }), KEY)).toBeNull();
    expect(pageMessageFrom(JSON.stringify({ channel: "context-page", key: KEY.replace("0", "1"), type: "ready" }), KEY)).toBeNull();
    expect(pageMessageFrom(JSON.stringify({ channel: "context-page", key: KEY.slice(0, 32), type: "ready" }), KEY)).toBeNull();
    expect(pageMessageFrom("not json", KEY)).toBeNull();
    expect(pageMessageFrom(JSON.stringify([KEY]), KEY)).toBeNull();
    expect(pageMessageFrom({ key: KEY }, KEY)).toBeNull();
  });
});

describe("what the view loads", () => {
  test("the console's own copy of the runtime, by its folder, never the sites domain", () => {
    expect(URLS.page).toBe("https://context.lc/drawing-assets/page/");
    expect(nativePageUrls("http://example.com")).toBeNull();
    expect(nativePageUrls("not a url")).toBeNull();
    expect(nativePageUrls("http://localhost:8081")!.page).toBe("http://localhost:8081/drawing-assets/page/");
  });

  test("the main frame loads the page alone, a subframe only its box page", () => {
    expect(pageLoadAllowed("https://context.lc/drawing-assets/page/", true, URLS)).toBe(true);
    expect(pageLoadAllowed("https://context.lc/drawing-assets/page/box", false, URLS)).toBe(true);
    expect(pageLoadAllowed("https://context.lc/drawing-assets/page/box.html", false, URLS)).toBe(true);
    expect(pageLoadAllowed("https://context.lc/drawing-assets/page/box", true, URLS)).toBe(false);
    expect(pageLoadAllowed("https://context.lc/drawing-assets/page/", false, URLS)).toBe(false);
    expect(pageLoadAllowed("https://context.lc/app", true, URLS)).toBe(false);
    expect(pageLoadAllowed("https://seyi.ctxlc.site/_page/", true, URLS)).toBe(false);
    expect(pageLoadAllowed("https://evil.example/drawing-assets/page/", true, URLS)).toBe(false);
  });
});

describe("what the app tells the page", () => {
  test("a note's words can't close the script they travel in", () => {
    const script = pageScriptFor({ channel: "context-page", type: "render", source: "</script><script>alert(1)</script>\u2028" });
    expect(script).not.toMatch(/<|>|\u2028/);
    const literal = script.slice(script.indexOf("(", script.indexOf("__contextPageFromApp(")) + 1, script.lastIndexOf(")"));
    expect(JSON.parse(literal).source).toBe("</script><script>alert(1)</script>\u2028");
  });

  test("the key goes in only as hex", () => {
    expect(pageKeyScript(KEY)).toBe(`window.__contextPageKey = "${KEY}"; true;`);
    expect(() => pageKeyScript('x"; alert(1); "')).toThrow();
    expect(() => pageKeyScript("abc")).toThrow();
  });
});
