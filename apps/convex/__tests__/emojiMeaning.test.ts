/**
 * THE SUGGESTED ICON, BY MEANING.
 *
 * Every standard emoji has a written description and a meaning fingerprint
 * made once for everybody; a suggestion fingerprints the name and takes the
 * closest emoji (asked for by the owner, 2026-10-14, for speed). What has
 * teeth:
 *
 *  - every standard emoji has its own description, and none is left out;
 *  - before the fingerprints are built, the first suggestion starts building
 *    them and Clef answers it; a second one meanwhile starts nothing more;
 *  - once built, a suggestion is one embedding call carrying the name's
 *    words alone, and no Clef question;
 *  - a fill that dies is claimed again only once it has gone quiet, a
 *    repeated batch adds no row twice, and a new build drops the old one;
 *  - when the fingerprint model fails, Clef answers;
 *  - past the day's cap on Clef's questions the lookup still answers, and
 *    switched off nothing is sent.
 *
 * `iconSuggest.meaning.live.test.ts` asks the real model.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `insertBatch` without the present-row check                         1 failed
 *   `claimFill` ignoring a live fill's age                              1 failed
 *   `suggestByMeaning` sending the whole path                           1 failed
 *   `emojiMeaningTexts` dropping the description                        2 failed
 *   `suggest` refusing the lookup past the day's cap                    1 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { emojiMeaningSet, emojiMeaningTexts } from "@context/shared/src/emojiMeaning";
import { EMOJI_ABOUT_TABLE } from "@context/shared/src/emojiAbout.generated";
import { suggestCandidates } from "@context/shared/src/iconSuggest";
import { FILL_STALE_MS } from "../functions/emojiMeaning";
import { TRANSCRIBE_WORKER_SECRET_ENV_VAR, TRANSCRIBE_WORKER_URL_ENV_VAR } from "../functions/meetings/transcribe";
import { type TestConvex, addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const WORKER = "https://inference.example.invalid";
const TOOTH = "🦷";
const DIMENSIONS = 1024;

/** A fake fingerprint: strongly "about teeth cleaning" or not, plus a little of the text's own. */
function fakeVector(text: string): number[] {
  const vector = Array<number>(DIMENSIONS).fill(0);
  if (text.toLowerCase().includes("teeth cleaning")) vector[0] = 10;
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 1000;
  vector[1 + hash] = 1;
  return vector;
}

interface Fixture {
  t: TestConvex;
  editor: Id<"users">;
  workspaceId: Id<"workspaces">;
  embedded: string[][];
  clef: number;
  /** Whether the Worker's fingerprint route answers. */
  embedding: boolean;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "seyi@example.invalid");
  const editor = await createUser(t, "sayo@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  const f: Fixture = { t, editor, workspaceId, embedded: [], clef: 0, embedding: true };
  vi.stubEnv(TRANSCRIBE_WORKER_URL_ENV_VAR, WORKER);
  vi.stubEnv(TRANSCRIBE_WORKER_SECRET_ENV_VAR, "test-only-secret");
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(WORKER)) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body));
    if (url === `${WORKER}/embed`) {
      const texts = body.texts as string[];
      f.embedded.push(texts);
      if (!f.embedding) return new Response(JSON.stringify({ error: "the embedding model failed" }), { status: 502 });
      return new Response(JSON.stringify({ vectors: texts.map(fakeVector) }));
    }
    f.clef += 1;
    // Clef picks the first option of every question.
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>)) {
      answers[name] = { type: "choice", choice: Object.keys(question.criteria)[0], confidence: 0.7 };
    }
    return new Response(JSON.stringify({ answers }));
  });
  return f;
}

const suggest = (f: Fixture, path: string) =>
  asUser(f.t, f.editor).action(api.functions.folderIcons.suggest, { workspaceId: f.workspaceId, path });

const setRow = (f: Fixture) =>
  f.t.run(async (ctx) =>
    await ctx.db
      .query("emojiMeaningSets")
      .withIndex("by_set", (q) => q.eq("set", emojiMeaningSet()))
      .unique(),
  );

describe("the descriptions", () => {
  test("every standard emoji has its own description, and every one is fingerprinted with it", () => {
    const described = new Map(EMOJI_ABOUT_TABLE.split("\n").map((line) => line.split("\t") as [string, string]));
    const texts = emojiMeaningTexts();
    expect(texts.map(({ char }) => char)).toEqual(suggestCandidates().map(({ char }) => char));
    for (const { char, text } of texts) {
      const about = described.get(char);
      expect(about, char).toBeTruthy();
      expect(text.endsWith(`: ${about}`), char).toBe(true);
    }
    expect(emojiMeaningSet()).toMatch(/^bge-m3-\d+-[0-9a-f]{8}$/);
  });
});

