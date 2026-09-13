/**
 * THE FILE EDITOR, THROUGH THE CONTROL PLANE.
 *
 * `fileOps.test.ts` proves the operations against a bucket. This one proves
 * the two things only the Convex layer can get wrong:
 *
 *  1. **Authorization.** Reading needs `member`; writing needs `editor`. A
 *     non-member gets an error byte-identical to the one for a workspace that
 *     never existed, in the style of `isolation.test.ts` — because an endpoint
 *     that distinguishes them is an oracle for which contexts are real.
 *  2. **Note content does not stay here.** The control plane holds metadata
 *     only (CLAUDE.md non-negotiable #1). Content passes through an action and
 *     is returned; it must appear in no table, no audit row, and no error
 *     message. That is asserted by writing a distinctive marker through every
 *     operation and then sweeping the entire database for it.
 *
 * The whole path is real: the real actions, the real `S3Store` doing real
 * SigV4 against a `fetch` stub speaking S3, the real envelope opened by the
 * real `decryptSecret`. Only the socket is fake.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import * as fileFunctions from "../functions/files";
import type { Id } from "../_generated/dataModel";
import { DELETE_CONFIRMATION } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A marker that could only have come from note content.
 *
 * Long, unique, and nothing like a path — so a sweep that finds it has found
 * a leak, not a coincidence.
 */
const SECRET_BODY_MARKER = "zzq-note-body-marker-9f13c4d2-never-persist";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  reader: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/**
 * A workspace with an owner, an editor, a read-only member, a stranger, and a
 * bucket behind it holding a small PARA context.
 *
 * The binding row is inserted directly rather than through `bindStorage`, for
 * the reason `provisioning.test.ts` documents: the public flow also *schedules*
 * a verification, and that scheduled probe would race the action under test.
 * The envelope is produced by the real `encryptSecret`, so the decrypt path
 * exercised here is the real one.
 */
async function fixture(
  options: MemoryS3Options & { conditionalWrite?: boolean } = {},
): Promise<Fixture> {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const reader = await createUser(t, "reader@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, reader, "member", owner);
  // The stranger is a real, authenticated user with a context of her own.
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
  backend.seed("1-projects/shared.md", "# Shared\n");
  backend.seed("2-areas/README.md", "# Areas\n");
  backend.seed("2-areas/private-note.md", `# Private\n\n${SECRET_BODY_MARKER}\n`);
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
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: {
        conditionalWrite,
        conditionalCreate: true,
        conditionalDelete: true,
      },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return { t, owner, editor, reader, stranger, workspaceId, backend };
}

/** Share `1-projects`, so a `team`-scoped caller has something to see. */
async function share(f: Fixture): Promise<void> {
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path: "1-projects",
    visibility: "team",
  });
}

function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * A workspace id that refers to nothing, produced by creating and deleting a
 * row so it is indistinguishable in shape from a live one.
 */
async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      slug: "temporary-placeholder",
      displayName: "Temporary",
      createdBy: (await ctx.db.insert("users", { createdAt: Date.now() })) as Id<"users">,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

/* -------------------------------------------------------------------------- */
/*                              the happy paths                               */
/* -------------------------------------------------------------------------- */

describe("an owner can edit their context", () => {
  test("lists a folder", async () => {
    const f = await fixture();
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "1-projects",
      "2-areas",
      "index.md",
      "privacy.md",
    ]);
  });

  test("reads a note and gets an etag to save against", async () => {
    const f = await fixture();
    const file = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    expect(file.text).toContain("# Shared");
    expect(file.etag).toBeTruthy();
  });

  test("creates, renames, duplicates and archives", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/new.md",
      text: "# New\n",
    });
    await as.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/new.md",
      to: "1-projects/renamed.md",
    });
    const duplicated = await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/renamed.md",
    });
    expect(duplicated.to).toBe("1-projects/renamed copy.md");

    const archived = await as.action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/renamed.md",
    });
    expect(archived.to).toMatch(/^4-archive\//);
    expect(f.backend.snapshot()[archived.to]).toBe("# New\n");
  });

  test("creates a folder", async () => {
    const f = await fixture();
    const created = await asUser(f.t, f.owner).action(
      api.functions.files.createDirectory,
      { workspaceId: f.workspaceId, path: "1-projects/plans" },
    );
    expect(f.backend.snapshot()[created.readme]).toContain("# plans");
  });

  test("pastes a copy at an explicit destination", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/shared.md",
      to: "2-areas/shared.md",
    });
    expect(f.backend.snapshot()["2-areas/shared.md"]).toContain("# Shared");
  });

  test("changes a note's visibility, and the manifest the gateway reads follows", async () => {
    const f = await fixture();
    await share(f);
    const result = await asUser(f.t, f.owner).action(
      api.functions.files.setNoteVisibility,
      {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "private",
      },
    );
    expect(result.exception).toBe(true);
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain("1-projects/shared.md: private");
  });
});

