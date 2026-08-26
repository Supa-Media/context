import { describe, expect, test } from "@jest/globals";
import { PARA_FOLDERS } from "@context/convex/functions/lib/scaffold";
import {
  MAX_CUSTOM_FOLDERS,
  addFolderRow,
  canAddFolderRow,
  canApplyStructure,
  describeOutcome,
  emptyCustomFolders,
  hasFolderErrors,
  paraFolderLines,
  removeFolderRow,
  setFolderRow,
  structureStepFor,
  toApplyStructureArgs,
  toFolderSpecs,
  validateCustomFolders,
  type CustomFolderRow,
} from "../features/onboarding/structure";

const rows = (...names: string[]): CustomFolderRow[] =>
  names.map((name) => ({ name, description: "" }));

describe("whether to ask at all", () => {
  test("a bucket that already holds a context is reported, not questioned", () => {
    // The most valuable thing this product can do for an existing vault is
    // nothing at all.
    expect(structureStepFor("existing-context")).toEqual({ kind: "existing" });
  });

  test("an empty bucket gets the question", () => {
    expect(structureStepFor("created")).toEqual({ kind: "ask" });
  });

  test("a backend that does not report a reason yet falls back to asking", () => {
    // Asking unnecessarily costs a question. Not asking when we should have
    // leaves somebody with an empty bucket and no folders, and the scaffolder
    // refuses to overwrite anything either way.
    expect(structureStepFor(undefined)).toEqual({ kind: "ask" });
    expect(structureStepFor("not-attempted")).toEqual({ kind: "ask" });
    expect(structureStepFor("failed")).toEqual({ kind: "ask" });
  });
});

describe("the PARA lines", () => {
  test("every folder the control plane creates has a line to render", () => {
    // A folder added upstream must fail here rather than render a blank row.
    for (const { folder, line } of paraFolderLines()) {
      expect(PARA_FOLDERS).toContain(folder);
      expect(line.length).toBeGreaterThan(0);
    }
    expect(paraFolderLines()).toHaveLength(PARA_FOLDERS.length);
  });

  test("the folders are the real ones, in the real order", () => {
    expect(paraFolderLines().map((entry) => entry.folder)).toEqual([...PARA_FOLDERS]);
  });
});

describe("the custom rows", () => {
  test("a blank row is dropped, not rejected", () => {
    // "Custom with no folders" is a real answer: index.md, privacy.md, and a
    // shape you make yourself.
    expect(validateCustomFolders(emptyCustomFolders())).toEqual({});
    expect(toFolderSpecs(emptyCustomFolders())).toEqual([]);
  });

  test("a plain name is fine", () => {
    expect(validateCustomFolders(rows("notes", "Clients", "reading list"))).toEqual({});
  });

  test("a slash is refused, because it would quietly nest", () => {
    const errors = validateCustomFolders(rows("work/clients"));
    expect(errors[0]).toMatch(/no slashes/i);
  });

  test("a leading dot is refused, because the gateway would hide it", () => {
    const errors = validateCustomFolders(rows(".secret"));
    expect(errors[0]).toMatch(/hidden/i);
  });

  test("duplicates are caught regardless of case", () => {
    const errors = validateCustomFolders(rows("Notes", "notes"));
    expect(errors[1]).toMatch(/already have a folder/i);
    // The first one is the keeper; only the later row is flagged.
    expect(errors[0]).toBeUndefined();
  });

  test("an over-long name is refused", () => {
    expect(validateCustomFolders(rows("a".repeat(65)))[0]).toMatch(/under 64/i);
  });

  test("past the cap, the surplus rows are the ones flagged", () => {
    const many = rows(...Array.from({ length: MAX_CUSTOM_FOLDERS + 2 }, (_, i) => `f${i}`));
    const errors = validateCustomFolders(many);
    expect(errors[MAX_CUSTOM_FOLDERS]).toBeDefined();
    expect(errors[MAX_CUSTOM_FOLDERS + 1]).toBeDefined();
    expect(errors[0]).toBeUndefined();
    expect(hasFolderErrors(errors)).toBe(true);
  });

  test("trims on the way out, and keeps the descriptions", () => {
    expect(
      toFolderSpecs([
        { name: "  notes  ", description: "  things I wrote  " },
        { name: "", description: "orphan description" },
      ]),
    ).toEqual([{ folder: "notes", description: "things I wrote" }]);
  });
});

