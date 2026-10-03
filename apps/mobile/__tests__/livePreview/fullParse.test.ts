import { describe, expect, test } from "@jest/globals";
import { stateFor, syntaxTree } from "./fixtures";

/**
 * A fixture's state is parsed to the end before any test reads it.
 *
 * `EditorState.create` parses on a time budget and leaves the rest to an
 * editor view, which a test has none of. On a slow CI machine the first test
 * in a file could read a half-built tree: `frontmatterAsMetadata` once saw no
 * list item at all (run 36957051708). A document far too long for that budget
 * makes the same thing happen on any machine.
 *
 * ## Sabotage record
 *
 * Without `ensureSyntaxTree` in `stateFor`, this test fails: the tree stops
 * short of the document.
 */
describe("a fixture state", () => {
  test("is parsed to the end, however long the document", () => {
    const doc = Array.from({ length: 40_000 }, (_, i) => `- item ${i} with **bold** and \`code\``).join("\n");
    const state = stateFor(doc);
    expect(syntaxTree(state).length).toBe(state.doc.length);
  });
});
