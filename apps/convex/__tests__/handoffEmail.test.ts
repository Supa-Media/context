/**
 * The owner hears about a move out of managed storage when it stops for them
 * or finishes, and at no other time.
 *
 * ## Sabotage record
 *
 * Mailing on CANCELLED (dropping the check in `handoffEmailKindFor`) failed
 * "the owner stopping it themselves sends nothing". Removing the owner-role
 * check in `claimHandoffEmail` mailed a demoted editor, failing "only an owner
 * still in the workspace is mailed". Dropping the rate limit sent a fourth
 * paused mail in a day, failing the cap test. Skipping `escapeHtml` on the
 * workspace name put raw markup in the body, failing the render test.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { managedBucketName } from "../functions/lib/managedStorage";
import {
  handoffEmailKindFor,
  renderHandoffEmail,
  storageSettingsUrl,
} from "../functions/lib/managedProvisioningFns/handoffEmail";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function moving() {
  const t = setupTest();
  const owner = await createUser(t, "mover@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "mover", { displayName: "Mover <b>Co</b>" });
  const encrypted = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://managed-account.r2.cloudflarestorage.example",
      region: "auto",
      bucket: managedBucketName(workspaceId),
      accessKeyId: "managed-token-id",
      encryptedSecretAccessKey: await encrypted("managed-secret-not-real"),
      status: "connected",
      capabilities: { conditionalWrite: true },
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      freeManaged: true,
      status: "none",
      managedProvisioning: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      direction: "to_customer",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: "auto",
      targetBucket: "customer-bucket",
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await encrypted(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase: "copy",
      objectsCopied: 0,
      objectsProcessedInPhase: 0,
      changesInPass: 0,
      readyToCutover: false,
      targetClaimed: true,
      startedBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId };
}

async function mailJobs(t: ReturnType<typeof setupTest>) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name.includes("sendHandoffEmail"));
}

function stubResend() {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
  vi.stubEnv("APP_ORIGIN", "https://app.example.invalid");
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  });
  return sent;
}

describe("which moves mail the owner", () => {
  test("a pause mails the owner who started the move", async () => {
    const { t, owner, workspaceId } = await moving();
    await t.mutation(internal.functions.managedProvisioning.failManagedStorageMigration, {
      workspaceId,
      errorCode: "COPY_FAILED",
    });
    const jobs = await mailJobs(t);
    expect(jobs.map((job) => job.args[0])).toEqual([
      { workspaceId, recipientUserId: owner, kind: "paused" },
    ]);
  });

  test("a bucket with files asks for a choice", async () => {
    const { t, workspaceId } = await moving();
    await t.mutation(internal.functions.managedProvisioning.failManagedStorageMigration, {
      workspaceId,
      errorCode: "DESTINATION_NOT_EMPTY",
    });
    expect((await mailJobs(t))[0]?.args[0]).toMatchObject({ kind: "needs_choice" });
  });

  test("the owner stopping it themselves sends nothing", async () => {
    const { t, owner, workspaceId } = await moving();
    await asUser(t, owner).mutation(api.functions.managedHandoff.cancelManagedStorageHandoff, {
      workspaceId,
    });
    expect(await mailJobs(t)).toEqual([]);
    expect(handoffEmailKindFor("CANCELLED")).toBeNull();
  });
});

describe("sending", () => {
  test("goes to the owner's verified address, with a link to Settings › Storage", async () => {
    const { t, owner, workspaceId } = await moving();
    const sent = stubResend();
    await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId,
      recipientUserId: owner,
      kind: "paused",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("mover@example.invalid");
    expect(sent[0].text).toContain("https://app.example.invalid/console/@mover?settings=storage");
    expect(sent[0].text).not.toContain("customer-bucket");
  });

  test("only an owner still in the workspace is mailed", async () => {
    const { t, owner, workspaceId } = await moving();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);
    const sent = stubResend();
    await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId,
      recipientUserId: editor,
      kind: "paused",
    });
    await t.run(async (ctx) => {
      const user = await ctx.db.get(owner);
      await ctx.db.patch(owner, { emailVerificationTime: undefined, email: user!.email });
    });
    await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId,
      recipientUserId: owner,
      kind: "paused",
    });
    expect(sent).toEqual([]);
  });

  test("a move that keeps pausing mails at most three times a day", async () => {
    const { t, owner, workspaceId } = await moving();
    const sent = stubResend();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
        workspaceId,
        recipientUserId: owner,
        kind: "paused",
      });
    }
    expect(sent).toHaveLength(3);
    // A different kind has its own allowance: finishing is always said.
    await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId,
      recipientUserId: owner,
      kind: "finished",
      retainedUntil: Date.UTC(2026, 9, 6),
    });
    expect(sent).toHaveLength(4);
    expect(sent[3].text).toContain("October 6");
  });

  test("without a mail key, nothing is claimed or sent", async () => {
    const { t, owner, workspaceId } = await moving();
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, status: 200 };
    });
    await t.action(internal.functions.handoffEmail.sendHandoffEmail, {
      workspaceId,
      recipientUserId: owner,
      kind: "paused",
    });
    expect(calls).toEqual([]);
  });
});

describe("the words", () => {
  test("escape the workspace name and name no bucket", () => {
    const mail = renderHandoffEmail("needs_choice", {
      workspaceName: "Mover <b>Co</b>",
      url: storageSettingsUrl("https://app.example.invalid/", "mover"),
    });
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("Mover &lt;b&gt;Co&lt;/b&gt;");
    expect(mail.text).toContain("nothing has been copied or deleted yet");
    expect(mail.text).toContain("https://app.example.invalid/console/@mover?settings=storage");
  });

  test("still say where to go without an origin", () => {
    const mail = renderHandoffEmail("paused", { workspaceName: "Mover", url: storageSettingsUrl(null, "mover") });
    expect(mail.text).toContain("Settings › Storage in Context");
    expect(mail.subject).toBe("Moving Mover to your bucket has paused");
  });
});