describe("Obsidian plugin inventory", () => {
  test("returns structured compatibility data to an owner without changing the bucket", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/manifest.json",
      JSON.stringify({
        id: "highlightr-plugin",
        name: "Highlightr",
        version: "1.2.2",
        author: "Example Author",
        minAppVersion: "1.0.0",
        description: "Highlight text",
      }),
    );
    f.backend.seed(
      ".obsidian/plugins/highlightr-plugin/main.js",
      'const { Plugin } = require("obsidian"); class Highlightr extends Plugin {}',
    );
    const before = f.backend.snapshot();

    const result = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );

    expect(result).toMatchObject({
      available: true,
      found: 1,
      scanned: 1,
      truncated: false,
      counts: { runs: 1 },
      plugins: [{
        source: "obsidian",
        folder: "highlightr-plugin",
        id: "highlightr-plugin",
        name: "Highlightr",
        version: "1.2.2",
        bundleFingerprint: expect.stringMatching(/^v2:/),
        verdict: "runs",
        reason: "no-calls-outside-the-sandbox-found",
      }],
    });
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("is owner-only and keeps a non-member indistinguishable from a missing workspace", async () => {
    const f = await fixture();
    const editorError = await captureError(() => asUser(f.t, f.editor).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    ));
    expect(errorCode(editorError)).toBe("INSUFFICIENT_ROLE");

    const missingId = await danglingWorkspaceId(f.t);
    const stranger = asUser(f.t, f.stranger);
    const existingError = await captureError(() => stranger.action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    ));
    const missingError = await captureError(() => stranger.action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: missingId },
    ));
    expect(errorShape(existingError)).toBe(errorShape(missingError));
    expect(errorCode(existingError)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("installs, updates, loads, and uninstalls an official plugin without touching Obsidian", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/virtual-linker/manifest.json",
      JSON.stringify({ id: "virtual-linker", name: "Obsidian copy", version: "0.9.0" }),
    );
    f.backend.seed(
      ".obsidian/plugins/virtual-linker/main.js",
      'const { Plugin } = require("obsidian"); class Old extends Plugin {}',
    );
    const storageFetch = f.backend.fetchImpl;
    let version = "1.0.0";
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      if (url.href.includes("obsidian-releases/HEAD/community-plugins.json")) {
        return new Response(JSON.stringify([{
          id: "virtual-linker",
          name: "Virtual Linker",
          author: "Example",
          description: "Links notes",
          repo: "example/virtual-linker",
        }]));
      }
      if (url.href.includes("example/virtual-linker/HEAD/manifest.json")) {
        return new Response(JSON.stringify({ id: "virtual-linker", version }));
      }
      if (url.hostname === "github.com" && url.pathname.endsWith("/manifest.json")) {
        return new Response(JSON.stringify({ id: "virtual-linker", name: "Virtual Linker", version }));
      }
      if (url.hostname === "github.com" && url.pathname.endsWith("/main.js")) {
        return new Response(`const { Plugin } = require("obsidian"); class V${version.replaceAll(".", "")} extends Plugin {}`);
      }
      if (url.hostname === "github.com" && url.pathname.endsWith("/styles.css")) {
        return new Response(".virtual-linker { color: blue; }");
      }
      return await storageFetch(input, init);
    });

    const search = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.searchCommunityPlugins,
      { workspaceId: f.workspaceId, query: "virtual" },
    );
    expect(search).toMatchObject([{ id: "virtual-linker", repository: "example/virtual-linker" }]);
    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.installCommunityPlugin, {
      workspaceId: f.workspaceId,
      pluginId: "virtual-linker",
    });
    let inventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    expect(inventory.plugins).toHaveLength(1);
    expect(inventory.plugins[0]).toMatchObject({
      source: "context",
      id: "virtual-linker",
      version: "1.0.0",
      verdict: "runs",
    });
    const firstFingerprint = inventory.plugins[0].bundleFingerprint!;
    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.approvePlugin, {
      workspaceId: f.workspaceId,
      pluginId: "virtual-linker",
      bundleFingerprint: firstFingerprint,
      capabilities: ["vault:read"],
      networkHosts: [],
    });
    const loaded = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      {
        workspaceId: f.workspaceId,
        pluginId: "virtual-linker",
        bundleFingerprint: firstFingerprint,
      },
    );
    expect(loaded).toMatchObject({ version: "1.0.0", mainJs: expect.stringContaining("class V100") });
    const request = {
      version: 1,
      requestId: "at_most_once",
      operation: { kind: "vault.read", path: "1-projects/shared.md" },
    };
    expect(await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.executePluginRequest, {
      runtimeToken: loaded.runtimeToken,
      request,
    })).toMatchObject({ ok: true });
    expect(await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.executePluginRequest, {
      runtimeToken: loaded.runtimeToken,
      request,
    })).toMatchObject({ ok: false, error: { code: "REQUEST_REPLAYED" } });

    version = "1.1.0";
    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.installCommunityPlugin, {
      workspaceId: f.workspaceId,
      pluginId: "virtual-linker",
    });
    inventory = await asUser(f.t, f.owner).action(api.functions.files.listObsidianPlugins, {
      workspaceId: f.workspaceId,
    });
    expect(inventory.plugins[0].version).toBe("1.1.0");
    expect(inventory.plugins[0].bundleFingerprint).not.toBe(firstFingerprint);
    expect((await asUser(f.t, f.owner).query(api.functions.obsidianPlugins.listPluginGrants, {
      workspaceId: f.workspaceId,
    }))[0].status).toBe("revoked");

    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.uninstallCommunityPlugin, {
      workspaceId: f.workspaceId,
      pluginId: "virtual-linker",
      bundleFingerprint: inventory.plugins[0].bundleFingerprint!,
    });
    const after = await asUser(f.t, f.owner).action(api.functions.files.listObsidianPlugins, {
      workspaceId: f.workspaceId,
    });
    expect(after.plugins[0]).toMatchObject({ source: "obsidian", version: "0.9.0" });
    expect(Object.keys(f.backend.snapshot()).some((key) => key.startsWith(".context/plugins/virtual-linker/"))).toBe(false);
    expect(f.backend.snapshot()).toHaveProperty(".obsidian/plugins/virtual-linker/main.js");
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
  });

  test("only an owner can grant a plugin and a blocked bundle cannot be granted", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/shell/manifest.json",
      JSON.stringify({ id: "shell", name: "Shell", version: "1.0.0" }),
    );
    f.backend.seed(".obsidian/plugins/shell/main.js", 'require("child_process")');
    const inventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    const fingerprint = inventory.plugins[0].bundleFingerprint!;

    const editorError = await captureError(() => asUser(f.t, f.editor).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "shell",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read"],
        networkHosts: [],
      },
    ));
    expect(errorCode(editorError)).toBe("INSUFFICIENT_ROLE");

    const blockedError = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "shell",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read"],
        networkHosts: [],
      },
    ));
    expect(errorCode(blockedError)).toBe("PLUGIN_NOT_RUNNABLE");
  });

  test("network authority is limited to hosts found in the reviewed bundle", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/web/manifest.json",
      JSON.stringify({ id: "web", name: "Web", version: "1.0.0" }),
    );
    f.backend.seed(
      ".obsidian/plugins/web/main.js",
      'requestUrl("https://api.example.com/items")',
    );
    const inventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    const fingerprint = inventory.plugins[0].bundleFingerprint!;

    const widened = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "web",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read", "network:request"],
        networkHosts: ["evil.example"],
      },
    ));
    expect(errorCode(widened)).toBe("INVALID_NETWORK_GRANT");

    const approved = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "web",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read", "network:request"],
        networkHosts: ["API.EXAMPLE.COM"],
      },
    );
    expect(approved.networkHosts).toEqual(["api.example.com"]);
    const runtimeToken = (await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      { workspaceId: f.workspaceId, pluginId: "web", bundleFingerprint: fingerprint },
    )).runtimeToken;

    const storageFetch = f.backend.fetchImpl;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      if (url.hostname === "api.example.com") {
        return new Response("{\"ok\":true}", {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": "secret=value" },
        });
      }
      return await storageFetch(input, init);
    });
    const response = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "network_1",
          operation: {
            kind: "network.request",
            url: "https://api.example.com/items",
            method: "GET",
            headers: [],
          },
        },
      },
    );
    if (!response.ok) throw new Error("expected brokered request to succeed");
    const networkResult = response.result as {
      status: number;
      headers: Array<{ name: string; value: string }>;
      body: ArrayBuffer;
    };
    expect(response).toMatchObject({ ok: true, result: { status: 200 } });
    expect(networkResult.headers).not.toContainEqual(expect.objectContaining({ name: "set-cookie" }));
    expect(new TextDecoder().decode(networkResult.body)).toBe("{\"ok\":true}");
  });
});

