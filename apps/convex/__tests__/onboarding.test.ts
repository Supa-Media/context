/**
 * First run: claim a name, connect storage, and only then be asked anything.
 *
 * ## The bug this file exists to pin
 *
 * The scaffold used to fire automatically the moment `bindStorage` succeeded,
 * reading the `structureTemplate` recorded when the workspace was created. In
 * the order the product actually has — claim a name, connect storage, *then*
 * look at the bucket — that meant the folder layout was written into somebody's
 * bucket **before they had been asked which layout they wanted**. The question
 * onboarding asked afterwards was decoration over a decision already taken.
 *
 * So the tests here are about sequencing as much as authorization:
 *
 *  1. connecting a bucket writes **nothing**, and publishes what was found;
 *  2. the answer, when it comes, is what gets written;
 *  3. an existing brain never reaches step 2 at all — and if it somehow did,
 *     the scaffolder would still refuse.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PARA_FOLDERS, PRIVACY_KEY } from "../functions/lib/scaffold";
import {
  type TestConvex,
  FAKE_STORAGE,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { type MemoryS3Options, memoryS3 } from "./storeStub.helpers";
import { gatewayInternals } from "./gatewayFormat.helpers";
import { clampScopes, visibilityTierOf } from "../functions/lib/consentScopes";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The real flow, up to the point a person would be asked: a workspace, a
 * credential pasted through the real `bindStorage`, and the scheduled
 * verification drained.
 */
async function connected(
  options: MemoryS3Options & {
    seed?: Record<string, string>;
    /** Defaults to a personal brain, which is what this file is mostly about. */
    kind?: "personal" | "shared";
  } = {},
) {
  const { seed, kind, ...bucketOptions } = options;
  const t: TestConvex = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", { kind });

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  for (const [key, body] of Object.entries(seed ?? {})) backend.seed(key, body);
  vi.stubGlobal("fetch", backend.fetchImpl);

  await bindFakeStorage(t, owner, workspaceId);
  await drainScheduled(t);
  return { t, owner, workspaceId, backend };
}

function binding(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return asUser(t, userId).query(api.functions.storage.getStorageBinding, {
    workspaceId,
  });
}

function apply(
  t: TestConvex,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  args: {
    template: "para" | "custom";
    folders?: { folder: string; description: string }[];
  },
) {
  return asUser(t, userId).mutation(api.functions.workspaces.applyStructure, {
    workspaceId,
    ...args,
  });
}

const CUSTOM = [
  { folder: "clients", description: "One folder per client." },
  { folder: "reading", description: "Books and articles worth keeping." },
];

/* -------------------------------------------------------------------------- */

/**
 * Step 2 of the flow, and the fix for the sequencing bug.
 *
 * Connecting a bucket must leave it exactly as it was, whatever
 * `structureTemplate` happens to say on the workspace row.
 */
describe("connecting storage writes nothing and answers the question itself", () => {
  test("an empty bucket comes back empty, and says so", async () => {
    const { t, owner, workspaceId, backend } = await connected();

    expect([...backend.objects.keys()]).toEqual([]);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "connected",
      scaffolded: false,
      scaffoldReason: "empty",
    });
  });

  test("a bucket that already holds a context says so, so nothing is asked", async () => {
    const { t, owner, workspaceId, backend } = await connected({
      seed: { "1-projects/ship-it.md": "# Ship it\n", "index.md": "# Mine\n" },
    });
    const after = backend.snapshot();

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "connected",
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
    expect(after).toEqual({
      "1-projects/ship-it.md": "# Ship it\n",
      "index.md": "# Mine\n",
    });
  });

  /**
   * The row's `structureTemplate` is set at creation, before anyone has been
   * asked. If connecting a bucket ever consults it again, this fails.
   */
  test("a workspace created with a template still gets nothing written on connect", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas", {
      structureTemplate: "para",
    });
    const backend = memoryS3(FAKE_STORAGE.bucket);
    vi.stubGlobal("fetch", backend.fetchImpl);

    await bindFakeStorage(t, owner, workspaceId);
    await drainScheduled(t);

    expect([...backend.objects.keys()]).toEqual([]);
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe("empty");
  });

  test("a rebind forgets what the previous bucket held", async () => {
    const { t, owner, workspaceId } = await connected({
      seed: { "1-projects/ship-it.md": "# Ship it\n" },
    });
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe(
      "existing-context",
    );

    // A different bucket entirely. Carrying the old conclusion forward would
    // have onboarding skip the question for storage nothing has looked at.
    const other = memoryS3("some-other-bucket");
    vi.stubGlobal("fetch", other.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId, { bucket: "some-other-bucket" });

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "unverified",
    });
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBeUndefined();

    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe("empty");
  });
});

