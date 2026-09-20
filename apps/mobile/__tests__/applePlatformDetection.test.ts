/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/**
 * IS THIS AN APPLE KEYBOARD — THE ONE ANSWER, AND UNTIL THIS FILE NOTHING HELD
 * IT.
 *
 * `applePlatform` exists because the question used to be answered in three
 * places that disagreed: the keymap binder read `userAgentData` with an
 * allowlist, the palette ran a regex over `navigator.platform || userAgent`,
 * and the tab menu simply assumed Apple. On Windows the binder correctly
 * listened for `Ctrl` while the menu printed the Command glyph beside the same
 * row. Its own header states the cost of that, and it is the reason to hold
 * this rather than shrug at it: **a shortcut printed beside a menu row is a
 * promise, and one naming a key that does nothing is a lie with no way to
 * diagnose it.**
 *
 * ## What is NOT at stake, because it sets the severity
 *
 * **Nothing is disclosed and no boundary moves.** A wrong answer here prints
 * the wrong modifier glyph and binds the wrong chord; it reaches no note, no
 * path and no grant. This is a guard-coverage file, not a defect report — the
 * code was measured and every stance below already held.
 *
 * ## Why it was unheld, which is the part worth copying
 *
 * The one test that imported this function opened with
 * `const APPLE = isApplePlatform()` and compared the menu's glyphs against it —
 * deliberately, and for a good reason its own comment records: hardcoding
 * `true` there had printed the Command glyph beside a row whose chord under
 * jsdom is `Ctrl`. The fix was right, and it made most of that file's
 * assertions **self-referential**: expectation and subject became the same
 * call, so they move together and the function can be inverted with both still
 * agreeing.
 *
 * Its one absolute — `expect(APPLE).toBe(false)` — is a statement about the
 * **harness**, not about the rule, which is why it holds a single direction and
 * is blind to every stance below.
 *
 * That file is a **consumer** of the rule and should go on sharing its source;
 * nothing in it is changed here. What was missing is an **auditor**, which has
 * to restate the rule from the outside — here, by setting the environment and
 * saying what the answer must be.
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens | reddened before |
 * | --- | --- | --- |
 * | the web half always answers `false` | **6** | 0 |
 * | the web half always answers `true` | **5** | **1** |
 * | drop the empty-`userAgentData` fall-through | **1** | 0 |
 * | drop the `userAgentData` try/catch | **1** | 0 |
 * | drop the legacy try/catch | **1** | 0 |
 * | the native half inverted | **2** | 0 |
 *
 * The first column was predicted as 9/6/2/1/1/2 and three of those were wrong;
 * the table is the run. **Numbers written before a measurement are guesses.**
 *
 * And the named set is held **member by member**, not in aggregate: dropping
 * any one of `macos`, `macintel`, `iphone`, `ipad`, `ipod` or `mac` reddens
 * exactly **1**, six times over. An aggregate assertion would have let five of
 * the six go.
 *
 * ## The "before" column is the finding, and it is asymmetric
 *
 * Five of the six were **0**: with the web half returning `false`
 * unconditionally *and* the native half inverted, the pre-existing suite is 329
 * suites and 6,215 tests, fully green.
 *
 * The sixth was **1**, and finding out which one it was is what makes this file
 * worth its length. `tabMenu.test.ts` opens its non-Apple case with
 * `expect(APPLE).toBe(false)` — an assertion about **what jsdom is**, not about
 * what the rule says. It therefore catches exactly one direction: answering
 * Apple where the environment is not. **The other direction had nothing**, and
 * the other direction is the one this module was written to prevent — the
 * three-way disagreement it replaced ended with a Mac being told `Ctrl`. A
 * guard that only holds the half the harness happens to disagree with is a
 * guard for the harness.
 */

/* -------------------------------------------------------------------------- */
/*                                   web                                      */
/* -------------------------------------------------------------------------- */

/** By explicit path on both halves: a bare import resolves only one of them. */
const web = require("../features/design/applePlatform.web") as {
  isApplePlatform: () => boolean;
};

/** jsdom defines these on the prototype, so a plain assignment does nothing. */
function set(key: "platform" | "userAgentData" | "userAgent", value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true });
}

function setThrowing(key: "platform" | "userAgentData"): void {
  Object.defineProperty(navigator, key, {
    get() {
      throw new Error("this getter throws, as some embedded webviews do");
    },
    configurable: true,
  });
}

const PRISTINE = {
  platform: navigator.platform,
  userAgent: navigator.userAgent,
};

afterEach(() => {
  set("platform", PRISTINE.platform);
  set("userAgent", PRISTINE.userAgent);
  // `userAgentData` does not exist in jsdom; restore its absence rather than
  // leaving the last test's object behind for the next one.
  Reflect.deleteProperty(navigator, "userAgentData");
  jest.resetModules();
});