describe("folderIcons.suggest, by meaning", () => {
  test("the first suggestion starts the build and Clef answers it; once built, the name alone finds the closest emoji", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    expect(await suggest(f, "2-areas/teeth cleaning")).not.toBeNull();
    expect(f.clef).toBe(2);
    expect((await setRow(f))?.state).toBe("filling");

    // A second suggestion while building starts nothing more.
    await suggest(f, "2-areas/taxes");
    expect(f.embedded).toHaveLength(0);

    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const built = await setRow(f);
    expect(built?.state).toBe("ready");
    expect(built?.filled).toBe(emojiMeaningTexts().length);

    f.embedded.length = 0;
    f.clef = 0;
    expect(await suggest(f, "2-areas/private-client/teeth cleaning-2026.md")).toBe(TOOTH);
    expect(f.clef).toBe(0);
    expect(f.embedded).toEqual([["teeth cleaning"]]);
  }, 120_000);

  test("past the day's cap for Clef, the lookup by meaning still answers; switched off, nothing is sent", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await suggest(f, "2-areas/taxes");
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    // The first suggestion's Clef questions made today's row; fill it to the cap.
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("jevUsage").unique();
      await ctx.db.patch(row!._id, { calls: 10_000 });
    });
    f.embedded.length = 0;
    f.clef = 0;
    expect(await suggest(f, "2-areas/teeth cleaning")).toBe(TOOTH);
    expect(f.clef).toBe(0);

    await f.t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "iconSuggest", off: true, updatedAt: Date.now() }));
    f.embedded.length = 0;
    expect(await suggest(f, "2-areas/teeth cleaning")).toBeNull();
    expect(f.embedded).toHaveLength(0);
    expect(f.clef).toBe(0);
  }, 120_000);

  test("when the fingerprint model fails, Clef answers", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await suggest(f, "2-areas/taxes");
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await setRow(f))?.state).toBe("ready");
    f.embedding = false;
    f.clef = 0;
    expect(await suggest(f, "2-areas/teeth cleaning")).not.toBeNull();
    expect(f.clef).toBe(2);
  }, 120_000);
});

describe("building the fingerprints", () => {
  test("a fill is claimed again only once it has gone quiet", async () => {
    const f = await fixture();
    const set = emojiMeaningSet();
    expect(await f.t.mutation(internal.functions.emojiMeaning.claimFill, { set })).toBe(true);
    expect(await f.t.mutation(internal.functions.emojiMeaning.claimFill, { set })).toBe(false);
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("emojiMeaningSets").unique();
      await ctx.db.patch(row!._id, { startedAt: Date.now() - FILL_STALE_MS - 1 });
    });
    expect(await f.t.mutation(internal.functions.emojiMeaning.claimFill, { set })).toBe(true);
  });

  test("a repeated batch adds no row twice, and a short build is not ready", async () => {
    const f = await fixture();
    const set = emojiMeaningSet();
    await f.t.mutation(internal.functions.emojiMeaning.claimFill, { set });
    const rows = [{ char: TOOTH, vector: fakeVector("tooth") }];
    await f.t.mutation(internal.functions.emojiMeaning.insertBatch, { set, rows });
    await f.t.mutation(internal.functions.emojiMeaning.insertBatch, { set, rows });
    expect((await setRow(f))?.filled).toBe(1);
    expect(await f.t.run((ctx) => ctx.db.query("emojiMeanings").collect())).toHaveLength(1);
    expect(await f.t.mutation(internal.functions.emojiMeaning.markReady, { set, expected: 2 })).toBe(false);
  });

  test("a ready build drops every older one", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("emojiMeaningSets", { set: "bge-m3-1-00000000", state: "ready", startedAt: 0, filled: 1 });
      await ctx.db.insert("emojiMeanings", { set: "bge-m3-1-00000000", char: TOOTH, vector: fakeVector("old") });
    });
    const set = emojiMeaningSet();
    await f.t.mutation(internal.functions.emojiMeaning.claimFill, { set });
    await f.t.mutation(internal.functions.emojiMeaning.insertBatch, { set, rows: [{ char: TOOTH, vector: fakeVector("new") }] });
    expect(await f.t.mutation(internal.functions.emojiMeaning.markReady, { set, expected: 1 })).toBe(true);
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const sets = await f.t.run((ctx) => ctx.db.query("emojiMeaningSets").collect());
    expect(sets.map((row) => row.set)).toEqual([set]);
    const rows = await f.t.run((ctx) => ctx.db.query("emojiMeanings").collect());
    expect(rows.map((row) => row.set)).toEqual([set]);
  });
});
