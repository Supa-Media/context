import { describe, expect, test } from "vitest";
import { S3Store } from "../../../mcp/src/store/s3.js";
import {
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
  type ScaffoldStore,
  hasExistingContext,
  renderPrivacyManifest,
  renderPrivacyManifestForFolders,
  scaffoldContext,
} from "../../functions/lib/scaffold";
import { gatewayInternals } from "../gatewayFormat.helpers";
import { memoryS3, memoryStore } from "../storeStub.helpers";
import {
  FAKE_BUCKET,
  FAKE_S3,
  seedLiveWorkspace,
  PARA_READMES,
} from "./fixtures";


/**
 * ISSUE #22.
 *
 * A bucket can refuse a write partway through — a policy that denies a prefix,
 * a credential rotated out from under us — and the old code did two wrong
 * things with that. It called the whole run `failed`, when the file that
 * actually matters had landed and the bucket *was* a working context. And it
 * left the owner unable to finish: the retry's first guard saw the `privacy.md`
 * the first attempt wrote, called the bucket an existing context, and told them
 * "nothing has been changed" while their bucket sat half-written. Completing it
 * meant deleting objects by hand over S3.
 *
 * What is essential is decided by the gateway, not by taste: `privacy.md` is
 * the visibility manifest `loadPrivacyState` parses, and without it a context
 * silently runs on the legacy `.note-acl` fallback and cannot have its folder
 * visibility changed at all. `index.md` is read in one guarded place
 * (`toolOrient`) and READMEs in none. See `ESSENTIAL_KEYS`.
 */
