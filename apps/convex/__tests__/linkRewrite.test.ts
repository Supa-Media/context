import { describe, expect, test } from "vitest";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { movePath, copyPath, setFolderVisibility, setVisibility, type FileStore } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

/**
 * A RENAME IN THE CONSOLE MOVES THE LINKS TOO.
 *
 * The owner's ask was explicit that this must hold on both sides: "when the
 * name is updated references to it are also updated automatically when using
 * context.lc directly or using the mcp". The gateway's half is
 * `apps/mcp/test/links.test.mjs`; this is the console's, through `movePath`,
 * which is what `moveEntry` calls and therefore what a drag in the file tree
 * and a rename in the menu both end up running.
 *
 * The engine itself is not re-tested here — `linkParity.test.ts` pins it to the
 * gateway's, which is tested exhaustively. What is tested here is the wiring
 * and the three things only this side can get wrong:
 *
 *  - a folder move recomputes the links *inside* the folder as well as the
 *    links into it,
 *  - the walk stops at what the caller can see, and
 *  - a copy rewrites nothing, because nothing moved.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the `canSee` filter dropped from the walk                    1
 *   the moved note's own links not recomputed                    1
 *   a truncated listing returning its short list, not `null`     1
 *   a failed walk rethrowing instead of reporting `capped`       1
 *
 * The fourth and fifth are why the last describe block exists. The first draft
 * of this file had no coverage of the capped paths at all, and both sabotages
 * passed it green — a rewrite that silently did half a bucket and reported a
 * total, with a suite that said nothing.
 */

const NOW = 1_800_000_000_000;

/** A bucket with a small web of links in it, in every style. */
function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/alpha/overview.md", "# Alpha\n\nsee [[../beta/notes]] and [[../../2-areas/health]]\n");
  store.seed("1-projects/beta/notes.md", "# Beta\n\n[[../alpha/overview]] and [x](../alpha/overview.md)\n");
  store.seed("2-areas/health.md", "# Health\n\nrooted [[1-projects/alpha/overview]]\n");
  store.seed("2-areas/private-log.md", "# Log\n\n[[../1-projects/alpha/overview]]\n");
  return store;
}

/** `1-projects` and `2-areas` team-visible; `2-areas/private-log.md` held back. */
async function shareMost(store: FileStore): Promise<void> {
  for (const path of ["1-projects", "2-areas"]) {
    await setFolderVisibility(store, { path, visibility: "team", scope: "private" });
  }
  await setVisibility(store, {
    path: "2-areas/private-log.md",
    visibility: "private",
    scope: "private",
  });
}

const read = (store: MemoryStore, key: string) => store.snapshot()[key];

describe("a move rewrites the links that pointed at what moved", () => {
  test("a rename is followed by every link style, and counted", async () => {
    const store = bucket();
    const result = await movePath(store, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "private",
      now: NOW,
    });

    expect(result.references).toEqual({ notes: 3, links: 4, capped: false });
    expect(read(store, "1-projects/beta/notes.md")).toBe(
      "# Beta\n\n[[../alpha/summary]] and [x](../alpha/summary.md)\n",
    );
    expect(read(store, "2-areas/health.md")).toBe("# Health\n\nrooted [[1-projects/alpha/summary]]\n");
    expect(read(store, "2-areas/private-log.md")).toBe(
      "# Log\n\n[[../1-projects/alpha/summary]]\n",
    );
  });

  test("nothing to rewrite is reported as nothing, not as a failure", async () => {
    const store = bucket();
    store.seed("3-resources/lonely.md", "# Lonely\n\nno links here\n");
    const result = await movePath(store, {
      from: "3-resources/lonely.md",
      to: "3-resources/solitary.md",
      scope: "private",
      now: NOW,
    });
    expect(result.references).toEqual({ notes: 0, links: 0, capped: false });
  });

  test("a folder move recomputes the links inside it, not just the links into it", async () => {
    /*
      The half a plausible implementation misses. `1-projects/alpha/overview.md`
      points *out* of the folder at `2-areas/health.md` with two `../`; from
      `4-archive/alpha/` that same note needs a different number, and a rewriter
      that only substituted the moved paths would leave it broken while
      reporting success.
    */
    const store = bucket();
    const result = await movePath(store, {
      from: "1-projects/alpha",
      to: "4-archive/alpha",
      scope: "private",
      now: NOW,
    });

    expect(result.references?.capped).toBe(false);
    expect(read(store, "4-archive/alpha/overview.md")).toBe(
      "# Alpha\n\nsee [[../../1-projects/beta/notes]] and [[../../2-areas/health]]\n",
    );
    expect(read(store, "1-projects/beta/notes.md")).toBe(
      "# Beta\n\n[[../../4-archive/alpha/overview]] and [x](../../4-archive/alpha/overview.md)\n",
    );
    expect(read(store, "2-areas/health.md")).toBe("# Health\n\nrooted [[4-archive/alpha/overview]]\n");
  });

  test("a link inside a code fence is left alone", async () => {
    const store = bucket();
    store.seed(
      "3-resources/how-to.md",
      "# How to\n\n```\n[[../1-projects/alpha/overview]]\n```\n\nand [[../1-projects/alpha/overview]]\n",
    );
    await movePath(store, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "private",
      now: NOW,
    });
    expect(read(store, "3-resources/how-to.md")).toBe(
      "# How to\n\n```\n[[../1-projects/alpha/overview]]\n```\n\nand [[../1-projects/alpha/summary]]\n",
    );
  });
});

