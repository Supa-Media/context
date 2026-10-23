import { describe, expect, test } from "vitest";
import { S3Store } from "../../../mcp/src/store/s3.js";
import { INDEX_KEY, PARA_FOLDERS, PRIVACY_KEY, type ScaffoldStore, hasExistingContext, scaffoldContext } from "../../functions/lib/scaffold";
import { gatewayInternals } from "../gatewayFormat.helpers";
import { memoryS3, memoryStore } from "../storeStub.helpers";
import {
  FAKE_BUCKET,
  FAKE_S3,
  seedLiveWorkspace,
  PARA_FOLDER_NOTES,
} from "./fixtures.helpers";
import { renderPrivacyManifest, renderPrivacyManifestForFolders } from "../seededRules.helpers";


/**
 * ISSUE #22.
 *
 * A bucket can refuse a write partway through — a policy that denies a prefix,
 * a credential rotated out from under us — and the old code did two wrong
 * things with that. It called the whole run `failed`, when the file that
 * actually matters had landed and the bucket *was* a working context. And it
 * left the owner unable to finish: the retry's first guard saw the file the
 * first attempt wrote, called the bucket an existing context, and told them
 * "nothing has been changed" while their bucket sat half-written. Completing it
 * meant deleting objects by hand over S3.
 *
 * Access is no longer a file: it lives on the tree's rows, so the scaffold has
 * no access manifest to guarantee. Nothing is essential (`ESSENTIAL_KEYS` is
 * empty). A refused write is a caveat, and the run goes on. `index.md` is
 * written first, so it is what lands when a bucket accepts only one object.
 */
describe("a refused write is a caveat, and the run goes on", () => {
  test("the front page is written before any folder note, not after", async () => {
    // A bucket that accepts exactly one object and then starts refusing. What
    // survives is decided entirely by write order.
    let accepted = 0;
    const store = memoryStore({ refuseWrite: () => accepted++ >= 1 });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result.written).toEqual([INDEX_KEY]);
    expect(result.reason).toBe("partial");
  });

  test("folders that will not write are a caveat, not a failure", async () => {
    const store = memoryStore({
      refuseWrite: (key) => key.endsWith("/about.md"),
    });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "partial" });
    expect(result.written.sort()).toEqual([INDEX_KEY]);
    expect(result.missing.sort()).toEqual([...PARA_FOLDER_NOTES].sort());
    // No access file is laid down, whichever way the folders went.
    expect(store.objects.has(PRIVACY_KEY)).toBe(false);
  });

  test("a refused front page does not stop the folder notes from landing", async () => {
    const store = memoryStore({ refuseWrite: (key) => key === INDEX_KEY });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "partial" });
    expect(result.written.sort()).toEqual([...PARA_FOLDER_NOTES].sort());
    expect(result.missing).toEqual([INDEX_KEY]);
    expect(result.error).toContain("AccessDenied");
  });

  test("the error never becomes the reason a good scaffold looks bad", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result).toMatchObject({ reason: "created", missing: [] });
    expect(result.error).toBeUndefined();
  });
});

/**
 * FINISHING THE JOB.
 *
 * `resume` narrows the first guard from "is anything here" to "is anything here
 * that we did not write, byte for byte". Every test in this block is either
 * that finishing the job now works, or that the narrowing did not open a door.
 */
