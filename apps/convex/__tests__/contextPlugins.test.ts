/**
 * THE CONTEXT-PLUGIN SWITCHES, THROUGH THE CONTROL PLANE.
 *
 * `apps/mcp/test/contextPlugins.test.mjs` proves the catalogue, the settings
 * file and the tool gate. This proves the things only this layer can get wrong,
 * and there are three:
 *
 *  1. **Who may work a switch.** Reading which features a context has is a
 *     member's — a member who cannot see it reports "the form isn't there" as a
 *     bug — and changing one is an owner's, because it changes what every
 *     connected client of every member can do.
 *  2. **Isolation.** A workspace somebody is not in must be indistinguishable
 *     from one that does not exist, on the read and on the write alike.
 *  3. **The bucket is the record.** The switch is a file in the customer's own
 *     storage, not a row here, so a write has to land there and a read has to
 *     come back from there — which is also what makes it survive an export.
 *
 * The whole path is real, as in `forms.test.ts`: the real actions, the real
 * `S3Store` doing real SigV4 against a `fetch` stub, the real catalogue and
 * resolver imported from the gateway. Only the socket is fake.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { CONTEXT_PLUGINS } from "../../mcp/src/plugins/catalog.js";
import { ENABLEMENT_KEY, parseEnablement } from "../../mcp/src/plugins/enablement.js";
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

const FORM_NOTE = "1-projects/feedback.md";
const RESPONSES = "1-projects/feedback-responses.md";

/** The smallest form that parses, so the switch has something real to refuse. */
const FORM_BLOCK = [
  "# Feedback",
  "",
  "```form",
  "id: bugs",
  `responses: ${RESPONSES}`,
  "layout: table",
  "submit: member",
  "edit_own: true",
  "votes: named",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "```",
].join("\n");

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(options: MemoryS3Options & { conditionalWrite?: boolean } = {}): Promise<Fixture> {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  await createWorkspace(t, owner, "ada");
  await createWorkspace(t, member, "alan");
  await createWorkspace(t, stranger, "edsger");

  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, member, "member", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
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
      capabilities: { conditionalWrite },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const f: Fixture = { t, owner, member, stranger, workspaceId, backend };
  /*
    A real form, written by the owner — which is also what creates its response
    file. `1-projects` has to be team-visible first for the same reason
    `forms.test.ts` makes it so: a form in a folder a member cannot see is a
    form they cannot answer.
  */
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  await asUser(t, owner).action(api.functions.files.writeNote, {
    workspaceId,
    path: FORM_NOTE,
    text: FORM_BLOCK,
  });
  return f;
}

function storedSettings(f: Fixture): string | undefined {
  return f.backend.snapshot()[ENABLEMENT_KEY];
}

describe("listing the built-ins", () => {
  test("an owner sees every plugin, on, before anything has been decided", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.contextPlugins.listPlugins, {
      workspaceId: f.workspaceId,
    });
    expect(result.plugins).toHaveLength(CONTEXT_PLUGINS.length);
    expect(result.plugins.every((plugin) => plugin.enabled)).toBe(true);
    expect(result.settingsError).toBeNull();
    expect(result.canManage).toBe(true);
    // Reading is a read. A context that has never touched this feature must not
    // acquire a settings file just because somebody opened the panel.
    expect(storedSettings(f)).toBeUndefined();
  });

  test("a member may read the list and is told they cannot change it", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.member).action(api.functions.contextPlugins.listPlugins, {
      workspaceId: f.workspaceId,
    });
    expect(result.plugins).toHaveLength(CONTEXT_PLUGINS.length);
    expect(result.canManage).toBe(false);
  });

  test("every row carries what turning it off would cost", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.contextPlugins.listPlugins, {
      workspaceId: f.workspaceId,
    });
    // The copy travels with the row rather than living in the console, so the
    // sentence beside a switch cannot go stale against the switch's behaviour.
    expect(result.plugins.every((plugin) => plugin.offMeans.length > 40)).toBe(true);
    expect(result.plugins.find((plugin) => plugin.id === "context-forms")?.tools).toContain(
      "submit_form",
    );
  });

  test("a workspace the caller is not in is indistinguishable from one that does not exist", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.contextPlugins.listPlugins, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a signed-out caller is refused before anything is looked up", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      f.t.action(api.functions.contextPlugins.listPlugins, { workspaceId: f.workspaceId }),
    );
    expect(errorCode(error)).toBe("UNAUTHENTICATED");
  });
});

