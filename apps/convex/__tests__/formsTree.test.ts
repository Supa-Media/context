/**
 * A form answer reaches the Convex tree at once: the response file is written
 * inside the form operation, so only its answer names it (`indexChangeOf`).
 */

import { afterEach, expect, test, vi } from "vitest";
import { RESPONSES, fixture, submit } from "./keyedFixture.forms.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the response file's new version reaches the Convex tree at once", async () => {
  // Sabotage: drop `form` from `indexChangeOf` and the tree keeps the version
  // from before the answer until the next sweep.
  const f = await fixture();
  const logged = async () =>
    (await f.t.run(async (ctx) => await ctx.db.query("nodeLog").collect())).filter((row) => row.path === RESPONSES && !row.gone).length;
  const before = await logged();
  await submit(f, f.member, { summary: "Search is slow" });
  expect(await logged()).toBe(before + 1);
});
