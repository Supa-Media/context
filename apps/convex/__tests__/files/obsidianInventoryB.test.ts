import { describe, expect, test, vi } from "vitest";
import {
  api,
  internal,
} from "../../_generated/api";
import {
  encryptSecret,
  requireKeyset,
} from "../../functions/lib/crypto";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { memoryS3 } from "../storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createWorkspace,
  errorCode,
} from "../fixtures.helpers";
import {
  SECRET_BODY_MARKER,
  fixture,
} from "./fixtures.helpers";

describe('Obsidian plugin inventory', () => {
  /*
    THE ONE THING AN OWNER MAY NOT AUTHORIZE AWAY.

    Decided by the owner, 2026-09-16: enabling a plugin over your own workspace
    is your call, the same trust you already place in Context — but a plugin
    enabled in one workspace may never reach another, because the people in that
    other one authorized nothing.

    It holds by construction rather than by policy, and that is the part worth a
    test: `executePluginRequest` takes a runtime token and a request, and the
    request has **no workspace argument**. The server derives the workspace from
    the session the token hashes to. So there is no message plugin code can send
    that names somewhere else — and this proves it against the shape that would
    matter, two workspaces owned by the same person, each on its own bucket.

    Same owner on purpose. A stranger being refused proves the membership check;
    it says nothing about whether an authorized token stays where it was issued,
    which is the actual question here.
  */
  test("a plugin's token reaches exactly one workspace", async () => {
    const f = await fixture();

    // A second workspace of the owner's, on its own bucket, holding a note
    // whose path does not exist in the first.
    const elsewhere = await createWorkspace(f.t, f.owner, "other-context");
    const otherBucket = memoryS3("other-bucket");
    otherBucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    otherBucket.seed("1-projects/only-over-here.md", `# Elsewhere\n\n${SECRET_BODY_MARKER}\n`);
    const first = f.backend.fetchImpl;
    // One socket, two buckets: each stub 404s a bucket that is not its own, so
    // whichever binding the server actually used is the one that answers.
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const response = await first(input, init);
      return response.status === 404 ? await otherBucket.fetchImpl(input, init) : response;
    });
    await f.t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId: elsewhere,
        provider: FAKE_STORAGE.provider,
        endpoint: FAKE_STORAGE.endpoint,
        region: FAKE_STORAGE.region,
        bucket: "other-bucket",
        accessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedSecretAccessKey: await encryptSecret(
          FAKE_STORAGE.secretAccessKey,
          requireKeyset(),
          { workspaceId: elsewhere },
        ),
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        lastVerifiedAt: Date.now(),
        boundBy: f.owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/manifest.json",
      JSON.stringify({ id: "highlightr-plugin", name: "Highlightr", version: "1.2.2" }),
    );
    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/main.js",
      'const { Plugin } = require("obsidian"); class Highlightr extends Plugin {}',
    );
    const inventory = await asUser(f.t, f.owner).action(api.functions.files.listObsidianPlugins, {
      workspaceId: f.workspaceId,
    });
    const bundleFingerprint = inventory.plugins[0].bundleFingerprint!;
    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.approvePlugin, {
      workspaceId: f.workspaceId,
      pluginId: "highlightr-plugin",
      bundleFingerprint,
      capabilities: ["vault:read"],
      networkHosts: [],
    });
    const { runtimeToken } = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      { workspaceId: f.workspaceId, pluginId: "highlightr-plugin", bundleFingerprint },
    );

    // The positive companion first: the token does work, in the workspace it
    // was issued for. Without this the refusal below passes on a broken build.
    expect(
      await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.executePluginRequest, {
        runtimeToken,
        request: {
          version: 1,
          requestId: "own_workspace",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      }),
    ).toMatchObject({ ok: true, result: { kind: "file", text: "# Shared\n" } });

    // And the note that exists only in the other workspace is not reachable —
    // by the owner of both, holding a live token, over a granted capability.
    const across = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "across_workspaces",
          operation: { kind: "vault.read", path: "1-projects/only-over-here.md" },
        },
      },
    );
    expect(across).toMatchObject({ ok: false });
    expect(JSON.stringify(across)).not.toContain(SECRET_BODY_MARKER);
  });

  test("an owner grants capabilities to the exact bundle that was checked", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/manifest.json",
      JSON.stringify({ id: "highlightr-plugin", name: "Highlightr", version: "1.2.2" }),
    );
    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/main.js",
      'const { Plugin } = require("obsidian"); class Highlightr extends Plugin {}',
    );
    const inventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    const fingerprint = inventory.plugins[0].bundleFingerprint!;

    const approved = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read", "metadata:read"],
        networkHosts: [],
      },
    );
    let runtimeToken = (await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
      },
    )).runtimeToken;
    expect(approved).toMatchObject({
      pluginId: "highlightr-plugin",
      bundleFingerprint: fingerprint,
      status: "active",
      capabilities: ["metadata:read", "vault:read"],
    });

    const grants = await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.listPluginGrants,
      { workspaceId: f.workspaceId },
    );
    expect(grants).toEqual([approved]);

    const read = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "read_1",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      },
    );
    expect(read).toMatchObject({
      version: 1,
      requestId: "read_1",
      ok: true,
      result: { kind: "file", text: "# Shared\n" },
    });
    const denied = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "write_1",
          operation: { kind: "vault.create", path: "1-projects/plugin.md", text: "# Plugin\n" },
        },
      },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "CAPABILITY_DENIED" } });

    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.approvePlugin, {
      workspaceId: f.workspaceId,
      pluginId: "highlightr-plugin",
      bundleFingerprint: fingerprint,
      capabilities: [
        "vault:read",
        "vault:write",
        "vault:rename",
        "vault:delete",
        "settings:read",
        "settings:write",
      ],
      networkHosts: [],
    });
    runtimeToken = (await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
      },
    )).runtimeToken;
    const loaded = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: { version: 1, requestId: "settings_1", operation: { kind: "settings.load" } },
      },
    );
    expect(loaded).toMatchObject({
      ok: true,
      result: { kind: "pluginSettings", json: "{}", etag: null },
    });
    const saved = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "settings_2",
          operation: { kind: "settings.save", json: "{\"color\":\"yellow\"}", expectedEtag: null },
        },
      },
    );
    expect(saved).toMatchObject({
      ok: true,
      result: { kind: "pluginSettings", json: "{\"color\":\"yellow\"}" },
    });
    expect(f.backend.snapshot()).not.toHaveProperty(".obsidian/plugins/highlightr-plugin/data.json");
    expect(f.backend.snapshot()).toHaveProperty(".context/plugins/highlightr-plugin/data.json");

    const created = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "create_1",
          operation: { kind: "vault.create", path: "1-projects/plugin.md", text: "# Plugin\n" },
        },
      },
    );
    if (!created.ok) throw new Error("expected plugin create to succeed");
    const createdEtag = (created.result as { etag: string }).etag;
    const conflict = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "modify_bad",
          operation: {
            kind: "vault.modify",
            path: "1-projects/plugin.md",
            text: "changed",
            expectedEtag: "stale",
          },
        },
      },
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const modified = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "modify_1",
          operation: {
            kind: "vault.modify",
            path: "1-projects/plugin.md",
            text: "changed",
            expectedEtag: createdEtag,
          },
        },
      },
    );
    if (!modified.ok) throw new Error("expected plugin modify to succeed");
    const modifiedEtag = (modified.result as { etag: string }).etag;
    const renamed = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "rename_1",
          operation: {
            kind: "vault.rename",
            from: "1-projects/plugin.md",
            to: "1-projects/plugin-renamed.md",
            expectedEtag: modifiedEtag,
          },
        },
      },
    );
    expect(renamed).toMatchObject({ ok: true, result: { kind: "moved" } });
    const renamedRead = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "read_renamed",
          operation: { kind: "vault.read", path: "1-projects/plugin-renamed.md" },
        },
      },
    );
    if (!renamedRead.ok) throw new Error("expected renamed plugin file to be readable");
    const deleted = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "delete_1",
          operation: {
            kind: "vault.delete",
            path: "1-projects/plugin-renamed.md",
            expectedEtag: (renamedRead.result as { etag: string }).etag,
          },
        },
      },
    );
    expect(deleted).toMatchObject({ ok: true, result: { kind: "deleted" } });
    await asUser(f.t, f.owner).mutation(api.functions.obsidianPlugins.reportRuntimeStatus, {
      workspaceId: f.workspaceId,
      pluginId: "highlightr-plugin",
      bundleFingerprint: fingerprint,
      status: "loaded",
      attempts: 1,
    });
    expect(await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.listRuntimeStates,
      { workspaceId: f.workspaceId },
    )).toMatchObject([{ pluginId: "highlightr-plugin", status: "loaded", attempts: 1 }]);

    const stopped = await asUser(f.t, f.owner).mutation(
      api.functions.obsidianPlugins.stopPlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
      },
    );
    expect(stopped).toMatchObject({ status: "blocked", errorCode: "OWNER_DISABLED" });
    const stoppedToken = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "after_stop",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      },
    ));
    expect(errorCode(stoppedToken)).toBe("PLUGIN_SESSION_INVALID");
    runtimeToken = (await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
      },
    )).runtimeToken;
    const editorStop = await captureError(() => asUser(f.t, f.editor).mutation(
      api.functions.obsidianPlugins.stopPlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "highlightr-plugin",
        bundleFingerprint: fingerprint,
      },
    ));
    expect(errorCode(editorStop)).toBe("INSUFFICIENT_ROLE");
    expect(await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "after_editor_stop",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      },
    )).toMatchObject({ ok: true });

    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/main.js",
      'const { Plugin } = require("obsidian"); class Changed extends Plugin {}',
    );
    const changedInventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    expect(changedInventory.plugins[0].bundleFingerprint).not.toBe(fingerprint);
    expect(await f.t.query(internal.functions.obsidianPlugins.resolveActiveGrant, {
      workspaceId: f.workspaceId,
      pluginId: "highlightr-plugin",
      bundleFingerprint: changedInventory.plugins[0].bundleFingerprint!,
    })).toBeNull();

    await asUser(f.t, f.owner).mutation(api.functions.obsidianPlugins.revokePlugin, {
      workspaceId: f.workspaceId,
      pluginId: "highlightr-plugin",
    });
    expect((await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.listPluginGrants,
      { workspaceId: f.workspaceId },
    ))[0].status).toBe("revoked");
    expect((await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.listRuntimeStates,
      { workspaceId: f.workspaceId },
    ))[0]).toMatchObject({ status: "blocked", errorCode: "GRANT_REVOKED" });
    const revokedToken = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "after_revoke",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      },
    ));
    expect(errorCode(revokedToken)).toBe("PLUGIN_SESSION_INVALID");
  });

});
