/**
 * THE APP AND AN AI CLIENT GET THE SAME SEARCH.
 *
 * ⌘K and the search page call `searchNotes` (this runtime); Claude and ChatGPT
 * call `search_notes` (the gateway's `toolSearchNotes`). Both promise the owner
 * the same answer for the same words (Dev2, 2026-10-09: "make sure these are
 * the same search results that the mcp sees"), and they reach it through two
 * entry points over the same index. This file is the check that the two entry
 * points have not drifted: one bucket, one caller, the same queries, and the
 * same notes in the same order out of both.
 *
 * Two drifts it was written against, both real before it existed:
 *  - a prefix without its trailing slash matched sibling folders through the
 *    gateway (`1-projects` found `1-projects-old/`), while the console put the
 *    slash back;
 *  - the console's index passes and refreshes counted `activity.md` as a note,
 *    and the gateway's did not, so the feed could reach the shared index from
 *    the console and then answer AI searches the gateway meant to keep it out
 *    of.
 *
 * What it does not claim: an AI connection sees only what its grant covers, so
 * a note shared with a group the person belongs to is in their app's answer and
 * not in their AI client's. That is the privacy engine's decision, made for
 * every AI tool alike, and not a search difference.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, searchNotes, setFolderVisibility } from "../functions/lib/fileOps";
import { loadPrivacyState } from "../functions/lib/fileOps/privacyState";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { toolSearchNotes } from "../../mcp/src/tools/search.js";

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/rent.md", "# Rent\n\nThe landlord raised the rent in March.\n");
  store.seed("1-projects/lease.md", "# Lease\n\nThe lease renewal mentions the rent cap.\n");
  store.seed("1-projects-old/rent-2024.md", "# Rent 2024\n\nOld rent notes.\n");
  store.seed("2-areas/home.md", "# Home\n\nRent, bills and the boiler.\n");
  store.seed("activity.md", "# Activity\n\n- rent.md edited, rent notes moved\n");
  return store;
}

async function indexed(store: MemoryStore & FileStore): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    const maintained = await maintainSearchIndex(store);
    if (maintained.complete) break;
  }
}

/** The paths an AI client is shown, in order, read off the tool's own text. */
async function aiPaths(
  store: FileStore,
  scope: "private" | "team",
  query: string,
  prefix?: string,
): Promise<string[]> {
  const { rules, overrides } = await loadPrivacyState(store);
  const result = (await toolSearchNotes(store, scope, rules, overrides, query, prefix)) as {
    content: { text: string }[];
  };
  return result.content[0].text
    .split("\n")
    .filter((line) => line.endsWith(".md") && !line.startsWith(" "));
}

async function appPaths(
  store: FileStore,
  scope: "private" | "team",
  query: string,
  prefix?: string,
): Promise<string[]> {
  const found = await searchNotes(store, { query, prefix, clearance: clearanceOf(scope) });
  return found.hits.map((hit) => hit.path);
}

describe("the app and an AI client search alike", () => {
  test("the same words find the same notes in the same order", async () => {
    const store = bucket();
    await indexed(store);
    for (const query of ["rent", "landlord", "lease rent", "boiler"]) {
      const app = await appPaths(store, "private", query);
      expect(app.length).toBeGreaterThan(0);
      expect(await aiPaths(store, "private", query)).toEqual(app);
    }
  });

  test("a folder without its trailing slash means that folder in both", async () => {
    const store = bucket();
    await indexed(store);
    for (const prefix of ["1-projects", "1-projects/"]) {
      const app = await appPaths(store, "private", "rent", prefix);
      expect(app.every((path) => path.startsWith("1-projects/"))).toBe(true);
      expect(await aiPaths(store, "private", "rent", prefix)).toEqual(app);
    }
  });

  test("the activity feed is not a search result in either", async () => {
    const store = bucket();
    await indexed(store);
    expect(await appPaths(store, "private", "edited")).toEqual([]);
    expect(await aiPaths(store, "private", "edited")).toEqual([]);
  });

  test("a team caller is held to the same notes in both", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
    await indexed(store);
    const app = await appPaths(store, "team", "rent");
    expect(app.every((path) => path.startsWith("1-projects/"))).toBe(true);
    expect(await aiPaths(store, "team", "rent")).toEqual(app);
  });

  test("the app's answer says how long the words took", async () => {
    const store = bucket();
    await indexed(store);
    const found = await searchNotes(store, { query: "rent", clearance: clearanceOf("private") });
    expect(found.timing?.words).toBeGreaterThanOrEqual(0);
    // No meaning index in this bucket, so no meaning time is claimed.
    expect(found.timing?.meaning).toBeUndefined();
  });
});
