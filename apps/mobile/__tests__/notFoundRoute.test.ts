import { describe, expect, test } from "@jest/globals";
import { recoveredHref, unmatchedSegments } from "../features/app/unmatched";

/**
 * The screen a URL nobody anticipated lands on, and the one link it recovers.
 *
 * `+not-found.tsx` exists to replace Expo Router's built-in **Unmatched Route**
 * screen — a development aid that ships, and what a `context://note/…` link
 * from ChatGPT rendered on iOS on 2026-09-03. Declaring the route is the whole
 * of that fix (`getNavigationConfig` installs the built-in only when the app
 * has not), and `htmlShell.test.ts`-style structure checks would not catch its
 * absence, so the assertion that it exists is the file being there.
 *
 * What is worth testing is the part that can silently stop working: reading the
 * segments the router hands it. The param's **name** is an implementation
 * detail of a dependency — `not-found` in expo-router 6, `unmatched` in the
 * documentation and in earlier versions — and getting it wrong does not fail
 * loudly. The screen still renders; the only thing that quietly stops is
 * recovering a note link somebody was sent.
 */

describe("reading the path a not-found route was reached with", () => {
  test("expo-router 6 names it `not-found`", () => {
    // Derived, not guessed: `getReactNavigationConfig` turns the `+not-found`
    // segment into the pattern `*not-found`, and `replacePart` strips the `*`.
    expect(unmatchedSegments({ "not-found": ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("the older name still works", () => {
    expect(unmatchedSegments({ unmatched: ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("a renamed param is still found, because a catch-all is an array", () => {
    /*
      The fallback, and it is a fact about the route rather than a guess about
      the key: a `+not-found` route has exactly one dynamic parameter, it is a
      catch-all, and `getParamValue` gives a catch-all its value as an array.
      Query parameters are strings.
    */
    expect(unmatchedSegments({ "something-else": ["note", "@supa", "a.md"] })).toEqual([
      "note",
      "@supa",
      "a.md",
    ]);
  });

  test("a query parameter is not mistaken for the path", () => {
    expect(unmatchedSegments({ utm_source: "chat", ref: "x" })).toEqual([]);
  });

  test("a single-segment path arrives as a bare string", () => {
    expect(unmatchedSegments({ "not-found": "typo" })).toEqual(["typo"]);
  });

  test("no params at all is no path", () => {
    expect(unmatchedSegments({})).toEqual([]);
  });
});

describe("the links a not-found route recovers", () => {
  test("a note link goes to the console", () => {
    expect(recoveredHref(["note", "@supa", "projects", "a.md"])).toBe("/console/@supa?note=projects%2Fa.md");
  });

  test("a page link (`/p/@slug/<path>`) goes to its note link, which opens it for a member, a guest or a grantee", () => {
    /*
      Tex texts a page as `/p/@slug/<path>.page.md`, which the edge serves as
      the page viewer. When the app itself is at that address (a held shell,
      a hand-off the viewer did not get to), this screen dead-ended it
      (Dev2, 2026-11-17: the StafferLink page "did not go anywhere").
    */
    expect(recoveredHref(["p", "@crystal-care", "projects", "stafferlink-vs-shiftmed.page.md"])).toBe(
      "/note/@crystal-care/projects/stafferlink-vs-shiftmed.page.md",
    );
  });

  test("a percent-encoded handle is read the same", () => {
    expect(recoveredHref(["p", "%40supa", "a.page.md"])).toBe("/note/@supa/a.page.md");
  });

  test("refuses what the note grammar refuses", () => {
    expect(recoveredHref(["p", "supa", "a.page.md"])).toBeNull();
    expect(recoveredHref(["p", "@supa"])).toBeNull();
    expect(recoveredHref(["p", "@supa", "..", "x.md"])).toBeNull();
    expect(recoveredHref(["typo"])).toBeNull();
    expect(recoveredHref([])).toBeNull();
  });
});

test("the website catch-all recovers a page link before its own not-found (Dev2, 2026-11-17)", () => {
  /*
    `/p/@slug/<path>` matches `app/[handle]/[...path].tsx` with `p` as the
    handle, so `+not-found` never saw it: the phone app showed "That link did
    not go anywhere", the web the homepage's "Nothing here". The route asks
    `recoveredHref` with the handle first.
  */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../app/[handle]/[...path].tsx"), "utf8");
  const recovers = source.indexOf("recoveredHref([handle, ...segments])");
  expect(recovers).toBeGreaterThan(-1);
  expect(recovers).toBeLessThan(source.indexOf("homeRedirect([handle, ...segments]"));
  expect(recoveredHref(["p", "@crystal-care", "projects", "stafferlink-vs-shiftmed.page.md"])).toBe("/note/@crystal-care/projects/stafferlink-vs-shiftmed.page.md");
});