describe("a half-written scaffold can be finished", () => {
  /** A partial run, and a switch to let the bucket start accepting writes. */
  async function halfWritten() {
    const refuse = { readmes: true };
    const store = memoryStore({
      refuseWrite: (key) => refuse.readmes && key.endsWith("/about.md"),
    });
    const first = await scaffoldContext(store, { structureTemplate: "para" });
    expect(first.reason).toBe("partial");
    return { store, refuse, first };
  }

  test("a plain retry still refuses — the bucket does look like a context", async () => {
    const { store } = await halfWritten();

    // Not a bug in the detector. From the outside this bucket holds an index.md,
    // which is exactly what a small context looks like. It is the caller that
    // has to know better.
    expect(await hasExistingContext(store)).toBe(true);
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "existing-context", written: [] });
  });

  test("a resumed retry completes the layout instead of refusing", async () => {
    const { store, refuse } = await halfWritten();
    const indexBefore = store.objects.get(INDEX_KEY)!;
    refuse.readmes = false;

    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });

    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.missing).toEqual([]);
    expect(second.written.sort()).toEqual([...PARA_FOLDER_NOTES].sort());
    expect(second.skipped).toEqual([INDEX_KEY]);
    // The file the first attempt landed was skipped, not rewritten: same
    // etag, same bytes. A resume that re-`put` index.md would reset a front
    // page the owner had already edited.
    expect(store.objects.get(INDEX_KEY)).toBe(indexBefore);
    expect([...store.objects.keys()].sort()).toEqual(
      [...PARA_FOLDER_NOTES, INDEX_KEY].sort(),
    );
  });

  test("resuming twice is still idempotent", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    await scaffoldContext(store, { structureTemplate: "para", resume: true });
    const before = store.snapshot();

    const third = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });
    expect(third).toMatchObject({ scaffolded: false, reason: "created" });
    expect(store.snapshot()).toEqual(before);
  });

  /**
   * THE GUARD THAT HAS TO SURVIVE.
   *
   * Resume is a licence to write into a bucket that is not empty. If it ever
   * applied to somebody's live vault it would be the exact bug the whole module
   * exists to prevent, so the licence is checked against the bucket itself,
   * not only against the row that granted it.
   */
  test("a vault that was here before we arrived is refused, resume or not", async () => {
    const store = memoryStore();
    seedLiveWorkspace(store);
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ scaffolded: false, reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("one note of theirs beside our half-written layout is enough to refuse", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    // Inside a folder our own layout owns, which is the case a root-only check
    // would wave through: `projects/` is a prefix we would have written.
    store.seed("projects/their-note.md", "# Mine, thanks\n");
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("a file at one of our keys that we did not write is enough to refuse", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    // Same key, different bytes. Byte-identity is what makes the answer "we
    // wrote this" rather than "something with this name is here".
    store.seed(INDEX_KEY, "# hand written, do not touch\n");
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("resuming with a different layout than the one we started is refused", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;

    // The half-written PARA files are not keys a custom layout would write, so
    // they read as foreign — which is the right answer. Two interleaved
    // layouts in somebody's bucket is not a repair.
    expect(
      await scaffoldContext(store, {
        structureTemplate: "custom",
        customFolders: [{ folder: "clients", description: "One per client." }],
        resume: true,
      }),
    ).toMatchObject({ reason: "existing-context", written: [] });
  });

  test("plumbing beside a half-written layout is not foreign", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    store.seed(".history/privacy.md.1", "an earlier version");
    store.seed(".context-probe/legacy-probe", "left by old verification");
    store.seed(".context/probes/probe", "left by verification");

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "created" });
  });

  test("resume finishes a run that wrote nothing, once the bucket lets it", async () => {
    const refuse = { all: true };
    const store = memoryStore({ refuseWrite: () => refuse.all });
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "partial", scaffolded: false });

    refuse.all = false;
    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });
    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.written.sort()).toEqual(
      [...PARA_FOLDER_NOTES, INDEX_KEY].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                    the same thing, through the real adapter                */
/* -------------------------------------------------------------------------- */

/**
 * Everything above runs against a hand-written `ContextStore`. That proves the
 * scaffolding logic and nothing about the adapter the control plane actually
 * builds — so run it once more through the real `S3Store`, with real SigV4,
 * real key encoding, real XML listing, over a fetch stub speaking S3.
 */
describe("through the real S3 adapter", () => {
  test("scaffolds a fresh bucket end to end", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    const store = new S3Store({
      ...FAKE_S3,
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result.scaffolded).toBe(true);
    expect([...backend.objects.keys()].sort()).toEqual(result.written.sort());
    expect(backend.objects.has(PRIVACY_KEY)).toBe(false);
    expect(backend.objects.has(INDEX_KEY)).toBe(true);
  });

  test("leaves an existing bucket alone end to end", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    backend.seed("projects/live.md", "# Live\n");
    backend.seed(PRIVACY_KEY, "# hand written\n");
    const before = backend.snapshot();

    const store = new S3Store({
      ...FAKE_S3,
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    expect(await scaffoldContext(store, { structureTemplate: "para" })).toMatchObject(
      { scaffolded: false, reason: "existing-context" },
    );
    expect(backend.snapshot()).toEqual(before);
    // Not one write was attempted.
    expect(backend.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  /**
   * A customer whose bucket holds other things can point us at a subtree. That
   * prefix is applied inside the adapter and is invisible to the scaffolder —
   * and it is emphatically not tenancy: it is the customer's own choice, never
   * derived from a workspace id.
   */
  test("honours a customer-chosen rootPrefix without the scaffolder knowing", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    const store = new S3Store({
      ...FAKE_S3,
      rootPrefix: "notes/workspace/",
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    const result = await scaffoldContext(store, { structureTemplate: "custom" });

    // The scaffolder asked for `index.md`…
    expect(result.written).toEqual([INDEX_KEY]);
    // …and the bucket got `notes/workspace/index.md`, and nothing else.
    expect([...backend.objects.keys()]).toEqual(["notes/workspace/index.md"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          a shared workspace                                */
/* -------------------------------------------------------------------------- */

/**
 * `kind` no longer decides any access in the bucket. A shared workspace's
 * folders take `team` on their rows once the scaffold's derivation runs
 * (`nodesPrivacy.scaffoldFolderDefaults`), and that is judged in
 * `onboarding.test.ts` and `provisioning.test.ts` over the rows. What the
 * scaffolder itself owes here is that it writes the same files either way, and
 * never an access file for the gateway to read.
 */
describe("a shared workspace's starting layout", () => {
  test("is written as the same files as a personal one, with no access file", async () => {
    const shared = memoryStore();
    const personal = memoryStore();
    await scaffoldContext(shared, { structureTemplate: "para", kind: "shared" });
    await scaffoldContext(personal, { structureTemplate: "para", kind: "personal" });

    expect([...shared.objects.keys()].sort()).toEqual([...personal.objects.keys()].sort());
    expect(shared.objects.has(PRIVACY_KEY)).toBe(false);
    expect(personal.objects.has(PRIVACY_KEY)).toBe(false);
  });

  test("a personal workspace's front page makes no claim about sharing", async () => {
    const personal = memoryStore();
    await scaffoldContext(personal, { structureTemplate: "para", kind: "personal" });
    expect(personal.objects.get(INDEX_KEY)!.body).not.toContain("readable by every member");
  });

  /**
   * The access map is still a file the gateway knows how to refuse. It is
   * never team-readable, whatever the rows say, and a seeded or repaired one
   * (test-only renderer, `seededRules.helpers.ts`) still defaults to all-private.
   */
  test("the gateway never shows the access map to a team reader", () => {
    const { canSee } = gatewayInternals();
    expect(canSee(PRIVACY_KEY, "team", [], new Map())).toBe(false);
  });

  test("the repair renderer still writes an all-private manifest", () => {
    const { parsePrivacyManifest } = gatewayInternals();
    const { rules } = parsePrivacyManifest(
      renderPrivacyManifestForFolders(["projects", "handbook"]),
    );
    expect(rules.length).toBe(2);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
  });

  /**
   * A workspace's `index.md` is its owner's own manifest and may describe anything.
   * Publishing it to everybody they later share a folder with is not ours to
   * decide, so the seeded personal renderer keeps the root shut.
   */
  test("a workspace's front page is not published, and neither is a repaired one", () => {
    const { parsePrivacyManifest, canSee } = gatewayInternals();

    const workspace = parsePrivacyManifest(renderPrivacyManifest("para", [], "personal"));
    expect(workspace.overrides.size).toBe(0);
    expect(canSee(INDEX_KEY, "team", workspace.rules, workspace.overrides)).toBe(false);

    const repaired = parsePrivacyManifest(
      renderPrivacyManifestForFolders(["projects", "handbook"]),
    );
    expect(repaired.overrides.size).toBe(0);
    expect(canSee(INDEX_KEY, "team", repaired.rules, repaired.overrides)).toBe(false);
  });
});