describe("working a switch", () => {
  test("an owner turning one off writes the decision into the customer's bucket", async () => {
    const f = await fixture();
    const result = await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      workspaceId: f.workspaceId,
      pluginId: "context-meetings",
      enabled: false,
    });
    expect(result.plugins.find((plugin) => plugin.id === "context-meetings")?.enabled).toBe(false);
    expect(result.plugins.find((plugin) => plugin.id === "context-forms")?.enabled).toBe(true);

    /*
      The bucket, not a row here. This is the assertion that keeps the feature
      inside non-negotiable #1: a customer who takes this bucket elsewhere, or
      self-hosts the gateway at it, finds the context configured as they left
      it — and the gateway reads this same file with no control plane involved.
    */
    const parsed = parseEnablement(storedSettings(f) ?? "");
    expect(parsed.error).toBeNull();
    expect(parsed.decisions?.disabled).toEqual(["context-meetings"]);
  });

  test("and it is recorded against the person who did it", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      workspaceId: f.workspaceId,
      pluginId: "context-forms",
      enabled: false,
    });
    const events = await f.t.run((ctx) => ctx.db.query("auditEvents").collect());
    const entry = events.find((event) => event.action === "plugin.disabled");
    expect(entry?.actorUserId).toBe(f.owner);
    expect(entry?.details).toMatchObject({ pluginId: "context-forms" });
  });

  test("turning it back on leaves the file saying so rather than deleting the decision", async () => {
    const f = await fixture();
    const args = { workspaceId: f.workspaceId, pluginId: "context-forms" };
    await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      ...args,
      enabled: false,
    });
    const back = await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      ...args,
      enabled: true,
    });
    expect(back.plugins.find((plugin) => plugin.id === "context-forms")?.enabled).toBe(true);
    const parsed = parseEnablement(storedSettings(f) ?? "");
    expect(parsed.decisions?.enabled).toEqual(["context-forms"]);
    expect(parsed.decisions?.disabled).toEqual([]);
  });

  test("a member cannot work a switch, and is told which role can", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.contextPlugins.setPluginEnabled, {
        workspaceId: f.workspaceId,
        pluginId: "context-forms",
        enabled: false,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    // Refused before the bucket was touched: a role check that writes first and
    // asks afterwards is not a role check.
    expect(storedSettings(f)).toBeUndefined();
  });

  test("an outsider cannot switch anything, and learns nothing about the workspace", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.contextPlugins.setPluginEnabled, {
        workspaceId: f.workspaceId,
        pluginId: "context-forms",
        enabled: false,
      }),
    );
    // Not INSUFFICIENT_ROLE, which would confirm the workspace exists.
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    expect(storedSettings(f)).toBeUndefined();
  });

  test("an id this build does not have is refused rather than written", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
        workspaceId: f.workspaceId,
        pluginId: "../../privacy.md",
        enabled: false,
      }),
    );
    expect(error).toBeTruthy();
    expect(storedSettings(f)).toBeUndefined();
  });

  test("a settings file nobody can parse reads as the defaults, and says why", async () => {
    const f = await fixture();
    f.backend.seed(ENABLEMENT_KEY, "{ half a file");
    const result = await asUser(f.t, f.owner).action(api.functions.contextPlugins.listPlugins, {
      workspaceId: f.workspaceId,
    });
    // Every plugin on, and a reason on the panel. The alternative — a typo in a
    // preferences file taking a workspace's features away — is the failure this
    // fallback exists to prevent.
    expect(result.plugins.every((plugin) => plugin.enabled)).toBe(true);
    expect(result.settingsError).toBe("not valid JSON");
  });

  test("a store without conditional writes still records the decision", async () => {
    // B2 and Wasabi. `forms.md` refuses a submission on these because a lost
    // write destroys somebody's content; a lost preference does not.
    const f = await fixture({ conditionalWrite: false });
    await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      workspaceId: f.workspaceId,
      pluginId: "context-chats",
      enabled: false,
    });
    expect(parseEnablement(storedSettings(f) ?? "").decisions?.disabled).toEqual(["context-chats"]);
  });
});

describe("a switched-off plugin is off on every door, not only the gateway's", () => {
  /*
    The finding this block exists for, found reading the diff: the gateway
    refused `submit_form` while the console went on writing rows into the same
    response file, and the row said "the console refuses a submission too". A
    sentence beside a switch that the product does not keep is worse than no
    switch — it is the product lying at the moment somebody is deciding.

    So both doors, and both are checked here because the gateway's own suite
    cannot see this one.
  */
  test("the console refuses a form submission while forms are off", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      workspaceId: f.workspaceId,
      pluginId: "context-forms",
      enabled: false,
    });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        values: [{ field: "summary", value: "anything" }],
      }),
    );
    expect(errorCode(error)).toBe("PLUGIN_OFF");
    // Named, with the way back — "that could not be saved" for a setting the
    // reader themself chose is a refusal with no next step.
    expect(String((error as { data?: { message?: string } })?.data?.message)).toContain(
      "Markdown forms",
    );
  });

  test("with forms on, the console submits exactly as before", async () => {
    // The positive companion. Without it the gate could widen onto every form
    // action in every context and still pass the refusal above.
    const f = await fixture();
    const submitted = await asUser(f.t, f.owner).action(api.functions.forms.submitForm, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      values: [{ field: "summary", value: "it works" }],
    });
    expect(submitted.responseId).toBeTruthy();
  });

  test("the switch never reaches past what its row promises", async () => {
    /*
      Two doors this deliberately does NOT close, each found by reading the diff
      rather than by a failing test.

      `writeImage` is the share-card renderer, not an upload anybody performs —
      gating it on the Images plugin would have made an owner turning off an
      agent's `read_image` silently break their own share links.

      `readImage` is content that is already there. A switch removes a
      capability; it must never start hiding what a person already has.
    */
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.contextPlugins.setPluginEnabled, {
      workspaceId: f.workspaceId,
      pluginId: "context-images",
      enabled: false,
    });
    const note = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "index.md",
    });
    expect(note).toBeTruthy();
  });
});
