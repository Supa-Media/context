/**
 * WHAT A WRITE TELLS THE AGENT ABOUT THE CHAOS SCORE.
 *
 *  1. The score before and after, in whole numbers, with a verdict that
 *     still says which way a change smaller than one point went.
 *  2. The folders the change touched, with what their size means.
 *  3. A team reader is never told about a folder they cannot see into.
 *  4. The lines are added to the answer without losing what the handler hid on it.
 *  5. A slow rescore never holds the answer up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chaosLines, withChaosLines, within } from "../src/chaos/report.js";
import { withActivityHint, activityHintOf } from "../src/live/activityHint.js";

const row = (folder, items, sum, weight, team = {}) => ({
  folder,
  items,
  sum,
  weight,
  team_exists: team.exists ?? 1,
  team_items: team.items ?? items,
  team_sum: team.sum ?? sum,
  team_weight: team.weight ?? weight,
});

test("the score before and after, with which way a small change went", () => {
  const text = chaosLines(
    {
      before: { all: 24.31, team: 20 },
      after: { all: 24.4, team: 20 },
      folders: [{ folder: "1-projects/backlog", before: row("1-projects/backlog", 27, 27 * 81, 27), after: row("1-projects/backlog", 28, 28 * 84, 28) }],
    },
    "all",
  );
  assert.match(text, /^chaos: 24 → 24 of 100 \(a little messier; lower is calmer\)/);
  assert.match(text, /1-projects\/backlog: 27 → 28 items \(chaotic: calm is 4 to 5, 10 is average\)/);
});

test("calmer, thin and gone folders read plainly", () => {
  const text = chaosLines(
    {
      before: { all: 30, team: 30 },
      after: { all: 28, team: 28 },
      folders: [
        { folder: "a", before: row("a", 3, 15, 3), after: row("a", 2, 40, 2) },
        { folder: "b", before: row("b", 1, 40, 1), after: null },
      ],
    },
    "all",
  );
  assert.match(text, /30 → 28 of 100 \(calmer/);
  assert.match(text, /a: 3 → 2 items \(thin: calm is 4 to 5\)/);
  assert.match(text, /b: gone/);
});

test("a team reader is never told about a folder with nothing they can open", () => {
  const text = chaosLines(
    {
      before: { all: 30, team: 10 },
      after: { all: 31, team: 10 },
      folders: [{ folder: "2-areas/private", before: row("2-areas/private", 3, 15, 3, { exists: 0 }), after: row("2-areas/private", 4, 0, 4, { exists: 0 }) }],
    },
    "team",
  );
  assert.equal(text, "chaos: 10 → 10 of 100 (no change; lower is calmer)");
});

test("nothing to say, nothing added", () => {
  assert.equal(chaosLines(null, "all"), "");
  const result = { content: [{ type: "text", text: "saved" }] };
  assert.equal(withChaosLines(result, ""), result);
  const error = { isError: true, content: [{ type: "text", text: "no" }] };
  assert.equal(withChaosLines(error, "chaos: 1 → 2"), error);
});

test("the lines join the answer and the handler's hidden hint survives", () => {
  const result = withActivityHint({ content: [{ type: "text", text: "saved: a.md" }] }, { created: true });
  const next = withChaosLines(result, "chaos: 1 → 2 of 100");
  assert.equal(next.content[0].text, "saved: a.md\nchaos: 1 → 2 of 100");
  assert.deepEqual(activityHintOf(next), { created: true });
});

test("a slow rescore never holds the answer up", async () => {
  const started = Date.now();
  const value = await within(new Promise(() => {}), 50);
  assert.equal(value, null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await within(Promise.reject(new Error("x")), 50), null);
  assert.equal(await within(Promise.resolve(7), 50), 7);
});
