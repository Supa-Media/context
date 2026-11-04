import { test } from "node:test";
import assert from "node:assert/strict";

import { mostRecent } from "../src/orient/render.js";

// `mostRecent` keeps the newest few in one pass instead of sorting every note (src/orient/render.js); its answer is
// the full sort's, ties and missing dates included. Sabotage: drop the splice's tie check (`< 0` to `<= 0`) and the
// order of equal notes differs.
test("mostRecent answers what sorting every note answers", () => {
  const sorted = (notes, limit) =>
    notes
      .filter((note) => note.uploaded instanceof Date && !Number.isNaN(note.uploaded.getTime()))
      .sort((a, b) => b.uploaded - a.uploaded || a.key.localeCompare(b.key))
      .slice(0, limit);
  let seed = 3;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  for (let round = 0; round < 2000; round += 1) {
    const notes = Array.from({ length: next() % 30 }, (_, index) => ({
      key: `k${next() % 10}`,
      id: index,
      uploaded: next() % 7 === 0 ? null : new Date(next() % 5),
    }));
    const limit = next() % 10;
    assert.deepEqual(mostRecent(notes, limit), sorted(notes, limit));
  }
});
