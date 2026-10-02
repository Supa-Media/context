/**
 * A move whose old storage is Dropbox: its grant outlives the switch for
 * exactly as long as the catch-up passes need it.
 *
 * Dropbox support is ending (no new connections, `docs/decisions/billing.md`),
 * so a Dropbox workspace is moved off it: into Context's storage by upgrading,
 * or into a bucket of the owner's (`to_own`). Before this, the grant was
 * revoked at the switch, so a write that landed in Dropbox in the last seconds
 * was never brought across. Now the switch keeps the grant, the passes read
 * Dropbox with it and revoke it when they end, and a revoke scheduled at the
 * switch is the backstop for passes that never run.
 *
 * ## Sabotage record
 *
 * Revoking at the switch regardless of `deferDropboxRevoke` failed "keeps the
 * Dropbox grant for the passes" (it first passed, because the count read only
 * pending jobs and an immediate revoke had already started; `scheduled` now
 * counts every job not cancelled). Not scheduling the backstop failed the same
 * test. Not revoking after the last pass, or when the workspace has moved
 * again, failed the two revoke tests.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { fakeS3 } from "./fakeS3.helpers";
import { FAKE_STORAGE, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import {
  CATCH_UP_PASS_DELAYS_MS,
  DROPBOX_REVOKE_BACKSTOP_MS,
} from "../functions/lib/managedProvisioningFns/constants";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof setupTest>;

const PROBED = {
  conditionalWrite: true,
  conditionalCreate: true,
  conditionalDelete: false,
  serverSideCopy: false,
};

async function dropboxReadyToSwitch() {
  const t = setupTest();
  const owner = await createUser(t, "dropbox-move-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "dropboxmove");
  const sealed = (secret: string) => encryptSecret(secret, requireKeyset(), { workspaceId });
  const sourceBindingId = await t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "dropbox" as const,
      rootPrefix: "Context/",
      encryptedRefreshToken: await sealed("refresh-not-real"),
      encryptedAccessToken: await sealed("access-not-real"),
      accessTokenExpiresAt: Date.now() + 3_600_000,
      dropboxAccountId: "dbid:EXAMPLE",
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("managedStorageMigrations", {
      workspaceId,
      sourceBindingId,
      direction: "to_own",
      targetProvider: "r2",
      targetEndpoint: FAKE_STORAGE.endpoint,
      targetRegion: FAKE_STORAGE.region,
      targetBucket: FAKE_STORAGE.bucket,
      targetAccessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedTargetSecretAccessKey: await sealed(FAKE_STORAGE.secretAccessKey),
      status: "copying",
      phase: "verify_target",
      objectsCopied: 1,
      objectsProcessedInPhase: 1,
      changesInPass: 0,
      readyToCutover: true,
      targetClaimed: true,
      passStartedAt: Date.now() - 60_000,
      startedBy: owner,
      createdAt: Date.now() - 60 * 60_000,
      updatedAt: Date.now(),
    }),
  );
  return { t, owner, workspaceId, sourceBindingId };
}

/**
 * Scheduled jobs by name that were not cancelled. Not only pending ones: the
 * test runner starts a job scheduled for now almost at once, so an immediate
 * revoke would be running or done, and a pending-only count would miss it.
 */
async function scheduled(t: T, name: string) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name.includes(name) && job.state.kind !== "canceled");
}

async function cancelQueued(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

/**
 * A Dropbox folder in memory behind the three calls a catch-up pass makes:
 * the token refresh, `list_folder`, and `download`. Everything else goes to
 * the S3 fake already installed.
 */
function fakeDropbox(files: Record<string, { body: string; modified: number }>) {
  const s3Fetch = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.dropboxapi.com/oauth2/token")) {
      calls.push("token");
      return Response.json({ access_token: "fresh-access-not-real", expires_in: 14_400, token_type: "bearer" });
    }
    if (url.startsWith("https://api.dropboxapi.com/2/files/list_folder")) {
      calls.push("list");
      return Response.json({
        has_more: false,
        cursor: "c",
        entries: Object.entries(files).map(([path, file]) => ({
          ".tag": "file",
          path_display: `/Context/${path}`,
          path_lower: `/context/${path.toLowerCase()}`,
          size: file.body.length,
          rev: "0123456789a",
          server_modified: new Date(file.modified).toISOString().replace(/\.\d+Z$/, "Z"),
        })),
      });
    }
    if (url.startsWith("https://content.dropboxapi.com/2/files/download")) {
      const arg = JSON.parse(new Headers(init?.headers as HeadersInit).get("Dropbox-API-Arg") ?? "{}");
      const path = String(arg.path).replace(/^\/Context\//, "");
      calls.push(`download ${path}`);
      const file = files[path];
      if (file === undefined) {
        return new Response(JSON.stringify({ error_summary: "path/not_found/" }), { status: 409 });
      }
      return new Response(file.body, {
        status: 200,
        headers: {
          "Dropbox-API-Result": JSON.stringify({ rev: "0123456789a", server_modified: new Date(file.modified).toISOString() }),
        },
      });
    }
    return s3Fetch(input, init);
  });
  return calls;
}

