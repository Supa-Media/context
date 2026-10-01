import { describe, expect, test } from "@jest/globals";
import { noteProperties } from "../../mcp/src/lists.js";
import { liveHomeTree } from "../features/home/homeSite";
import { addTask, ensureFolder, findPath, setStatus } from "../features/home/castWorkspace";
import { addNote } from "../features/home/localTree";

/*
  What a chat scene's assistant does to the homepage's tree (Dev2,
  2026-09-30): folders appear, notes are filed and renamed, and a project's
  status changes where a List reads it.
*/

const { tree: site } = liveHomeTree([
  { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome" },
  { path: "Legal/privacy.md", routePath: "/Legal/privacy", title: "Privacy", markdown: "# Privacy" },
]);

function withProjects() {
  const made = ensureFolder(site, "1-projects/beta-launch")!;
  return made.tree;
}

describe("finding what a script names", () => {
  const tree = withProjects();

  test("by its path, in any case, or by its last name the way people say it", () => {
    expect(findPath(tree, "1-projects/beta-launch")).toBe("1-projects/beta-launch");
    expect(findPath(tree, "1-Projects/Beta-Launch")).toBe("1-projects/beta-launch");
    expect(findPath(tree, "beta-launch")).toBe("1-projects/beta-launch");
    expect(findPath(tree, "Beta launch")).toBe("1-projects/beta-launch");
    expect(findPath(tree, "projects/beta launch")).toBe("1-projects/beta-launch");
    expect(findPath(tree, "privacy")).toBe("02-Legal/01-Privacy.md");
    expect(findPath(tree, "welcome")).toBe("01-Welcome.md");
  });

  test("never guesses: a name nothing has is nothing", () => {
    expect(findPath(tree, "launch")).toBeNull();
    expect(findPath(tree, "")).toBeNull();
    expect(findPath(tree, "privacy", "folder")).toBeNull();
  });

  test("the shallowest of two with the same name", () => {
    const both = ensureFolder(tree, "4-archive/beta-launch")!.tree;
    expect(findPath(both, "beta-launch")).toBe("1-projects/beta-launch");
  });
});

describe("folders", () => {
  test("made with every folder above them that is missing, each listed in its parent", () => {
    const made = ensureFolder(site, "1-projects/beta-launch/research")!;
    expect(made.path).toBe("1-projects/beta-launch/research");
    expect(made.tree.listings[""]!.entries.map((entry) => entry.path)).toContain("1-projects");
    expect(made.tree.listings["1-projects"]!.entries.map((entry) => entry.path)).toEqual(["1-projects/beta-launch"]);
    expect(made.tree.listings["1-projects/beta-launch/research"]!.entries).toEqual([]);
  });

  test("a folder already there, however it was written, is used rather than doubled", () => {
    const tree = withProjects();
    const again = ensureFolder(tree, "Projects/Beta launch")!;
    expect(again.path).toBe("1-projects/beta-launch");
    expect(again.tree).toBe(tree);
  });

  test("a note in the way is not turned into a folder", () => {
    expect(ensureFolder(site, "01-Welcome.md/inside")).toBeNull();
  });
});

describe("statuses", () => {
  test("a folder with no front note becomes a project: an overview, titled, with the status", () => {
    const made = setStatus(withProjects(), "1-projects/beta-launch", "in progress")!;
    expect(made.path).toBe("1-projects/beta-launch/overview.md");
    expect(noteProperties(made.tree.notes[made.path]!)).toEqual({ status: "in progress" });
    expect(made.tree.notes[made.path]).toContain("# Beta launch");
  });

  test("a folder's front note keeps every other line", () => {
    const tree = addNote(withProjects(), "1-projects/beta-launch", "index", "---\nowner: '@maya'\nstatus: to do\n---\n# Beta\n\nWords.\n")!.tree;
    const made = setStatus(tree, "1-projects/beta-launch", "done")!;
    expect(made.path).toBe("1-projects/beta-launch/index.md");
    expect(made.tree.notes[made.path]).toBe("---\nowner: '@maya'\nstatus: done\n---\n# Beta\n\nWords.\n");
  });

  test("a note's own status, and nothing for a path that is not there", () => {
    const made = setStatus(site, "01-Welcome.md", "done")!;
    expect(noteProperties(made.tree.notes["01-Welcome.md"]!)).toEqual({ status: "done" });
    expect(setStatus(site, "nowhere", "done")).toBeNull();
  });
});

describe("tasks", () => {
  test("a note of its own in the project, named for its words, not started", () => {
    const made = addTask(withProjects(), "1-projects/beta-launch", "Invite the first 50 people")!;
    expect(made.path).toBe("1-projects/beta-launch/Invite the first 50 people.md");
    expect(noteProperties(made.tree.notes[made.path]!)).toEqual({ status: "to do" });
  });

  test("a slash in its words does not make a folder", () => {
    const made = addTask(withProjects(), "1-projects/beta-launch", "Write the Q4/Q1 plan")!;
    expect(made.path).toBe("1-projects/beta-launch/Write the Q4-Q1 plan.md");
  });

  test("only into a folder that is there", () => {
    expect(addTask(site, "1-projects", "Nope")).toBeNull();
  });
});
