/**
 * The landing demo's Context-plugin rows are the real ones.
 *
 * `useDemoConsoleData.ts` carries a copy of the catalogue rather than
 * importing it, and its own comment says why: the landing page is a static
 * demo and must not pull the gateway's module into a web bundle for five rows
 * of copy. The same comment promises the copy is faithful — "so the demo
 * cannot show a product that does not exist" — and until this file that
 * promise was a comment.
 *
 * A test may import what a bundle may not, so this compares the two. It is the
 * only place the demo and the gateway meet, and it exists because the failure
 * it catches is silent and outward-facing: the demo is what somebody sees
 * before they have an account, so a row that drifts is the product describing
 * itself wrongly to exactly the person with no way to check.
 */

import { describe, expect, test } from "@jest/globals";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONTEXT_PLUGINS } = require("../../mcp/src/plugins/catalog.js");
import { DEMO_CONTEXT_PLUGINS } from "../features/console/useDemoConsoleData";

type Manifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  context: { defaultEnabled: boolean; tools: string[]; surfaces: string[]; offMeans: string };
};

describe("the landing demo's plugin rows", () => {
  const real = CONTEXT_PLUGINS as Manifest[];

  test("there is one row per built-in, in the same order", () => {
    expect(DEMO_CONTEXT_PLUGINS.map((row) => row.id)).toEqual(real.map((plugin) => plugin.id));
  });

  test("every field a visitor reads is the catalogue's own", () => {
    for (const plugin of real) {
      const row = DEMO_CONTEXT_PLUGINS.find((candidate) => candidate.id === plugin.id);
      expect(row).toBeDefined();
      expect(row!.name).toBe(plugin.name);
      expect(row!.description).toBe(plugin.description);
      expect(row!.version).toBe(plugin.version);
      expect(row!.author).toBe(plugin.author);
      expect(row!.tools).toEqual(plugin.context.tools);
      expect(row!.surfaces).toEqual(plugin.context.surfaces);
      // The consequence of turning it off is the sentence somebody decides on,
      // and the one an out-of-date demo would most plausibly still be showing.
      expect(row!.offMeans).toBe(plugin.context.offMeans);
    }
  });

  test("a row switched off in the demo is still a plugin that ships on", () => {
    // The demo turns one row off to show what the control looks like. That is
    // presentation, so `enabled` is deliberately NOT compared above — but
    // `defaultEnabled` is a fact about the product and is.
    for (const plugin of real) {
      const row = DEMO_CONTEXT_PLUGINS.find((candidate) => candidate.id === plugin.id);
      expect(row!.defaultEnabled).toBe(plugin.context.defaultEnabled);
    }
  });
});