describe("Obsidian vault import", () => {
  test("requires the exact destructive acknowledgement before a replacement job exists", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const args = {
      workspaceId: f.workspaceId,
      strategy: "replace" as const,
      sourceFingerprint: "vault-replace-confirmation",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    };

    for (const confirmation of [undefined, "i understand", "I understand "]) {
      const error = await captureError(() => owner.mutation(
        api.functions.files.startVaultImport,
        { ...args, confirmation },
      ));
      expect(errorCode(error)).toBe("IMPORT_REPLACE_CONFIRMATION_REQUIRED");
    }

    const jobs = await f.t.run((ctx) => ctx.db.query("vaultImportJobs").collect());
    expect(jobs).toEqual([]);
  });

  test("clears every bucket object in a resumable owner-only phase before replacement uploads", async () => {
    const f = await fixture();
    f.backend.seed(".audit/legacy-events.jsonl", "legacy audit");
    f.backend.seed(".context/audit/events.jsonl", "audit");
    f.backend.seed(".context/recover/privacy.md", "old privacy");
    f.backend.seed("attachment.png", new Uint8Array([1, 2, 3]));
    for (let index = 0; index < 205; index += 1) {
      f.backend.seed(`archive/note-${String(index).padStart(3, "0")}.md`, `${index}`);
    }
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "replace",
      confirmation: "I understand",
      sourceFingerprint: "vault-replace-resumable",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    expect(job.replacement).toEqual({
      phase: "counting",
      totalObjects: 0,
      deletedObjects: 0,
    });

    const unauthorized = await captureError(() => asUser(f.t, f.stranger).action(
      api.functions.files.clearVaultImportBatch,
      { workspaceId: f.workspaceId, jobId: job.jobId, sourceFingerprint: "vault-replace-resumable" },
    ));
    expect(errorCode(unauthorized)).toBe("WORKSPACE_NOT_FOUND");
    expect(Object.keys(f.backend.snapshot())).toHaveLength(215);

    const counted = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(counted.replacement).toEqual({
      phase: "deleting",
      totalObjects: 215,
      deletedObjects: 0,
    });
    expect(Object.keys(f.backend.snapshot())).toHaveLength(215);

    const firstPage = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(firstPage.replacement).toEqual({
      phase: "deleting",
      totalObjects: 215,
      deletedObjects: 100,
    });
    expect(Object.keys(f.backend.snapshot())).toHaveLength(115);

    await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    const cleared = await owner.action(api.functions.files.clearVaultImportBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
    });
    expect(cleared.replacement).toEqual({
      phase: "uploading",
      totalObjects: 215,
      deletedObjects: 215,
    });
    expect(f.backend.snapshot()).toEqual({});

    const complete = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-resumable",
      batchIndex: 0,
      files: [{
        path: "new.md",
        bytes: new TextEncoder().encode("new").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });
    expect(complete.status).toBe("complete");
    expect(f.backend.snapshot()["new.md"]).toBe("new");
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain("default_visibility: private");
  });

  test("refuses replacement file bytes until the bucket-clearing phase finishes", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "replace",
      confirmation: "I understand",
      sourceFingerprint: "vault-replace-ordering",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    const error = await captureError(() => owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-replace-ordering",
      batchIndex: 0,
      files: [{ path: "new.md", bytes: new TextEncoder().encode("new").buffer, contentType: "text/markdown" }],
    }));

    expect(errorCode(error)).toBe("IMPORT_REPLACE_NOT_READY");
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
    expect(f.backend.snapshot()["new.md"]).toBeUndefined();
  });

  test("persists resumable progress and counts a retried batch only once", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-1",
      totalFiles: 2,
      totalBytes: 12,
      totalBatches: 2,
    });
    const batch = {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-1",
      batchIndex: 0,
      files: [{
        path: "Imported/one.md",
        bytes: new TextEncoder().encode("# One\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    };

    const first = await owner.action(api.functions.files.importVaultJobBatch, batch);
    const retry = await owner.action(api.functions.files.importVaultJobBatch, batch);

    expect(first).toMatchObject({
      status: "active",
      completedFiles: 1,
      totalFiles: 2,
      createdFiles: 1,
      skippedFiles: 0,
      completedBatches: [0],
    });
    expect(retry).toEqual(first);
    expect(f.backend.snapshot()["Imported/one.md"]).toBe("# One\n");

    const durable = await owner.query(api.functions.files.latestVaultImportJob, {
      workspaceId: f.workspaceId,
    });
    expect(durable).toMatchObject({
      jobId: job.jobId,
      status: "active",
      completedFiles: 1,
      totalFiles: 2,
    });
  });

  test("resumes the same selected vault and completes after the missing batch", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const args = {
      workspaceId: f.workspaceId,
      strategy: "folder" as const,
      sourceFingerprint: "vault-fingerprint-2",
      totalFiles: 2,
      totalBytes: 12,
      totalBatches: 2,
    };
    const started = await owner.mutation(api.functions.files.startVaultImport, args);
    await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: 0,
      files: [{
        path: "Imports/Vault/one.md",
        bytes: new TextEncoder().encode("one").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    await owner.mutation(api.functions.files.pauseVaultImport, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
    });
    const resumed = await owner.mutation(api.functions.files.startVaultImport, args);
    expect(resumed).toMatchObject({
      jobId: started.jobId,
      status: "active",
      completedFiles: 1,
      completedBatches: [0],
    });

    const complete = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: started.jobId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: 1,
      files: [{
        path: "Imports/Vault/two.md",
        bytes: new TextEncoder().encode("two").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });
    expect(complete).toMatchObject({
      status: "complete",
      completedFiles: 2,
      totalFiles: 2,
      completedBatches: [0, 1],
    });
  });

  test("keeps another user from seeing or advancing a vault import job", async () => {
    const f = await fixture();
    const job = await asUser(f.t, f.owner).mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-private",
      totalFiles: 1,
      totalBytes: 3,
      totalBatches: 1,
    });

    const queryError = await captureError(() =>
      asUser(f.t, f.stranger).query(api.functions.files.latestVaultImportJob, {
        workspaceId: f.workspaceId,
      }),
    );
    const batchError = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.importVaultJobBatch, {
        workspaceId: f.workspaceId,
        jobId: job.jobId,
        sourceFingerprint: "vault-fingerprint-private",
        batchIndex: 0,
        files: [{
          path: "private.md",
          bytes: new TextEncoder().encode("no").buffer,
          contentType: "text/markdown; charset=utf-8",
        }],
      }),
    );
    expect(errorCode(queryError)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(batchError)).toBe("WORKSPACE_NOT_FOUND");
    expect(f.backend.snapshot()["private.md"]).toBeUndefined();
  });

  test("rejects a mismatched resume plan before any local bytes reach storage", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-mismatch",
      totalFiles: 1,
      totalBytes: 6,
      totalBatches: 1,
    });

    const error = await captureError(() => owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-mismatch",
      batchIndex: 0,
      files: [
        {
          path: "one.md",
          bytes: new TextEncoder().encode("one").buffer,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "two.md",
          bytes: new TextEncoder().encode("two").buffer,
          contentType: "text/markdown; charset=utf-8",
        },
      ],
    }));

    expect(errorCode(error)).toBe("IMPORT_PLAN_INVALID");
    expect(f.backend.snapshot()["one.md"]).toBeUndefined();
    expect(f.backend.snapshot()["two.md"]).toBeUndefined();
  });

  test("preserves Markdown and attachment paths without retaining their bytes in Convex", async () => {
    const f = await fixture();
    const markdown = new TextEncoder().encode("# Imported\n\n![[diagram.png]]\n");
    const image = new Uint8Array([137, 80, 78, 71]);
    const owner = asUser(f.t, f.owner);
    const job = await owner.mutation(api.functions.files.startVaultImport, {
      workspaceId: f.workspaceId,
      strategy: "merge",
      sourceFingerprint: "vault-fingerprint-no-content",
      totalFiles: 2,
      totalBytes: markdown.byteLength + image.byteLength,
      totalBatches: 1,
    });

    const result = await owner.action(api.functions.files.importVaultJobBatch, {
      workspaceId: f.workspaceId,
      jobId: job.jobId,
      sourceFingerprint: "vault-fingerprint-no-content",
      batchIndex: 0,
      files: [
        {
          path: "Imported/Note.md",
          bytes: markdown.buffer,
          contentType: "text/markdown; charset=utf-8",
        },
        {
          path: "Imported/diagram.png",
          bytes: image.buffer,
          contentType: "image/png",
        },
      ],
    });

    expect(result).toMatchObject({ status: "complete", createdFiles: 2, completedFiles: 2 });
    expect(f.backend.snapshot()["Imported/Note.md"]).toContain("# Imported");
    expect([...f.backend.bytesOf("Imported/diagram.png")!]).toEqual([...image]);

    const database = await f.t.run(async (ctx) => {
      const tables = ["auditEvents", "storageBindings", "vaultImportJobs", "workspaces", "users"] as const;
      return JSON.stringify(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
    });
    expect(database).not.toContain("# Imported");
    expect(database).not.toContain("137,80,78,71");
  });

  test("is create-only, so retrying cannot overwrite a file that already exists", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
      workspaceId: f.workspaceId,
      files: [{
        path: "index.md",
        bytes: new TextEncoder().encode("# Replacement\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["index.md"]);
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  // The create-only claim above is tested against a backend that honours the
  // precondition. `initialCapabilities()` starts every binding at
  // `conditionalWrite: false` — "B2 and arbitrary S3-compatible endpoints do
  // not reliably [support it]" — and every other conditional write in
  // `fileOps.ts` reads `store.capabilities` before relying on one. An importer
  // that sends the precondition and trusts the answer, on a binding recorded as
  // not having proven it, is the exact failure the probe exists to prevent:
  // "a lost write with no error, which is the one failure mode a notes product
  // cannot have" — here, during onboarding, over the customer's own vault.
  test("does not lose an existing file on a backend whose conditional writes were never proven", async () => {
    const f = await fixture({ conditionalWrite: false, ignoreIfMatch: true });
    const result = await asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
      workspaceId: f.workspaceId,
      files: [{
        path: "index.md",
        bytes: new TextEncoder().encode("# Replacement\n").buffer,
        contentType: "text/markdown; charset=utf-8",
      }],
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["index.md"]);
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  test("is owner-only and refuses Obsidian or Context hidden state", async () => {
    const f = await fixture();
    const file = {
      path: "notes/new.md",
      bytes: new TextEncoder().encode("# no\n").buffer,
      contentType: "text/markdown; charset=utf-8",
    };
    const editorError = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.importVaultBatch, {
        workspaceId: f.workspaceId,
        files: [file],
      }),
    );
    expect(errorCode(editorError)).toBe("INSUFFICIENT_ROLE");

    const hiddenError = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.importVaultBatch, {
        workspaceId: f.workspaceId,
        files: [{ ...file, path: ".obsidian/plugins.json" }],
      }),
    );
    expect(errorCode(hiddenError)).toBe("PATH_INVALID");
    expect(f.backend.snapshot()[".obsidian/plugins.json"]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                                   roles                                    */
/* -------------------------------------------------------------------------- */

describe("read access and write access are different grants", () => {
  test("a read-only member may list and read what is shared", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects",
    });
    expect(listing.entries.map((entry) => entry.name)).toContain("shared.md");
  });

  test("a read-only member cannot write", async () => {
    const f = await fixture();
    await share(f);
    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        text: "# Vandalised\n",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
  });

  /**
   * The enumeration IS the guard, and it went stale.
   *
   * Every write action's clearance lives in one `minimum:` line in
   * `functions/files.ts`, and this list is the only thing holding those lines.
   * Mutating each of the ten in turn — `editor` to `member`, `owner` to
   * `editor` — found **four that produced zero failures across all 1123
   * checks**: `copyEntry`, `duplicateEntry`, `archiveEntry` and `resetPrivacy`.
   * All four were added after this list was written and never added to it.
   *
   * **They are not the same kind of hole, and the difference is measured rather
   * than assumed.** With its bar lowered to `member`:
   *
   *  - `copyEntry` and `duplicateEntry` **resolve**, and the key lands
   *    (`1-projects/copied.md`, `1-projects/shared copy.md`). The role gate is
   *    the only thing between a read tier and a write.
   *  - `archiveEntry` is refused `ARCHIVE_UNAVAILABLE` — by `archivePath`'s own
   *    scope gate, because `4-archive` is private by default and a team-scope
   *    caller cannot write into a folder they cannot see. Its role gate is
   *    load-bearing only where the owner has shared `4-archive`, which is why
   *    this test now shares it: with that done, the archive key lands too.
   *  - `resetPrivacy` is refused `PRIVACY_MANIFEST_READ_ONLY` by the module —
   *    the belt-and-braces CLAUDE.md states deliberately, "checked at the action
   *    (`minimum: "owner"`) and again in the module a test can drive without a
   *    session". The braces held it; only the belt was unheld.
   *
   * An earlier version of this comment said the first three were "the only
   * thing standing between a read-only member and a write". That was true of
   * two of them. Getting it wrong here is worse than elsewhere, because the
   * distinction it missed is the one the same comment draws for `resetPrivacy`
   * two paragraphs down.
   */
  test("a read-only member cannot delete, move, or change visibility either", async () => {
    const f = await fixture();
    await share(f);
    // `4-archive` shared too, so `archiveEntry`'s destination is reachable at
    // team scope and its role gate becomes the only remaining bar. Without it
    // the archive is refused by `archivePath` whatever its clearance says, and
    // both the third clause of the assertion below and the claim above would be
    // untestable. Verified by lowering all three bars: the three keys land.
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "4-archive",
      visibility: "team",
    });
    const as = asUser(f.t, f.reader);
    for (const call of [
      () =>
        as.action(api.functions.files.deleteEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          confirmation: DELETE_CONFIRMATION,
        }),
      () =>
        as.action(api.functions.files.moveEntry, {
          workspaceId: f.workspaceId,
          from: "1-projects/shared.md",
          to: "1-projects/moved.md",
        }),
      () =>
        as.action(api.functions.files.setNoteVisibility, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          visibility: "private",
        }),
      () =>
        as.action(api.functions.files.createDirectory, {
          workspaceId: f.workspaceId,
          path: "1-projects/new-folder",
        }),
      () =>
        as.action(api.functions.files.copyEntry, {
          workspaceId: f.workspaceId,
          from: "1-projects/shared.md",
          to: "1-projects/copied.md",
        }),
      () =>
        as.action(api.functions.files.duplicateEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
        }),
      () =>
        as.action(api.functions.files.archiveEntry, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
        }),
    ]) {
      expect(errorCode(await captureError(call))).toBe("INSUFFICIENT_ROLE");
    }
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
    // Nothing arrived anywhere either — a refusal that still wrote the
    // destination would pass every assertion above. Every clause can fire:
    // with the three role gates lowered this filter returns
    // `["1-projects/copied.md", "1-projects/shared copy.md",
    //   "4-archive/<stamp>/1-projects/shared.md"]`.
    expect(
      Object.keys(f.backend.snapshot()).filter(
        (key) =>
          key.includes("copied") || key.includes(" copy") || key.startsWith("4-archive/2"),
      ),
    ).toEqual([]);
  });

  /**
   * AND THE ENUMERATION WENT STALE AGAIN, THE MOMENT A NEW WRITE DOOR OPENED.
   *
   * `removeNoteEncryption` is the one action in this file that writes plaintext
   * over an encrypted note, and it arrived after the list above was last
   * checked. Measured the way that comment says to measure: with its
   * `minimum: "editor"` lowered to `"member"`, the whole `apps/convex` run
   * stayed green — 2170 of 2170 — so nothing at all was holding the bar on the
   * most destructive write the console has. A read-only member could have
   * replaced a locked note they were shared with by plaintext of their own
   * choosing, destroying ciphertext nobody — not the owner, not us — can
   * reconstruct.
   *
   * It gets its own test rather than a tenth entry in the loop above because
   * the loop's notes are all `# Shared\n`, and this door refuses an unencrypted
   * note (`NOTE_NOT_ENCRYPTED`) before its role gate would ever matter: a row
   * there would assert the wrong refusal and stay green with the bar on the
   * floor. Here the note really is encrypted, so a lowered bar lands the write
   * and both halves of the assertion fail — the refusal and the bytes.
   */
  test("a read-only member cannot remove a locked note's encryption", async () => {
    const f = await fixture();
    await share(f);
    const locked = [
      "---",
      "context_encryption: v1",
      "---",
      "",
      "> [!NOTE] This note is encrypted.",
      "",
      "```context-encrypted",
      '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA",' +
        '"aad":"context-note-v1:ws_x","recipients":[{"kind":"passphrase","id":"p1",' +
        '"alg":"A256GCM","iv":"BBBBBBBBBBBBBBBB","wrapped":"CCCC"}]}',
      "```",
      "",
    ].join("\n");
    f.backend.seed("1-projects/locked.md", locked);

    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.removeNoteEncryption, {
        workspaceId: f.workspaceId,
        path: "1-projects/locked.md",
        text: "# I took the lock off a note I can only read\n",
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.backend.snapshot()["1-projects/locked.md"]).toBe(locked);
  });

  test("an editor cannot rewrite the access map — the action's own bar, not the module's", async () => {
    // `resetPrivacy` is guarded twice on purpose: `minimum: "owner"` at the
    // action, and `scope !== "private"` inside `resetPrivacyManifest`. Dropping
    // the action's bar to `editor` failed nothing, because the module caught it
    // — so this asserts the code the ACTION produces, which is the one the
    // module never emits.
    const f = await fixture();
    await share(f);
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect();
      const reader = membership.find((row) => row.userId === f.reader);
      if (reader !== undefined) await ctx.db.patch(reader._id, { role: "editor" });
    });

    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.resetPrivacy, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("an editor may write", async () => {
    const f = await fixture();
    await share(f);
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/from-editor.md",
      text: "# Editor\n",
    });
    expect(f.backend.snapshot()["1-projects/from-editor.md"]).toBe("# Editor\n");
  });
});

