import { describe, expect, test } from "vitest";
import { memoryStore } from "./storeStub.helpers";
import { COUNT_PAGE_CAP, countNotes } from "../functions/lib/noteCount";

/**
 * Counting what is in somebody's bucket.
 *
 * The console showed no note count at all, because there was no honest number
 * to show: nothing had ever looked (issue #25 — it used to draw "1,284 objects"
 * over a bucket holding six). This is the thing that looks.
 *
 * Three properties decide whether the number is worth printing:
 *
 *  1. **It counts notes, not objects.** `.history/` on a live brain holds tens
 *     of thousands of revisions of the same handful of files. An object count
 *     is a number about our own plumbing wearing the label "your notes".
 *  2. **It survives that plumbing.** A flat listing returns `.history/…` first,
 *     because `.` sorts before every digit and letter, so a flat walk with any
 *     page budget exhausts it inside the history and reports **zero notes for
 *     the largest contexts there are**. The walk is delimited at the root and
 *     descends only into folders that are not plumbing — the same shape, and
 *     for the same reason, as `hasExistingContext`.
 *  3. **It admits when it stopped.** A bucket bigger than the page budget
 *     yields a floor, not a total, and says so. A truncated count printed as a
 *     total is the #25 bug with extra steps.
 */

/** Enough `.history/` to bury the real notes several page budgets deep. */
function seedHistory(store: ReturnType<typeof memoryStore>, count: number): void {
  for (let i = 0; i < count; i += 1) {
    store.seed(`.history/1-projects/ship.md/${String(i).padStart(6, "0")}.md`, "old");
  }
}

