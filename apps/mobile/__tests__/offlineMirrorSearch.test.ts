import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch, endSession } from "../features/offline/epoch";
import type { CacheScope } from "../features/offline/keys";
import { NOTHING_NEEDED, putMirroredNotes, forgetMirroredNote } from "../features/offline/mirror";
import {
  MAX_SEARCHED_CHARS,
  fold,
  forgetMirrorSearch,
  queryTerms,
  searchMirror,
} from "../features/offline/mirrorSearch";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";

/**
 * Searching the copy of every note that is on the device.
 *
 * The console's search asks the gateway, and offline that is ten seconds of
 * spinner and then nothing — on a phone that holds every note body in its
 * mirror. `mirrorSearch.ts` answers from the mirror instead, in the server's
 * own result shape so the palette draws it unchanged. What is pinned here:
 *
 *  - **the answer** — title and path above body, every term required, case
 *    and accents ignored, a snippet cut from the line the hit is on;
 *  - **the boundaries** — one clearance, one workspace, never ciphertext, and
 *    never a note the index no longer names;
 *  - **the cost** — a few thousand notes, measured.
 *
 * Every fixture is invented.
 */

const NOW = Date.parse("2026-09-18T12:00:00Z");
const WS = "ws_one";

let store: MirrorStore;

beforeEach(() => {
  store = memoryMirrorStore();
});

interface Fixture {
  path: string;
  text: string;
  etag?: string;
  encrypted?: boolean;
}

async function put(
  notes: Fixture[],
  scope: CacheScope = "private",
  workspaceId = WS,
  target: MirrorStore = store,
): Promise<void> {
  await putMirroredNotes(
    target,
    currentEpoch(),
    scope,
    workspaceId,
    notes.map((note) => ({
      path: note.path,
      text: note.text,
      etag: note.etag ?? `e-${note.path}`,
      visibility: scope === "private" ? "private" : "team",
      inherited: scope === "private" ? "private" : "team",
      exception: false,
      readOnly: note.encrypted === true,
      ...(note.encrypted === true ? { encrypted: true } : {}),
    })),
    NOTHING_NEEDED,
    NOW,
  );
}

const paths = (answer: { hits: { path: string }[] }) => answer.hits.map((hit) => hit.path);

describe("folding text for comparison", () => {
  test("lowercases and strips accents without changing the length", () => {
    const text = "Café CRÈME Ångström naïve";
    const folded = fold(text);
    expect(folded).toBe("cafe creme angstrom naive");
    expect(folded.length).toBe(text.length);
  });

  test("keeps every offset lined up even for a character whose lowercase is longer", () => {
    // "İ" lowercases to two code units; a snippet cut at a folded offset
    // would land one character off for the rest of the note.
    const text = "İstanbul notes";
    expect(fold(text).length).toBe(text.length);
    expect(fold(text).indexOf("notes")).toBe(text.indexOf("notes"));
  });

  test("a query is its words, folded, without duplicates or one-letter noise", () => {
    expect(queryTerms("  Review CYCLE, review a")).toEqual(["review", "cycle"]);
    expect(queryTerms("café")).toEqual(["cafe"]);
    expect(queryTerms("...")).toEqual([]);
  });
});