/* -------------------------------------------------------------------------- */
/*                            visibility as a boundary                        */
/* -------------------------------------------------------------------------- */

describe("a team-scoped caller cannot read, list, or infer a private note", () => {
  /**
   * `owner` gets `private` scope; everyone else in the workspace gets `team`.
   * Being able to write is a separate grant from being able to see what the
   * owner marked private — see the module comment in `functions/files.ts`.
   */
  test("a member does not see a private folder at all", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["1-projects"]);
  });

  test("nor privacy.md, which would name every private folder", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.reader).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(listing.entries.map((entry) => entry.name)).not.toContain(PRIVACY_KEY);
  });

  test("reading a private note fails byte-identically to reading one that never existed", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);

    const hidden = await captureError(() =>
      as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/private-note.md",
      }),
    );
    const absent = await captureError(() =>
      as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/no-such-note.md",
      }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
  });

  /**
   * End to end, and the collapse is now an ANSWER rather than a refusal.
   *
   * It used to be a shared `FILE_NOT_FOUND`, which read as safe and was the
   * leak: a name that does not exist inherits its parent's default, so under a
   * team-visible parent it was visible and returned an empty listing while a
   * private one refused. Two answers, and the difference was the withheld fact.
   * Both give the empty listing now — including inside a folder the caller can
   * see, which is where the old shape came apart.
   */
  test("listing a private folder is byte-identical to listing one that never existed", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);
    const hidden = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "2-areas",
    });
    const absent = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "9-imaginary",
    });
    // `path` echoes the request, so it is the one field allowed to differ.
    expect(JSON.stringify({ ...hidden, path: null })).toBe(
      JSON.stringify({ ...absent, path: null }),
    );
  });

  /**
   * And inside a folder the caller CAN see, which is where the old shape came
   * apart. At the root both legs were refused because the root default is
   * private; one level in, an absent name inherits `team`, is visible, and used
   * to return an empty listing while a private sibling refused.
   *
   * The private subfolder is built here rather than in `share`, because a
   * fixture without one makes both legs absent and the comparison vacuous —
   * which is how the first version of this test passed.
   */
  test("and the same holds inside a folder the caller can see", async () => {
    const f = await fixture();
    await share(f);
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client/brief.md",
      text: "# Brief\n",
    });
    await owner.action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client",
      visibility: "private",
    });

    // The owner sees it, so the collapse below is about scope rather than the
    // folder having stopped existing.
    expect(
      (
        await owner.action(api.functions.files.listFiles, {
          workspaceId: f.workspaceId,
          path: "1-projects/secret-client",
        })
      ).entries.map((e: { name: string }) => e.name),
    ).toEqual(["brief.md"]);

    const as = asUser(f.t, f.reader);
    const hidden = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects/secret-client",
    });
    const absent = await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects/never-existed",
    });
    expect(JSON.stringify({ ...hidden, path: null })).toBe(
      JSON.stringify({ ...absent, path: null }),
    );
  });

  test("an editor writing into a folder they cannot see is refused, and refused the same way", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.editor);
    const hidden = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/sneaky.md",
        text: "# Sneaky\n",
      }),
    );
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
    expect(f.backend.snapshot()["2-areas/sneaky.md"]).toBeUndefined();
  });

  test("the owner still sees everything", async () => {
    const f = await fixture();
    await share(f);
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "2-areas",
    });
    expect(listing.entries.map((entry) => entry.name)).toContain("private-note.md");
  });
});

