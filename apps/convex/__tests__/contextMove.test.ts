/**
 * MOVING SOMETHING OUT OF ONE CONTEXT AND INTO ANOTHER.
 *
 * Two buckets, two privacy manifests, no shared credential — so this exercises
 * the three halves of the operation (`exportContextMoveBatch`,
 * `importContextMoveBatch`, `deleteMovedSources`) against two in-memory stores,
 * driven by the same little loop `functions/contextMoves.ts` runs for real.
 * The orchestration's *authorization* is proven separately in
 * `contextMoves.test.ts`; what is proven here is what actually happens to the
 * bytes and to the two manifests.
 *
 * The assertions that matter most, and why each one is a real failure mode:
 *
 *  - **Nothing is ever widened.** A private note landing in a team-default
 *    folder is the whole reason `landingVisibility` exists. Getting this wrong
 *    publishes somebody's private draft to a different set of people than the
 *    ones they chose, in one press, with no undo — which is the single worst
 *    thing this feature could do.
 *  - **A group rule does not travel.** `@supa-leads` names a group in the
 *    source's control plane. Carried across, it reaches nobody today and the
 *    wrong people the day the destination mints that name.
 *  - **The source is never removed before the destination has answered.** Every
 *    ordering test here is really the same question: which of the two buckets
 *    is allowed to be wrong if the move dies halfway. The answer is the one
 *    holding a redundant copy, never the one holding nothing.
 *  - **A folder past `FOLDER_OPERATION_CAP` moves completely.** That cap is
 *    what a single-store move refuses at, and "it should work even for large
 *    moves" is the requirement this operation exists to meet. The test moves
 *    more objects than the cap and counts them at the other end.
 *  - **An encrypted note stays where its key is.** Its ciphertext in another
 *    context is a note nobody can ever open again — a silent, permanent loss
 *    dressed up as a successful move.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  CONTEXT_MOVE_SKIP_CAP,
  FOLDER_OPERATION_CAP,
  type ContextMoveSkip,
  type FileStore,
  clearMovedSourceRules,
  deleteMovedSources,
  exportContextMoveBatch,
  importContextMoveBatch,
  landingVisibility,
} from "../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Visibility,
  effectiveVisibility,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
} from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "../functions/lib/scaffold";

type Bucket = MemoryStore & FileStore;

/**
 * A bucket whose storage really does honour the preconditions.
 *
 * Not a detail: `deleteMovedSources` only makes its delete conditional where
 * the binding proved it can, and the conflict half of this suite is meaningless
 * against a stub that deletes whatever it is pointed at.
 */
function bucket(folders: string[], kind: "personal" | "shared" = "personal"): Bucket {
  const store = memoryStore({ conditional: true }) as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(folders, kind));
  return store;
}

/** The owner of the context something is moving out of, and of the one it lands in. */
const OWNER = clearanceOf("private", []);

/** An editor of the destination: may write, reads at `team`. */
const EDITOR = clearanceOf("team", []);

function manifestOf(store: Bucket) {
  return parsePrivacyManifest(store.objects.get(PRIVACY_KEY)!.body);
}

function visibilityIn(store: Bucket, path: string) {
  const manifest = manifestOf(store);
  return effectiveVisibility(path, manifest.rules, manifest.overrides);
}

/**
 * Edit a fixture's manifest through the same renderer the product writes it
 * with, rather than by patching its text.
 *
 * A hand-written rule block that happened not to parse would make a test pass
 * by leaving the fixture with no rules at all — which is the "all private"
 * answer several of these assertions are checking for on purpose.
 */
function withRules(
  store: Bucket,
  change: (state: { rules: PrivacyRule[]; overrides: Map<string, Visibility> }) => void,
): void {
  const text = store.objects.get(PRIVACY_KEY)!.body;
  const parsed = parsePrivacyManifest(text);
  const state = { rules: [...parsed.rules], overrides: new Map(parsed.overrides) };
  change(state);
  store.seed(PRIVACY_KEY, replacePrivacyRulesBlock(text, state.rules, state.overrides));
}

/**
 * The loop `advanceContextMove` runs, with the scheduler and the credential
 * barrier taken out.
 *
 * Written here rather than imported because the real one is an action chain
 * over two workspace ids; this is the same order of operations against two
 * stores, and keeping it short is what makes each test below readable as "this
 * is what the move did".
 */