describe("what a search over the device finds", () => {
  test("a word in a body comes back in the server's own shape", async () => {
    await put([
      { path: "2-areas/people/layomi.md", text: "# Layomi\n\nMet at the design review.\nLikes tea." },
      { path: "1-projects/garden.md", text: "# Garden\n\nTomatoes." },
    ]);
    const answer = await searchMirror(store, "private", WS, "design review");
    expect(answer.hits).toEqual([
      {
        path: "2-areas/people/layomi.md",
        title: "Layomi",
        snippets: ["Met at the design review."],
      },
    ]);
    expect(answer).toMatchObject({ mirrored: true, searched: 2, encryptedSkipped: 0 });
  });

  test("a title or path match ranks above a note that only mentions it", async () => {
    await put([
      { path: "0-inbox/a.md", text: "# Monday\n\nThe budget is due on Friday." },
      { path: "1-projects/budget.md", text: "# Plans\n\nNumbers." },
      { path: "3-resources/z.md", text: "# Budget 2027\n\nDraft." },
    ]);
    const answer = await searchMirror(store, "private", WS, "budget");
    expect(paths(answer)).toEqual(["3-resources/z.md", "1-projects/budget.md", "0-inbox/a.md"]);
  });

  test("every word must be somewhere in the note", async () => {
    await put([
      { path: "a.md", text: "# A\n\nreview of the cycle" },
      { path: "b.md", text: "# B\n\nreview only" },
      { path: "cycle.md", text: "# C\n\nthe review" },
    ]);
    const answer = await searchMirror(store, "private", WS, "review cycle");
    // `cycle.md` has one word in its name and the other in its body — still a hit.
    expect(paths(answer).sort()).toEqual(["a.md", "cycle.md"]);
  });

  test("case and accents do not matter, in either direction", async () => {
    await put([
      { path: "a.md", text: "# Menu\n\nThe CAFÉ on Elm serves crème brûlée." },
      { path: "b.md", text: "# Other\n\nnothing" },
    ]);
    expect(paths(await searchMirror(store, "private", WS, "cafe creme"))).toEqual(["a.md"]);
    expect(paths(await searchMirror(store, "private", WS, "Brûlée"))).toEqual(["a.md"]);
  });

  test("the snippet is the matching line, cut around the hit when the line is long", async () => {
    const long = `${"filler words ".repeat(40)}the quarterly offsite is in Lisbon ${"more ".repeat(40)}`;
    await put([{ path: "a.md", text: `# Notes\n\n${long}` }]);
    const [hit] = (await searchMirror(store, "private", WS, "offsite")).hits;
    const snippet = hit!.snippets[0]!;
    expect(snippet).toContain("quarterly offsite is in Lisbon");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(202);
  });

  test("results are capped, and the count says how many there were", async () => {
    await put(
      Array.from({ length: 30 }, (_, n) => ({ path: `n${n}.md`, text: `# N${n}\n\nshared word` })),
    );
    const answer = await searchMirror(store, "private", WS, "shared", { limit: 10 });
    expect(answer.hits).toHaveLength(10);
    expect(answer.matchCount).toBe(30);
  });

  test("a context with nothing mirrored at this clearance says so, rather than 'no matches'", async () => {
    const answer = await searchMirror(store, "private", WS, "anything");
    expect(answer).toMatchObject({ mirrored: false, hits: [], searched: 0 });
  });
});

describe("what a search over the device must never read", () => {
  test("an encrypted note's ciphertext is never searched, and is counted", async () => {
    await put([
      // The envelope happens to contain the query. Matching it would hand
      // somebody a "hit" whose snippet is base64.
      { path: "secret.md", text: "---\nencrypted: true\n---\nQUJDbeaconREVG", encrypted: true },
      { path: "plain.md", text: "# Plain\n\nbeacon" },
    ]);
    const answer = await searchMirror(store, "private", WS, "beacon");
    expect(paths(answer)).toEqual(["plain.md"]);
    expect(answer.encryptedSkipped).toBe(1);
    // Not even by name: "N encrypted notes not searched" is only true if none were.
    expect(paths(await searchMirror(store, "private", WS, "secret"))).toEqual([]);
  });

  test("a team search never reads a body filed at the private clearance", async () => {
    await put([{ path: "diary.md", text: "# Diary\n\nthe surprise party plan" }], "private");
    await put([{ path: "shared.md", text: "# Shared\n\nthe party menu" }], "team");
    expect(paths(await searchMirror(store, "team", WS, "party"))).toEqual(["shared.md"]);
    expect(paths(await searchMirror(store, "team", WS, "surprise"))).toEqual([]);
    // And an owner searches the copy synced for them, not a team one beside it.
    expect(paths(await searchMirror(store, "private", WS, "party"))).toEqual(["diary.md"]);
  });

  test("one workspace's search never sees another's notes", async () => {
    await put([{ path: "a.md", text: "# A\n\nzebra crossing" }], "private", "ws_other");
    await put([{ path: "b.md", text: "# B\n\nnothing" }], "private", WS);
    expect(paths(await searchMirror(store, "private", WS, "zebra"))).toEqual([]);
    expect(paths(await searchMirror(store, "private", "ws_other", "zebra"))).toEqual(["a.md"]);
  });

  test("a note the index stopped naming is not found, even though it was searched before", async () => {
    await put([
      { path: "gone.md", text: "# Gone\n\nwalrus" },
      { path: "kept.md", text: "# Kept\n\nwalrus" },
    ]);
    expect(paths(await searchMirror(store, "private", WS, "walrus"))).toHaveLength(2);
    await forgetMirroredNote(store, currentEpoch(), WS, "gone.md");
    expect(paths(await searchMirror(store, "private", WS, "walrus"))).toEqual(["kept.md"]);
  });

  test("a note that changed is searched at its new version", async () => {
    await put([{ path: "a.md", text: "# A\n\nold words", etag: "v1" }]);
    expect(paths(await searchMirror(store, "private", WS, "old"))).toEqual(["a.md"]);
    await put([{ path: "a.md", text: "# A\n\nnew words", etag: "v2" }]);
    expect(paths(await searchMirror(store, "private", WS, "old"))).toEqual([]);
    expect(paths(await searchMirror(store, "private", WS, "new"))).toEqual(["a.md"]);
  });

  test("a note that became encrypted drops out of what is searched", async () => {
    await put([{ path: "a.md", text: "# A\n\nplaintext otter", etag: "v1" }]);
    expect(paths(await searchMirror(store, "private", WS, "otter"))).toEqual(["a.md"]);
    await put([{ path: "a.md", text: "otter-looking-ciphertext", etag: "v2", encrypted: true }]);
    expect(paths(await searchMirror(store, "private", WS, "otter"))).toEqual([]);
  });

  test("a sign-out takes the in-memory copy with it", async () => {
    await put([{ path: "a.md", text: "# A\n\nheron" }]);
    expect(paths(await searchMirror(store, "private", WS, "heron"))).toEqual(["a.md"]);
    endSession();
    await store.clearAll();
    expect(await searchMirror(store, "private", WS, "heron")).toMatchObject({
      mirrored: false,
      hits: [],
    });
  });

  test("forgetting a workspace drops what was held in memory for it", async () => {
    await put([{ path: "a.md", text: "# A\n\nkestrel" }]);
    expect(paths(await searchMirror(store, "private", WS, "kestrel"))).toEqual(["a.md"]);
    forgetMirrorSearch(WS);
    await store.forgetWorkspace(WS);
    expect(paths(await searchMirror(store, "private", WS, "kestrel"))).toEqual([]);
  });

  /*
    The two in-flight cases: a first search reads every body, which on a phone
    is long enough for a sign-out or a Leave to land in the middle. What was
    read for the session or workspace that just ended must be neither kept nor
    answered. The store is held at its first body read so the ending lands
    exactly there.
  */
  function gated(inner: MirrorStore) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const store: MirrorStore = {
      ...inner,
      readIndex: (...args) => inner.readIndex(...args),
      readBody: async (...args) => {
        reached();
        await gate;
        return inner.readBody(...args);
      },
    };
    return { store, release, arrived };
  }

  test("a sign-out in the middle of the first search answers nothing", async () => {
    await put([{ path: "a.md", text: "# A\n\nplover" }]);
    const held = gated(store);
    const answer = searchMirror(held.store, "private", WS, "plover");
    await held.arrived;
    endSession();
    held.release();
    expect(await answer).toMatchObject({ mirrored: false, hits: [] });
  });

  test("forgetting a workspace in the middle of the first search answers nothing", async () => {
    await put([{ path: "a.md", text: "# A\n\ncurlew" }]);
    const held = gated(store);
    const answer = searchMirror(held.store, "private", WS, "curlew");
    await held.arrived;
    forgetMirrorSearch(WS);
    held.release();
    expect(await answer).toMatchObject({ mirrored: false, hits: [] });
  });

  test("a huge note is searched up to a bound, not held whole", async () => {
    const huge = `# Mail\n\nearly marker\n${"x".repeat(MAX_SEARCHED_CHARS)}\nlate marker`;
    await put([{ path: "mail.md", text: huge }]);
    expect(paths(await searchMirror(store, "private", WS, "early"))).toEqual(["mail.md"]);
    expect(paths(await searchMirror(store, "private", WS, "late"))).toEqual([]);
  });
});

