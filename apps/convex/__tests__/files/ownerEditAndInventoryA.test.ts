import { describe, expect, test, vi } from "vitest";
import { isLogicalDeleteMarker } from "../../../mcp/src/store/logicalDelete.js";
import { api } from "../../_generated/api";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  Fixture,
  fixture,
  share,
  errorShape,
  danglingWorkspaceId,
} from "./fixtures.helpers";

describe("an owner can edit their context", () => {
  test("migrates only reserved system objects and leaves notes untouched", async () => {
    const f = await fixture();
    f.backend.seed(".audit/legacy-events.jsonl", "legacy audit");
    const notesBefore = Object.fromEntries(
      Object.entries(f.backend.snapshot()).filter(([key]) => !key.startsWith(".")),
    );

    const result = await asUser(f.t, f.owner).action(
      api.functions.files.updateStorageLayout,
      { workspaceId: f.workspaceId },
    );

    expect(result.state).toBe("copying");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (f.backend.snapshot()[".context/audit/legacy-events.jsonl"] !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
      await f.t.finishInProgressScheduledFunctions();
    }
    expect(f.backend.snapshot()[".context/audit/legacy-events.jsonl"]).toBe("legacy audit");
    expect(f.backend.snapshot()[".audit/legacy-events.jsonl"]).toBe("legacy audit");
    expect(
      Object.fromEntries(
        Object.entries(f.backend.snapshot()).filter(([key]) => !key.startsWith(".")),
      ),
    ).toEqual(notesBefore);

    const events = await asUser(f.t, f.owner).query(api.functions.audit.listEvents, {
      workspaceId: f.workspaceId,
    });
    expect(
      events.find((event) => event.action === "storage.layout_migration_requested")?.paths,
    ).toEqual([]);

    /*
      AND THE OUTCOME IS WRITTEN SOMEWHERE A QUERY CAN READ IT.

      The bucket has always known — `migrateStorageLayout` keeps its state
      under `.context/` and short-circuits on `complete`. Nothing outside it
      did, so the console could not tell a bucket that still needs this from
      one migrated last week, and the offer was answered by a flag on one
      device: it came back on the next browser, for a workspace already
      migrated. This is the half that travels with the workspace.
    */
    const binding = await asUser(f.t, f.owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId: f.workspaceId },
    );
    // Whatever the passes above reached — the point is that the row is no
    // longer silent, not which of the six words it landed on.
    expect(binding?.storageLayoutState).toBeDefined();
    expect(binding?.storageLayoutAt).toBeGreaterThan(0);
  });

  /**
   * Let the observation the mutation queued actually run, and hand back what
   * it recorded.
   *
   * `observeStorageLayout` schedules rather than probes — a public function
   * that opened a credential would have `runFileOperation` in its own call
   * graph — so the answer arrives a scheduler hop later and the binding is
   * where it lands. Polled rather than slept on: the hop is immediate in
   * practice, and a fixed sleep is how this file would get slow.
   */
  async function observedLayout(f: Fixture): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await f.t.finishInProgressScheduledFunctions();
      const checked = await f.t.run(async (ctx) =>
        (
          await ctx.db
            .query("storageBindings")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
            .unique()
        )?.storageLayoutCheckedAt,
      );
      // `t.run`'s result crosses a serialization boundary, where an absent
      // optional field arrives as `null` rather than `undefined`.
      if (typeof checked === "number") return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /*
    AND A BUCKET THAT WAS BORN ON THE LAYOUT IS TOLD SO, HAVING RUN NOTHING.

    This is the whole chain the owner's console runs on its first load —
    mutation, scheduler, file operation, the gateway's own read, the recorded
    answer — for the case that used to come out wrong. "No migration state
    file" was read as "nobody has migrated this", which is true of a context we
    scaffolded ourselves and beside the point: it has never held a `.audit/` or
    a `.history/`, so there has never been anything here to migrate. Every new
    workspace was offered a one-time storage update minutes after it was
    created.

    The fixture's bucket is exactly that bucket: notes, `index.md`,
    `privacy.md`, and no plumbing of any generation.
  */
  test("a bucket born on the layout answers 'already current', having run nothing", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();

    expect(
      await asUser(f.t, f.owner).mutation(api.functions.storage.observeStorageLayout, {
        workspaceId: f.workspaceId,
      }),
    ).toEqual({ queued: true });
    await observedLayout(f);

    const binding = await asUser(f.t, f.owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId: f.workspaceId },
    );
    expect(binding?.storageLayoutState).toBe("complete");
    // Asking is a question, not a checkpoint: nothing was copied, written or
    // deleted to find that out.
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("and one with pre-v1 plumbing in it still has the migration to run", async () => {
    /*
      The sabotage guard for the case above. Answering `complete` for a bucket
      that still holds legacy objects retires the offer with work behind it —
      pre-v1 plumbing left where no screen mentions it, dual reads carrying it
      for ever, and nothing anywhere saying so.
    */
    const f = await fixture();
    f.backend.seed(".history/1-projects/shared.md.2026-01-01.md", "an old version");

    await asUser(f.t, f.owner).mutation(api.functions.storage.observeStorageLayout, {
      workspaceId: f.workspaceId,
    });
    await observedLayout(f);

    const binding = await asUser(f.t, f.owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId: f.workspaceId },
    );
    expect(binding?.storageLayoutState).toBeUndefined();
    // Asked, though — which is what tells the console this is the real "nobody
    // has run it" rather than a question nobody has put.
    expect(binding?.storageLayoutCheckedAt).toBeGreaterThan(0);
  });

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
    // The placeholder, named for the prefix it holds open. Its wording is
    // `fileOps.test.ts`'s to pin; what this end-to-end path checks is that the
    // action wrote the key at all.
    expect(created.readme).toBe("1-projects/plans/README.md");
    expect(f.backend.snapshot()[created.readme]).toContain("Folder placeholder.");
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

  /*
    THE BUG THIS ANSWERS, STATED AS A SCENARIO.

    Install a plugin. Close the app. Open it again. Until this existed the
    plugins pane rested at "Read the plugins in this bucket" and the registry
    beside it, with no inventory to compare against, offered Install on the row
    that was already installed — so it got installed again, and the report that
    came back was "installs do not persist". They always had; nothing ever read
    them back without being asked.

    So the property is not "the pointer is in the bucket" — the install test
    below already proves that. It is that the question can be ANSWERED without
    running the scan, because the scan is what nobody had run.
  */
  test("what is installed can be read back without running a scan", async () => {
    const f = await fixture();
    f.backend.seed(
      ".context/plugins/virtual-linker/current.json",
      JSON.stringify({ id: "virtual-linker", version: "1.0.0", repository: "example/virtual-linker" }),
    );
    f.backend.seed(
      ".context/plugins/virtual-linker/releases/1.0.0/manifest.json",
      JSON.stringify({ id: "virtual-linker", name: "Virtual Linker", version: "1.0.0" }),
    );
    f.backend.seed(
      ".context/plugins/virtual-linker/releases/1.0.0/main.js",
      'const { Plugin } = require("obsidian"); class V extends Plugin {}',
    );
    // Somebody else's plugin, in the directory Context reads and never writes.
    // It is not something Context installed and must not be reported as one.
    f.backend.seed(
      ".obsidian/plugins/dataview/manifest.json",
      JSON.stringify({ id: "dataview", name: "Dataview", version: "0.5.0" }),
    );
    f.backend.seed(".obsidian/plugins/dataview/main.js", "module.exports = class {};");

    const installed = await asUser(f.t, f.owner).action(api.functions.files.listManagedPlugins, {
      workspaceId: f.workspaceId,
    });
    expect(installed.available).toBe(true);
    expect(installed.installs).toEqual([
      { id: "virtual-linker", version: "1.0.0", repository: "example/virtual-linker" },
    ]);

    // Owner-only, and a non-member cannot tell this context from one that does
    // not exist — the same shape `listObsidianPlugins` keeps two tests up.
    const missingId = await danglingWorkspaceId(f.t);
    const stranger = asUser(f.t, f.stranger);
    const existingError = await captureError(() => stranger.action(
      api.functions.files.listManagedPlugins,
      { workspaceId: f.workspaceId },
    ));
    const missingError = await captureError(() => stranger.action(
      api.functions.files.listManagedPlugins,
      { workspaceId: missingId },
    ));
    expect(errorShape(existingError)).toBe(errorShape(missingError));
    expect(errorCode(existingError)).toBe("WORKSPACE_NOT_FOUND");
    const memberError = await captureError(() => asUser(f.t, f.editor).action(
      api.functions.files.listManagedPlugins,
      { workspaceId: f.workspaceId },
    ));
    expect(errorCode(memberError)).toBe("INSUFFICIENT_ROLE");
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
    const bindingId = await f.t.run(async (ctx) => (await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique())!._id);
    await f.t.run((ctx) => ctx.db.patch(bindingId, {
      capabilities: { conditionalWrite: true, conditionalCreate: false, conditionalDelete: true },
    }));
    const failedUpdate = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.installCommunityPlugin,
      { workspaceId: f.workspaceId, pluginId: "virtual-linker" },
    ));
    expect(errorCode(failedUpdate)).toBe("STORAGE_UNSAFE");
    expect((await asUser(f.t, f.owner).query(api.functions.obsidianPlugins.listPluginGrants, {
      workspaceId: f.workspaceId,
    }))[0].status).toBe("revoked");
    const revokedSession = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken: loaded.runtimeToken,
        request: {
          version: 1,
          requestId: "after_failed_update",
          operation: { kind: "vault.read", path: "1-projects/shared.md" },
        },
      },
    ));
    expect(errorCode(revokedSession)).toBe("PLUGIN_SESSION_INVALID");
    await f.t.run((ctx) => ctx.db.patch(bindingId, {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    }));
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
    expect(isLogicalDeleteMarker(
      f.backend.snapshot()[".context/plugins/virtual-linker/current.json"],
    )).toBe(true);
    expect(f.backend.snapshot()).toHaveProperty(
      ".context/plugins/virtual-linker/releases/1.1.0/main.js",
    );
    expect(f.backend.snapshot()).toHaveProperty(".obsidian/plugins/virtual-linker/main.js");
  });

});