async function runMove(
  source: Bucket,
  destination: Bucket,
  options: {
    from: string;
    to: string;
    limit?: number;
    maxBytes?: number;
    passes?: number;
    /** What the mover holds in the DESTINATION. An owner unless one is given. */
    landAs?: typeof OWNER;
  },
): Promise<{
  moved: string[];
  skipped: ContextMoveSkip[];
  conflicts: string[];
  failure: string | null;
  batches: number;
}> {
  const moved: string[] = [];
  const skipped: ContextMoveSkip[] = [];
  const conflicts: string[] = [];
  let failure: string | null = null;
  let batches = 0;

  for (let pass = 0; pass < (options.passes ?? 500); pass += 1) {
    const exported = await exportContextMoveBatch(source, {
      from: options.from,
      to: options.to,
      clearance: OWNER,
      skip: skipped.map((entry) => entry.path),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    batches += 1;
    for (const entry of exported.skipped) {
      if (!skipped.some((seen) => seen.path === entry.path)) skipped.push(entry);
    }
    if (exported.objects.length > 0) {
      const landed = await importContextMoveBatch(destination, {
        objects: exported.objects,
        clearance: options.landAs ?? OWNER,
      });
      if (landed.landed.length > 0) {
        const removed = await deleteMovedSources(source, {
          sources: landed.landed.map((entry) => ({
            path: entry.source,
            etag: exported.objects.find((object) => object.source === entry.source)!.etag,
          })),
        });
        moved.push(...removed.deleted);
        conflicts.push(...removed.conflicts);
        if (removed.conflicts.length > 0) {
          const stale = landed.landed.filter((entry) => removed.conflicts.includes(entry.source));
          await deleteMovedSources(destination, {
            sources: stale.map((entry) => ({ path: entry.destination, etag: entry.etag })),
          });
          failure = "conflict";
          break;
        }
      }
      if (landed.failure !== null) {
        failure = landed.failure.code;
        break;
      }
    }
    if (!exported.remaining) break;
  }

  if (failure === null) {
    await clearMovedSourceRules(source, {
      from: options.from,
      survivors: skipped.map((entry) => entry.path),
    });
  }
  return { moved, skipped, conflicts, failure, batches };
}

/* -------------------------------------------------------------------------- */

describe("landingVisibility", () => {
  test("team only survives when both ends already say team", () => {
    expect(landingVisibility("team", "team")).toBe("team");
    expect(landingVisibility("team", "private")).toBe("private");
    expect(landingVisibility("private", "team")).toBe("private");
    expect(landingVisibility("private", "private")).toBe("private");
  });

  test("a group rule at the destination is not team, so nothing lands team under it", () => {
    // `visibilityOf` can answer with a group name, and the one thing that must
    // never happen is a `team` note landing under it and reading as though the
    // group had been chosen for it.
    expect(landingVisibility("team", "@supa-leads")).toBe("private");
  });
});

describe("moving one note into another context", () => {
  test("it lands at the destination and is gone from the source", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");

    const result = await runMove(source, destination, {
      from: "1-projects/pay.md",
      to: "work/pay.md",
    });

    expect(result.failure).toBeNull();
    expect(result.moved).toEqual(["1-projects/pay.md"]);
    expect(destination.snapshot()["work/pay.md"]).toBe("# Pay\n\nsalaries\n");
    expect(source.objects.has("1-projects/pay.md")).toBe(false);
  });

  test("a private note landing in a team folder is written private first", async () => {
    const source = bucket(["1-projects"]);
    // A shared context: its folders default to `team`, which is exactly the
    // case where an unguarded move publishes something.
    const destination = bucket(["work"], "shared");
    source.seed("1-projects/pay.md", "# Pay\n");
    expect(visibilityIn(source, "1-projects/pay.md")).toBe("private");
    expect(visibilityIn(destination, "work/README.md")).toBe("team");

    await runMove(source, destination, { from: "1-projects/pay.md", to: "work/pay.md" });

    expect(visibilityIn(destination, "work/pay.md")).toBe("private");
  });

  test("the exception is in the manifest before the body is in the bucket", async () => {
    /*
      The ordering, measured rather than asserted from the code. A note written
      first and narrowed second is readable by the destination's whole team for
      as long as the second write takes — which on a bucket that throws in
      between is forever.
    */
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"], "shared");
    source.seed("1-projects/pay.md", "# Pay\n");

    const order: string[] = [];
    const put = destination.put.bind(destination);
    destination.put = async (key, body, options) => {
      order.push(key === PRIVACY_KEY ? "manifest" : "note");
      return await put(key, body, options);
    };

    await runMove(source, destination, { from: "1-projects/pay.md", to: "work/pay.md" });

    expect(order).toEqual(["manifest", "note"]);
  });

  test("a team note lands team only where the destination folder already is", async () => {
    const source = bucket(["1-projects"], "shared");
    const open = bucket(["work"], "shared");
    const closed = bucket(["work"]);
    source.seed("1-projects/plan.md", "# Plan\n");
    source.seed("1-projects/notes.md", "# Notes\n");
    expect(visibilityIn(source, "1-projects/plan.md")).toBe("team");

    await runMove(source, open, { from: "1-projects/plan.md", to: "work/plan.md" });
    await runMove(source, closed, { from: "1-projects/notes.md", to: "work/notes.md" });

    expect(visibilityIn(open, "work/plan.md")).toBe("team");
    expect(visibilityIn(closed, "work/notes.md")).toBe("private");
  });

  test("a note pointed at a group lands private, because the name means nothing there", async () => {
    const source = bucket(["1-projects"], "shared");
    const destination = bucket(["work"], "shared");
    source.seed("1-projects/hiring.md", "# Hiring\n");
    // The rule a group control writes: an exact override naming a group.
    withRules(source, (state) => state.overrides.set("1-projects/hiring.md", "@supa-leads"));
    expect(visibilityIn(source, "1-projects/hiring.md")).toBe("@supa-leads");

    await runMove(source, destination, { from: "1-projects/hiring.md", to: "work/hiring.md" });

    expect(destination.objects.has("work/hiring.md")).toBe(true);
    expect(visibilityIn(destination, "work/hiring.md")).toBe("private");
  });

  test("the source's own exception is forgotten once the note is gone", async () => {
    const source = bucket(["1-projects"], "shared");
    const destination = bucket(["work"]);
    source.seed("1-projects/pay.md", "# Pay\n");
    withRules(source, (state) => state.overrides.set("1-projects/pay.md", "private"));

    await runMove(source, destination, { from: "1-projects/pay.md", to: "work/pay.md" });

    expect(manifestOf(source).overrides.has("1-projects/pay.md")).toBe(false);
  });
});

describe("moving a folder into another context", () => {
  test("every descendant lands under the new prefix", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/README.md", "# Acme\n");
    source.seed("1-projects/acme/notes.md", "# Notes\n");
    source.seed("1-projects/acme/deep/further.md", "# Further\n");
    source.seed("1-projects/other.md", "# Other\n");

    const result = await runMove(source, destination, {
      from: "1-projects/acme",
      to: "work/acme",
    });

    expect(result.failure).toBeNull();
    expect(Object.keys(destination.snapshot()).sort()).toEqual([
      PRIVACY_KEY,
      "work/acme/README.md",
      "work/acme/deep/further.md",
      "work/acme/notes.md",
    ]);
    // Everything outside the folder is untouched.
    expect(source.objects.has("1-projects/other.md")).toBe(true);
    expect([...source.objects.keys()].some((key) => key.startsWith("1-projects/acme/"))).toBe(false);
  });

  test("a folder rule does not outlive the folder it described", async () => {
    const source = bucket(["1-projects"], "shared");
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/notes.md", "# Notes\n");
    withRules(source, (state) => state.rules.push({ prefix: "1-projects/acme", vis: "private" }));
    expect(visibilityIn(source, "1-projects/acme/notes.md")).toBe("private");

    await runMove(source, destination, { from: "1-projects/acme", to: "work/acme" });

    expect(manifestOf(source).rules.some((rule) => rule.prefix === "1-projects/acme")).toBe(false);
    /*
      Why this matters more than tidiness: the next thing to write
      `1-projects/acme/anything.md` — an ingestion alias, a new note, a restore
      — would inherit a visibility nobody chose for it, from a folder that no
      longer exists.
    */
  });

  test("plumbing never travels", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/notes.md", "# Notes\n");
    source.seed("1-projects/acme/.context/marker", "x");
    source.seed(".context/assets/images/logo", "png");

    await runMove(source, destination, { from: "1-projects/acme", to: "work/acme" });

    expect(Object.keys(destination.snapshot()).sort()).toEqual([
      PRIVACY_KEY,
      "work/acme/notes.md",
    ]);
    expect(source.objects.has("1-projects/acme/.context/marker")).toBe(true);
  });

  test("a folder larger than a single-store move could touch still moves, whole", async () => {
    /*
      `FOLDER_OPERATION_CAP` is where `movePath` refuses, and refusing is right
      there — it rewrites the manifest as though the whole walk happened. This
      operation's all-or-nothing unit is one object, so the same folder is not a
      bigger move, it is more batches.
    */
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    const total = FOLDER_OPERATION_CAP + 37;
    for (let index = 0; index < total; index += 1) {
      source.seed(`1-projects/acme/note-${String(index).padStart(4, "0")}.md`, `# ${index}\n`);
    }

    const result = await runMove(source, destination, {
      from: "1-projects/acme",
      to: "work/acme",
    });

    expect(result.failure).toBeNull();
    expect(result.moved.length).toBe(total);
    expect(result.batches).toBeGreaterThan(1);
    expect(Object.keys(destination.snapshot()).length).toBe(total + 1); // + privacy.md
    expect([...source.objects.keys()].some((key) => key.startsWith("1-projects/acme/"))).toBe(false);
  });

  test("a batch is bounded by bytes as well as by count, and still carries one", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/big.md", "x".repeat(4_096));
    source.seed("1-projects/acme/small.md", "y");

    const first = await exportContextMoveBatch(source, {
      from: "1-projects/acme",
      to: "work/acme",
      clearance: OWNER,
      maxBytes: 8,
    });

    // One object over the ceiling rather than none: a batch that carried
    // nothing would be a move that can never finish.
    expect(first.objects.length).toBe(1);
    expect(first.remaining).toBe(true);
  });
});