describe("countNotes", () => {
  test("an empty bucket is zero, and is not a truncated zero", async () => {
    const store = memoryStore();
    expect(await countNotes(store)).toEqual({ notes: 0, truncated: false });
  });

  test("counts markdown at the root and at depth", async () => {
    const store = memoryStore();
    store.seed("index.md", "#");
    store.seed("privacy.md", "#");
    store.seed("1-projects/ship.md", "#");
    store.seed("1-projects/ship/notes.md", "#");
    store.seed("3-resources/reading/2026/paper.md", "#");

    expect(await countNotes(store)).toEqual({ notes: 5, truncated: false });
  });

  /**
   * The one that matters, and the one that was vacuous on the first attempt.
   *
   * A flat walk returns the `.history/` objects first and reports zero — but
   * only once there is more history than the page budget can chew through.
   * Seeded with 12,000 objects against the default 40-page/1,000-object budget,
   * a flat walk simply spent 12 pages and then reached the notes anyway, so the
   * test passed with the bug in place. Sabotaging the delimiter is what found
   * that; the budget here is shrunk instead, the same trick
   * `scaffold.test.ts` uses on `DETECT_PAGE_CAP` and for the same reason.
   *
   * 500 history objects at 100 per page is five pages of plumbing against a
   * four-page budget: a flat walk cannot get out of `.history/`. The delimited
   * walk needs three — one root, one per real folder.
   */
  test("plumbing does not bury the notes, however much of it there is", async () => {
    const store = memoryStore();
    seedHistory(store, 500);
    store.seed("1-projects/ship.md", "#");
    store.seed("2-areas/health.md", "#");
    store.seed("index.md", "#");

    expect(await countNotes(store, { pageCap: 4, pageSize: 100 })).toEqual({
      notes: 3,
      truncated: false,
    });
  });

  /** And the same bucket shape at the real budget, to keep the two honest. */
  test("the same bucket counts the same at the default budget", async () => {
    const store = memoryStore();
    seedHistory(store, 500);
    store.seed("1-projects/ship.md", "#");
    store.seed("2-areas/health.md", "#");
    store.seed("index.md", "#");

    expect(await countNotes(store)).toEqual({ notes: 3, truncated: false });
  });

  test("every dot-segment is plumbing, not just .history", async () => {
    const store = memoryStore();
    store.seed(".history/x.md", "old");
    store.seed(".audit/2026-08.md", "log");
    store.seed(".obsidian/workspace.md", "ui");
    store.seed("1-projects/ship/.trash/gone.md", "deleted");
    store.seed("1-projects/ship.md", "#");

    expect(await countNotes(store)).toEqual({ notes: 1, truncated: false });
  });

  test("attachments are not notes", async () => {
    const store = memoryStore();
    store.seed("1-projects/ship.md", "#");
    store.seed("1-projects/diagram.png", "binary");
    store.seed("1-projects/data.csv", "a,b");
    store.seed("1-projects/README.MD", "#");

    // `.MD` counts — the extension is the file's, not the filesystem's.
    expect(await countNotes(store)).toEqual({ notes: 2, truncated: false });
  });

  test("a bucket past the budget gives a floor and says so", async () => {
    const store = memoryStore();
    for (let i = 0; i < 25; i += 1) store.seed(`1-projects/n${i}.md`, "#");

    const counted = await countNotes(store, { pageCap: 2, pageSize: 10 });
    expect(counted).not.toBeNull();
    expect(counted!.truncated).toBe(true);
    expect(counted!.notes).toBeLessThan(25);
    expect(counted!.notes).toBeGreaterThan(0);
  });

  test("a bucket that exactly fills the budget is not called truncated", async () => {
    const store = memoryStore();
    for (let i = 0; i < 20; i += 1) store.seed(`1-projects/n${i}.md`, "#");

    expect(await countNotes(store, { pageCap: 4, pageSize: 10 })).toEqual({
      notes: 20,
      truncated: false,
    });
  });

  /** The default budget is worth stating: it is what a real bucket meets. */
  test("the default budget holds a large real context without truncating", async () => {
    expect(COUNT_PAGE_CAP).toBeGreaterThanOrEqual(20);

    const store = memoryStore();
    seedHistory(store, 5_000);
    for (let i = 0; i < 3_000; i += 1) store.seed(`1-projects/n${i}.md`, "#");

    expect(await countNotes(store)).toEqual({ notes: 3_000, truncated: false });
  });

  /**
   * A store that reports another page and offers nowhere to go.
   *
   * `truncated` and `cursor` reach this module from two independent tags —
   * `readTag` in `apps/mcp/src/store/s3.js` reads `IsTruncated` from one element
   * and `NextContinuationToken` from another, and nothing checks they agree.
   * `!listing.truncated || !listing.cursor` treated that pair as a finished
   * listing, so the walk stopped **and reported `truncated: false`**: a floor
   * printed as an exact total, which is issue #25 with a measurement in front
   * of it and what four paragraphs of "The note count is measured" forbid.
   *
   * The inner per-folder walk is flat on 1000-key pages, so any folder holding
   * more than one page is in scope on a real bucket — this is not reserved for
   * exotic stores.
   */
  test("a store that will not continue makes the total a floor", async () => {
    // Two walks, so two probes. Stalling both at once proves only the outcome:
    // either line setting the flag satisfies it, so either could be reverted
    // with nothing catching it. Each probe below stalls exactly one.
    const seed = () => {
      const store = memoryStore();
      for (let i = 0; i < 25; i += 1) store.seed(`1-projects/n${i}.md`, "#");
      return store;
    };
    const stallWhen = (
      store: ReturnType<typeof memoryStore>,
      predicate: (options?: { prefix?: string; delimiter?: string }) => boolean,
    ) => ({
      ...store,
      list: async (options?: { prefix?: string; delimiter?: string; cursor?: string }) => {
        const page = await store.list(options);
        return predicate(options) ? { ...page, truncated: true, cursor: undefined } : page;
      },
    });

    // The delimited walk at the root. Short here means whole folders are never
    // even discovered, so their notes are not merely uncounted — they are
    // invisible to the count entirely.
    const outer = seed();
    const outerCount = await countNotes(
      stallWhen(outer, (options) => options?.delimiter === "/"),
      { pageCap: 20, pageSize: 10 },
    );
    expect(outerCount).not.toBeNull();
    expect(outerCount!.truncated).toBe(true);

    // The flat walk inside each folder — the one that runs on 1000-key pages
    // against a real bucket, so any folder past one page is in scope.
    const inner = seed();
    const innerCount = await countNotes(
      stallWhen(inner, (options) => options?.delimiter !== "/"),
      { pageCap: 20, pageSize: 10 },
    );
    expect(innerCount).not.toBeNull();
    expect(innerCount!.truncated).toBe(true);
    expect(innerCount!.notes).toBeLessThan(25);

    // The positive control: the same bucket, an honest store, an exact total.
    expect(await countNotes(seed(), { pageCap: 20, pageSize: 10 })).toEqual({
      notes: 25,
      truncated: false,
    });
  });

  /**
   * One folder the adapter will not walk must not cost the whole count.
   *
   * The prefix passed back to `store.list` is a folder name the *customer*
   * chose, and `assertSafePrefix` in the adapter throws on a backslash, a
   * control character, or a `.`/`..` segment. Under a single outer catch that
   * returned `null` for the entire bucket — permanently, and silently, on
   * exactly the buckets most likely to be somebody's real vault.
   */
  test("a folder the adapter refuses makes the total a floor, not a blank", async () => {
    const store = memoryStore();
    store.seed("1-projects/ship.md", "#");
    store.seed("2-areas/health.md", "#");
    store.seed("index.md", "#");

    const refusing = {
      ...store,
      list: async (options?: { prefix?: string; delimiter?: string }) => {
        if (options?.prefix === "2-areas/") throw new Error("unsafe prefix");
        return await store.list(options);
      },
    };

    expect(await countNotes(refusing)).toEqual({ notes: 2, truncated: true });
  });

  /**
   * A listing that throws mid-walk must not take the verification down with
   * it. The probe's job is to record a status; a count is the least important
   * thing it learns.
   */
  test("a failing listing yields no count rather than an exception", async () => {
    const store = memoryStore();
    store.seed("1-projects/ship.md", "#");
    const broken = {
      ...store,
      list: async () => {
        throw new Error("connection reset");
      },
    };

    expect(await countNotes(broken)).toBeNull();
  });
});
