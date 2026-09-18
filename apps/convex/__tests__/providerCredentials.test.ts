import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { decryptSecret, requireKeyset } from "../functions/lib/crypto";

/**
 * A PROVIDER KEY THAT NEVER APPEARS ANYWHERE BUT THE ONE PLACE IT MUST.
 *
 * The agent spends somebody's own Anthropic or OpenAI account, so the control
 * plane holds their API key. Non-negotiable #1 governs it exactly as it
 * governs a storage credential: encrypted at rest, never in Markdown, never in
 * a bucket, never in a log, never in a URL, never on a device.
 *
 * ## Why the error paths are tested harder than the happy path
 *
 * "Never in a log" is not hypothetical here — this repository shipped it.
 * #661 added a fourth key to `storageBindings.capabilities` while two routes
 * in `controlPlane.ts` restated the capability shape inline. `v.object` is
 * exact, so `openStorageBinding`'s own `returns` validator refused the answer
 * it had just built and Convex threw `ReturnsValidationError`.
 *
 * The outage was the headline and the fix was the shape. But look at what that
 * validator carries: `s3BindingValidator` has `secretAccessKey: v.string()`,
 * because the gateway signs with it. A validation error names the value it
 * rejected, so the object serialized into the production function logs
 * **with a live R2 secret and a D1 API token in it.**
 *
 * That is a whole class of bug — an error path that serializes the object it
 * is complaining about — and no happy-path test sees it. Every test below that
 * drives a failure exists because of it, and they all ask the same question:
 * with the key in hand and something going wrong, does the key get out?
 *
 * `SENTINEL` is searched for as a substring across everything reachable —
 * the thrown value, its message, its stack, the audit trail, every stored row,
 * and every client-callable answer. A fragment counts as a leak, which is why
 * it is a long distinctive string rather than a realistic-looking key.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `fingerprintOf` changed to `apiKey.slice(-8)` — the "show the last few
 *     characters" convention every provider's own console uses.
 *     → **2 fail**: `what is stored is an envelope and a hash, never the key`
 *     and `the key is not in what the console can read`. `appSecrets` already
 *     made this call — "a hash, not a prefix: what appears in a screenshot is
 *     not a fragment of the real value" — and this is that rule applied to a
 *     credential somebody else issued.
 *  2. `connectProvider` re-throwing as `new Error(\`bad key ${args.apiKey}\`)`,
 *     which is #661's mistake written by hand.
 *     → **1 fails**: `a failure with the key in hand does not carry it out`.
 *     Nothing else in the suite notices — the happy path still passes.
 *  3. The plaintext threaded into `writeCredential` and put in the audit row.
 *     → **1 fails**: `the audit trail records that it happened, not what it
 *     was`. Worth recording that this took three edits rather than one:
 *     `writeCredential` never receives the key at all — the action encrypts
 *     and passes an envelope — so the mutation that writes the audit row is
 *     structurally unable to log it. That is a better guarantee than the test,
 *     and the test is what stops somebody restoring the argument.
 *  4. `credentialRow` finding the row by provider alone, ignoring the
 *     workspace.
 *     → **1 fails**: `one workspace cannot open another's credential`.
 *  5. `encryptSecret` given `{ platform: "integration" }` instead of the
 *     workspace, so every envelope opens under one AAD.
 *     → **3 fail**: `the envelope really is the key, opened under its own
 *     workspace`, `the gateway's own route is the one place the key appears`
 *     and `connecting twice replaces rather than accumulates`.
 *
 *     The first draft of this entry claimed `an envelope does not open under
 *     another workspace` would fail, and it does not: that test calls
 *     `decryptSecret` directly, so it characterises the crypto module's AAD
 *     rather than anything this file decides. It is kept because the guarantee
 *     is worth stating where somebody will read it, but it is not evidence
 *     about this module and is no longer described as if it were.
 */

