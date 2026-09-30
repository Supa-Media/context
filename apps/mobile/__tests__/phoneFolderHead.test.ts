import { describe, expect, test } from "@jest/globals";
import { folderActivity, folderCounts } from "../features/console/home/folderHead";
import type { ActivityEntry } from "../features/console/activity/activity";

/**
 * The phone's folder page head (board 07 of the approved Home artboards,
 * 2026-09-30): what the folder holds, who has been in it this week, and its
 * latest change in one line.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. A sibling folder whose name starts the same counted as inside. → "only what is inside"
 *  2. Faces not limited to the week.                                 → "who has been in it this week"
 *  3. An agent drawn as its owner's face.                             → "an agent is its own actor"
 *  4. Latest taken as the first entry, not the newest.               → "the latest change is the newest"
 */

const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return { at: at(1), kind: "revised", paths: ["clients/acme/brief.md"], n: 1, vis: "team", by: "@ada", via: null, note: null, ...overrides };
}

describe("folderActivity", () => {
  test("only what is inside the folder counts, not a sibling that shares its name's start", () => {
    const view = folderActivity([entry({ paths: ["clients-old/x.md"] })], "clients", NOW);
    expect(view.latest).toBeNull();
    expect(view.actors).toEqual([]);
  });

  test("the latest change is the newest, whatever order the entries came in", () => {
    const view = folderActivity(
      [
        entry({ at: at(30), by: "@bo", paths: ["clients/bloom.md"] }),
        entry({ at: at(2), by: "@ada", paths: ["clients/acme/brief.md"] }),
      ],
      "clients",
      NOW,
    );
    expect(view.latest?.text).toBe("@ada revised brief");
    expect(view.latest?.when).toBe("2h");
    expect(view.latest?.path).toBe("clients/acme/brief.md");
  });

  test("who has been in it this week, newest first, each once, three at most", () => {
    const view = folderActivity(
      [
        entry({ at: at(1), by: "@ada" }),
        entry({ at: at(2), by: "@bo" }),
        entry({ at: at(3), by: "@ada" }),
        entry({ at: at(4), by: "@cy" }),
        entry({ at: at(5), by: "@di" }),
        entry({ at: at(24 * 8), by: "@old" }),
      ],
      "clients",
      NOW,
    );
    expect(view.actors.map((a) => a.name)).toEqual(["@ada", "@bo", "@cy"]);
    expect(folderActivity([entry({ at: at(24 * 8), by: "@old" })], "clients", NOW).actors).toEqual([]);
  });

  test("an agent is its own actor, drawn as a robot, not as its owner's face", () => {
    const view = folderActivity(
      [entry({ at: at(1), by: "@ada", via: "Claude" }), entry({ at: at(2), by: "@ada", via: null })],
      "clients",
      NOW,
    );
    expect(view.actors).toEqual([
      { key: "agent:@ada:Claude", name: "Claude", agent: true },
      { key: "person:@ada", name: "@ada", agent: false },
    ]);
  });

  test("the workspace's own page takes everything", () => {
    expect(folderActivity([entry({ paths: ["todo.md"] })], "", NOW).latest?.path).toBe("todo.md");
  });
});

describe("folderCounts", () => {
  test("notes and folders all the way down, never plumbing", () => {
    const counts = folderCounts(
      ["clients/a.md", "clients/acme/b.md", "clients/acme/deep/c.md", "clients-old/x.md", "clients/.context/y.md"],
      ["clients", "clients/acme", "clients/acme/deep", "clients-old", "clients/.context"],
      "clients",
    );
    expect(counts).toEqual({ notes: 3, folders: 2 });
  });
});
