/**
 * HOW TEX EXPLAINS CONTEXT (Dev2, 2026-11-25, "Tex PR training"). Asked "what is context?", Tex answered that it is
 * "your Obsidian-style vault of notes, organized into Projects, Areas, Resources and Archive": the person's own
 * about-me line, because What Context is said what Context is made of and never what it does for a person.
 *
 * Sabotage record (2026-11-25), applied, this file run, named test failing, reverted:
 *  1. about-tex.md's old What Context is put back → "Tex has a plain pitch…" fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { wordsOf } from "../../../scripts/tex-prompt-module.mjs";

test("Tex has a plain pitch, and the person's own setup is never what Context is", () => {
  const about = wordsOf()["about-tex"];
  assert.match(about, /a memory that's theirs, that they can text, and that every AI they use can read/);
  assert.match(about, /never what Context is/);
  assert.match(about, /use everyday examples/, "someone Tex knows nothing about gets everyday examples");
  assert.match(about, /guides\/what-is-context\.md/, "details come from the guides");
  assert.doesNotMatch(about, /Obsidian|PARA/, "the pitch never plants another app's or a method's name");
  assert.match(wordsOf().working, /one way to organise, never what Context is/);
});