describe("editing the rows", () => {
  test("adding stops at the cap rather than validating afterwards", () => {
    let current: CustomFolderRow[] = emptyCustomFolders();
    while (canAddFolderRow(current)) current = addFolderRow(current);
    expect(current).toHaveLength(MAX_CUSTOM_FOLDERS);
    expect(addFolderRow(current)).toHaveLength(MAX_CUSTOM_FOLDERS);
  });

  test("removing never empties the editor completely", () => {
    const one = removeFolderRow(rows("only"), 0);
    expect(one).toEqual([{ name: "", description: "" }]);
  });

  test("removing takes out the row asked for", () => {
    expect(removeFolderRow(rows("a", "b", "c"), 1).map((r) => r.name)).toEqual(["a", "c"]);
  });

  test("setting one field leaves the other, and the other rows, alone", () => {
    const next = setFolderRow(rows("a", "b"), 1, { description: "second" });
    expect(next[1]).toEqual({ name: "b", description: "second" });
    expect(next[0]).toEqual({ name: "a", description: "" });
  });
});

describe("the call", () => {
  test("PARA omits the folder list rather than sending an empty one", () => {
    // PARA brings its own folders, and the mutation refuses `para` *with* a
    // list rather than quietly dropping it.
    const args = toApplyStructureArgs("w1", "para", rows("ignored"));
    expect(args).toEqual({ workspaceId: "w1", template: "para" });
    expect("folders" in args).toBe(false);
  });

  test("the template travels as `template`, which is the argument the mutation takes", () => {
    // `structureTemplate` is the column `applyStructure` *writes*, not the
    // argument it accepts — that key is rejected by the argument validator.
    expect("structureTemplate" in toApplyStructureArgs("w1", "para", [])).toBe(false);
    expect("structureTemplate" in toApplyStructureArgs("w1", "custom", rows("notes"))).toBe(
      false,
    );
  });

  test("custom sends what was filled in", () => {
    // This is the only path anything typed into the folder editor takes to a
    // server. If it does not appear here, the editor does nothing at all.
    expect(
      toApplyStructureArgs("w1", "custom", [
        { name: "notes", description: "everything I write" },
        { name: "", description: "" },
      ]),
    ).toEqual({
      workspaceId: "w1",
      template: "custom",
      folders: [{ folder: "notes", description: "everything I write" }],
    });
  });
});

describe("whether there is anything to send", () => {
  test("PARA is always ready", () => {
    expect(canApplyStructure("para", emptyCustomFolders(), {})).toBe(true);
  });

  test("custom with a folder is ready", () => {
    expect(canApplyStructure("custom", rows("notes"), {})).toBe(true);
  });

  test("custom with nothing typed is not — the control plane refuses that", () => {
    // `applyStructure`: "Name at least one folder, or choose the standard
    // layout." The screen used to promise the opposite, so following the
    // instruction on it earned a refusal.
    expect(canApplyStructure("custom", emptyCustomFolders(), {})).toBe(false);
  });

  test("a row with an error holds the button", () => {
    const bad = rows("work/clients");
    expect(canApplyStructure("custom", bad, validateCustomFolders(bad))).toBe(false);
  });
});

describe("what it says it will do", () => {
  test("PARA counts the real folders", () => {
    expect(describeOutcome("para", [])).toContain(String(PARA_FOLDERS.length));
  });

  test("custom counts what was typed, and says so in the singular", () => {
    expect(describeOutcome("custom", rows("notes"))).toMatch(/\b1 folder\b/);
    expect(describeOutcome("custom", rows("a", "b"))).toMatch(/\b2 folders\b/);
  });

  test("custom with no folders asks for one rather than promising two files", () => {
    // The old sentence — "just index.md and privacy.md" — described a request
    // the control plane refuses outright.
    expect(describeOutcome("custom", emptyCustomFolders())).toMatch(/at least one folder/i);
  });
});
