/**
 * LongMemEval retrieval (set (c) of the Search suite): each past session is one dated note in Sam's workspace, and
 * the question finds the answer session's note in the top 5, through a real gateway world with the fake embedder.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { retrievalScores, retrieveQuestion, sessionNotes, slugOf } from "../evals/memoryRetrieval.mjs";
import { embedderFor } from "../evals/searchSuite.mjs";

const item = {
  question_id: "lme-test-1",
  question_type: "single-session-user",
  question: "Which bicycle did I buy for the mountain trail?",
  answer: "A red bicycle",
  question_date: "2023/05/20 (Sat) 02:21",
  answer_session_ids: ["bike-session"],
  haystack_session_ids: ["pancake-session", "bike-session", "Plant Care/2"],
  haystack_dates: ["2023/04/12 (Wed) 09:30", "2023/05/01 (Mon) 10:00", "2023/01/01 (Sun) 10:00"],
  haystack_sessions: [
    [
      { role: "user", content: "How many eggs go in pancakes for six people?" },
      { role: "assistant", content: "Use three eggs, a cup of flour and a cup of milk." },
    ],
    [
      { role: "user", content: "I finally bought a red bicycle for the mountain trail near my house." },
      { role: "assistant", content: "A red bicycle is a great choice for mountain trails." },
    ],
    [
      { role: "user", content: "Water the fern on Tuesdays and keep it out of direct sun." },
      { role: "assistant", content: "Ferns like humidity and indirect light." },
    ],
  ],
};

test("a session's id slugs to a safe file name part", () => {
  assert.equal(slugOf("Plant Care/2"), "plant-care-2");
  assert.equal(slugOf("../../etc"), "etc");
  assert.equal(slugOf("!!!"), "session");
});

test("each past session is a dated, unique note, and the answer session is the expected one", () => {
  const { notes, expect, missing } = sessionNotes(item);
  const addresses = Object.keys(notes);
  assert.equal(addresses.length, 3);
  assert.equal(new Set(addresses).size, 3);
  for (const address of addresses) {
    assert.match(address, /^@sam\/inbox\/sessions\/longmemeval\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
  }
  assert.ok(addresses.includes("@sam/inbox/sessions/longmemeval/2023-05-01-bike-session.md"));
  assert.match(notes["@sam/inbox/sessions/longmemeval/2023-05-01-bike-session.md"], /^---\ntitle: "Chat 2023-05-01"\ndate: 2023-05-01\n---\n\n\*\*User:\*\* I finally bought a red bicycle/);
  assert.deepEqual(expect, ["@sam/inbox/sessions/longmemeval/2023-05-01-bike-session.md"]);
  assert.deepEqual(missing, []);
});

test("two sessions whose ids slug alike on one day get distinct paths", () => {
  const twin = { ...item, haystack_session_ids: ["a b", "a-b", "a_b"], haystack_dates: ["2023/05/01 (Mon) 10:00", "2023/05/01 (Mon) 11:00", "2023/05/01 (Mon) 12:00"], answer_session_ids: ["a-b", "missing-one"] };
  const { notes, expect, missing } = sessionNotes(twin);
  assert.equal(Object.keys(notes).length, 3);
  assert.equal(new Set(Object.keys(notes)).size, 3);
  assert.equal(expect.length, 1);
  assert.deepEqual(missing, ["missing-one"]);
});

test("retrieveQuestion finds the answer session's note in the top 5 and the scores compute", async () => {
  const record = await retrieveQuestion(item, { ai: embedderFor({ fake: true }) });
  assert.equal(record.id, "lme-test-1");
  assert.equal(record.ability, "extraction");
  assert.equal(record.error, null);
  assert.ok(record.rank !== null && record.rank <= 5, `rank ${record.rank}, hits ${record.hits.join(", ")}`);
  assert.equal(record.recallAny5, true);
  assert.equal(record.recallAll5, true);

  const scores = retrievalScores([record]);
  assert.equal(scores.n, 1);
  assert.equal(scores.recallAny5Pct, 100);
  assert.equal(scores.recallAll5Pct, 100);
  assert.equal(scores.byAbility.extraction.n, 1);
  assert.equal(scores.byAbility.extraction.recallAny5Pct, 100);
  assert.equal(typeof scores.top5Pct, "number");
  assert.equal(scores.errors, 0);
});

test("retrievalScores counts a miss and skips questions with no answer notes", () => {
  const records = [
    { id: "a", kind: "multi-session", expect: ["@sam/x.md"], rank: 7, hits: [], recallAny5: false, recallAll5: false, ms: 10 },
    { id: "b", kind: "knowledge-update", expect: ["@sam/y.md"], rank: 1, hits: ["@sam/y.md"], recallAny5: true, recallAll5: true, ms: 20 },
    { id: "c_abs", kind: "single-session-user", expect: [], rank: null, hits: [], recallAny5: false, recallAll5: false, ms: 5 },
  ];
  const scores = retrievalScores(records);
  assert.equal(scores.n, 2);
  assert.equal(scores.recallAny5Pct, 50);
  assert.equal(scores.recallAll5Pct, 50);
  assert.deepEqual(scores.byAbility.multi, { n: 1, recallAny5Pct: 0 });
  assert.deepEqual(scores.byAbility.update, { n: 1, recallAny5Pct: 100 });
  assert.equal(scores.byAbility.abstention, undefined);
});