/**
 * Long, distinctive, and shaped like nothing else in the suite.
 *
 * A realistic `sk-ant-…` would share a prefix with fixtures elsewhere and a
 * substring search would go off on the wrong thing; this cannot collide.
 */
const SENTINEL = "zarquon-plumbago-9471-not-a-real-key-and-never-was";

/** Everything a thrown value can carry, flattened for one substring search. */
function spill(error: unknown): string {
  const parts = [String(error)];
  if (error instanceof Error) {
    parts.push(error.message, error.stack ?? "");
  }
  try {
    parts.push(JSON.stringify(error));
  } catch {
    // A value that will not serialize cannot carry the key into a log either.
  }
  try {
    parts.push(JSON.stringify(Object.getOwnPropertyNames(error).map((k) => (error as never)[k])));
  } catch {
    // Same.
  }
  return parts.join("\n");
}

async function connectedWorkspace(t: ReturnType<typeof setupTest>) {
  const ownerId = await createUser(t, "owner@example.com");
  const workspaceId = await createWorkspace(t, ownerId, "seyi");
  await asUser(t, ownerId).action(api.functions.providers.connectProvider, {
    workspaceId,
    provider: "anthropic",
    apiKey: SENTINEL,
  });
  return { ownerId, workspaceId };
}

describe("what is stored", () => {
  test("what is stored is an envelope and a hash, never the key", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(row.encryptedApiKey).not.toContain(SENTINEL);
    // A hash of the whole key, so a screenshot of the console shows nothing
    // that is part of the real value — `appSecrets` makes the same call.
    expect(row.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(SENTINEL).not.toContain(row.fingerprint);
    expect(row.workspaceId).toBe(workspaceId);
  });

  test("the envelope really is the key, opened under its own workspace", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const row = await t.run(
      async (ctx) => (await ctx.db.query("providerCredentials").collect())[0]!,
    );
    const opened = await decryptSecret(row.encryptedApiKey, requireKeyset(), { workspaceId });

    expect(opened).toBe(SENTINEL);
  });

  test("an envelope does not open under another workspace", async () => {
    /*
      The AAD is the whole of what makes a stolen envelope useless in another
      tenant, so it is asserted directly rather than inferred from the route
      that happens to use it today.
    */
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);
    const otherId = await createUser(t, "other@example.com");
    const otherWorkspace = await createWorkspace(t, otherId, "supa");

    const row = await t.run(
      async (ctx) => (await ctx.db.query("providerCredentials").collect())[0]!,
    );
    expect(row.workspaceId).toBe(workspaceId);

    await expect(
      decryptSecret(row.encryptedApiKey, requireKeyset(), { workspaceId: otherWorkspace }),
    ).rejects.toThrow();
  });
});

describe("what comes back out", () => {
  test("the key is not in what the console can read", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    const listed = await asUser(t, ownerId).query(api.functions.providers.listProviders, {
      workspaceId,
    });

    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider).toBe("anthropic");
    expect(listed[0]!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the gateway's own route is the one place the key appears", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const opened = await t.action(internal.functions.providers.openProviderCredential, {
      workspaceId,
      provider: "anthropic",
    });

    expect(opened?.apiKey).toBe(SENTINEL);
  });

  test("one workspace cannot open another's credential", async () => {
    const t = setupTest();
    await connectedWorkspace(t);
    const otherId = await createUser(t, "other@example.com");
    const otherWorkspace = await createWorkspace(t, otherId, "supa");

    const opened = await t.action(internal.functions.providers.openProviderCredential, {
      workspaceId: otherWorkspace,
      provider: "anthropic",
    });

    expect(opened).toBeNull();
  });

  test("the audit trail records that it happened, not what it was", async () => {
    const t = setupTest();
    await connectedWorkspace(t);

    const events = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(events.some((e) => e.action === "agent.provider.connected")).toBe(true);
  });
});

