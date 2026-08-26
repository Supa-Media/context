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
  asUser,
  bindFakeStorage,
  createUser,
  createWorkspace,
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

/**
 * Run every queued scheduled function to completion.
 *
 * `finishInProgressScheduledFunctions()` only awaits jobs that have already
 * *started*, and a `runAfter(0)` job sits `pending` behind a real 0ms timer
 * until the event loop gets a turn. Awaiting it straight after the mutation
 * therefore returns immediately, having waited for nothing — a test written
 * that way asserts on the state before verification and passes or fails for
 * reasons unrelated to the code. So: yield, drain, repeat until the queue is
 * empty, and fail loudly rather than silently proceeding if it never is.
 */
async function drainScheduled(t: TestConvex): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const outstanding = jobs.filter(
      (job) => job.state.kind === "pending" || job.state.kind === "inProgress",
    );
    if (outstanding.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("scheduled functions never drained");
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

describe("scaffolding on first successful verification", () => {
  test("an empty bucket gets a context the gateway can read", async () => {
    const { t, backend, workspaceId } = await connecting();
    const result = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
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

  test('a "custom" workspace gets no folders', async () => {
    const { t, backend, workspaceId } = await connecting({
      structureTemplate: "custom",
    });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    expect([...backend.objects.keys()].sort()).toEqual(["index.md", "privacy.md"]);
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
    expect((await binding(t, owner, workspaceId))?.status).toBe("connected");
  });

  test("running verification twice writes nothing the second time", async () => {
    const { t, backend, workspaceId } = await connecting();
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });
    const before = backend.snapshot();

    const second = await t.action(
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId },
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
      { workspaceId },
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
      structureTemplate: "custom",
      rootPrefix: "notes/brain/",
    });
    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId,
    });

    expect([...backend.objects.keys()].sort()).toEqual([
      "notes/brain/index.md",
      "notes/brain/privacy.md",
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