describe("what a cross-context move refuses to do", () => {
  test("it will not overwrite something already at the destination", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/pay.md", "# mine\n");
    destination.seed("work/pay.md", "# theirs\n");

    const result = await runMove(source, destination, {
      from: "1-projects/pay.md",
      to: "work/pay.md",
    });

    expect(result.failure).toBe("DESTINATION_EXISTS");
    expect(destination.snapshot()["work/pay.md"]).toBe("# theirs\n");
    // And the source is still there. A move that refused and deleted anyway
    // would be a delete.
    expect(source.snapshot()["1-projects/pay.md"]).toBe("# mine\n");
  });

  test("a note edited between the copy and the delete keeps the newer text", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/pay.md", "# first\n");

    const exported = await exportContextMoveBatch(source, {
      from: "1-projects/pay.md",
      to: "work/pay.md",
      clearance: OWNER,
    });
    // Somebody saves the note in the source context while the batch is in the
    // air. The etag the export took is now stale.
    source.seed("1-projects/pay.md", "# second\n");

    const landed = await importContextMoveBatch(destination, {
      objects: exported.objects,
      clearance: OWNER,
    });
    const removed = await deleteMovedSources(source, {
      sources: [{ path: "1-projects/pay.md", etag: exported.objects[0]!.etag }],
    });

    expect(removed.deleted).toEqual([]);
    expect(removed.conflicts).toEqual(["1-projects/pay.md"]);
    expect(source.snapshot()["1-projects/pay.md"]).toBe("# second\n");

    // The rollback the orchestrator performs: the stale copy goes, and it goes
    // conditionally, so it cannot take anything else with it.
    await deleteMovedSources(destination, {
      sources: landed.landed.map((entry) => ({ path: entry.destination, etag: entry.etag })),
    });
    expect(destination.objects.has("work/pay.md")).toBe(false);
  });

  test("an encrypted note stays in the context whose key can open it", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/plain.md", "# Plain\n");
    source.seed(
      "1-projects/acme/secret.md",
      "---\ncontext_encryption: v1\n---\n\nAAAAAAAAAAAAAAAA\n",
    );

    const result = await runMove(source, destination, {
      from: "1-projects/acme",
      to: "work/acme",
    });

    expect(result.failure).toBeNull();
    expect(result.moved).toEqual(["1-projects/acme/plain.md"]);
    expect(result.skipped).toEqual([
      { path: "1-projects/acme/secret.md", reason: "encrypted" },
    ]);
    expect(source.objects.has("1-projects/acme/secret.md")).toBe(true);
    expect(destination.objects.has("work/acme/secret.md")).toBe(false);
  });

  test("a rule covering something left behind is kept", async () => {
    const source = bucket(["1-projects"], "shared");
    const destination = bucket(["work"]);
    source.seed(
      "1-projects/acme/secret.md",
      "---\ncontext_encryption: v1\n---\n\nAAAAAAAAAAAAAAAA\n",
    );
    withRules(source, (state) => state.rules.push({ prefix: "1-projects/acme", vis: "private" }));

    await runMove(source, destination, { from: "1-projects/acme", to: "work/acme" });

    // The folder is not empty, so its rule is not stale — dropping it would
    // re-tier the note that could not travel.
    expect(manifestOf(source).rules.some((rule) => rule.prefix === "1-projects/acme")).toBe(true);
  });

  test("the skip list has a ceiling, and it is the orchestrator's to enforce", () => {
    // Stated here because the engine cannot see the list growing across
    // batches — `advanceContextMove` is what counts it and stops.
    expect(CONTEXT_MOVE_SKIP_CAP).toBeGreaterThan(0);
  });

  test("an editor cannot land something in a folder the destination keeps private", async () => {
    const source = bucket(["1-projects"]);
    // A shared destination whose folders are `team`, with one private folder in
    // it — the shape an owner has after tightening a single folder.
    const destination = bucket(["work", "board"], "shared");
    withRules(destination, (state) => {
      // Replaced rather than appended: two rules for one prefix is a manifest
      // the product never writes, and `visibilityOf` would answer from
      // whichever came first — a fixture that made this test pass or fail for
      // a reason unrelated to the guard.
      state.rules = state.rules.map((rule) =>
        rule.prefix === "board" ? { ...rule, vis: "private" as const } : rule,
      );
    });
    expect(visibilityIn(destination, "board/anything.md")).toBe("private");
    source.seed("1-projects/pay.md", "# Pay\n");

    const exported = await exportContextMoveBatch(source, {
      from: "1-projects/pay.md",
      to: "board/pay.md",
      clearance: OWNER,
    });

    /*
      An editor there cannot list `board`, so they cannot write into it — and
      the refusal is `notFound`, the same answer the folder gives them for
      every other question, rather than one that confirms it is there.

      Without this, "move into @theirs" would be the one write in the product
      that reaches past the mover's own clearance.
    */
    await expect(
      importContextMoveBatch(destination, { objects: exported.objects, clearance: EDITOR }),
    ).rejects.toThrow();
    expect(destination.objects.has("board/pay.md")).toBe(false);
    // And nothing was written to the manifest on the way to refusing.
    expect(manifestOf(destination).overrides.has("board/pay.md")).toBe(false);

    // The destination's own owner may, which is what makes the refusal above
    // about clearance rather than about the folder.
    const landed = await importContextMoveBatch(destination, {
      objects: exported.objects,
      clearance: OWNER,
    });
    expect(landed.failure).toBeNull();
    expect(destination.objects.has("board/pay.md")).toBe(true);
  });

  test("plumbing cannot be named as either end", async () => {
    const source = bucket(["1-projects"]);
    source.seed(".context/trash/1-projects/gone.md", "# Gone\n");

    // Refused before anything is read, by the same `assertWritablePath` every
    // other write path goes through. Trash, audit and the privacy manifest are
    // not the customer's folders to move, and `privacy.md` in particular is the
    // access map for the context it is being taken out of.
    await expect(
      exportContextMoveBatch(source, {
        from: ".context/trash",
        to: "work/old",
        clearance: OWNER,
      }),
    ).rejects.toThrow();
    await expect(
      exportContextMoveBatch(source, {
        from: "1-projects",
        to: PRIVACY_KEY,
        clearance: OWNER,
      }),
    ).rejects.toThrow();
  });
});
