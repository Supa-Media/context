import test from "node:test";
import assert from "node:assert/strict";
import { applyMoveOverlay } from "../src/moves/jobs.js";

test("logical move overlay keeps first-job precedence and avoids per-note job scans", () => {
  let sourceReads = 0;
  const objects = Array.from({ length: 600 }, (_, index) => ({
    get source() { sourceReads += 1; return `old/note-${index}.md`; },
    destination: `new/note-${index}.md`,
  }));
  const keys = Array.from({ length: 600 }, (_, index) => ({ key: `old/note-${index}.md`, size: index }));
  const moved = applyMoveOverlay(keys, [
    { objects },
    { objects: [{ source: "old/note-0.md", destination: "wrong/note-0.md" }] },
  ]);
  assert.equal(moved.length, 600);
  assert.deepEqual(moved[0], { key: "new/note-0.md", size: 0, logicalSource: "old/note-0.md" });
  assert.equal(moved[599].key, "new/note-599.md");
  assert.ok(sourceReads <= 1200, `source paths read ${sourceReads} times`);
});