/* -------------------------------------------------------------------------- */
/*                    the audit trail is inside that boundary                 */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK: RECOVER A HIDDEN NOTE'S PATH FROM THE AUDIT TRAIL.
 *
 * Everything above proves the file APIs hold the line — a `team`-scoped member
 * cannot read, list, or infer a private note. `listEvents` is readable by every
 * member of the same workspace and used to hand them the path anyway, three
 * different ways, for a note whose folder listing correctly comes back empty.
 *
 * Attacker and victim share ONE database and ONE workspace on purpose. A
 * fixture that puts them in separate ones proves nothing: the refusal would
 * then come from the row not existing rather than from the gate.
 */
describe("a member cannot recover a hidden path out of the audit trail", () => {
  const HIDDEN = "2-areas/acquisition-of-acme.md";
  const SIBLING = "2-areas/acquisition-of-acme-terms.md";

  /**
   * A private folder holding two notes, touched by the owner in the ways that
   * write a path onto the trail: created, and re-classified.
   */
  async function attackFixture() {
    const f = await fixture();
    await share(f);
    const owner = asUser(f.t, f.owner);

    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: HIDDEN,
      text: "# Acme\n",
    });
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: SIBLING,
      text: "# Terms\n",
    });
    await owner.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: HIDDEN,
      visibility: "private",
    });
    return f;
  }

  async function memberSees(f: Fixture): Promise<string> {
    const rows = await asUser(f.t, f.reader).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    return JSON.stringify(rows);
  }

  /**
   * The premise. If the member could list the folder, nothing below is a leak.
   */
  test("the member's own listing of that folder is empty", async () => {
    const f = await attackFixture();
    const listing = await asUser(f.t, f.reader).action(
      api.functions.files.listFiles,
      { workspaceId: f.workspaceId, path: "2-areas" },
    );
    expect(listing.entries).toEqual([]);
  });

  /**
   * `file.create` and `visibility.note` both name the note, and the second one
   * labels it `visibility: "private"` -- so before the gate the member did not
   * merely learn a path, they learned it was a path kept from them.
   */
  test("the trail does not hand over the path it was created under", async () => {
    const f = await attackFixture();
    expect(await memberSees(f)).not.toContain(HIDDEN);
  });

  /**
   * The worst of the three. `deleteEntry` on a folder records
   * `keysUnder(...)` expanded at the *actor's* clearance, so an owner deleting
   * a private folder used to write every private note in it onto a row the
   * member reads.
   */
  test("nor every private sibling out of a folder delete", async () => {
    const f = await attackFixture();
    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      confirmation: DELETE_CONFIRMATION,
    });
    const dump = await memberSees(f);
    expect(dump).not.toContain(HIDDEN);
    expect(dump).not.toContain(SIBLING);
  });

  /**
   * The owner is the reason this is a gate and not a schema change: the record
   * itself is unchanged, and the person with `private` clearance still reads
   * all of it.
   */
  test("the owner's own view of the same trail is complete", async () => {
    const f = await attackFixture();
    const rows = await asUser(f.t, f.owner).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    expect(JSON.stringify(rows)).toContain(HIDDEN);
    expect(rows.every((row) => row.pathsWithheld === false)).toBe(true);
  });

  /**
   * THE HALF OF THE TRAIL A MEMBER KEEPS.
   *
   * Withholding every path from a non-owner would have been simpler and would
   * have taken this with it — "what did my own client just do in my name" is
   * a member's main reason to open the trail, and those paths are ones the
   * member supplied, expanded at the member's own clearance.
   */
  test("a member still reads the paths of what they did themselves", async () => {
    const f = await attackFixture();
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/editor-wrote-this.md",
      text: "# Mine\n",
    });
    const rows = await asUser(f.t, f.editor).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    const mine = rows.find((row) => row.actorUserId === f.editor);
    expect(mine?.pathsWithheld).toBe(false);
    expect(mine?.paths).toEqual(["1-projects/editor-wrote-this.md"]);
    // And the owner's rows in the very same response are still closed.
    expect(
      rows.filter((row) => row.actorUserId === f.owner).every((row) => row.pathsWithheld),
    ).toBe(true);
  });

  /**
   * THE SECOND-ORDER LEAK: A REDACTION THAT VARIES IS ITSELF A SIGNAL.
   *
   * `pathsWithheld` is computed from the reader alone, never from the row, so
   * a withheld row that named two private notes and a withheld row that named
   * nothing at all come back byte-identical. Had the flag been raised only
   * when `paths` was non-empty, a member could have subtracted "rows that
   * touched something" from "notes I can list" — the same census the note
   * count is owner-only to prevent, rebuilt out of booleans.
   *
   * The two rows are inserted directly, with equal `at` and equal action, so
   * the only thing that could differ between them is the thing under test.
   */
  test("a withheld row is indistinguishable from a row that named nothing", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        action: "file.delete",
        paths: ["2-areas/one.md", "2-areas/two.md"],
        at: 5_000,
      });
      await ctx.db.insert("auditEvents", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        action: "file.delete",
        paths: [],
        at: 5_000,
      });
    });
    const rows = await asUser(f.t, f.reader).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    const pair = rows.filter((row) => row.at === 5_000);
    expect(pair).toHaveLength(2);
    // `eventId` is the row's own id and is not derived from its contents.
    const shape = (row: (typeof pair)[number]) =>
      JSON.stringify({ ...row, eventId: null });
    expect(shape(pair[0]!)).toBe(shape(pair[1]!));
  });
});