describe("switching over from Dropbox", () => {
  test("keeps the Dropbox grant for the passes, with a backstop revoke", async () => {
    const { t, workspaceId } = await dropboxReadyToSwitch();
    const before = Date.now();
    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
        workspaceId,
        capabilities: PROBED,
      }),
    ).resolves.toEqual({ cutover: true });

    const revokes = await scheduled(t, "revokeDropboxGrant");
    // Not now: only the backstop, after the last pass would have run.
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.scheduledTime).toBeGreaterThanOrEqual(before + DROPBOX_REVOKE_BACKSTOP_MS);
    expect(DROPBOX_REVOKE_BACKSTOP_MS).toBeGreaterThan(CATCH_UP_PASS_DELAYS_MS.at(-1)!);

    const passes = await scheduled(t, "runMoveCatchUp");
    expect(passes).toHaveLength(1);
    const args = passes[0]!.args[0] as { source: Record<string, unknown>; direction: string };
    expect(args.direction).toBe("to_own");
    expect(args.source).toMatchObject({ provider: "dropbox", rootPrefix: "Context/" });
    expect(JSON.stringify(args.source)).not.toContain("refresh-not-real");
  });
});

describe("the catch-up passes from Dropbox", () => {
  async function switched() {
    const scenario = await dropboxReadyToSwitch();
    await scenario.t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, {
      workspaceId: scenario.workspaceId,
      capabilities: PROBED,
    });
    const [pass] = await scheduled(scenario.t, "runMoveCatchUp");
    await cancelQueued(scenario.t);
    vi.stubEnv("DROPBOX_APP_KEY", "test-app-key");
    return { ...scenario, passArgs: pass!.args[0] as Record<string, unknown> };
  }

  test("brings a late Dropbox write across under its original capitalization", async () => {
    const { t, passArgs } = await switched();
    const s3 = fakeS3({ [FAKE_STORAGE.bucket]: { "index.md": ["front page", Date.now()] } });
    const calls = fakeDropbox({
      "index.md": { body: "front page", modified: Date.now() - 2 * 60 * 60_000 },
      "Projects/Late Note.md": { body: "written after the last check", modified: Date.now() },
    });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, passArgs as never);
    expect(calls).toContain("token");
    // The switch also queues the binding's own verification, which writes and
    // removes a probe under `.context/probes/`; under load it can run during
    // this test. It is not a note, and not what is being checked here.
    const keys = s3.keys(FAKE_STORAGE.bucket).filter((key) => !key.startsWith(".context/probes/"));
    expect(keys, JSON.stringify({ keys, calls })).toEqual(["Projects/Late Note.md", "index.md"]);
  });

  test("revokes the grant after the last pass", async () => {
    const { t, passArgs } = await switched();
    fakeS3({ [FAKE_STORAGE.bucket]: {} });
    fakeDropbox({});
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, {
      ...passArgs,
      pass: CATCH_UP_PASS_DELAYS_MS.length - 1,
    } as never);
    const revokes = await scheduled(t, "revokeDropboxGrant");
    expect(revokes).toHaveLength(1);
  });

  test("revokes the grant when the workspace has moved again", async () => {
    const { t, workspaceId, passArgs } = await switched();
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").unique();
      await ctx.db.delete(binding!._id);
    });
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, passArgs as never);
    const revokes = await scheduled(t, "revokeDropboxGrant");
    expect(revokes).toHaveLength(1);
    expect((revokes[0]!.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId).toBe(workspaceId);
  });

  test("an earlier pass leaves the grant standing for the next", async () => {
    const { t, passArgs } = await switched();
    fakeS3({ [FAKE_STORAGE.bucket]: {} });
    fakeDropbox({});
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, passArgs as never);
    expect(await scheduled(t, "revokeDropboxGrant")).toHaveLength(0);
    expect(await scheduled(t, "runMoveCatchUp")).toHaveLength(1);
  });
});