describe("the modern answer is preferred, and is not the only one", () => {
  test("`userAgentData` wins over the deprecated `platform`", () => {
    set("userAgentData", { platform: "macOS" });
    set("platform", "Win32");
    expect(web.isApplePlatform()).toBe(true);

    set("userAgentData", { platform: "Windows" });
    set("platform", "MacIntel");
    expect(web.isApplePlatform()).toBe(false);
  });

  test("AND AN EMPTY MODERN ANSWER FALLS THROUGH RATHER THAN MEANING 'NOT APPLE'", () => {
    /*
      The named regression, in the file's own words: this is "the case that made
      an earlier version answer `Ctrl` on a Mac". An empty string is the browser
      declining to say, not a denial, and reading it as one is a wrong answer on
      exactly the machines the glyph matters most on.
    */
    set("userAgentData", { platform: "" });
    set("platform", "MacIntel");
    expect(web.isApplePlatform()).toBe(true);
  });

  test("and a missing modern answer falls through too", () => {
    set("userAgentData", {});
    set("platform", "MacIntel");
    expect(web.isApplePlatform()).toBe(true);
  });
});

describe("neither read may take the app down on the first keystroke", () => {
  test("a `userAgentData` getter that throws falls through to the legacy one", () => {
    setThrowing("userAgentData");
    set("platform", "MacIntel");
    expect(web.isApplePlatform()).toBe(true);
  });

  test("and a `platform` getter that throws answers `false` rather than throwing", () => {
    /*
      The stance the file states for itself: this runs on the first keystroke,
      so a throw here takes the whole app down before anybody can report why.
      `false` is also the safe direction — the non-Apple chord is what every
      other platform already expects.
    */
    setThrowing("platform");
    expect(web.isApplePlatform()).toBe(false);
  });
});

describe("the set of names that mean Apple, every member of it", () => {
  test("each name is recognised, whatever its case", () => {
    for (const name of ["macos", "macintel", "iphone", "ipad", "ipod", "mac"]) {
      set("platform", name);
      expect(web.isApplePlatform()).toBe(true);
      set("platform", name.toUpperCase());
      expect(web.isApplePlatform()).toBe(true);
    }
  });

  test("and a name outside it is not, including ones that merely contain a member", () => {
    /*
      `Set.has` is an exact comparison and that is the property worth pinning:
      a substring rule would answer Apple for `Linux x86_64 (macbook-alike)` and
      for every future platform string with those three letters inside it.
    */
    for (const name of ["win32", "windows", "linux x86_64", "android", "macintosh-alike", "x11"]) {
      set("platform", name);
      expect(web.isApplePlatform()).toBe(false);
    }
  });
});

describe("the last resort, which is the user agent", () => {
  test("an empty `platform` falls through to the user agent", () => {
    set("platform", "");
    set("userAgent", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)");
    expect(web.isApplePlatform()).toBe(true);
  });

  test("and jsdom's own user agent is not an Apple one", () => {
    /*
      The anti-vacuity half. jsdom's default agent carries `AppleWebKit`, which
      contains neither `Mac` nor any device name — so the regex declining it is
      a real decision rather than an empty haystack, and this is the environment
      every other test in this suite runs the console under.
    */
    set("platform", "");
    expect(web.isApplePlatform()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  native                                    */
/* -------------------------------------------------------------------------- */

describe("the native half, which is settled at build time", () => {
  /*
      Nothing executed this half at all: the resolver in `jest.config.js` serves
      `.web.ts` first, so a bare import of this module anywhere in the suite
      mounts the browser answer and the one that ships to iOS and Android runs
      in no test. It is three tokens long, and three tokens is enough to get
      backwards.
  */
  function osAnswers(os: string): boolean {
    jest.resetModules();
    jest.doMock("react-native", () => ({ Platform: { OS: os } }));
    // WITH THE EXTENSION. `require("…/applePlatform")` is still a bare
    // specifier and the resolver serves `.web.ts` for it — which answered
    // `false` for every OS handed in here and passed half of these tests
    // while proving nothing about the file they name.
    const native = require("../features/design/applePlatform.ts") as {
      isApplePlatform: () => boolean;
    };
    return native.isApplePlatform();
  }

  test("iOS and macOS are Apple keyboards", () => {
    expect(osAnswers("ios")).toBe(true);
    expect(osAnswers("macos")).toBe(true);
  });

  test("and Android, Windows and the web build are not", () => {
    expect(osAnswers("android")).toBe(false);
    expect(osAnswers("windows")).toBe(false);
    expect(osAnswers("web")).toBe(false);
  });
});