describe("the error paths, which are where #661 happened", () => {
  test("a failure with the key in hand does not carry it out", async () => {
    /*
      Every one of these reaches the action with the key already in `args` and
      then goes wrong. That is the shape of the production incident: not a
      route that returns a secret, but a route that *fails* while holding one
      and serializes what it was holding.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const strangerId = await createUser(t, "stranger@example.com");
    const memberId = await createUser(t, "member@example.com");
    await addMember(t, workspaceId, memberId, "member");

    const failures: Array<[string, () => Promise<unknown>]> = [
      [
        "a workspace the caller is not in",
        () =>
          asUser(t, strangerId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
      [
        "a role that may not write",
        () =>
          asUser(t, memberId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
      [
        "a provider this build does not know",
        () =>
          asUser(t, ownerId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "hal9000",
            apiKey: SENTINEL,
          }),
      ],
      [
        "nobody signed in",
        () =>
          t.action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
    ];

    for (const [name, run] of failures) {
      const error = await captureError(run);
      expect(error, `${name} should have failed`).toBeDefined();
      expect(spill(error), `${name} leaked the key`).not.toContain(SENTINEL);
    }
  });

  test("a refused key is refused without being quoted back", async () => {
    /*
      The most tempting place to print a secret is the message explaining why
      it was no good. "Expected a key starting with sk-, got <the key>" is how
      that gets written, and it is one careless line from the same outcome.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const error = await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: `   ${SENTINEL}\n`,
      }),
    );

    expect(error).toBeDefined();
    expect(errorCode(error)).toBe("INVALID_PROVIDER_KEY");
    expect(spill(error)).not.toContain(SENTINEL);
  });

  test("nothing is stored when the key is refused", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: "",
      }),
    );

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("who may change it", () => {
  test("a member may not connect a provider", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const memberId = await createUser(t, "member@example.com");
    await addMember(t, workspaceId, memberId, "member");

    const error = await captureError(() =>
      asUser(t, memberId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: SENTINEL,
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("an OpenAI-compatible endpoint is not connectable yet, and that is deliberate", async () => {
    /*
      `compatible` needs a customer-supplied base URL, and a URL the gateway
      attaches somebody's key to is an exfiltration route in a shared workspace
      and an SSRF everywhere else. `storage.ts` refuses loopback and
      private-network addresses for a bucket endpoint and those guards are
      private to it; borrowing them is a refactor of a security surface, and
      the request this URL would feed does not exist yet.

      So the provider is absent rather than half-validated, and this test is
      what makes adding it back a deliberate act with a diff to review.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const error = await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "compatible",
        apiKey: SENTINEL,
      }),
    );

    expect(errorCode(error)).toBe("UNKNOWN_PROVIDER");
    expect(spill(error)).not.toContain(SENTINEL);
  });

  test("a stranger cannot read which providers are connected", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);
    const strangerId = await createUser(t, "stranger@example.com");

    const error = await captureError(() =>
      asUser(t, strangerId).query(api.functions.providers.listProviders, { workspaceId }),
    );

    expect(error).toBeDefined();
  });

  test("disconnecting removes the row and says so in the audit trail", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    await asUser(t, ownerId).mutation(api.functions.providers.disconnectProvider, {
      workspaceId,
      provider: "anthropic",
    });

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(0);

    const events = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(events.some((e) => e.action === "agent.provider.disconnected")).toBe(true);
  });

  test("connecting twice replaces rather than accumulates", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    await asUser(t, ownerId).action(api.functions.providers.connectProvider, {
      workspaceId,
      provider: "anthropic",
      apiKey: "a-second-key-entirely-different-from-the-first-one",
    });

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(1);

    const opened = await t.action(internal.functions.providers.openProviderCredential, {
      workspaceId,
      provider: "anthropic",
    });
    expect(opened?.apiKey).toBe("a-second-key-entirely-different-from-the-first-one");
  });
});
