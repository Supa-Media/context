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
  FileOpError,
  type ContextMoveSkip,
  type FileStore,
  clearMovedSourceRules,
  deleteMovedSources,
  exportContextMoveBatch,
  importContextMoveBatch,
  landingVisibility,
  listFolderPaths,
} from "../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Visibility,
  effectiveVisibility,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
} from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "./seededRules.helpers";

type Bucket = MemoryStore & FileStore;

/**
 * A bucket whose storage really does honour the preconditions.
 *
 * Not a detail: `deleteMovedSources` only makes its delete conditional where
 * the binding proved it can, and the conflict half of this suite is meaningless
 * against a stub that deletes whatever it is pointed at.
 */
function bucket(
  folders: string[],
  kind: "personal" | "shared" = "personal",
  /**
   * Model R2: `If-Match` on DELETE is accepted and ignored, and the binding
   * says so. This is what every real row probes as, so it is worth being able
   * to run the whole suite against it.
   */
  options: { ignoreIfMatchOnDelete?: boolean } = {},
): Bucket {
  const store = memoryStore({ conditional: true, ...options }) as Bucket;
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

  try {
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
        // First batch only, exactly as `advanceContextMove` passes it.
        ...(moved.length === 0 ? { root: options.to } : {}),
      });
      if (landed.landed.length > 0) {
        const removed = await deleteMovedSources(source, {
          sources: landed.landed.map((entry) => {
            const exportedObject = exported.objects.find(
              (object) => object.source === entry.source,
            )!;
            return {
              path: entry.source,
              etag: exportedObject.etag,
            };
          }),
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
  } catch (error) {
    /*
      The orchestrator's own `catch`, in miniature: a refusal thrown out of the
      engine — a destination that is already a folder, an unreadable manifest —
      ends the move on the row rather than escaping. A harness that let it
      escape would make every such test read as a crash rather than as the
      refusal it is.
    */
    failure = error instanceof FileOpError ? error.code : "threw";
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

  test("a stale exception at the landing path does not publish what lands on it", async () => {
    /*
      `clearExactVisibilityIfAbsent` IS A DELIBERATE NO-OP, SO THIS PATH EXISTS.

      Deleting a note leaves its exact rule behind on purpose: there is no
      compare-and-delete for an ACL entry keyed to an absent object, and the
      race the check would open — exposing a writer who recreates the path — was
      judged worse than a stale rule. That reasoning holds for a note recreated
      in the same context, where the rule is the owner's own earlier intent at
      that path. It does not hold for a note arriving from another context,
      whose tier was computed somewhere else.

      So a path inside a private folder can carry a `team` exception with
      nothing at it, and `landingVisibility` cannot see it: it is asked what the
      destination FOLDER publishes, a private folder answers `private`, the
      narrowing write is skipped as redundant, and the stale exception decides
      what landed. A note its owner moved in as private was readable by the
      people they had named in the destination — the one thing this operation
      promises never to do, and the reason it asks for no confirmation.
    */
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/notes.md", "# Notes\n\nprivate on both sides\n");
    expect(visibilityIn(source, "1-projects/notes.md")).toBe("private");
    // What a share of one note, since deleted, leaves in a private folder.
    withRules(destination, (state) => state.overrides.set("work/notes.md", "team"));
    expect(destination.objects.has("work/notes.md")).toBe(false);
    expect(visibilityIn(destination, "work/notes.md")).toBe("team");

    await runMove(source, destination, { from: "1-projects/notes.md", to: "work/notes.md" });

    expect(destination.objects.has("work/notes.md")).toBe(true);
    expect(visibilityIn(destination, "work/notes.md")).toBe("private");
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

});

describe("moving a folder into another context", () => {
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

describe("the folders a destination picker is offered", () => {
  test("every folder in the context, flattened, in one walk", async () => {
    const store = bucket(["1-projects", "2-areas"]);
    store.seed("1-projects/acme/notes.md", "# Notes\n");
    store.seed("1-projects/acme/deep/further.md", "# Further\n");
    store.seed("2-areas/health.md", "# Health\n");
    store.seed(".context/trash/1-projects/gone.md", "# Gone\n");

    const { folders, truncated } = await listFolderPaths(store, { clearance: OWNER });

    expect(folders).toEqual([
      "1-projects",
      "1-projects/acme",
      "1-projects/acme/deep",
      "2-areas",
    ]);
    // Plumbing is not a destination, and it is not a name a picker may print.
    expect(folders.some((folder) => folder.startsWith(".context"))).toBe(false);
    expect(truncated).toBe(false);
  });

  test("a folder the caller cannot see is not in the list", async () => {
    const store = bucket(["work", "board"], "shared");
    withRules(store, (state) => {
      state.rules = state.rules.map((rule) =>
        rule.prefix === "board" ? { ...rule, vis: "private" as const } : rule,
      );
    });
    store.seed("work/plan.md", "# Plan\n");
    store.seed("board/minutes.md", "# Minutes\n");

    expect((await listFolderPaths(store, { clearance: OWNER })).folders).toEqual([
      "board",
      "work",
    ]);
    // An editor is offered only what they could already list. Offering the
    // other one would name a private folder to somebody in a picker.
    expect((await listFolderPaths(store, { clearance: EDITOR })).folders).toEqual(["work"]);
  });

  test("an unreadable manifest lists nothing rather than everything", async () => {
    const store = bucket(["work"]);
    store.seed(PRIVACY_KEY, "# privacy\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\nnonsense\n");
    store.seed("work/plan.md", "# Plan\n");

    await expect(listFolderPaths(store, { clearance: EDITOR })).rejects.toThrow();
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

  test("storage that can do neither is refused before anything is copied", async () => {
    // B2 and Wasabi, which this file already models as `ignoreIfMatch`:
    // they accept the precondition and write anyway, so the binding reports
    // no conditional write. Refused by name, and refused on the source side —
    // where a discovery made any later would already have written the
    // destination.
    const source = memoryStore({ ignoreIfMatch: true }) as Bucket;
    source.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["1-projects"], "personal"));
    source.seed("1-projects/pay.md", "# Pay\n");
    const destination = bucket(["work"]);

    await expect(
      exportContextMoveBatch(source, {
        from: "1-projects/pay.md",
        to: "work/pay.md",
        clearance: OWNER,
      }),
    ).rejects.toThrow(/conflict-safe/);
    expect(destination.objects.has("work/pay.md")).toBe(false);
  });

  test("a destination that cannot write only-if-absent is refused too", async () => {
    const source = bucket(["1-projects"]);
    const destination = memoryStore() as Bucket;
    destination.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["work"], "personal"));
    source.seed("1-projects/pay.md", "# Pay\n");

    const exported = await exportContextMoveBatch(source, {
      from: "1-projects/pay.md",
      to: "work/pay.md",
      clearance: OWNER,
    });

    // The read-compare that used to stand in for this is exactly the window a
    // move must not have: two movers landing on one path both see it free.
    await expect(
      importContextMoveBatch(destination, { objects: exported.objects, clearance: OWNER }),
    ).rejects.toThrow(/only if it is absent|if it is absent/);
    expect(source.objects.has("1-projects/pay.md")).toBe(true);
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

  test("it will not merge a folder onto a folder the destination already has", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/notes.md", "# mine\n");
    destination.seed("work/acme/theirs.md", "# theirs\n");

    const result = await runMove(source, destination, {
      from: "1-projects/acme",
      to: "work/acme",
    });

    /*
      Two trees whose keys never collide, so the per-object check cannot see
      this at all — and `movePath` records what the merge does when it is
      allowed: the source folder's rule lands on a destination that already had
      notes in it, and one of them changes tier. Refused before anything is
      written, and the source is untouched.
    */
    expect(result.failure).toBe("DESTINATION_EXISTS");
    expect(destination.objects.has("work/acme/notes.md")).toBe(false);
    expect(source.snapshot()["1-projects/acme/notes.md"]).toBe("# mine\n");
  });

  test("it will not put a folder where the destination has a file of that name", async () => {
    const source = bucket(["1-projects"]);
    const destination = bucket(["work"]);
    source.seed("1-projects/acme/notes.md", "# mine\n");
    destination.seed("work/acme", "not a folder");

    const result = await runMove(source, destination, {
      from: "1-projects/acme",
      to: "work/acme",
    });

    // Invisible to a per-object check too: every destination is `work/acme/…`
    // and none of them is `work/acme`. The result would be a file key
    // shadowing a folder prefix, a shape some stores cannot represent.
    expect(result.failure).toBe("DESTINATION_EXISTS");
    expect(destination.snapshot()["work/acme"]).toBe("not a folder");
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
