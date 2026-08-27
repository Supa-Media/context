/**
 * Connecting a bucket, end to end.
 *
 * These run the *real* action against the *real* `S3Store`: real SigV4, real
 * `If-Match` headers, real ListObjectsV2 XML. Only the socket is fake — a
 * `fetch` stub speaking S3 over HTTP. A `ContextStore` fake would have proved
 * the probe logic and nothing about the adapter the control plane actually
 * builds from a decrypted credential, which is the half that can be wrong in
 * production.
 *
 * The four things that must hold:
 *  - a capability is recorded only if it was *observed*, and a backend that
 *    accepts `If-Match` and ignores it is recorded as not supporting it;
 *  - a failure is actionable and does not leave the binding claiming to be
 *    connected;
 *  - the credential appears in no recorded error, no audit event, and no
 *    return value;
 *  - an existing context is not touched.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY, PARA_FOLDERS } from "../functions/lib/scaffold";
import {
  type TestConvex,
  FAKE_STORAGE,
  addMember,
  asUser,
  bindFakeStorage,
  createUser,
  createWorkspace,
  drainScheduled,
  setupTest,
} from "./fixtures.helpers";
import { type MemoryS3Options, memoryS3 } from "./storeStub.helpers";
import { gatewayInternals } from "./gatewayFormat.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface ConnectOptions extends MemoryS3Options {
  structureTemplate?: "para" | "custom";
  rootPrefix?: string;
  bucket?: string;
}

/**
 * A workspace with a binding row and a stubbed bucket behind it, and **no
 * verification queued**.
 *
 * The row is inserted directly rather than through `bindStorage`, for the same
 * reason `fixtures.helpers.ts` inserts membership rows directly: going through
 * the public function would do something else as well — here, schedule a
 * verification. `convex-test` starts a `runAfter(0)` job eagerly, so that
 * scheduled run would race the explicit `t.action(...)` under test, and two
 * concurrent probes against one bucket produce results neither test wrote.
 * The scheduling itself is covered separately, through the real
 * `bindStorage`, below.
 *
 * The envelope is produced by the real `encryptSecret`, so the decrypt path
 * under test is the real one.
 */
async function connecting(options: ConnectOptions = {}) {
  const { structureTemplate, rootPrefix, bucket, ...bucketOptions } = options;
  const t: TestConvex = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", {
    structureTemplate,
  });

  const bucketName = bucket ?? FAKE_STORAGE.bucket;
  const backend = memoryS3(bucketName, bucketOptions);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: bucketName,
      rootPrefix,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: false },
      status: "unverified" as const,
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return { t, owner, workspaceId, backend };
}

/** The same thing through the real public flow, which *does* schedule. */
async function connectingViaBindStorage(options: ConnectOptions = {}) {
  const { structureTemplate, rootPrefix, bucket, ...bucketOptions } = options;
  const t: TestConvex = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", {
    structureTemplate,
  });

  const bucketName = bucket ?? FAKE_STORAGE.bucket;
  const backend = memoryS3(bucketName, bucketOptions);
  vi.stubGlobal("fetch", backend.fetchImpl);

  await bindFakeStorage(t, owner, workspaceId, {
    ...(bucket ? { bucket } : {}),
    ...(rootPrefix ? { rootPrefix } : {}),
  });
  return { t, owner, workspaceId, backend };
}

function binding(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  return asUser(t, owner).query(api.functions.storage.getStorageBinding, {
    workspaceId,
  });
}

/* -------------------------------------------------------------------------- */

describe("bindStorage schedules verification", () => {
  test("moves the binding from unverified to connected", async () => {
    const { t, owner, workspaceId } = await connectingViaBindStorage();

    // Nothing has contacted the bucket yet, and the row says so.
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "unverified",
      capabilities: { conditionalWrite: false },
    });

    await drainScheduled(t);

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "connected",
      capabilities: { conditionalWrite: true },
    });
    expect((await binding(t, owner, workspaceId))?.lastVerifiedAt).toBeTypeOf(
      "number",
    );
    expect((await binding(t, owner, workspaceId))?.lastError).toBeUndefined();
  });

  test("rebinding re-runs verification against the new bucket", async () => {
    const { t, owner, workspaceId } = await connectingViaBindStorage();
    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.status).toBe("connected");

    // Point at a bucket nothing can reach.
    const broken = memoryS3("some-other-bucket", { unreachable: true });
    vi.stubGlobal("fetch", broken.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId, { bucket: "some-other-bucket" });

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "unverified",
      capabilities: { conditionalWrite: false },
    });
    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.status).toBe("error");
  });
});

