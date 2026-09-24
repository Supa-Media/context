import { describe, expect, test, vi } from "vitest";
import {
  api,
  internal,
} from "../../_generated/api";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  SECRET_BODY_MARKER,
  fixture,
} from "./fixtures";

describe('Obsidian plugin inventory', () => {
  /**
   * `metadata:read` MEANS METADATA, WHICH IS WHAT THE CONSENT SCREEN PROMISED.
   *
   * The approval dialog offers two separate rows, and a person is asked to
   * decide on each:
   *
   *   vault:read      "Read your notes — open the Markdown of any note in this
   *                    context that you can see."
   *   metadata:read   "Read links and tags — frontmatter, headings, tags and
   *                    the links between notes."
   *
   * The second is offered as the *lesser* of the two, and somebody who grants
   * it while declining the first has said, in as many words, that this plugin
   * may not read their notes. So the test is not "does `metadata.get` work" —
   * it is whether the distinction the person was shown is the distinction the
   * gateway enforces.
   *
   * `metadata.get` resolves to a full `read` of the note and shapes the
   * response with `extractFields`, whose fields are `title`, `headings`,
   * `tags`, `links` — and `body`, which is the whole note minus its
   * frontmatter and heading lines. Spread into the response, that hands the
   * Markdown to a grant that was explicitly refused it.
   *
   * SABOTAGE: restore `body` to the `metadata.get` response and the marker
   * assertion below reddens on its own; the shape assertion stays green, which
   * is why both are here.
   */
  test("a plugin granted metadata:read and refused vault:read cannot read a note's body", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/tagwrangler/manifest.json",
      JSON.stringify({ id: "tagwrangler", name: "Tag Wrangler", version: "0.5.0" }),
    );
    f.backend.seed(
      ".obsidian/plugins/tagwrangler/main.js",
      'const { Plugin } = require("obsidian"); class TagWrangler extends Plugin {}',
    );
    const inventory = await asUser(f.t, f.owner).action(
      api.functions.files.listObsidianPlugins,
      { workspaceId: f.workspaceId },
    );
    const fingerprint = inventory.plugins[0].bundleFingerprint!;

    // The whole point: metadata:read alone. No vault:read.
    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.approvePlugin, {
      workspaceId: f.workspaceId,
      pluginId: "tagwrangler",
      bundleFingerprint: fingerprint,
      capabilities: ["metadata:read"],
      networkHosts: [],
    });
    const { runtimeToken } = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.loadPluginBundle,
      { workspaceId: f.workspaceId, pluginId: "tagwrangler", bundleFingerprint: fingerprint },
    );

    // Reading the note outright is refused, which is the grant working.
    const refused = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "read_denied",
          operation: { kind: "vault.read", path: "2-areas/private-note.md" },
        },
      },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "CAPABILITY_DENIED" } });

    const metadata = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken,
        request: {
          version: 1,
          requestId: "metadata_1",
          operation: { kind: "metadata.get", path: "2-areas/private-note.md" },
        },
      },
    );
    expect(metadata).toMatchObject({ ok: true });

    // The note's body must not have come back by the other door.
    expect(JSON.stringify(metadata)).not.toContain(SECRET_BODY_MARKER);

    // And the metadata the capability *does* promise is still delivered, so
    // this is a narrowing rather than a removal. Stated as an exact key set:
    // a future field is a decision somebody makes here, not one that arrives.
    const result = (metadata as { result: Record<string, unknown> }).result;
    expect(Object.keys(result).sort()).toEqual(
      ["etag", "headings", "links", "path", "tags", "title"],
    );
    expect(result.title).toBe("Private");
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

  test("network authority is limited to reviewed hosts and every hop uses public-only egress", async () => {
    const f = await fixture();
    f.backend.seed(
      ".obsidian/plugins/web/manifest.json",
      JSON.stringify({ id: "web", name: "Web", version: "1.0.0" }),
    );
    f.backend.seed(
      ".obsidian/plugins/web/main.js",
      'requestUrl("https://api.example.com/items"); requestUrl("https://redirect.example/items")',
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

    expect(await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.pluginRuntimeCapabilities,
      { workspaceId: f.workspaceId },
    )).toEqual({ egress: false });
    vi.stubEnv("PLUGIN_EGRESS_URL", "https://egress.example.invalid");
    expect(await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.pluginRuntimeCapabilities,
      { workspaceId: f.workspaceId },
    )).toEqual({ egress: false });
    vi.unstubAllEnvs();

    const unavailable = await captureError(() => asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "web",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read", "network:request"],
        networkHosts: ["API.EXAMPLE.COM"],
      },
    ));
    expect(errorCode(unavailable)).toBe("NETWORK_EGRESS_UNAVAILABLE");

    vi.stubEnv("PLUGIN_EGRESS_URL", "https://egress.example.invalid");
    vi.stubEnv("PLUGIN_EGRESS_SECRET", "test-egress-secret");
    expect(await asUser(f.t, f.owner).query(
      api.functions.obsidianPlugins.pluginRuntimeCapabilities,
      { workspaceId: f.workspaceId },
    )).toEqual({ egress: true });

    const storageFetch = f.backend.fetchImpl;
    const egressCalls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      if (url.hostname !== "egress.example.invalid") return await storageFetch(input, init);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-egress-secret");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      egressCalls.push(request);
      expect(request).not.toHaveProperty("workspaceId");
      expect(request).not.toHaveProperty("pluginId");
      if (request.url === "https://api.example.com/redirect") {
        return Response.json({
          ok: true,
          status: 302,
          headers: [{ name: "location", value: "https://redirect.example/private" }],
          bodyBase64: "",
        });
      }
      if (request.url === "https://redirect.example/private") {
        return Response.json({
          ok: false,
          error: { code: "NETWORK_PRIVATE_ADDRESS_DENIED", message: "private" },
        }, { status: 403 });
      }
      return Response.json({
        ok: true,
        status: 200,
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "set-cookie", value: "must-not-cross" },
        ],
        bodyBase64: btoa("{\"ok\":true}"),
      });
    });

    const approved = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.approvePlugin,
      {
        workspaceId: f.workspaceId,
        pluginId: "web",
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read", "network:request"],
        networkHosts: ["api.example.com", "redirect.example"],
      },
    );
    expect(approved.networkHosts).toEqual(["api.example.com", "redirect.example"]);
    const loaded = await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.loadPluginBundle, {
      workspaceId: f.workspaceId,
      pluginId: "web",
      bundleFingerprint: fingerprint,
    });
    const success = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken: loaded.runtimeToken,
        request: {
          version: 1,
          requestId: "network_ok",
          operation: { kind: "network.request", url: "https://api.example.com/items", method: "GET", headers: [] },
        },
      },
    );
    expect(success).toMatchObject({ ok: true, result: { status: 200 } });
    if (!success.ok) throw new Error("network request should succeed");
    expect((success.result as { bodyBase64: string }).bodyBase64)
      .toBe(btoa('{"ok":true}'));
    expect(success.result).not.toHaveProperty("body");
    expect((success.result as { headers: Array<{ name: string }> }).headers)
      .not.toContainEqual(expect.objectContaining({ name: "set-cookie" }));

    const deniedHost = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken: loaded.runtimeToken,
        request: {
          version: 1,
          requestId: "network_denied_host",
          operation: { kind: "network.request", url: "https://evil.example/items", method: "GET", headers: [] },
        },
      },
    );
    expect(deniedHost).toMatchObject({ ok: false, error: { code: "NETWORK_HOST_DENIED" } });

    const privateRedirect = await asUser(f.t, f.owner).action(
      api.functions.obsidianPlugins.executePluginRequest,
      {
        runtimeToken: loaded.runtimeToken,
        request: {
          version: 1,
          requestId: "network_private_redirect",
          operation: { kind: "network.request", url: "https://api.example.com/redirect", method: "GET", headers: [] },
        },
      },
    );
    expect(privateRedirect).toMatchObject({
      ok: false,
      error: { code: "NETWORK_PRIVATE_ADDRESS_DENIED" },
    });
    expect(egressCalls.map((call) => call.url)).toEqual([
      "https://api.example.com/items",
      "https://api.example.com/redirect",
      "https://redirect.example/private",
    ]);
  });

  test("a lifecycle generation prevents review and runtime issuance from racing bundle changes", async () => {
    const f = await fixture();
    const pluginId = "race-safe";
    const fingerprint = "v2:reviewed-bundle";
    const reviewedGeneration = await f.t.query(
      internal.functions.obsidianPlugins.snapshotLifecycle,
      { workspaceId: f.workspaceId, pluginId },
    );
    expect(reviewedGeneration).toBe(0);

    const generation = await f.t.mutation(internal.functions.obsidianPlugins.recordLifecycle, {
      workspaceId: f.workspaceId,
      actorUserId: f.owner,
      pluginId,
      version: "1.0.0",
      action: "installing",
    });
    const staleReview = await captureError(() => f.t.mutation(
      internal.functions.obsidianPlugins.persistGrant,
      {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        pluginId,
        bundleFingerprint: fingerprint,
        capabilities: ["vault:read"],
        networkHosts: [],
        expectedLifecycleGeneration: reviewedGeneration,
      },
    ));
    expect(errorCode(staleReview)).toBe("PLUGIN_LIFECYCLE_CHANGED");
    const midLifecycleReview = await captureError(() => f.t.query(
      internal.functions.obsidianPlugins.snapshotLifecycle,
      { workspaceId: f.workspaceId, pluginId },
    ));
    expect(errorCode(midLifecycleReview)).toBe("PLUGIN_LIFECYCLE_BUSY");

    await asUser(f.t, f.owner).action(api.functions.obsidianPlugins.recoverPluginLifecycle, {
      workspaceId: f.workspaceId,
      pluginId,
      confirmation: "RECOVER_PLUGIN",
    });
    const staleWriter = await captureError(() => f.t.action(
      internal.functions.files.runFileOperation,
      {
        workspaceId: f.workspaceId,
        scope: "private",
        operation: {
          kind: "pluginManagedInstall",
          pluginId,
          version: "1.0.0",
          repository: "example/race-safe",
          manifestJson: JSON.stringify({ id: pluginId, version: "1.0.0" }),
          mainJs: "class RaceSafe {}",
          stylesCss: null,
          lifecycleGeneration: generation,
        },
      },
    ));
    expect(errorCode(staleWriter)).toBe("CONFLICT");
    expect(await f.t.query(internal.functions.obsidianPlugins.snapshotLifecycle, {
      workspaceId: f.workspaceId,
      pluginId,
    })).toBe(generation + 1);
    expect(f.backend.snapshot()[".context/plugins/race-safe/current.json"]).toContain(
      `"lifecycleGeneration":${generation + 1}`,
    );
  });
});