describe("essentials are guaranteed; folders and READMEs are best effort", () => {
  test("privacy.md is written before anything best-effort, not after", async () => {
    // A bucket that accepts exactly one object and then starts refusing. What
    // survives is decided entirely by write order.
    let accepted = 0;
    const store = memoryStore({ refuseWrite: () => accepted++ >= 1 });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result.written).toEqual([PRIVACY_KEY]);
    expect(result.reason).toBe("partial");
  });

  test("folders that will not write are a caveat, not a failure", async () => {
    const store = memoryStore({
      refuseWrite: (key) => key.endsWith("/README.md"),
    });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "partial" });
    expect(result.written.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    expect(result.missing.sort()).toEqual([...PARA_READMES].sort());
    // The claim behind calling this a success: the manifest the gateway
    // enforces visibility with is there, and it parses.
    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(store.objects.get(PRIVACY_KEY)!.body).rules,
    ).toHaveLength(PARA_FOLDERS.length);
  });

  test("an essential that will not write is a failure, and stops the run", async () => {
    const store = memoryStore({ refuseWrite: (key) => key === PRIVACY_KEY });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: false, reason: "failed" });
    expect(result.missing).toContain(PRIVACY_KEY);
    // Nothing else was laid into a bucket that just refused the access
    // manifest. A folder full of READMEs and no privacy.md is not a context.
    expect([...store.objects.keys()]).toEqual([]);
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
      refuseWrite: (key) => refuse.readmes && key.endsWith("/README.md"),
    });
    const first = await scaffoldContext(store, { structureTemplate: "para" });
    expect(first.reason).toBe("partial");
    return { store, refuse, first };
  }

  test("a plain retry still refuses — the bucket does look like a context", async () => {
    const { store } = await halfWritten();

    // Not a bug in the detector. From the outside this bucket holds a
    // privacy.md and an index.md, which is exactly what a small context looks
    // like. It is the caller that has to know better.
    expect(await hasExistingContext(store)).toBe(true);
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "existing-context", written: [] });
  });

  test("a resumed retry completes the layout instead of refusing", async () => {
    const { store, refuse } = await halfWritten();
    const privacyBefore = store.objects.get(PRIVACY_KEY)!;
    refuse.readmes = false;

    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });

    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.missing).toEqual([]);
    expect(second.written.sort()).toEqual([...PARA_READMES].sort());
    expect(second.skipped.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    // The files the first attempt landed were skipped, not rewritten: same
    // etag, same bytes. A resume that re-`put` privacy.md would reset any
    // visibility the owner had already changed.
    expect(store.objects.get(PRIVACY_KEY)).toBe(privacyBefore);
    expect([...store.objects.keys()].sort()).toEqual(
      [...PARA_READMES, INDEX_KEY, PRIVACY_KEY].sort(),
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
    // would wave through: `1-projects/` is a prefix we would have written.
    store.seed("1-projects/their-note.md", "# Mine, thanks\n");
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
    store.seed(PRIVACY_KEY, "# hand written, do not touch\n");
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

  test("resume finishes a run whose essential failed, once the bucket lets it", async () => {
    const refuse = { all: true };
    const store = memoryStore({ refuseWrite: () => refuse.all });
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "failed", scaffolded: false });

    refuse.all = false;
    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });
    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.written.sort()).toEqual(
      [...PARA_READMES, INDEX_KEY, PRIVACY_KEY].sort(),
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

    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(backend.objects.get(PRIVACY_KEY)!.body).rules,
    ).toHaveLength(PARA_FOLDERS.length);
  });

  test("leaves an existing bucket alone end to end", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    backend.seed("1-projects/live.md", "# Live\n");
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
    expect(result.written.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    // …and the bucket got `notes/workspace/index.md`.
    expect([...backend.objects.keys()].sort()).toEqual(
      ["notes/workspace/index.md", "notes/workspace/privacy.md"].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                          a shared workspace                                */
/* -------------------------------------------------------------------------- */

/**
 * The one thing `kind` changes, and the reason it had to change something.
 *
 * A workspace exists because several people are in it. Scaffolded all-private —
 * which is what happened before this — every folder is unreachable to everybody
 * but an owner, because `clampScopes` lets only an `owner` hand a client the
 * `context:private` scope. So an `editor` invited into a brand-new workspace
 * could not read one note in it by any grant they were able to issue, and the
 * fix was a file they had to know existed.
 *
 * These are written against the **gateway's own** parser and `canSee`, for the
 * reason `gatewayFormat.helpers.ts` gives: an assertion about the bytes we
 * wrote would be both halves of our own expectation.
 */
describe("a shared workspace's starting manifest", () => {
  test("opens the scaffolded folders to the workspace, and only those", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual([...PARA_FOLDERS].sort());
    expect(rules.every((rule) => rule.vis === "team")).toBe(true);
    // One exact-note rule, and this line used to assert none — which is how the
    // root-level miss got past a round of review. The folder rules genuinely
    // are only these five; `index.md` needs a rule of its own precisely because
    // no folder rule can reach the root. See "the front page is opened by
    // name" below.
    expect([...overrides.entries()]).toEqual([["index.md", "team"]]);

    for (const key of [
      "0-inbox/README.md",
      "1-projects/README.md",
      "1-projects/anything.md",
      "4-archive/deep/nested/note.md",
    ]) {
      expect(canSee(key, "team", rules, overrides), `${key} is not readable`).toBe(
        true,
      );
    }
  });

  /**
   * `default_visibility` stays `private` — it is fixed in
   * `renderPrivacyRulesBlock` — so opening the five folders the scaffolder made
   * is not the same as opening the bucket. A folder somebody adds later is
   * still private until a line names it, which is the property that keeps this
   * a starting layout rather than a switch.
   */
  test("a path outside the declared folders still fails closed", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(canSee("payroll/salaries.md", "team", rules, overrides)).toBe(false);
    expect(canSee("root-level-note.md", "team", rules, overrides)).toBe(false);
  });

  /** `privacy.md` is the access map. Reading it is an owner's business either way. */
  test("the access map itself is never team-readable", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );
    expect(canSee(PRIVACY_KEY, "team", rules, overrides)).toBe(false);
  });

  test("a custom layout opens the owner's own folders, not PARA's", async () => {
    const store = memoryStore();
    await scaffoldContext(store, {
      structureTemplate: "custom",
      kind: "shared",
      customFolders: [
        { folder: "handbook", description: "How we work." },
        { folder: "customers", description: "One folder per account." },
      ],
    });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual(["customers", "handbook"]);
    expect(canSee("handbook/onboarding.md", "team", rules, overrides)).toBe(true);
    expect(canSee("1-projects/anything.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * The regression that matters most. A personal workspace is the majority case and
   * the one where a `team` default would hand somebody's notes to whoever they
   * later invite, without being asked. Sabotage `startingVisibility`'s
   * `personal` branch and this is what fails.
   */
  test("a personal workspace is untouched by any of this", async () => {
    const shared = memoryStore();
    const personal = memoryStore();
    const omitted = memoryStore();
    await scaffoldContext(shared, { structureTemplate: "para", kind: "shared" });
    await scaffoldContext(personal, { structureTemplate: "para", kind: "personal" });
    // No `kind` at all: the conservative branch, for a job scheduled by an
    // older mutation during a rollout.
    await scaffoldContext(omitted, { structureTemplate: "para" });

    const personalManifest = personal.objects.get(PRIVACY_KEY)!.body;
    expect(omitted.objects.get(PRIVACY_KEY)!.body).toBe(personalManifest);
    expect(shared.objects.get(PRIVACY_KEY)!.body).not.toBe(personalManifest);

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(personalManifest);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(canSee("1-projects/anything.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * `resetPrivacyManifest` repairs a manifest that was failing closed, against
   * a bucket that already has members and content — neither property a fresh
   * workspace has. All-private is the only rewrite there under which nothing
   * changes hands, so the repair renderer must keep defaulting to it.
   */
  test("the repair renderer still writes an all-private manifest", () => {
    const { parsePrivacyManifest } = gatewayInternals();
    const { rules } = parsePrivacyManifest(
      renderPrivacyManifestForFolders(["1-projects", "handbook"]),
    );
    expect(rules.length).toBe(2);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
  });

  /**
   * The guard that would have caught the root-level miss, and catches the next
   * one.
   *
   * The previous round made every *folder* `team` and stopped, which is a rule
   * about prefixes — and `index.md` is at the root, under no prefix, so it
   * matched nothing and fell through to `default_visibility: private`. A
   * workspace shipped whose members could read every note in it and not the
   * page that says what it is; the gateway gates its whole orientation on
   * `canSee("index.md", …)`, so their client got a bare folder map.
   *
   * So this asserts over **every key the scaffolder actually writes** rather
   * than over the ones somebody remembered to list. Add a file at the root next
   * year and forget its override, and this fails.
   */
  test("every file the scaffolder writes is readable by the workspace, bar the access map", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    const written = [...store.objects.keys()];
    // Non-vacuous: the scaffold really did write a root note and some folders.
    expect(written).toContain(INDEX_KEY);
    expect(written.length).toBeGreaterThan(PARA_FOLDERS.length);

    for (const key of written) {
      // `privacy.md` is the one exception, and it is not this manifest's
      // choice: `canSee` hardcodes owner-only for it.
      const expected = key === PRIVACY_KEY ? false : true;
      expect(canSee(key, "team", rules, overrides), `${key} at team scope`).toBe(expected);
    }
  });

  /**
   * The same fact stated on its own, because it is the one somebody will look
   * for by name — and because the guard above would still pass if `index.md`
   * were made readable by opening the whole bucket instead.
   */
  test("the front page is opened by name, not by widening anything", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const manifest = store.objects.get(PRIVACY_KEY)!.body;
    const { rules, overrides } = parsePrivacyManifest(manifest);

    expect(canSee(INDEX_KEY, "team", rules, overrides)).toBe(true);
    // An exact-note rule, and exactly one of them.
    expect([...overrides.entries()]).toEqual([[INDEX_KEY, "team"]]);
    // The root itself stays shut: a sibling root note nobody ruled on, and a
    // folder somebody adds later, are both still private.
    expect(manifest).toContain("default_visibility: private");
    expect(canSee("secrets.md", "team", rules, overrides)).toBe(false);
    expect(canSee("payroll/2026.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * A workspace's `index.md` is its owner's own manifest and may describe anything.
   * Publishing it to everybody they later share a folder with is not ours to
   * decide, so the root stays shut there — including on the repair path, which
   * defaults to `personal`.
   */
  test("a workspace's front page is not published, and neither is a repaired one", () => {
    const { parsePrivacyManifest, canSee } = gatewayInternals();

    const workspace = parsePrivacyManifest(renderPrivacyManifest("para", [], "personal"));
    expect(workspace.overrides.size).toBe(0);
    expect(canSee(INDEX_KEY, "team", workspace.rules, workspace.overrides)).toBe(false);

    const repaired = parsePrivacyManifest(
      renderPrivacyManifestForFolders(["1-projects", "handbook"]),
    );
    expect(repaired.overrides.size).toBe(0);
    expect(canSee(INDEX_KEY, "team", repaired.rules, repaired.overrides)).toBe(false);
  });

  test("the manifest tells a member what the two words mean here", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });
    const manifest = store.objects.get(PRIVACY_KEY)!.body;

    // The one thing a member cannot discover by reading the rules: `private`
    // in a workspace is not "the person who wrote it", it is "owners".
    expect(manifest).toContain("owners");
    expect(manifest).toContain("every member of this workspace");
    expect(manifest).not.toContain("only you");
  });
});
