/**
 * The phone's Folders page draws folders in the order the tree does: each
 * folder's saved `order` (Move up, Move down, dragging in the sidebar), else
 * its job's rank (Inbox, Projects, Areas, Resources, extras, Website, own
 * folders, Archive last), else its name — `compareListingEntries`, the one
 * comparator the server, the offline mirror and the tree share (owner,
 * 2026-10-18; `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * SABOTAGE (applied, run, reverted): sorting `buildHome`'s top-level folders
 * by name again fails all three.
 */

import { describe, expect, test } from "@jest/globals";
import { buildHome, type HomeInput } from "../features/console/home/homeModel";

const NOW = Date.UTC(2026, 9, 18, 12);

function input(overrides: Partial<HomeInput> = {}): HomeInput {
  return {
    notes: [],
    folders: ["Zebra notes", "Capture", "9-archive", "Projects", "Areas", "Brand", "website", "Areas/inside"],
    shared: new Set(),
    pins: [],
    opened: [],
    recents: null,
    tag: null,
    now: NOW,
    ...overrides,
  };
}

describe("the phone's folder order", () => {
  test("with no order, jobs first by rank, own folders by name, Archive last", () => {
    const facts = new Map([
      ["Capture", { role: "inbox" }],
      ["Projects", { role: "projects" }],
      ["Areas", { role: "areas" }],
      ["9-archive", { role: "archive" }],
      ["website", { role: "website" }],
    ]);
    const home = buildHome(input({ folderFacts: facts }));
    expect(home.folders.map((folder) => folder.path)).toEqual([
      "Capture",
      "Projects",
      "Areas",
      "website",
      "Brand",
      "Zebra notes",
      "9-archive",
    ]);
  });

  test("a saved order wins over job and name", () => {
    const facts = new Map<string, { role?: string; order?: number }>([
      ["Capture", { role: "inbox", order: 20 }],
      ["Projects", { role: "projects", order: 10 }],
      ["Zebra notes", { order: 0 }],
      ["Areas", { role: "areas", order: 30 }],
    ]);
    const home = buildHome(input({ folderFacts: facts }));
    expect(home.folders.map((folder) => folder.path).slice(0, 4)).toEqual(["Zebra notes", "Projects", "Capture", "Areas"]);
  });

  test("without facts from a listing, root names still say the jobs", () => {
    const home = buildHome(input({ folders: ["4-archive", "Recipes", "1-projects", "0-inbox"] }));
    expect(home.folders.map((folder) => folder.path)).toEqual(["0-inbox", "1-projects", "Recipes", "4-archive"]);
  });
});