describe("what it costs", () => {
  /*
    Synthetic, and deliberately unkind: 3,000 notes of ~2.5KB drawn from a
    vocabulary wide enough that most terms miss most notes, so a search has to
    scan nearly every body. Node is faster than Hermes — the budget in the
    brief is ~200ms on a phone — so this asserts well inside it and prints the
    numbers for the record.
  */
  const WORDS = Array.from({ length: 4_000 }, (_, n) => `w${n.toString(36)}x`);
  function body(seed: number): string {
    let state = seed * 2654435761;
    const out: string[] = [];
    for (let n = 0; n < 360; n += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      out.push(WORDS[state % WORDS.length]!);
      if (n % 12 === 11) out.push("\n");
    }
    return out.join(" ");
  }

  test("3,000 notes search well inside the budget once warm", async () => {
    const notes = Array.from({ length: 3_000 }, (_, n) => ({
      path: `folder-${n % 40}/note-${n}.md`,
      text: `# Note ${n}\n\n${body(n)}`,
    }));
    for (let at = 0; at < notes.length; at += 500) await put(notes.slice(at, at + 500));

    const coldStart = performance.now();
    const cold = await searchMirror(store, "private", WS, "w1x w2x");
    const coldMs = performance.now() - coldStart;

    const timings: number[] = [];
    for (const query of ["w3fx", "note 1234", "wzzzzx", "w10x w11x w12x", "folder-7"]) {
      const start = performance.now();
      await searchMirror(store, "private", WS, query);
      timings.push(performance.now() - start);
    }
    const warmMs = Math.max(...timings);
    // eslint-disable-next-line no-console
    console.log(
      `mirror search over ${cold.searched} notes: cold ${coldMs.toFixed(0)}ms, warm worst ${warmMs.toFixed(1)}ms`,
    );
    expect(cold.searched).toBe(3_000);
    expect(warmMs).toBeLessThan(60);
  });
});