/* -------------------------------------------------------------------------- */

describe("the answer is what gets written", () => {
  test("the standard layout lands as five folders, a manifest, and a privacy file", async () => {
    const { t, owner, workspaceId, backend } = await connected();

    expect(await apply(t, owner, workspaceId, { template: "para" })).toMatchObject({
      queued: true,
      template: "para",
      folders: [],
    });
    await drainScheduled(t);

    expect([...backend.objects.keys()].sort()).toEqual(
      [
        "0-inbox/README.md",
        "1-projects/README.md",
        "2-areas/README.md",
        "3-resources/README.md",
        "4-archive/README.md",
        "index.md",
        "privacy.md",
      ].sort(),
    );
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      scaffolded: true,
      scaffoldReason: "created",
    });
  });

  test("the manifest says what belongs in each folder, one line each", async () => {
    const { t, owner, workspaceId, backend } = await connected();
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    const index = backend.objects.get("index.md")!.body;
    for (const folder of PARA_FOLDERS) {
      expect(index).toContain(`\`${folder}/\` —`);
    }
    expect(index).toContain("raw captures, unfiled");
    expect(index).toContain("Move, don't delete.");
  });

  test("a custom layout writes their folders, with their words as the READMEs", async () => {
    const { t, owner, workspaceId, backend } = await connected();

    expect(
      await apply(t, owner, workspaceId, { template: "custom", folders: CUSTOM }),
    ).toMatchObject({ template: "custom", folders: ["clients", "reading"] });
    await drainScheduled(t);

    expect([...backend.objects.keys()].sort()).toEqual([
      "clients/README.md",
      "index.md",
      "privacy.md",
      "reading/README.md",
    ]);
    expect(backend.objects.get("clients/README.md")!.body).toContain(
      "One folder per client.",
    );
    expect(backend.objects.get("index.md")!.body).toContain(
      "`reading/` — Books and articles worth keeping.",
    );
  });

  /**
   * The recommendation the product owner signed off on: private everywhere, no
   * exceptions. `team` grants nothing on a context five minutes old — but the
   * moment its owner invites somebody, a folder that defaulted to `team` becomes
   * visible without anyone having decided that.
   */
  test("every folder starts private, whichever layout was chosen", async () => {
    for (const choice of [
      { template: "para" as const, expected: [...PARA_FOLDERS] },
      { template: "custom" as const, folders: CUSTOM, expected: ["clients", "reading"] },
    ]) {
      const { t, owner, workspaceId, backend } = await connected();
      await apply(t, owner, workspaceId, {
        template: choice.template,
        folders: choice.folders,
      });
      await drainScheduled(t);

      const { parsePrivacyManifest, canSee } = gatewayInternals();
      const { rules, overrides } = parsePrivacyManifest(
        backend.objects.get(PRIVACY_KEY)!.body,
      );
      expect(rules.map((rule) => rule.prefix).sort()).toEqual(
        [...choice.expected].sort(),
      );
      expect(rules.every((rule) => rule.vis === "private")).toBe(true);
      for (const folder of choice.expected) {
        expect(
          canSee(`${folder}/anything.md`, "team", rules, overrides),
          `${folder} is team-visible`,
        ).toBe(false);
      }
      vi.unstubAllGlobals();
    }
  });

  test("the workspace row records what was actually chosen", async () => {
    const { t, owner, workspaceId } = await connected();
    await apply(t, owner, workspaceId, { template: "custom", folders: CUSTOM });

    const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
    expect(workspace?.structureTemplate).toBe("custom");
    expect(workspace?.customFolders).toEqual(CUSTOM);

    // Drained rather than left pending: `convex-test` runs a `runAfter(0)`
    // job on a real timer, so one abandoned here fires during a *later* test,
    // against whatever `fetch` is stubbed to by then — i.e. that test's bucket.
    await drainScheduled(t);
  });

  test("the audit trail records the choice, and no description", async () => {
    const { t, owner, workspaceId } = await connected();
    await apply(t, owner, workspaceId, { template: "custom", folders: CUSTOM });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const applied = events.filter(
      (event) => event.action === "workspace.structure_applied",
    );
    expect(applied).toHaveLength(1);
    expect(applied[0].paths).toEqual(["clients/README.md", "reading/README.md"]);
    expect(applied[0].details).toMatchObject({ template: "custom", folderCount: 2 });
    // Prose does not go in an audit trail.
    expect(JSON.stringify(applied[0])).not.toContain("One folder per client.");

    // Drained rather than left pending: `convex-test` runs a `runAfter(0)`
    // job on a real timer, so one abandoned here fires during a *later* test,
    // against whatever `fetch` is stubbed to by then — i.e. that test's bucket.
    await drainScheduled(t);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE NON-NEGOTIABLE.
 *
 * A user connecting an existing brain must see nothing change. The mutation
 * refuses as a courtesy — it gives them an answer instead of a silent no-op —
 * but the refusal is not the enforcement, and the last test here proves it by
 * removing the courtesy.
 */
describe("a context that already exists is never scaffolded over", () => {
  test("choosing a layout is refused, and the bucket is untouched", async () => {
    const { t, owner, workspaceId, backend } = await connected({
      seed: {
        "privacy.md": "# hand written, do not touch\n",
        "index.md": "# My brain\n",
        "1-projects/ship-it.md": "# Ship it\n",
      },
    });
    const before = backend.snapshot();

    const error = await captureError(() =>
      apply(t, owner, workspaceId, { template: "para" }),
    );
    expect(errorCode(error)).toBe("CONTEXT_NOT_EMPTY");

    await drainScheduled(t);
    expect(backend.snapshot()).toEqual(before);
  });

  test("a live brain whose first pages are all .history is still refused", async () => {
    const seed: Record<string, string> = { "1-projects/ship-it.md": "# Ship it\n" };
    for (let index = 0; index < 1500; index += 1) {
      seed[`.history/1-projects/ship-it.${index}.md`] = "old";
    }
    const { t, owner, workspaceId, backend } = await connected({ seed });
    const before = backend.snapshot();

    expect(
      errorCode(
        await captureError(() => apply(t, owner, workspaceId, { template: "para" })),
      ),
    ).toBe("CONTEXT_NOT_EMPTY");
    expect(backend.snapshot()).toEqual(before);
  });

  /**
   * SABOTAGE.
   *
   * The mutation's `CONTEXT_NOT_EMPTY` check is deliberately bypassed here — the
   * binding is told the bucket is empty when it is not — and the scaffold is
   * driven anyway. The bucket must *still* come out byte-identical, because the
   * rule that protects it lives in the scaffolder, not in the mutation.
   *
   * If a future refactor moves the no-overwrite guard up into the authorization
   * layer, this is what fails.
   */
  test("even with every check above bypassed, nothing is overwritten", async () => {
    const { t, owner, workspaceId, backend } = await connected({
      seed: {
        "privacy.md": "# hand written, do not touch\n",
        "index.md": "# My brain\n",
        "1-projects/ship-it.md": "# Ship it\n",
        "0-inbox/README.md": "my own inbox readme, not yours\n",
      },
    });
    const before = backend.snapshot();

    // Lie to the row, so the mutation's courtesy refusal cannot fire.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { scaffoldReason: "empty", scaffolded: false });
    });

    expect(
      await apply(t, owner, workspaceId, { template: "para" }),
    ).toMatchObject({ queued: true });
    await drainScheduled(t);

    expect(backend.snapshot()).toEqual(before);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
  });

  /**
   * SABOTAGE, for the resume path.
   *
   * `applyStructure` decides whether a retry may skip the emptiness guard by
   * reading `scaffoldMissing` off the binding — a field only a scaffold of ours
   * can ever write. Here the row is *forged* to say so over a bucket that is
   * somebody's live brain. The bucket must still come out byte-identical,
   * because the licence the mutation hands out is not the enforcement: the
   * scaffolder checks the bucket itself, and refuses anything it did not write.
   */
  test("even a forged resume licence cannot scaffold over a live brain", async () => {
    const { t, owner, workspaceId, backend } = await connected({
      seed: {
        "privacy.md": "# hand written, do not touch\n",
        "index.md": "# My brain\n",
        "1-projects/ship-it.md": "# Ship it\n",
        "0-inbox/README.md": "my own inbox readme, not yours\n",
      },
    });
    const before = backend.snapshot();

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        scaffoldReason: "partial",
        scaffolded: true,
        scaffoldMissing: ["0-inbox/README.md", "1-projects/README.md"],
      });
    });

    expect(await apply(t, owner, workspaceId, { template: "para" })).toMatchObject({
      queued: true,
    });
    await drainScheduled(t);

    expect(backend.snapshot()).toEqual(before);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
  });

  test("a second application is refused once a layout has been written", async () => {
    const { t, owner, workspaceId, backend } = await connected();
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);
    const before = backend.snapshot();

    expect(
      errorCode(
        await captureError(() =>
          apply(t, owner, workspaceId, { template: "custom", folders: CUSTOM }),
        ),
      ),
    ).toBe("STRUCTURE_ALREADY_APPLIED");
    expect(backend.snapshot()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */

describe("choosing a layout is owner-only and validated", () => {
  test("a member cannot choose, and an editor cannot either", async () => {
    const { t, workspaceId } = await connected();
    for (const role of ["editor", "member"] as const) {
      const intruder = await createUser(t, `${role}@example.invalid`);
      await t.run((ctx) =>
        ctx.db.insert("workspaceMembers", {
          workspaceId,
          userId: intruder,
          role,
          joinedAt: Date.now(),
        }),
      );
      const error = await captureError(() =>
        apply(t, intruder, workspaceId, { template: "para" }),
      );
      expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    }
  });

  /** A non-member must not learn that this workspace exists. */
  test("a stranger gets the not-found answer, not a permission one", async () => {
    const { t, workspaceId } = await connected();
    const stranger = await createUser(t, "stranger@example.invalid");
    expect(
      errorCode(
        await captureError(() => apply(t, stranger, workspaceId, { template: "para" })),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a workspace with no storage is told to connect storage first", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    expect(
      errorCode(
        await captureError(() => apply(t, owner, workspaceId, { template: "para" })),
      ),
    ).toBe("NO_STORAGE_BINDING");
  });

  test("an unverified binding is refused — nothing has contacted that bucket", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const backend = memoryS3(FAKE_STORAGE.bucket);
    vi.stubGlobal("fetch", backend.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId);
    // Deliberately not drained: the probe has not run.

    expect(
      errorCode(
        await captureError(() => apply(t, owner, workspaceId, { template: "para" })),
      ),
    ).toBe("STORAGE_NOT_VERIFIED");
  });

  /**
   * The hostile names, through the real mutation. `scaffold.test.ts` proves the
   * validator itself; this proves it is actually wired in front of the write.
   */
  test.each([
    ["..", "traversal"],
    [".history", "hidden"],
    ["a/b", "not-a-single-segment"],
    ["windows\\path", "backslash"],
    ["privacy.md", "reserved"],
    [" leading", "untrimmed"],
  ])("refuses a folder named %j, and writes nothing", async (folder, reason) => {
    const { t, owner, workspaceId, backend } = await connected();

    const error = await captureError(() =>
      apply(t, owner, workspaceId, {
        template: "custom",
        folders: [{ folder, description: "anything" }],
      }),
    );
    expect(errorCode(error)).toBe("INVALID_FOLDER");
    expect((error as { data: { reason: string } }).data.reason).toBe(reason);

    await drainScheduled(t);
    expect([...backend.objects.keys()]).toEqual([]);
    // And the row was not patched with a layout that was never written.
    expect((await t.run((ctx) => ctx.db.get(workspaceId)))?.customFolders).toBeUndefined();
  });

  test("refuses a custom layout with no folders at all", async () => {
    const { t, owner, workspaceId } = await connected();
    expect(
      errorCode(
        await captureError(() =>
          apply(t, owner, workspaceId, { template: "custom", folders: [] }),
        ),
      ),
    ).toBe("INVALID_STRUCTURE");
  });

  /** Refused rather than ignored: dropped folders are folders they go looking for. */
  test("refuses folders supplied alongside the standard layout", async () => {
    const { t, owner, workspaceId } = await connected();
    expect(
      errorCode(
        await captureError(() =>
          apply(t, owner, workspaceId, { template: "para", folders: CUSTOM }),
        ),
      ),
    ).toBe("INVALID_STRUCTURE");
  });

  test("no error it throws carries the credential", async () => {
    const { t, owner, workspaceId } = await connected();
    const error = await captureError(() =>
      apply(t, owner, workspaceId, {
        template: "custom",
        folders: [{ folder: "..", description: "x" }],
      }),
    );
    const text = JSON.stringify((error as { data: unknown }).data);
    expect(text).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(text).not.toContain(FAKE_STORAGE.accessKeyId);
    expect(text).not.toContain(FAKE_STORAGE.bucket);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * ISSUE #22, THROUGH THE WHOLE STACK.
 *
 * A bucket refuses some of the writes. What the person is told, and whether
 * they can get out of it without an S3 client.
 *
 * The old answer to both was bad: the binding said `failed` even though the
 * `privacy.md` that makes a context a context had landed, and the retry came
 * back "this bucket already holds a context, nothing has been changed" — over a
 * bucket we had half-written ourselves five seconds earlier.
 */
describe("a scaffold that only partly lands can be finished from the console", () => {
  const README_KEYS = PARA_FOLDERS.map((folder) => `${folder}/README.md`);

  test("lost folders are reported as a caveat on a success, not as a failure", async () => {
    const { t, owner, workspaceId, backend } = await connected({
      refuseWrite: (key) => key.endsWith("/README.md"),
    });

    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    // The context works: the manifest the gateway enforces visibility with is
    // in the bucket, and it parses.
    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(backend.objects.get(PRIVACY_KEY)!.body).rules,
    ).toHaveLength(PARA_FOLDERS.length);

    const row = await binding(t, owner, workspaceId);
    expect(row).toMatchObject({
      status: "connected",
      scaffolded: true,
      scaffoldReason: "partial",
    });
    // …and it says exactly what is missing, so the console can name it rather
    // than apologise vaguely.
    expect([...(row?.scaffoldMissing ?? [])].sort()).toEqual([...README_KEYS].sort());
  });

  test("the owner can retry and finish it — no S3 client required", async () => {
    const refuse = { readmes: true };
    const { t, owner, workspaceId, backend } = await connected({
      refuseWrite: (key) => refuse.readmes && key.endsWith("/README.md"),
    });
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe("partial");

    // Whatever was wrong with the bucket is fixed. The same button again.
    refuse.readmes = false;
    expect(await apply(t, owner, workspaceId, { template: "para" })).toMatchObject({
      queued: true,
    });
    await drainScheduled(t);

    expect([...backend.objects.keys()].sort()).toEqual(
      [...README_KEYS, "index.md", "privacy.md"].sort(),
    );
    const row = await binding(t, owner, workspaceId);
    expect(row).toMatchObject({ scaffolded: true, scaffoldReason: "created" });
    expect(row?.scaffoldMissing).toEqual([]);
  });

  test("a run whose privacy.md failed is a failure, and is also retryable", async () => {
    const refuse = { all: true };
    const { t, owner, workspaceId, backend } = await connected({
      // Everything but the plumbing, so the writability probe still passes and
      // the binding is genuinely connected. This is a bucket that accepts
      // writes and then refuses these ones — a policy on the note surface, not
      // a dead credential.
      refuseWrite: (key) => refuse.all && !key.startsWith("."),
    });
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      scaffolded: false,
      scaffoldReason: "failed",
    });
    expect([...backend.objects.keys()]).toEqual([]);

    refuse.all = false;
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe("created");
    expect([...backend.objects.keys()].sort()).toEqual(
      [...README_KEYS, "index.md", "privacy.md"].sort(),
    );
  });

  /**
   * The retry has to survive the owner poking the other button first.
   * "Check the connection" reclassifies the bucket, and a half-written one now
   * honestly reads as a context — which is precisely the reading that stranded
   * them. `scaffoldMissing` is what a look-only probe must not erase.
   */
  test("re-verifying in between does not strand the half-written bucket", async () => {
    const refuse = { readmes: true };
    const { t, owner, workspaceId, backend } = await connected({
      refuseWrite: (key) => refuse.readmes && key.endsWith("/README.md"),
    });
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    await asUser(t, owner).mutation(api.functions.storage.reverifyStorage, {
      workspaceId,
    });
    await drainScheduled(t);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      // Honest about what is in the bucket…
      scaffoldReason: "existing-context",
    });
    // …and still remembers what it owes.
    expect(
      [...((await binding(t, owner, workspaceId))?.scaffoldMissing ?? [])].sort(),
    ).toEqual([...README_KEYS].sort());

    refuse.readmes = false;
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);
    expect([...backend.objects.keys()].sort()).toEqual(
      [...README_KEYS, "index.md", "privacy.md"].sort(),
    );
  });

  test("rebinding to another bucket takes the licence with it", async () => {
    const { t, owner, workspaceId } = await connected({
      refuseWrite: (key) => key.endsWith("/README.md"),
    });
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.scaffoldMissing).not.toEqual([]);

    // A different bucket, which happens to be somebody's live brain. Carrying
    // "we owe this bucket five READMEs" across would carry a licence to write
    // into it, earned somewhere else entirely.
    const other = memoryS3("some-other-bucket");
    other.seed("1-projects/theirs.md", "# Theirs\n");
    vi.stubGlobal("fetch", other.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId, { bucket: "some-other-bucket" });
    expect((await binding(t, owner, workspaceId))?.scaffoldMissing).toBeUndefined();

    await drainScheduled(t);
    expect(
      errorCode(
        await captureError(() => apply(t, owner, workspaceId, { template: "para" })),
      ),
    ).toBe("CONTEXT_NOT_EMPTY");
    expect(other.snapshot()).toEqual({ "1-projects/theirs.md": "# Theirs\n" });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * `applyStructure` is public and triggers a decrypt. It must do so by
 * *scheduling*, never by calling — a call would put a credential in a public
 * function's scope. `structure.test.ts` enforces that statically over the whole
 * call graph; this is the behavioural half.
 */
describe("choosing a layout never brings a credential near the caller", () => {
  test("it is a mutation, and returns nothing the probe learned", async () => {
    const { t, owner, workspaceId } = await connected();
    const result = await apply(t, owner, workspaceId, { template: "para" });

    expect(Object.keys(result).sort()).toEqual(["folders", "queued", "template"]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(text).not.toContain(FAKE_STORAGE.accessKeyId);

    // Drained rather than left pending: `convex-test` runs a `runAfter(0)`
    // job on a real timer, so one abandoned here fires during a *later* test,
    // against whatever `fetch` is stubbed to by then — i.e. that test's bucket.
    await drainScheduled(t);
  });

  test("the scaffold it queues is the internal verifying action", async () => {
    const { t, owner, workspaceId } = await connected();
    await apply(t, owner, workspaceId, { template: "para" });

    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const queued = jobs.filter((job) => job.state.kind === "pending");
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toContain("verifyStorageBinding");
    // The layout travels with the job rather than being read off a row later.
    expect(JSON.stringify(queued[0].args)).toContain('"template":"para"');

    // Drained before this test ends, and not for tidiness. `convex-test` starts
    // a `runAfter(0)` job on a real timer, so a job left pending here runs
    // *during a later test* — against whatever `fetch` is stubbed to by then,
    // which is that test's bucket. Leaving one queued writes a PARA layout into
    // the next test's storage and fails it for reasons it has nothing to do
    // with.
    await drainScheduled(t);
  });

  test("re-verifying afterwards writes nothing more", async () => {
    const { t, owner, workspaceId, backend } = await connected();
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);
    const before = backend.snapshot();

    await asUser(t, owner).mutation(api.functions.storage.reverifyStorage, {
      workspaceId,
    });
    await drainScheduled(t);

    expect(backend.snapshot()).toEqual(before);
    // …and the row now honestly says the bucket holds a context.
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe(
      "existing-context",
    );
  });

});

/* -------------------------------------------------------------------------- */

/**
 * Setting up a **workspace** rather than a brain, end to end through the real
 * mutation.
 *
 * `applyStructure` reads `kind` off the workspace row and hands it to the
 * scheduled job. That it is read there rather than taken as an argument is the
 * point: a client that could name it could scaffold somebody's personal brain
 * open to everyone they later invite.
 */
describe("a shared workspace is laid down for the people in it", () => {
  test("the folders come out readable by the workspace, through the gateway's parser", async () => {
    const { t, owner, workspaceId, backend } = await connected({ kind: "shared" });

    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      backend.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual([...PARA_FOLDERS].sort());
    expect(canSee("1-projects/kickoff.md", "team", rules, overrides)).toBe(true);
    // …and the access map is still an owner's business.
    expect(canSee(PRIVACY_KEY, "team", rules, overrides)).toBe(false);
  });

  test("a brain in the same deployment still starts all-private", async () => {
    const { t, owner, workspaceId, backend } = await connected();

    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      backend.objects.get(PRIVACY_KEY)!.body,
    );
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(canSee("1-projects/kickoff.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * The whole reason this exists. Scaffolded all-private, an editor invited
   * into a brand-new workspace can reach nothing: `clampScopes` strips
   * `context:private` from anybody who is not an `owner`, so there is no grant
   * they can issue that would let a client read one note.
   */
  test("an editor's widest possible grant can read the workspace", async () => {
    const { t, owner, workspaceId, backend } = await connected({ kind: "shared" });
    await apply(t, owner, workspaceId, { template: "para" });
    await drainScheduled(t);

    const editorScopes = clampScopes(
      ["context:read", "context:write", "context:private"],
      "editor",
    );
    expect(visibilityTierOf(editorScopes)).toBe("team");

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      backend.objects.get(PRIVACY_KEY)!.body,
    );
    expect(
      canSee("1-projects/kickoff.md", visibilityTierOf(editorScopes), rules, overrides),
    ).toBe(true);
  });
});