/* -------------------------------------------------------------------------- */
/*                              tenant isolation                              */
/* -------------------------------------------------------------------------- */

describe("a stranger cannot reach another workspace's files", () => {
  test("every file endpoint answers exactly as it does for a workspace that never existed", async () => {
    const f = await fixture();
    const dangling = await danglingWorkspaceId(f.t);
    const as = asUser(f.t, f.stranger);
    const importJobId = await f.t.run((ctx) =>
      ctx.db.insert("vaultImportJobs", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        strategy: "merge",
        sourceFingerprint: "vault-isolation",
        totalFiles: 1,
        totalBytes: 3,
        totalBatches: 1,
        completedBatches: [],
        completedFiles: 0,
        createdFiles: 0,
        skippedFiles: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const calls: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) => as.action(api.functions.files.listFiles, { workspaceId, path: "" }),
      // `.obsidian/` is outside the privacy manifest entirely, so the plugin
      // inventory must establish ownership before its fixed read path opens.
      (workspaceId) =>
        as.action(api.functions.files.listObsidianPlugins, { workspaceId }),
      (workspaceId) =>
        as.action(api.functions.files.readNote, { workspaceId, path: "1-projects/shared.md" }),
      (workspaceId) =>
        as.action(api.functions.files.writeNote, {
          workspaceId,
          path: "1-projects/x.md",
          text: "x",
        }),
      // The separate, narrower door that writes plaintext over an encrypted
      // note — see `removeNoteEncryption` in `lib/fileOps.ts`. It reads
      // `privacy.md` and the target note exactly as `writeNote` does, so it
      // carries the same cross-tenant risk and needs the same refusal.
      (workspaceId) =>
        as.action(api.functions.files.removeNoteEncryption, {
          workspaceId,
          path: "1-projects/x.md",
          text: "x",
        }),
      (workspaceId) =>
        as.action(api.functions.files.importVaultBatch, {
          workspaceId,
          files: [{
            path: "imported.md",
            bytes: new TextEncoder().encode("# Imported\n").buffer,
            contentType: "text/markdown; charset=utf-8",
          }],
        }),
      (workspaceId) =>
        as.mutation(api.functions.files.startVaultImport, {
          workspaceId,
          strategy: "merge",
          sourceFingerprint: "vault-isolation",
          totalFiles: 1,
          totalBytes: 3,
          totalBatches: 1,
        }),
      (workspaceId) =>
        as.query(api.functions.files.latestVaultImportJob, { workspaceId }),
      (workspaceId) =>
        as.mutation(api.functions.files.pauseVaultImport, { workspaceId, jobId: importJobId }),
      (workspaceId) =>
        as.action(api.functions.files.importVaultJobBatch, {
          workspaceId,
          jobId: importJobId,
          sourceFingerprint: "vault-isolation",
          batchIndex: 0,
          files: [{
            path: "imported.md",
            bytes: new TextEncoder().encode("# Imported\n").buffer,
            contentType: "text/markdown; charset=utf-8",
          }],
        }),
      (workspaceId) =>
        as.action(api.functions.files.clearVaultImportBatch, {
          workspaceId,
          jobId: importJobId,
          sourceFingerprint: "vault-isolation",
        }),
      (workspaceId) =>
        as.action(api.functions.files.moveEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.copyEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.duplicateEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.archiveEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.createDirectory, { workspaceId, path: "a" }),
      (workspaceId) =>
        as.action(api.functions.files.deleteEntry, {
          workspaceId,
          path: "a.md",
          confirmation: DELETE_CONFIRMATION,
        }),
      (workspaceId) =>
        as.action(api.functions.files.setNoteVisibility, {
          workspaceId,
          path: "a.md",
          visibility: "team",
        }),
      (workspaceId) =>
        as.action(api.functions.files.setDirectoryVisibility, {
          workspaceId,
          path: "a",
          visibility: "team",
        }),
      // Search reaches the whole context by design, so it is the endpoint that
      // returns the most from one call: paths, titles and body snippets across
      // every folder. Stripping its `callerId` + `authorizeFileAccess` and
      // hardcoding `scope: "private"` left all 1,403 checks green before this
      // line existed — a stranger reading another tenant's bucket at OWNER
      // scope, invisible to the suite.
      (workspaceId) =>
        as.action(api.functions.files.searchContext, { workspaceId, query: "shared" }),
      // Reads the same index `searchContext` does, so it carries the same
      // cross-tenant risk: a stranger asking for another workspace's note
      // paths must get `WORKSPACE_NOT_FOUND`, never a real (even empty) list.
      (workspaceId) => as.action(api.functions.files.notePaths, { workspaceId }),
      // Counts and phase reveal less than a path, but the existence of a long
      // move is still activity in another tenant and therefore owner-only.
      (workspaceId) => as.query(api.functions.files.listDurableMoves, { workspaceId }),
      // Owner-only, and absent here since it was written. The one exit from a
      // broken `privacy.md`, so reaching it across tenants would rewrite
      // somebody else's access map to all-private.
      (workspaceId) => as.action(api.functions.files.resetPrivacy, { workspaceId }),
      // Owner-only, and a writer of `privacy.md` like the two visibility
      // setters beside it. The group name resolves against the workspace the
      // caller names, so reaching this across tenants would point somebody
      // else's note at a group — and the refusal has to come from the
      // workspace check ahead of that resolution, not from the group lookup,
      // or a stranger learns which names exist by the shape of the error.
      (workspaceId) =>
        as.action(api.functions.files.setNoteGroup, {
          workspaceId,
          path: "1-projects/shared.md",
          group: "@supa-leads",
        }),
    ];

    /**
     * The endpoints whose refusal is an ANSWER rather than an error.
     *
     * `searchContexts` takes a *list* of workspace ids and searches the ones
     * the caller may reach, so a workspace id it cannot use is dropped rather
     * than refused — `resolveScope` argues that out at length, and the short
     * version is that refusing would make the endpoint an oracle a hundred
     * guesses wide per request.
     *
     * Dropping is only safe if it is **indistinguishable**, which is a stronger
     * claim than "it does not throw" and needs its own assertion rather than a
     * line in the table above. So these are called the same two ways — with
     * another tenant's real id, and with an id that never existed — and the two
     * answers must be byte-identical. An endpoint that returned, say, a source
     * row for a real-but-forbidden context and none for a dangling one would
     * pass a test that only checked for an absence of results.
     *
     * They are held in their own list rather than excused from the coverage
     * check, because the check is what makes this file notice a new endpoint at
     * all: `searchContext` had no isolation test for a whole release because
     * nobody added a line, and an escape hatch spelled "skip these names" is
     * how that happens again.
     */
    const dropping: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) =>
        as.action(api.functions.files.searchContexts, {
          query: "shared",
          contexts: [workspaceId],
        }),
    ];

    // **The list above is checked against what Convex says is public, not
    // against what a regex can find in the source.**
    //
    // It was hand-maintained and went stale the way a hand-maintained list of
    // security-critical endpoints always does: `searchContext` arrived with
    // #154 and nobody added it here, so the endpoint that reaches furthest into
    // a bucket had no isolation check at all. `resetPrivacy` had been missing
    // since it was written.
    //
    // The first version of this guard grepped `^export const (\w+) = action\(`
    // out of the file, and `structure.test.ts` had already written down why
    // that is wrong — "a guard a rename defeats is not a guard". Measured, it
    // was defeated twice: a public `query` in this module was invisible to it
    // (a public existence oracle over any `workspaceId` sat in `files.ts` with
    // all 1,403 checks green), and so was an ordinary line break, since
    // `export const x =\n  action({` does not match. Nothing in CI reformats
    // `apps/convex`, so that is a live hole rather than a stylistic one.
    //
    // `isPublic` is Convex's own flag on the registered function. It does not
    // care about the builder, the line breaks, the name, or a type annotation.
    //
    // **`isHttp` is read too, and leaving it out was this guard's third hole.**
    // `httpActionGeneric` sets `isHttp` and neither `isPublic` nor `isInternal`
    // (convex/dist/esm/server/impl/registration_impl.js:245, against 124/172/210
    // for mutation/query/action), so an `httpAction` exported from this module
    // is invisible to an `isPublic` test. Measured: an unauthenticated
    // `GET /files/raw` listing any workspace's bucket at OWNER scope, routed for
    // real in `http.ts`, left all 1,403 checks green.
    //
    // `structure.test.ts` had already written this down — its `classify()`
    // returns `isPublic: true` for an `isHttp` function and calls it "the hole
    // this whole file exists to close, hiding in plain sight". An earlier
    // version of this comment claimed parity with that function while omitting
    // the one case it exists for.
    //
    // An `httpAction` can never appear in `covered`, because it is not reachable
    // through `api.`. So this makes the equality fail permanently the moment one
    // lands in `files.ts`, which is the intended outcome rather than a gap:
    // an HTTP route into file operations needs its own argument, in
    // `UNAUTHENTICATED_HTTP_ROUTES` or beside it, not a line in this table.
    //
    // **What it still does not cover, stated rather than implied:** a file
    // endpoint that lands in a different module. This reads `functions/files.ts`
    // alone, because the neighbouring modules have their own isolation stories
    // and sweeping them here would assert something this test has not thought
    // about. A new module of file endpoints needs its own entry, and no check
    // here will say so.
    const covered = new Set(
      [...calls, ...dropping].flatMap((call) =>
        [...call.toString().matchAll(/api\.functions\.files\.(\w+)/g)].map((m) => m[1]),
      ),
    );
    const publicEndpoints = Object.entries(fileFunctions)
      .filter(([, value]) => {
        const fn = value as { isPublic?: boolean; isHttp?: boolean } | null;
        return fn?.isPublic === true || fn?.isHttp === true;
      })
      .map(([name]) => name);
    expect(publicEndpoints.length).toBeGreaterThan(10);
    expect([...covered].sort()).toEqual([...publicEndpoints].sort());

    for (const call of calls) {
      const theirs = await captureError(() => call(f.workspaceId));
      const nowhere = await captureError(() => call(dangling));
      expect(errorCode(theirs)).toBe("WORKSPACE_NOT_FOUND");
      expect(errorShape(theirs)).toBe(errorShape(nowhere));
    }

    for (const call of dropping) {
      const theirs = await call(f.workspaceId);
      const nowhere = await call(dangling);
      // Byte-identical, and not merely both empty: the whole answer is
      // compared, so a source row, a count or a cursor that appeared for a real
      // context and not for an invented one would fail here.
      expect(JSON.stringify(theirs)).toBe(JSON.stringify(nowhere));
      // And nothing from the other tenant's bucket rode along. `shared` is a
      // word in it; `SECRET_BODY_MARKER` is in its private half.
      const rendered = JSON.stringify(theirs);
      expect(rendered).not.toContain("1-projects/shared.md");
      expect(rendered).not.toContain(SECRET_BODY_MARKER);
    }
  });

  test("and nothing in the other tenant's bucket was touched", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();
    await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        text: "# Vandalised\n",
      }),
    );
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("a signed-out caller is turned away before anything else happens", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      f.t.action(api.functions.files.listFiles, { workspaceId: f.workspaceId, path: "" }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

/* -------------------------------------------------------------------------- */
/*                                  conflicts                                 */
/* -------------------------------------------------------------------------- */

describe("a stale save is a conflict, never a silent overwrite", () => {
  test("the conflict reaches the client with the current etag", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const first = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
    });

    const error = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
      }),
    );
    expect(errorCode(error)).toBe("CONFLICT");
    const data = (error as { data: { currentEtag?: string; message: string } }).data;
    expect(data.currentEtag).toBeTruthy();
    expect(data.message).toMatch(/changed somewhere else/);
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Theirs\n");
  });

  test("a backend that ignores If-Match still reports it, and the write says how it was checked", async () => {
    const f = await fixture({ ignoreIfMatch: true, conditionalWrite: false });
    const as = asUser(f.t, f.owner);
    const first = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    const theirs = await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
    });
    expect(theirs.conflictCheck).toBe("read-compare");

    const error = await captureError(() =>
      as.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
      }),
    );
    expect(errorCode(error)).toBe("CONFLICT");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Theirs\n");
  });
});

