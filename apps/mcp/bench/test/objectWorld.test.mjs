/**
 * The Search suite's object world (`evals/objectWorld.mjs`): the bench's workspaces in workspace objects, searched
 * through the gateway as a person, answered by the object's own index, and read only as that person may read.
 *
 * Sabotage record (temporary local edits, reverted; each fails the named test):
 *   `rulesOf` makes every shared note team, held back or not   -> "a held-back note ..." fails
 *   `reach.put` lists every person's rows for every person      -> "a held-back note ..." fails ("another person's ..."
 *                                                                  still passes: Ade's object refuses Sam by its own members)
 *   the binding's `notesHome` is "bucket"                       -> "a search is answered by the object" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createObjectWorld } from "../evals/objectWorld.mjs";
import { objectScores } from "../evals/searchSuite.mjs";
import { cachedEmbeddings, fakeAi } from "../models.mjs";
import { hitsOf } from "../search.mjs";

const bench = () => ({
  people: [
    { person: "Sam", workspace: "sam", personal: true, role: "owner" },
    { person: "Sam", workspace: "club", personal: false, role: "member" },
    { person: "Ade", workspace: "ade", personal: true, role: "owner" },
    { person: "Ade", workspace: "club", personal: false, role: "owner" },
  ],
  workspaces: {
    sam: { files: { "notes/kayak-trip.md": "# Kayak trip\n\nPaddles, dry bags and the tide table for the kayak trip.\n" }, heldBack: [], generated: [] },
    club: {
      files: { "events/quiz-night.md": "# Quiz night\n\nThe quiz night is on the last Friday, kayak raffle at the break.\n", "money/treasurer-secret.md": "# Treasurer\n\nThe kayak fund balance, for the treasurer only.\n" },
      heldBack: ["money/treasurer-secret.md"],
      generated: [],
    },
    ade: { files: { "diary/kayak-dream.md": "# Kayak dream\n\nAde's private kayak plans.\n" }, heldBack: [], generated: [] },
  },
});

async function searched(world, person, query) {
  const traces = [];
  const log = console.log;
  console.log = (line, ...rest) => (typeof line === "string" && line.startsWith('{"event":"search"') ? traces.push(JSON.parse(line)) : log(line, ...rest));
  try {
    const answer = await world.search(person, query);
    return { ...answer, hits: answer.ok ? hitsOf(answer.text, `@${person.toLowerCase()}`) : [], traces };
  } finally {
    console.log = log;
  }
}

test("a search is answered by the object, across the workspaces the person reaches", async () => {
  const world = await createObjectWorld(bench(), { ai: cachedEmbeddings(fakeAi()) });
  try {
    const answer = await searched(world, "Sam", "kayak");
    assert.equal(answer.ok, true, answer.text);
    assert.ok(answer.hits.includes("@sam/notes/kayak-trip.md"), answer.hits.join(", "));
    assert.ok(answer.hits.includes("@club/events/quiz-night.md"), answer.hits.join(", "));
    assert.ok(answer.traces.length > 0 && answer.traces.every((t) => t.objectSearch === "served"), JSON.stringify(answer.traces.map((t) => t.objectSearch)));
  } finally {
    world.close();
  }
});

test("a held-back note in a shared workspace is not found by a member, and is by its owner", async () => {
  const world = await createObjectWorld(bench(), { ai: cachedEmbeddings(fakeAi()) });
  try {
    assert.ok(!(await searched(world, "Sam", "treasurer kayak fund")).hits.includes("@club/money/treasurer-secret.md"));
    assert.ok((await searched(world, "Ade", "treasurer kayak fund")).hits.includes("@club/money/treasurer-secret.md"));
  } finally {
    world.close();
  }
});

test("another person's personal workspace is never searched", async () => {
  const world = await createObjectWorld(bench(), { ai: cachedEmbeddings(fakeAi()) });
  try {
    const hits = (await searched(world, "Sam", "kayak dream private plans")).hits;
    assert.ok(!hits.some((hit) => hit.startsWith("@ade/")), hits.join(", "));
  } finally {
    world.close();
  }
});

test("object scores count where the object's rank was the same, better or worse", () => {
  const records = [
    { id: "a", expect: ["x"], rank: 1, ms: 1, object: { rank: 1, hits: ["x"], ms: 1 } },
    { id: "b", expect: ["x"], rank: 2, ms: 1, object: { rank: 1, hits: ["x"], ms: 1 } },
    { id: "c", expect: ["x"], rank: 1, ms: 1, object: { rank: null, hits: [], ms: 1 } },
  ];
  const s = objectScores(records);
  assert.deepEqual([s.first, s.same, s.better, s.worse], [2, 1, 1, 1]);
});