/* -------------------------------------------------------------------------- */

describe("the capability recorded is the capability observed", () => {
  test("an honest backend gets conditional writes", async () => {
    const { t, owner, workspaceId } = await connecting();
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );

    expect(result).toMatchObject({
      verified: true,
      reachable: true,
      writable: true,
      conditionalWrite: true,
    });
    expect((await binding(t, owner, workspaceId))?.capabilities).toEqual({
      conditionalWrite: true,
    });
  });

  /**
   * The failure this whole probe exists for.
   *
   * Backblaze B2 and Wasabi accept an `If-Match` header and write anyway.
   * `S3Store.capabilities.conditionalWrite` is declared `true` regardless,
   * because the adapter does send the header — so believing the adapter's
   * claim would mean the gateway thinks it has conflict detection while every
   * conflict-safe write silently becomes last-writer-wins. Two concurrent
   * `set_visibility` calls lose one, and a note meant to be private stays
   * team-readable.
   *
   * Connected, because the bucket genuinely works. `conditionalWrite: false`,
   * because it genuinely does not do that.
   */
  test("a backend that accepts If-Match and ignores it is recorded as not supporting it", async () => {
    const { t, owner, workspaceId } = await connecting({ ignoreIfMatch: true });

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );

    expect(result).toMatchObject({
      verified: true,
      reachable: true,
      writable: true,
      conditionalWrite: false,
    });
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "connected",
      capabilities: { conditionalWrite: false },
    });
  });

  test("the audit trail records the capability, not an assumption", async () => {
    const { t, workspaceId } = await connecting({ ignoreIfMatch: true });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const verified = events.filter((event) => event.action === "storage.verified");
    expect(verified).toHaveLength(1);
    expect(verified[0].details).toMatchObject({ conditionalWrite: false });
  });

  test("the probe leaves nothing behind in the bucket", async () => {
    const { t, backend, workspaceId } = await connecting({
      structureTemplate: "custom",
    });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    for (const key of backend.objects.keys()) {
      expect(key.startsWith(".context-probe/"), `${key} was left behind`).toBe(
        false,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a failure is actionable and never claims success", () => {
  test("an unreachable bucket records what to check", async () => {
    const { t, owner, workspaceId } = await connecting({ unreachable: true });

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );
    expect(result).toMatchObject({ verified: false, reachable: false });

    const row = await binding(t, owner, workspaceId);
    expect(row?.status).toBe("error");
    expect(row?.lastVerifiedAt).toBeUndefined();
    expect(row?.capabilities).toEqual({ conditionalWrite: false });
    // Actionable: it names the bucket and what to check, not "Server Error".
    expect(row?.lastError).toContain(FAKE_STORAGE.bucket);
    expect(row?.lastError).toMatch(/endpoint, region, and bucket name/);
  });

  test("a read-only credential is reported as read-only, not as unreachable", async () => {
    const { t, owner, workspaceId } = await connecting({ readOnly: true });

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );
    expect(result).toMatchObject({
      verified: false,
      reachable: true,
      writable: false,
    });

    const row = await binding(t, owner, workspaceId);
    expect(row?.status).toBe("error");
    expect(row?.lastError).toMatch(/listed but not written/);
    expect(row?.lastError).toMatch(/put and delete objects/);
  });

  test("an audit event records the failure", async () => {
    const { t, workspaceId } = await connecting({ unreachable: true });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.map((event) => event.action)).toContain(
      "storage.verification_failed",
    );
    expect(events.map((event) => event.action)).not.toContain("storage.verified");
  });

  test("a credential that cannot be decrypted tells the owner to reconnect", async () => {
    const { t, owner, workspaceId } = await connecting();
    // Corrupt the envelope the way a rotated-away key would.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        encryptedSecretAccessKey: "v2:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAA",
      });
    });

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );
    expect(result.verified).toBe(false);
    // Actionable rather than diagnostic: the owner's move is to paste the key
    // again, and the reason the envelope would not open (wrong key, wrong
    // workspace, tampered ciphertext) is deliberately not distinguished.
    expect(result.error).toMatch(/could not be opened/);
    expect(result.error).toMatch(/[Rr]ebind|[Rr]econnect/);
    expect((await binding(t, owner, workspaceId))?.status).toBe("error");
  });

  test("a binding removed mid-probe is not an error, and records nothing", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );
    expect(result).toMatchObject({ verified: false, scaffoldReason: "no-binding" });
    expect(await t.run((ctx) => ctx.db.query("auditEvents").collect())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The credential must not escape, by any of the three routes it could: the
 * error text stored on the row, the audit trail, or what the action hands back.
 *
 * The bucket here is deliberately hostile — it echoes the access key id and a
 * SigV4 signature fragment in its `<Message>`, which is exactly what an S3
 * error body quoting the canonical request looks like.
 */
describe("credentials never leave the verifying action", () => {
  const HOSTILE_MESSAGE =
    `The access key ${FAKE_STORAGE.accessKeyId} with ` +
    `Signature=deadbeefdeadbeefdeadbeef and secret ` +
    `${FAKE_STORAGE.secretAccessKey} is not authorized.`;

  test("not in the recorded error, the audit trail, or the return value", async () => {
    const { t, owner, workspaceId } = await connecting({
      unreachable: true,
      errorMessage: HOSTILE_MESSAGE,
    });

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );

    const forbidden = [
      FAKE_STORAGE.secretAccessKey,
      FAKE_STORAGE.accessKeyId,
      "deadbeefdeadbeefdeadbeef",
    ];

    const returned = JSON.stringify(result);
    const row = JSON.stringify(await binding(t, owner, workspaceId));
    const events = JSON.stringify(
      await t.run((ctx) => ctx.db.query("auditEvents").collect()),
    );
    const bindings = JSON.stringify(
      await t.run((ctx) => ctx.db.query("storageBindings").collect()),
    );

    for (const secret of forbidden) {
      expect(returned, `return value leaked ${secret}`).not.toContain(secret);
      expect(row, `the published binding leaked ${secret}`).not.toContain(secret);
      expect(events, `the audit trail leaked ${secret}`).not.toContain(secret);
    }
    // The row still holds the *encrypted* secret, and nothing more.
    expect(bindings).not.toContain(FAKE_STORAGE.secretAccessKey);

    // Non-vacuity: the hostile message did reach us, it was just scrubbed.
    expect(result.error).toContain("[redacted]");
  });

  test("the return value carries no credential-shaped field at all", async () => {
    const { t, workspaceId } = await connecting();
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );
    for (const field of Object.keys(result)) {
      expect(field.toLowerCase()).not.toContain("secret");
      expect(field.toLowerCase()).not.toContain("key");
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * VERIFICATION LOOKS; IT DOES NOT WRITE.
 *
 * This is the half of the connect flow that runs before anybody has been asked
 * anything. `bindStorage` schedules it the instant a credential is pasted, so
 * if it scaffolded, the folder layout would be chosen for the user and the
 * question onboarding asks afterwards would be decoration over a decision
 * already taken.
 *
 * What it does instead is *classify*, and publish the classification on the
 * binding — which is what lets onboarding stop asking a question it can answer
 * itself.
 */
describe("verification classifies the bucket without touching it", () => {
  test("an empty bucket is reported empty, and stays empty", async () => {
    const { t, owner, backend, workspaceId } = await connecting();

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );

    expect(result).toMatchObject({
      verified: true,
      scaffolded: false,
      scaffoldReason: "empty",
    });
    // Not one object. This is the regression that matters: a bucket connected
    // before the owner chose a layout must come out of verification untouched.
    expect([...backend.objects.keys()]).toEqual([]);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "connected",
      scaffolded: false,
      scaffoldReason: "empty",
    });
  });

  test("a bucket that already holds a context says so, with no prompt to answer", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    const before = backend.snapshot();

    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
    );

    expect(result).toMatchObject({
      verified: true,
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
    expect(backend.snapshot()).toEqual(before);
    expect(await binding(t, owner, workspaceId)).toMatchObject({
      scaffoldReason: "existing-context",
    });
  });

  /**
   * The delimiter listing, through the whole stack.
   *
   * A real brain snapshots every overwrite into `.history/`, which sorts before
   * every digit. A flat first-page listing of one comes back looking completely
   * empty — so a detector built on one would tell onboarding this live context
   * is a blank bucket and offer to lay a layout over the top of it.
   */
  test("a live brain whose first pages are all .history is not reported empty", async () => {
    const { t, backend, workspaceId } = await connecting();
    for (let index = 0; index < 1500; index += 1) {
      backend.seed(`.history/1-projects/ship-it.${index}.md`, "old");
    }
    backend.seed("1-projects/ship-it.md", "# Ship it\n");

    expect(
      await t.action(internal.functions.provisioning.verifyStorageBinding, {
        workspaceId,
      }),
    ).toMatchObject({ scaffoldReason: "existing-context" });
  });

  /* ------------------------------------------------------------------ */

  /**
   * The note count, end to end through the real S3 adapter.
   *
   * `noteCount.test.ts` proves the walk. These prove it reaches the row a
   * console reads — a separate failure, and the one that would leave the tile
   * blank forever with a perfectly correct counter sitting behind it.
   */
  test("a verified bucket carries a note count and the moment it was taken", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    backend.seed("1-projects/ship-it/notes.md", "# Notes\n");
    backend.seed("2-areas/health.md", "# Health\n");
    backend.seed("1-projects/diagram.png", "binary");

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const row = await binding(t, owner, workspaceId);
    expect(row).toMatchObject({ noteCount: 3, noteCountTruncated: false });
    expect(row?.noteCountedAt).toBeTypeOf("number");
  });

  /** The `.history/` trap, at the layer that actually talks to a bucket. */
  test("history revisions are not counted as notes", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    for (let index = 0; index < 1500; index += 1) {
      backend.seed(`.history/1-projects/ship-it.${index}.md`, "old");
    }
    backend.seed("1-projects/ship-it.md", "# Ship it\n");

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    expect(await binding(t, owner, workspaceId)).toMatchObject({ noteCount: 1 });
  });

  /**
   * Absent is not zero. A probe that never reached the bucket must leave the
   * last real count standing — recording a `0` would tell the console this
   * context is empty on the strength of a network error, which is the shape of
   * #25 that this whole feature exists to avoid repeating.
   */
  test("a later failed probe does not erase the count", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });
    const countedAt = (await binding(t, owner, workspaceId))?.noteCountedAt;
    expect(countedAt).toBeTypeOf("number");

    const broken = memoryS3(FAKE_STORAGE.bucket, { unreachable: true });
    vi.stubGlobal("fetch", broken.fetchImpl);
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    expect(await binding(t, owner, workspaceId)).toMatchObject({
      status: "error",
      noteCount: 1,
      noteCountedAt: countedAt,
    });
  });

  /**
   * A rebind points at a **different bucket**, so a count carried across it is
   * a number about somewhere else. Left standing, this read
   * `{status: "error", noteCount: 2}` — a confident total beside a bucket
   * nothing had ever reached, which is #25 wearing a fresh coat.
   */
  test("rebinding to another bucket clears the count with everything else", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    backend.seed("2-areas/health.md", "# Health\n");
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });
    expect(await binding(t, owner, workspaceId)).toMatchObject({ noteCount: 2 });

    const elsewhere = memoryS3("some-other-bucket", { unreachable: true });
    vi.stubGlobal("fetch", elsewhere.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId, { bucket: "some-other-bucket" });

    const row = await binding(t, owner, workspaceId);
    expect(row?.noteCount).toBeUndefined();
    expect(row?.noteCountedAt).toBeUndefined();
    expect(row?.noteCountTruncated).toBeUndefined();
  });

  /**
   * The count is of every Markdown file in the bucket, private notes included,
   * while a member of somebody else's context may read only the `team` tier.
   * Handing them the total lets them derive exactly how much is being withheld
   * — an exact private-note count for a person who deliberately shared a
   * subset. The role clamps what a client may read in three places already;
   * this is the same rule applied to a number about the same notes.
   */
  test("a member cannot read the owner's note count", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/private-thing.md", "# Secret\n");
    backend.seed("2-areas/another.md", "# Also secret\n");
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const guest = await createUser(t, "guest@example.invalid");
    await addMember(t, workspaceId, guest, "member");

    // The owner sees it.
    expect(await binding(t, owner, workspaceId)).toMatchObject({ noteCount: 2 });

    // The member sees the binding, and no census on it.
    const asGuest = await asUser(t, guest).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(asGuest).toMatchObject({ status: "connected", bucket: FAKE_STORAGE.bucket });
    expect(asGuest?.noteCount).toBeUndefined();
    expect(asGuest?.noteCountedAt).toBeUndefined();
    expect(asGuest?.noteCountTruncated).toBeUndefined();
  });

  /** An editor is not the owner either. Write access is not a licence to count. */
  test("an editor cannot read the note count either", async () => {
    const { t, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");

    const seen = await asUser(t, editor).query(api.functions.storage.getStorageBinding, {
      workspaceId,
    });
    expect(seen?.noteCount).toBeUndefined();
  });

  /** A freshly scaffolded bucket is counted as it now stands, not as found. */
  test("a scaffold is counted after it lands, not before", async () => {
    const { t, owner, workspaceId } = await connecting();

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
      structure: { template: "para", folders: [] },
    });

    const row = await binding(t, owner, workspaceId);
    expect(row?.noteCount).toBeGreaterThan(0);
  });

  test("a bucket holding only plumbing is empty, and is left that way", async () => {
    const { t, backend, workspaceId } = await connecting();
    backend.seed(".obsidian/app.json", "{}");
    const before = backend.snapshot();

    expect(
      await t.action(internal.functions.provisioning.verifyStorageBinding, {
        workspaceId,
      }),
    ).toMatchObject({ scaffoldReason: "empty" });
    expect(backend.snapshot()).toEqual(before);
  });

  /**
   * A failure that never reached the bucket knows nothing new about what is in
   * it. Overwriting a previous `existing-context` with a blank would turn one
   * DNS blip into onboarding offering to scaffold over a live brain.
   */
  test("a later failed probe does not erase what the last good one learned", async () => {
    const { t, owner, backend, workspaceId } = await connecting();
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });
    expect((await binding(t, owner, workspaceId))?.scaffoldReason).toBe(
      "existing-context",
    );

    const broken = memoryS3(FAKE_STORAGE.bucket, { unreachable: true });
    vi.stubGlobal("fetch", broken.fetchImpl);
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    const row = await binding(t, owner, workspaceId);
    expect(row?.status).toBe("error");
    expect(row?.scaffoldReason).toBe("existing-context");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Scaffolding, once somebody has actually chosen.
 *
 * The layout travels with the call — `structure` — rather than being read off
 * a field frozen when the workspace was created. `applyStructure` is the only
 * thing that supplies one; see `onboarding.test.ts` for that half.
 */