/* -------------------------------------------------------------------------- */
/*                            deleting and archiving                          */
/* -------------------------------------------------------------------------- */

describe("permanent deletion is explicit", () => {
  test("the wrong confirmation changes nothing", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        confirmation: "yes",
      }),
    );
    expect(errorCode(error)).toBe("CONFIRMATION_REQUIRED");
    expect(f.backend.snapshot()["1-projects/shared.md"]).toBe("# Shared\n");
  });

  test("the right one deletes, and keeps nothing back", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
      confirmation: DELETE_CONFIRMATION,
    });
    const survivors = Object.values(f.backend.snapshot()).filter((body) =>
      body.includes(SECRET_BODY_MARKER),
    );
    expect(survivors).toEqual([]);
  });

  test("archiving is recoverable — the note is still in the bucket", async () => {
    const f = await fixture();
    const archived = await asUser(f.t, f.owner).action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
    });
    expect(f.backend.snapshot()[archived.to]).toContain(SECRET_BODY_MARKER);

    await asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: archived.to,
      to: "2-areas/private-note.md",
    });
    expect(f.backend.snapshot()["2-areas/private-note.md"]).toContain(SECRET_BODY_MARKER);
  });
});

/* -------------------------------------------------------------------------- */
/*                    note content never stays in the control plane           */
/* -------------------------------------------------------------------------- */