describe("the rewrite stops at what the caller can see", () => {
  test("a team caller does not rewrite a note it cannot read", async () => {
    /*
      The gateway's rule, and this side has to make the same call for the same
      reason: the control plane holds the credential and *could* repair the
      private note, and the count it reported back would then be a count over
      notes this caller cannot list. `move_folder`'s own filtering comment in
      the gateway carries the argument in full.
    */
    const store = bucket();
    await shareMost(store);
    const result = await movePath(store, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "team",
      now: NOW,
    });

    expect(read(store, "1-projects/beta/notes.md")).toBe(
      "# Beta\n\n[[../alpha/summary]] and [x](../alpha/summary.md)\n",
    );
    // Untouched, and uncounted.
    expect(read(store, "2-areas/private-log.md")).toBe(
      "# Log\n\n[[../1-projects/alpha/overview]]\n",
    );
    expect(result.references?.notes).toBe(2);
  });

  test("an owner's move reaches the same private note", async () => {
    // The other half of the pair: this is a clearance, not a bug in the walk.
    const store = bucket();
    await shareMost(store);
    const result = await movePath(store, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "private",
      now: NOW,
    });
    expect(read(store, "2-areas/private-log.md")).toBe(
      "# Log\n\n[[../1-projects/alpha/summary]]\n",
    );
    expect(result.references?.notes).toBe(3);
  });
});

describe("a walk that could not be finished says so", () => {
  /*
    The one branch a green suite is most likely to be lying about, and it was:
    the first version of this file had no coverage of it at all, and a sabotage
    that returned the short list instead of `null` failed nothing.

    A page that reports more and hands back no way to ask for it is the shape
    `keysUnder` documents in its own `complete` flag. Ending the walk there
    returns a list that reads exactly like a complete one — and the caller then
    rewrites part of a bucket and reports a total.
  */
  function truncating(store: MemoryStore & FileStore): MemoryStore & FileStore {
    return {
      ...store,
      async list(options: Parameters<FileStore["list"]>[0]) {
        const page = await store.list(options);
        return { ...page, truncated: true, cursor: undefined };
      },
    } as MemoryStore & FileStore;
  }

  test("a truncated listing rewrites nothing and reports capped", async () => {
    const store = bucket();
    const before = read(store, "1-projects/beta/notes.md");
    const result = await movePath(truncating(store), {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "private",
      now: NOW,
    });

    expect(result.references).toEqual({ notes: 0, links: 0, capped: true });
    // The move itself still happened. A rewrite that could not be attempted
    // must not undo one that succeeded.
    expect(read(store, "1-projects/alpha/summary.md")).toBeDefined();
    expect(read(store, "1-projects/beta/notes.md")).toBe(before);
  });

  test("a store that fails the whole-bucket walk is capped, not a failed move", async () => {
    /*
      The throw is scoped to the root listing, which is the only list this
      rewrite makes — a store that refused *every* list would fail the move long
      before reaching here, and a test built that way would be asserting about a
      branch it never reached.
    */
    const store = bucket();
    const before = read(store, "1-projects/beta/notes.md");
    const failing = {
      ...store,
      async list(options: Parameters<FileStore["list"]>[0]) {
        if ((options?.prefix ?? "") === "") throw new Error("the bucket is unreachable");
        return store.list(options);
      },
    } as MemoryStore & FileStore;

    const result = await movePath(failing, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/summary.md",
      scope: "private",
      now: NOW,
    });
    expect(result.references).toEqual({ notes: 0, links: 0, capped: true });
    expect(read(store, "1-projects/alpha/summary.md")).toBeDefined();
    expect(read(store, "1-projects/beta/notes.md")).toBe(before);
  });
});

describe("a copy is not a move", () => {
  test("copying rewrites nothing, because nothing went anywhere", async () => {
    const store = bucket();
    const before = read(store, "1-projects/beta/notes.md");
    const result = await copyPath(store, {
      from: "1-projects/alpha/overview.md",
      to: "1-projects/alpha/overview-copy.md",
      scope: "private",
    });
    expect(result.references).toBeUndefined();
    expect(read(store, "1-projects/beta/notes.md")).toBe(before);
  });
});