describe("scaffolding the layout the caller asked for", () => {
  const PARA = { template: "para" as const, folders: [] };

  test("an empty bucket gets a context the gateway can read", async () => {
    const { t, backend, workspaceId } = await connecting();
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId, structure: PARA },
    );

    expect(result).toMatchObject({ scaffolded: true, scaffoldReason: "created" });
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

    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(backend.objects.get(PRIVACY_KEY)!.body).rules.map(
        (rule) => rule.prefix,
      ),
    ).toEqual([...PARA_FOLDERS]);
  });

  test("a custom layout gets the owner's own folders, with their own words", async () => {
    const { t, backend, workspaceId } = await connecting();
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
      structure: {
        template: "custom",
        folders: [
          { folder: "clients", description: "One folder per client." },
          { folder: "reading", description: "Books and articles worth keeping." },
        ],
      },
    });

    expect([...backend.objects.keys()].sort()).toEqual([
      "clients/README.md",
      "index.md",
      "privacy.md",
      "reading/README.md",
    ]);
    // Their description, verbatim, in the folder's README and in the manifest.
    expect(backend.objects.get("clients/README.md")!.body).toContain(
      "One folder per client.",
    );
    expect(backend.objects.get("index.md")!.body).toContain(
      "`reading/` — Books and articles worth keeping.",
    );
    // …and every one of them starts private, read back through the gateway's
    // own parser.
    const { parsePrivacyManifest } = gatewayInternals();
    const parsed = parsePrivacyManifest(backend.objects.get(PRIVACY_KEY)!.body);
    expect(parsed.rules.map((rule) => rule.prefix).sort()).toEqual([
      "clients",
      "reading",
    ]);
    expect(parsed.rules.every((rule) => rule.vis === "private")).toBe(true);
  });

  /**
   * The primary case. An existing brain connects and sees nothing change.
   */
  test("an existing brain is byte-identical afterwards", async () => {
    const { t, backend, owner, workspaceId } = await connecting();
    // Undo the empty-bucket assumption: this bucket has been live for months.
    backend.objects.clear();
    backend.seed(PRIVACY_KEY, "# hand written, do not touch\n");
    backend.seed("index.md", "# My brain\n");
    backend.seed("1-projects/ship-it.md", "# Ship it\n");
    for (let index = 0; index < 1500; index += 1) {
      backend.seed(`.history/1-projects/ship-it.${index}.md`, "old");
    }
    const before = backend.snapshot();

    // Asked for a layout *explicitly*, which is the call that actually wants to
    // write. Detection-only would prove less.
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId, structure: PARA },
    );

    expect(result).toMatchObject({
      verified: true,
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
    expect(backend.snapshot()).toEqual(before);
    expect((await binding(t, owner, workspaceId))?.status).toBe("connected");
  });

  test("running it twice writes nothing the second time", async () => {
    const { t, backend, workspaceId } = await connecting();
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
      structure: PARA,
    });
    const before = backend.snapshot();

    const second = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId, structure: PARA },
    );
    expect(second).toMatchObject({
      verified: true,
      scaffolded: false,
      scaffoldReason: "existing-context",
    });
    expect(backend.snapshot()).toEqual(before);
  });

  test("a bucket that cannot be verified is never scaffolded", async () => {
    const { t, backend, workspaceId } = await connecting({ readOnly: true });
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId, structure: PARA },
    );
    expect(result).toMatchObject({
      verified: false,
      scaffolded: false,
      scaffoldReason: "not-attempted",
    });
    expect(backend.objects.size).toBe(0);
  });

  test("a customer's rootPrefix is honoured and is not tenancy", async () => {
    const { t, backend, workspaceId } = await connecting({
      rootPrefix: "notes/brain/",
    });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
      structure: {
        template: "custom",
        folders: [{ folder: "work", description: "The day job." }],
      },
    });

    expect([...backend.objects.keys()].sort()).toEqual([
      "notes/brain/index.md",
      "notes/brain/privacy.md",
      "notes/brain/work/README.md",
    ]);
    // Nothing derived from a workspace id ever appears in a key.
    for (const key of backend.objects.keys()) {
      expect(key).not.toContain(workspaceId);
      expect(key).not.toContain("atlas");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("verification stays out of reach of clients", () => {
  test("every export of the provisioning module is internal", async () => {
    const module = await import("../functions/provisioning");
    const registered = Object.entries(module).filter(
      ([, value]) =>
        typeof value === "function" &&
        ((value as { isQuery?: boolean }).isQuery ||
          (value as { isMutation?: boolean }).isMutation ||
          (value as { isAction?: boolean }).isAction),
    );
    expect(registered.length).toBeGreaterThan(0);
    for (const [name, value] of registered) {
      expect(
        (value as { isInternal?: boolean }).isInternal,
        `${name} is not internal`,
      ).toBe(true);
      expect((value as { isPublic?: boolean }).isPublic).toBeFalsy();
    }
  });

  test("a non-owner still cannot rebind, so cannot repoint the probe", async () => {
    const { t, workspaceId } = await connecting();
    const intruder = await createUser(t, "intruder@example.invalid");

    await expect(
      bindFakeStorage(t, intruder, workspaceId, { bucket: "attacker-bucket" }),
    ).rejects.toThrow();
  });
});