describe("note content never lands in the control plane", () => {
  /**
   * The sweep. Every document in every table, serialized, searched for the
   * marker — rather than checking the two tables we happen to think of, which
   * would pass on the day somebody adds a third.
   */
  async function everyStoredDocument(t: TestConvex): Promise<string> {
    return await t.run(async (ctx) => {
      const tables = [
        "names",
        "workspaces",
        "workspaceMembers",
        "storageBindings",
        "rateLimits",
        "oauthClients",
        "oauthGrants",
        "auditEvents",
      ] as const;
      const dump: Record<string, unknown[]> = {};
      for (const table of tables) {
        dump[table] = await ctx.db.query(table).collect();
      }
      return JSON.stringify(dump);
    });
  }

  test("after a full editing session, no table holds a byte of it", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const body = `# Sensitive\n\n${SECRET_BODY_MARKER}\n`;

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
      text: body,
    });
    const read = await as.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
    });
    // It really did come back — otherwise the sweep below proves nothing.
    expect(read.text).toContain(SECRET_BODY_MARKER);

    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: read.path,
      text: `${body}more\n`,
      expectedEtag: read.etag,
    });
    await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
    });
    await as.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/sensitive.md",
      to: "1-projects/moved-sensitive.md",
    });
    await as.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/moved-sensitive.md",
      visibility: "team",
    });
    await as.action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/moved-sensitive.md",
    });
    await as.action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "1-projects",
    });

    const dump = await everyStoredDocument(f.t);
    expect(dump).not.toContain(SECRET_BODY_MARKER);
    // The bucket, meanwhile, has it — which is the whole point.
    expect(JSON.stringify(f.backend.snapshot())).toContain(SECRET_BODY_MARKER);
  });

  test("the audit trail records paths and an outcome, and nothing else", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/sensitive.md",
      text: `# Sensitive\n\n${SECRET_BODY_MARKER}\n`,
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const write = events.find((event) => event.action === "file.create")!;
    expect(write).toBeDefined();
    expect(write.paths).toEqual(["1-projects/sensitive.md"]);
    expect(write.actorUserId).toBe(f.owner);
    expect(JSON.stringify(write.details ?? {})).not.toContain(SECRET_BODY_MARKER);
  });

  test("every write operation leaves an audit row naming the acting identity", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.editor);
    await share(f);
    await as.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/a.md",
      text: "# A\n",
    });
    await as.action(api.functions.files.duplicateEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/a.md",
    });
    await as.action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/a copy.md",
      confirmation: DELETE_CONFIRMATION,
    });

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    const actions = events.map((event) => event.action);
    expect(actions).toContain("file.create");
    expect(actions).toContain("file.duplicate");
    expect(actions).toContain("file.delete");
    for (const event of events.filter((e) => e.action.startsWith("file."))) {
      expect(event.actorUserId).toBe(f.editor);
    }
  });

  /**
   * A failure is the other way content escapes: an error that quotes what you
   * tried to save, stored on a row or shown in a toast, is the same leak with
   * a stack trace attached.
   */
  test("no failure message quotes the content that failed", async () => {
    const f = await fixture();
    const as = asUser(f.t, f.owner);
    const body = `# Sensitive\n\n${SECRET_BODY_MARKER}\n`;

    // A create over something that exists, a conflict, and a refused path —
    // three different failure shapes, all carrying the same body.
    const failures = [
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          text: body,
        }),
      ),
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: PRIVACY_KEY,
          text: body,
        }),
      ),
      await captureError(() =>
        as.action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: "1-projects/shared.md",
          text: body,
          expectedEtag: "not-the-real-etag",
        }),
      ),
    ];

    for (const failure of failures) {
      expect(JSON.stringify(failure)).not.toContain(SECRET_BODY_MARKER);
      expect(String((failure as Error).message ?? "")).not.toContain(SECRET_BODY_MARKER);
    }

    const dump = await everyStoredDocument(f.t);
    expect(dump).not.toContain(SECRET_BODY_MARKER);
  });

  /**
   * The other half of the same promise: the bucket credential the barrier
   * opens must not come back out either — not in a result, not in an error.
   */
  test("no bucket credential reaches the caller", async () => {
    const f = await fixture();
    const listing = await asUser(f.t, f.owner).action(api.functions.files.listFiles, {
      workspaceId: f.workspaceId,
      path: "",
    });
    expect(JSON.stringify(listing)).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(JSON.stringify(listing)).not.toContain(FAKE_STORAGE.accessKeyId);

    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "does-not-exist.md",
      }),
    );
    expect(JSON.stringify(failure)).not.toContain(FAKE_STORAGE.secretAccessKey);
  });

  test("a provider's own error text is not forwarded to the caller", async () => {
    const f = await fixture({
      readOnly: true,
      errorMessage: `signature mismatch for ${FAKE_STORAGE.accessKeyId}`,
    });
    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/nope.md",
        text: "# Nope\n",
      }),
    );
    expect(errorCode(failure)).toBe("STORAGE_FAILED");
    expect(JSON.stringify(failure)).not.toContain(FAKE_STORAGE.accessKeyId);
  });
});

/* -------------------------------------------------------------------------- */
/*                              no bucket connected                           */
/* -------------------------------------------------------------------------- */

describe("a context with no bucket says so", () => {
  test("listing reports that storage is not connected", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "unbound");
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.files.listFiles, { workspaceId, path: "" }),
    );
    expect(errorCode(error)).toBe("STORAGE_NOT_CONNECTED");
  });
});

describe("visibility is a clearance decision, and clearance belongs to the owner", () => {
  /**
   * The live breach, pinned. Seyi invited a test agent as an editor and
   * watched it flip his private folders to `team` — at which point it could
   * read everything in them. An editor changing visibility is an editor
   * deciding their own clearance; `resetPrivacy` had already written that
   * argument down and gated itself `owner`, while these two said `editor`.
   * The MCP gateway got it right from day one (`scope !== "private"` →
   * refused); the console actions are what this suite now holds to the same
   * rule.
   */
  test("an editor cannot widen a folder to team — the exact live attack", async () => {
    const f = await fixture();
    await share(f);

    const error = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.setDirectoryVisibility, {
        workspaceId: f.workspaceId,
        path: "2-areas",
        visibility: "team",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");

    // And the private note behind that folder stays unreadable: the attack's
    // payoff, not just its mechanism, is what must be absent.
    const read = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/shared.md",
      }),
    );
    expect(errorCode(read)).not.toBeNull();
  });

  test("an editor cannot change a note's visibility either — narrowing included", async () => {
    const f = await fixture();
    await share(f);
    // Narrowing is refused too: visibility writes rewrite privacy.md, and an
    // editor hiding a team note from other members is the same authority
    // exercised in the other direction.
    const error = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.files.setNoteVisibility, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        visibility: "private",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("the owner still can — this is a gate, not a removal", async () => {
    const f = await fixture();
    await share(f);
    const result = await asUser(f.t, f.owner).action(
      api.functions.files.setDirectoryVisibility,
      { workspaceId: f.workspaceId, path: "2-areas", visibility: "team" },
    );
    expect(result.visibility).toBe("team");
  });
});
