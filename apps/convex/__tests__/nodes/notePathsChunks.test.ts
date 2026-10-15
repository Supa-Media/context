/**
 * Link completion's path list for a workspace bigger than Convex lets one
 * array be: an eleven-thousand-note workspace failed every `notePaths` call
 * with "Array length is too long (11153 > 8192)" (2026-10-15, production).
 *
 * convex-test does not enforce that cap (a run with 8,300 paths in `paths`
 * came back intact), so this pins the shape `notePathsAnswer` gives the
 * operation rather than replaying the deployment's refusal.
 *
 * Sabotage: make `notePathsAnswer` return `{ paths }` whatever its length and
 * the chunked case fails.
 */

import { describe, expect, test } from "vitest";
import { notePathsAnswer, NOTE_PATHS_CHUNK } from "../../functions/lib/fileOps/search";

/** Convex's limit on one array in a function's arguments or return value. */
const CONVEX_ARRAY_LIMIT = 8_192;

describe("notePathsAnswer", () => {
  test("a chunk always fits in one Convex array", () => {
    expect(NOTE_PATHS_CHUNK).toBeLessThanOrEqual(CONVEX_ARRAY_LIMIT);
  });

  test("a list that fits goes out as it always did", () => {
    expect(notePathsAnswer(["a.md", "b.md"])).toEqual({ paths: ["a.md", "b.md"] });
    expect(notePathsAnswer(null)).toEqual({ paths: null });
  });

  test("an eleven-thousand-note list goes out in chunks, with paths null for older apps", () => {
    const paths = Array.from({ length: 11_153 }, (_, index) => `2-areas/${index}.md`);
    const answer = notePathsAnswer(paths);
    expect(answer.paths).toBeNull();
    expect(answer.pathChunks!.every((chunk) => chunk.length <= CONVEX_ARRAY_LIMIT)).toBe(true);
    expect(answer.pathChunks!.flat()).toEqual(paths);
  });
});
