/**
 * A folder's tags, and several rows' (boards 14 and 16 of the phone Home
 * artboards, approved by the owner on 2026-09-30): which note carries them,
 * what typing suggests, and what one sheet writes to several notes.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `folderTagTarget` taking the placeholder README.     → "a folder's tags live on its front note"
 *  2. `tagSuggestions` offering tags the folder has.       → "typing suggests what the workspace uses, best first"
 *  3. `tagSuggestions` offering "Add" for a known spelling. → "typing suggests what the workspace uses, best first"
 *  4. `bulkTagTargets` tagging a drawing.                  → "several rows: a note on itself, a folder on its front note"
 *  5. `retagged` dropping tags only some targets had.      → "a tag only some carry is kept where it was"
 *  6. `retagAll` writing targets that did not change.      → "writes only what changed, and stops at the first refusal"
 *  7. `retagAll` carrying on after a refusal.              → "writes only what changed, and stops at the first refusal"
 *  8. A listed front note not yet read treated as absent.  → "nothing is guessed about notes this device has not read"
 *  9. An unread note tagged as if it had no tags.          → "nothing is guessed about notes this device has not read"
 */

import { describe, expect, test } from "@jest/globals";
import {
  bulkTagTargets,
  cleanTag,
  folderTagTarget,
  retagAll,
  retagged,
  sharedTags,
  tagSuggestions,
  tagTargetName,
  workspaceTags,
} from "../features/console/home/folderTags";

const note = (path: string, tags: string[] = [], lede: string | null = null) => ({ path, tags, lede });

describe("a folder's tags", () => {
  test("a folder's tags live on its front note", () => {
    expect(folderTagTarget("", [])).toBeNull();
    // No front note: overview.md, made on the first save.
    expect(folderTagTarget("clients", [note("clients/acme.md", ["x"])])).toEqual({
      path: "clients/overview.md",
      creates: true,
      tags: [],
    });
    // The untouched placeholder New folder wrote is not a front note anyone chose.
    expect(folderTagTarget("clients", [note("clients/README.md", [], "Folder placeholder.")])).toMatchObject({
      path: "clients/overview.md",
      creates: true,
    });
    // A README someone wrote in is.
    expect(folderTagTarget("clients", [note("clients/README.md", ["client"], "Our clients.")])).toEqual({
      path: "clients/README.md",
      creates: false,
      tags: ["client"],
    });
    // overview.md before index.md before README.md.
    expect(
      folderTagTarget("clients", [note("clients/README.md", ["a"], "x"), note("clients/overview.md", ["b"])]),
    ).toMatchObject({ path: "clients/overview.md", tags: ["b"] });
  });

  test("the workspace's tags, busiest first", () => {
    expect(workspaceTags([note("a.md", ["x", "y"]), note("b.md", ["y", "y"]), note("c.md", ["z", "y"])])).toEqual([
      { tag: "y", count: 3 },
      { tag: "x", count: 1 },
      { tag: "z", count: 1 },
    ]);
  });

  test("a typed tag is written as one word", () => {
    expect(cleanTag("  #launch week ")).toBe("launch-week");
    expect(cleanTag("##")).toBe("");
    expect(cleanTag("a, b [c]")).toBe("a-b-c");
  });

  test("typing suggests what the workspace uses, best first", () => {
    const known = [
      { tag: "client", count: 9 },
      { tag: "retainer", count: 4 },
      { tag: "retainers", count: 1 },
      { tag: "pre-retainer", count: 7 },
    ];
    const typed = tagSuggestions("ret", known, ["client"]);
    expect(typed.suggestions.map((one) => one.tag)).toEqual(["retainer", "retainers", "pre-retainer"]);
    expect(typed.add).toBe("ret");
    // Nothing typed: every tag the folder does not have yet.
    expect(tagSuggestions("", known, ["client"]).suggestions.map((one) => one.tag)).not.toContain("client");
    // A spelling that exists is never offered as new, whatever its case.
    expect(tagSuggestions("Retainer", known, []).add).toBeNull();
    expect(tagSuggestions("CLIENT", known, ["client"]).add).toBeNull();
  });
});

describe("nothing is guessed", () => {
  test("nothing is guessed about notes this device has not read", () => {
    // README.md is in the folder's listing, but not in this device's copy yet.
    expect(folderTagTarget("clients", [], ["clients/acme.md", "clients/README.md"])).toBeNull();
    // Listed and read: its tags are known.
    expect(
      folderTagTarget("clients", [note("clients/README.md", ["x"], "Ours.")], ["clients/README.md"]),
    ).toMatchObject({ path: "clients/README.md", tags: ["x"] });
    // Nothing listed as a front note: overview.md is safe to make.
    expect(folderTagTarget("clients", [], ["clients/acme.md"])).toMatchObject({ creates: true });
    // A picked note not read yet is left out rather than written over.
    expect(bulkTagTargets(["clients/unread.md"], [], ["", "clients"])).toEqual([]);
  });
});

describe("tagging several rows", () => {
  const notes = [
    note("clients/acme.md", ["client", "retainer"]),
    note("clients/bolt.md", ["client"]),
    note("clients/north/overview.md", ["client", "lead"]),
  ];
  const folders = ["", "clients", "clients/north"];

  test("several rows: a note on itself, a folder on its front note", () => {
    expect(
      bulkTagTargets(["clients/acme.md", "clients/north", "clients/sketch.excalidraw", "clients/photo.png"], notes, folders),
    ).toEqual([
      { path: "clients/acme.md", creates: false, tags: ["client", "retainer"] },
      { path: "clients/north/overview.md", creates: false, tags: ["client", "lead"] },
    ]);
    expect(tagTargetName("clients/north/overview.md")).toBe("north");
    expect(tagTargetName("clients/acme.md")).toBe("acme");
  });

  test("the sheet starts with the tags they all share", () => {
    const targets = bulkTagTargets(["clients/acme.md", "clients/bolt.md", "clients/north"], notes, folders);
    expect(sharedTags(targets)).toEqual(["client"]);
    expect(sharedTags([])).toEqual([]);
  });

  test("a tag only some carry is kept where it was", () => {
    // Shared was [client]; the sheet took client off and added vip.
    expect(retagged(["client", "retainer"], ["client"], ["vip"])).toEqual(["retainer", "vip"]);
    expect(retagged(["client"], ["client"], ["client", "vip"])).toEqual(["client", "vip"]);
  });

  test("writes only what changed, and stops at the first refusal", async () => {
    const targets = bulkTagTargets(["clients/acme.md", "clients/bolt.md", "clients/north"], notes, folders);
    const written: [string, readonly string[], boolean][] = [];
    const answer = await retagAll({
      targets,
      // Adding retainer: acme has it already, so only bolt and north are written.
      after: ["client", "retainer"],
      save: async (path, tags, create) => {
        written.push([path, tags, create]);
        return null;
      },
    });
    expect(written).toEqual([
      ["clients/bolt.md", ["client", "retainer"], false],
      ["clients/north/overview.md", ["client", "lead", "retainer"], false],
    ]);
    expect(answer).toEqual({
      problem: null,
      changed: [
        { path: "clients/bolt.md", from: ["client"] },
        { path: "clients/north/overview.md", from: ["client", "lead"] },
      ],
    });

    const refused = await retagAll({
      targets,
      after: ["vip"],
      save: async (path) => (path === "clients/bolt.md" ? "Someone changed bolt just now." : null),
    });
    expect(refused.problem).toBe("Someone changed bolt just now.");
    expect(refused.changed.map((one) => one.path)).toEqual(["clients/acme.md"]);
  });
});
