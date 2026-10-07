/**
 * THE CONSOLE'S SEARCH, BY MEANING.
 *
 * The console asks the same meaning index the gateway does, through the same
 * `search/meaning/serve.js`, and merges it into whichever word index answered.
 * What is asserted:
 *
 *  - A note found only by meaning comes back marked `meaningOnly`, keyed by
 *    `path` as every console hit is, and counted.
 *  - **A `team` caller is never handed a private note by meaning**, even when
 *    the index (wrongly, stale) says it is a team passage: the live
 *    `privacy.md` decides, here as in the gateway.
 *  - A store with no meaning index searches words only and sends nothing.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `merged` returning `found` unchanged in `fileOps/search.ts` → "a note found only by meaning…" fails
 *   `isVisible` replaced by `() => true` in the meaning call  → "a team caller is not handed a private note…" fails
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, searchNotes, setFolderVisibility } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { attachMeaningIndex } from "../../mcp/src/search/meaning/store.js";
import { MEANING_DIMENSIONS } from "../../mcp/src/search/meaning/embed.js";

const DESCRIPTOR = { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "ready" };

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/garden.md", "# Garden\n\nTomatoes go by the south fence.\n");
  store.seed("1-projects/vegetables.md", "# Vegetables\n\nA list of vegetables to buy.\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/salary.md", "# Salary\n\nThe raise talk is in May.\n");
  return store;
}

/** Vectorize and Workers AI on Cloudflare's REST API, answering with `paths` best first. */
function stubCloudflare(paths: string[]) {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push(url);
    const result = url.includes("/ai/run/")
      ? (() => {
          const texts = JSON.parse(init.body).text as string[];
          return { shape: [texts.length, MEANING_DIMENSIONS], data: texts.map(() => Array(MEANING_DIMENSIONS).fill(0.2)) };
        })()
      : { matches: paths.map((path, i) => ({ id: `v${i}`, score: 0.9 - i * 0.05, metadata: { path, chunk: 0, tier: "team" } })) };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
  return sent;
}

async function indexed(store: FileStore): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await maintainSearchIndex(store)).complete) break;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the console's search, by meaning", () => {
  test("a note found only by meaning is added, marked, keyed by path and counted", async () => {
    const store = bucket();
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    stubCloudflare(["1-projects/garden.md"]);

    const answer = await searchNotes(store, { query: "vegetables", clearance: clearanceOf("private"), refreshOnMiss: false });
    expect(answer.hits.map((hit) => [hit.path, hit.meaningOnly])).toEqual(
      expect.arrayContaining([
        ["1-projects/vegetables.md", false],
        ["1-projects/garden.md", true],
      ]),
    );
    const garden = answer.hits.find((hit) => hit.path === "1-projects/garden.md");
    expect(garden?.snippets).toEqual(["Tomatoes go by the south fence."]);
    expect(answer.matchCount).toBe(2);
    expect("meaning" in answer).toBe(false);
  });

  test("a team caller is not handed a private note, whatever tier the index recorded", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    stubCloudflare(["2-areas/salary.md", "1-projects/garden.md"]);

    const asTeam = await searchNotes(store, { query: "money", clearance: clearanceOf("team"), refreshOnMiss: false });
    expect(asTeam.hits.map((hit) => hit.path)).toEqual(["1-projects/garden.md"]);

    // Non-vacuity: the owner, asking the same index, does get the private note.
    const asOwner = await searchNotes(store, { query: "money", clearance: clearanceOf("private"), refreshOnMiss: false });
    expect(asOwner.hits.map((hit) => hit.path)).toContain("2-areas/salary.md");
  });

  test("no meaning index: words only, and nothing is sent", async () => {
    const store = bucket();
    await indexed(store);
    const sent = stubCloudflare(["1-projects/garden.md"]);

    const answer = await searchNotes(store, { query: "vegetables", clearance: clearanceOf("private"), refreshOnMiss: false });
    expect(answer.hits.map((hit) => hit.path)).toEqual(["1-projects/vegetables.md"]);
    expect(sent).toEqual([]);
  });
});
