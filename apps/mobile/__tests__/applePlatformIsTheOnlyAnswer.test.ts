/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * "ONE ANSWER, IN ONE PLACE" WAS NOT TRUE, AND THIS FILE IS WHAT MAKES IT SO.
 *
 * `design/applePlatform` opens by describing the defect it was written to end:
 *
 * > This existed three times before: the keymap binder checked `userAgentData`
 * > with an allowlist, the palette ran a regex over `navigator.platform ||
 * > navigator.userAgent`, and `menu.ts` simply defaulted to `true`. On Windows
 * > they disagreed on the same machine — the binder correctly listened for
 * > `Ctrl`, and the menu printed the Command glyph.
 *
 * **Two of those three were still there**, unchanged, doing exactly what that
 * paragraph says they did. `menu.ts` was converted; the keymap binder kept its
 * own `detectApple` with its own allowlist, and the palette kept its own regex.
 * So the module that exists to end a disagreement was one of three answers, and
 * they disagree on real browsers.
 *
 * Measured four-way before anything was changed — the fourth is the link hint,
 * which is a deliberate exception and is discussed at the bottom:
 *
 * | browser | canonical | binder | palette | link hint |
 * | --- | --- | --- | --- | --- |
 * | macOS, `platform: "MacIntel"` | Apple | Apple | Apple | Apple |
 * | Chromium with a reduced UA on macOS | Apple | Apple | Apple | Apple |
 * | **embedded webview, empty `platform`, iPad UA** | **Apple** | **Ctrl** | Apple | Apple |
 * | **`platform` reported as `"Mac"`** | **Apple** | **Ctrl** | Apple | Apple |
 * | **`platform` reported as `"macintel"`** | **Apple** | **Ctrl** | **Ctrl** | Apple |
 * | iPad in desktop mode | Apple | Apple | Apple | Apple |
 * | Windows | Ctrl | Ctrl | Ctrl | Ctrl |
 * | Linux | Ctrl | Ctrl | Ctrl | Ctrl |
 *
 * The binder is the copy that matters, because **the binder is what actually
 * listens**. On any of those three rows the tab menu printed the Command glyph
 * beside a command whose listener was waiting for `Ctrl` — the precise sentence
 * the module's header claims to have retired.
 *
 * ## What is NOT at stake, because it sets the severity
 *
 * **Nothing is disclosed and no boundary moves.** A wrong answer prints the
 * wrong glyph and binds the wrong chord; it reaches no note, no path, no grant
 * and no credential. What makes it worth closing is that the product already
 * decided this, wrote down why, and then kept two of the three copies.
 *
 * ## Three differences, and why each one is a real browser
 *
 * The binder's set is `{macOS, MacIntel, iPhone, iPad, iPod}` compared
 * **case-sensitively**, with **no user-agent fallback**. The canonical set is
 * lowercased before comparison, includes `mac`, and falls through to the agent
 * when `platform` is empty — each of which was put there for a case the binder
 * therefore still fails:
 *
 *  - **An empty `navigator.platform`.** The binder's own comment concedes the
 *    property is *"empty in a few embedded webviews"*, and then has nothing
 *    behind it. The canonical half reads the agent instead.
 *  - **`"Mac"`.** In the canonical set, not in the binder's.
 *  - **Any case variation.** The canonical half lowercases first.
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens | without this file |
 * | --- | --- | --- |
 * | give the binder its private detector back | **6** | 1 |
 * | give the palette its private regex back | **1** | 0 |
 * | the canonical web half always answers `false` | **24** | 19 |
 * | make the link hint always say `Ctrl` | **3** | 2 |
 *
 * Predicted 3/1/9/1 before running; three of the four were wrong. The table is
 * the run.
 *
 * The second column's lone **1** is not pre-existing coverage — it is this
 * commit's own amendment to `useKeymapWeb.test.ts`, which had frozen the old
 * detector's behaviour (see there). **The honest before-state is simpler and
 * is the claim worth keeping: with all three answers live and disagreeing, the
 * suite was 330 suites and 6,226 tests, fully green.**
 *
 * The binder's own suite pins its detection on `MacIntel`, `macOS` and `Win32`
 * — three inputs every copy *agrees* on — so it could not see a divergence at
 * all. That is the same shape as the auditor this register added for the
 * canonical half an hour earlier, one level up: there the rule had no witness,
 * here the rule had three implementations.
 */

/* -------------------------------------------------------------------------- */
/*                                the harness                                 */
/* -------------------------------------------------------------------------- */

/** By explicit path with the extension: a bare specifier resolves the web half. */
const { useKeymap } = require("../features/design/useKeymap.web") as typeof import("../features/design/useKeymap.web");
const { isApplePlatform } = require("../features/design/applePlatform.web") as typeof import("../features/design/applePlatform.web");
const { followChord } = require("../features/console/files/noteLinks") as typeof import("../features/console/files/noteLinks");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRISTINE = {
  platform: Object.getOwnPropertyDescriptor(navigator, "platform"),
  userAgent: Object.getOwnPropertyDescriptor(navigator, "userAgent"),
};

function browser(platform: string, userAgent: string): void {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
  Reflect.deleteProperty(navigator, "userAgentData");
}

