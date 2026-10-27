/**
 * THE WORDS FIRST, THE MEANING AFTER (the search tune-up, Dev2's pick,
 * 2026-10-27).
 *
 * The palette used to wait for both halves of a search in every workspace
 * before drawing a row, and each workspace embedded the same question for
 * itself. Now it asks the words and the meaning as two halves: the words are
 * drawn as soon as they land, and the meaning joins after, embedded once.
 * What is asserted:
 *
 *  - The words half asks no meaning index and sends nothing to the model.
 *  - The meaning half answers only notes found by meaning, each with how close
 *    it was, filtered by the caller's live `canSee` exactly like the merged
 *    search: a team caller is not handed a private note.
 *  - A question already embedded is not embedded again.
 *  - Through the control plane, a half is accepted and the words half answers
 *    what the merged search's words do.
 *
 * Sabotage record (temporary local edits, reverted, as measured):
 *   the `half !== "words"` guard removed in `searchNotes`  → "the words half asks…" fails
 *   the given `vector` not passed to `meaningMatches`      → "a question already embedded…" fails
 *   the meaning half not answered on its own               → "the meaning half answers…", "a question
 *                                                             already embedded…" and "the words half
 *                                                             answers…" fail
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, maintainSearchIndex, searchNotes } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { attachMeaningIndex } from "../../mcp/src/search/meaning/store.js";
import { MEANING_DIMENSIONS } from "../../mcp/src/search/meaning/embed.js";
import { fuse } from "../functions/lib/blendedSearch";
import { renderPrivacyManifest, setFolderVisibility } from "./seededRules.helpers";
import { asUser } from "./fixtures.helpers";
import { SHARED_WORD, twoTenants } from "./blendedSearch.helpers";

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

describe("a search in two halves", () => {
  test("the words half asks no meaning index and sends nothing to the model", async () => {
    const store = bucket();
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    const sent = stubCloudflare(["1-projects/garden.md"]);

    const words = await searchNotes(store, { query: "vegetables", clearance: clearanceOf("private"), refreshOnMiss: false, half: "words" });
    expect(words.hits.map((hit) => hit.path)).toEqual(["1-projects/vegetables.md"]);
    expect(sent).toEqual([]);
  });

  test("the meaning half answers only notes found by meaning, with how close each was", async () => {
    const store = bucket();
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    stubCloudflare(["1-projects/garden.md", "1-projects/vegetables.md"]);

    const meaning = await searchNotes(store, { query: "vegetables", clearance: clearanceOf("private"), refreshOnMiss: false, half: "meaning" });
    expect(meaning.hits.map((hit) => [hit.path, hit.meaningOnly, hit.closeness])).toEqual([
      ["1-projects/garden.md", true, 0.9],
      ["1-projects/vegetables.md", true, 0.85],
    ]);
    expect(meaning.hits[0]?.snippets).toEqual(["Tomatoes go by the south fence."]);
  });

  test("a question already embedded is not embedded again", async () => {
    const store = bucket();
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    const sent = stubCloudflare(["1-projects/garden.md"]);

    const vector = Array<number>(MEANING_DIMENSIONS).fill(0.1);
    const meaning = await searchNotes(store, {
      query: "vegetables",
      clearance: clearanceOf("private"),
      refreshOnMiss: false,
      half: "meaning",
      vector,
    });
    expect(meaning.hits.map((hit) => hit.path)).toEqual(["1-projects/garden.md"]);
    expect(sent.some((url) => url.includes("/ai/run/"))).toBe(false);
    expect(sent.length).toBe(1);
  });

  test("a team caller's meaning half is not handed a private note", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
    await indexed(store);
    attachMeaningIndex(store, DESCRIPTOR, null);
    stubCloudflare(["2-areas/salary.md", "1-projects/garden.md"]);

    const asTeam = await searchNotes(store, { query: "money", clearance: clearanceOf("team"), refreshOnMiss: false, half: "meaning" });
    expect(asTeam.hits.map((hit) => hit.path)).toEqual(["1-projects/garden.md"]);
    const asOwner = await searchNotes(store, { query: "money", clearance: clearanceOf("private"), refreshOnMiss: false, half: "meaning" });
    expect(asOwner.hits.map((hit) => hit.path)).toContain("2-areas/salary.md");
  });

  test("closeness rides through the blend", () => {
    const rows = fuse([
      { key: "ws1", offset: 0, asked: 10, hits: [{ path: "a.md", title: "A", snippets: [], meaningOnly: true, closeness: 0.62 }] },
    ]);
    expect(rows[0]?.closeness).toBe(0.62);
  });
});

describe("the halves through the control plane", () => {
  test("the words half answers what the merged search's words do; a meaning half with no index answers nothing", async () => {
    const f = await twoTenants();
    const both = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, { query: SHARED_WORD });
    const words = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, { query: SHARED_WORD, half: "words" });
    expect(words.results.map((row) => row.path)).toEqual(both.results.map((row) => row.path));
    expect(words.results.length).toBeGreaterThan(0);

    const meaning = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, { query: SHARED_WORD, half: "meaning" });
    expect(meaning.results).toEqual([]);
    expect(meaning.cursor).toBeNull();
  }, 60_000);
});
