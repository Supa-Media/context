/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";

/**
 * `jest-environment-jsdom` does not expose `TextEncoder`/`TextDecoder` as
 * globals on its own — measured directly, not assumed — and `jest.setup.js`
 * is what fills that in for every test file, jsdom-backed ones included; see
 * its own comment for the regression this closes: 26 suites failed on a bare
 * `ReferenceError` the moment `BrowsePane` learned to import
 * `@context/communications` transitively, none of them about anything this
 * package does. This pins the actual behaviour that depends on it — the
 * package can be required, and a day can be parsed back — under the real
 * jsdom environment the console's own render tests run in, rather than
 * trusting that the setup file keeps doing its job invisibly.
 */
describe("importing the communications console under jsdom", () => {
  test("TextEncoder is available — jest.setup.js filled the gap jsdom leaves", () => {
    expect(typeof globalThis.TextEncoder).toBe("function");
  });

  test("the package can be required and used", () => {
    const { parseChannelDayMessages } = require("@context/communications") as typeof import("@context/communications");
    const note = [
      "---",
      'type: "channel-day"',
      "---",
      "",
      "# 2026-09-07",
      "",
      "## Thread — Hello",
      "",
      "### 09:00 · Someone · Hello {#msg-0123456789abcdef}",
      "",
      "<!-- context:untrusted-communication begin nonce -->",
      "",
      "hi",
      "",
      "<!-- context:untrusted-communication end nonce -->",
      "",
    ].join("\n");
    expect(parseChannelDayMessages(note).messages).toHaveLength(1);
  });

  test("the console's own screens import cleanly too", () => {
    expect(() => require("../features/console/panes/BrowsePane")).not.toThrow();
  });

  test("the demo fixture — which computes a real message anchor at load — imports cleanly", () => {
    expect(() => require("../features/console/placeholderData")).not.toThrow();
  });
});