const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  document.body.innerHTML = "";
  if (PRISTINE.platform) Object.defineProperty(navigator, "platform", PRISTINE.platform);
  if (PRISTINE.userAgent) Object.defineProperty(navigator, "userAgent", PRISTINE.userAgent);
  Reflect.deleteProperty(navigator, "userAgentData");
});

/** Mounts the binder and returns the commands it fires. */
function bind(): string[] {
  const seen: string[] = [];
  function Probe(): null {
    useKeymap({ scope: "global", onCommand: (command) => void seen.push(command) });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(root);
  act(() => root.render(createElement(Probe)));
  return seen;
}

function press(init: { key: string; metaKey?: boolean; ctrlKey?: boolean }): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
  });
}

/* -------------------------------------------------------------------------- */
/*                   the binder agrees with the printed glyph                 */
/* -------------------------------------------------------------------------- */

/**
 * Three browsers on which the binder and the canonical answer used to differ.
 * Each is stated as "the canonical answer is Apple here" first, so the test
 * asserts the rule rather than describing the harness.
 */
const APPLE_BROWSERS: Array<[string, string, string]> = [
  ["an embedded webview with no `platform`", "", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"],
  ["a browser reporting `platform` as `Mac`", "Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
  ["a browser lowercasing `platform`", "macintel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
];

describe("the key the binder listens for is the key the menu prints", () => {
  for (const [label, platform, userAgent] of APPLE_BROWSERS) {
    test(`⌘K opens the palette on ${label}`, () => {
      browser(platform, userAgent);
      // The premise, stated rather than assumed: this IS an Apple keyboard by
      // the one answer the menus print from.
      expect(isApplePlatform()).toBe(true);

      const seen = bind();
      press({ key: "k", metaKey: true });
      expect(seen).toEqual(["palette"]);
    });
  }

  test("and Ctrl+K does not, on the same browsers", () => {
    /*
      The anti-vacuity half. A binder that fired `palette` for every K would
      satisfy every assertion above while proving nothing about the modifier —
      and "both chords work" is itself the bug on a Mac, because ⌘K and Ctrl+K
      are different chords rather than aliases.
    */
    for (const [, platform, userAgent] of APPLE_BROWSERS) {
      browser(platform, userAgent);
      const seen = bind();
      press({ key: "k", ctrlKey: true });
      expect(seen).toEqual([]);
    }
  });

  test("and Windows is unaffected in both directions", () => {
    browser("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isApplePlatform()).toBe(false);

    const seen = bind();
    press({ key: "k", metaKey: true });
    expect(seen).toEqual([]);
    press({ key: "k", ctrlKey: true });
    expect(seen).toEqual(["palette"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        and there is only one answer                        */
/* -------------------------------------------------------------------------- */

const FEATURES = join(__dirname, "..", "features");

/**
 * Comments stripped first, and that is not tidiness — it is the same trap this
 * register logged one file earlier.
 *
 * `applePlatform.ts` names both properties in its opening paragraph, because
 * its whole subject is the copies that used to read them. A grep that counted
 * prose would therefore report the canonical module as an offender and, worse,
 * would go on reporting one after every copy was removed — **a guard a comment
 * can trip is a guard a comment can satisfy**, and both directions are useless.
 */
function readsPlatform(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return /navigator[\s\S]{0,80}?[.[]\s*["']?(?:platform|userAgentData)\b/.test(code);
}

/** Every source file under `features/`, so the claim is about all of them. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("only one module decides what an Apple keyboard is", () => {
  test("nothing else reads `navigator.platform` or `userAgentData`", () => {
    /*
      A file-level claim, so reading the source is the right instrument — the
      question is *which files touch a global*, not what a value is. (The
      register's standing warning about source-text assertions is about the
      other case: asserting a configuration's value by grepping for its
      literal, which a comment can satisfy.)

      `navigator.userAgent` is deliberately NOT on this list. It has readers
      that are not platform detection, and one that is — see below.
    */
    const offenders = sourceFiles(FEATURES).filter((path) => {
      if (path.endsWith(join("design", "applePlatform.web.ts"))) return false;
      // Third-party, committed, and held byte-for-byte by its own CI job.
      if (path.endsWith("bundle.generated.ts")) return false;
      return readsPlatform(readFileSync(path, "utf8"));
    });

    expect(offenders.map((path) => path.slice(FEATURES.length + 1))).toEqual([]);
  });

  test("and the link hint is the one deliberate exception, which does not diverge", () => {
    /*
      `followChord` reads the **user agent** and takes it as an argument rather
      than reaching for `navigator` itself. Its docblock argues the choice and
      the argument is sound: *"an iPad with a Magic Keyboard is a Mac here, and
      a Windows browser is not, however the app around it was built"* — the
      editor is a web surface on both hosts, so `Platform.OS` is the wrong
      question there.

      It is exempt because it is a **pure function of its input**, which is what
      makes it testable and what stops it becoming a fourth hidden answer. What
      is asserted here is the thing that would make the exemption cost
      something: that it still agrees with the canonical answer on the browsers
      where the other copies did not.
    */
    for (const [, platform, userAgent] of APPLE_BROWSERS) {
      browser(platform, userAgent);
      expect(isApplePlatform()).toBe(true);
      expect(followChord(userAgent)).toBe("⌘");
    }

    browser("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isApplePlatform()).toBe(false);
    expect(followChord(navigator.userAgent)).toBe("Ctrl");
  });
});
