/**
 * Re-checking a binding without re-pasting the credential.
 *
 * Verification used to be reachable from exactly one place — the moment a
 * credential was saved — so a single transient failure left the row `error`
 * permanently and the only documented cure was to type the secret access key
 * again. That is a lockout, and it is also a bad habit to teach: "re-enter your
 * credential to fix an unrelated problem" is the exact instruction a phishing
 * page wants a user to be used to following.
 *
 * What is proved here:
 *
 *  1. an owner can re-check, and a previously-`error` binding reaches
 *     `connected` **without the secret being supplied again** — the row's
 *     stored envelope is what gets used;
 *  2. `editor` and `member` cannot, and a non-member cannot even learn the
 *     workspace exists;
 *  3. the rate limit engages, because this makes an outbound request to a URL
 *     the customer chose;
 *  4. it works from `error`, `unverified` and `connected` alike;
 *  5. a re-check of a healthy binding does not take it offline while it runs;
 *  6. nothing about the credential comes back in the return value or the audit
 *     row.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";
import { type MemoryS3Options, memoryS3 } from "./storeStub.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A workspace whose binding is already in a chosen state, with a stubbed bucket
 * behind it and **nothing queued**.
 *
 * Seeded directly rather than through `bindStorage`, for the reason
 * `provisioning.test.ts` gives at length: binding schedules its own probe, and
 * a probe racing the one under test produces results neither test wrote.
 */
async function boundWorkspace(
  options: {
    status?: "unverified" | "connected" | "error";
    lastError?: string;
    errorCode?: string;
  } & MemoryS3Options = {},
) {
  const { status, lastError, errorCode: seededCode, ...bucketOptions } = options;
  const t: TestConvex = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  vi.stubGlobal("fetch", backend.fetchImpl);

  await seedStorageBinding(t, {
    workspaceId,
    boundBy: owner,
    status: status ?? "error",
    lastError,
    errorCode: seededCode,
    capabilities: { conditionalWrite: false },
  });

  return { t, owner, workspaceId, backend };
}

function binding(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return asUser(t, userId).query(api.functions.storage.getStorageBinding, {
    workspaceId,
  });
}

function reverify(
  t: TestConvex,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return asUser(t, userId).mutation(api.functions.storage.reverifyStorage, {
    workspaceId,
  });
}

/* -------------------------------------------------------------------------- */

describe("an error is recoverable without the credential", () => {
  /** The lockout, and its cure. */
  test("a previously-error binding reaches connected with no secret re-supplied", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({
      status: "error",
      lastError: "Could not list the bucket. The provider said: timed out.",
      errorCode: "UNREACHABLE",
    });
    expect((await binding(t, owner, workspaceId))?.status).toBe("error");

    const result = await reverify(t, owner, workspaceId);
    expect(result).toEqual({ queued: true, status: "error" });

    await drainScheduled(t);

    const healed = await binding(t, owner, workspaceId);
    expect(healed?.status).toBe("connected");
    // The stale failure is cleared with it — a green status next to red text is
    // how a fixed problem keeps getting reported.
    expect(healed?.lastError).toBeUndefined();
    expect(healed?.errorCode).toBeUndefined();
    expect(healed?.lastVerifiedAt).toBeTypeOf("number");
    // Observed, not assumed: this backend honours `If-Match`.
    expect(healed?.capabilities).toEqual({ conditionalWrite: true });
  });

  /**
   * Non-vacuity for the test above: the row's *stored* envelope is what got
   * used. If re-verification silently required a fresh credential, or read one
   * from somewhere else, this would not be the same secret.
   */
  test("the credential used is the one already on the row", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({ status: "error" });
    const before = await t.run((ctx) =>
      ctx.db.query("storageBindings").unique(),
    );

    await reverify(t, owner, workspaceId);
    await drainScheduled(t);

    const after = await t.run((ctx) => ctx.db.query("storageBindings").unique());
    expect(after?.encryptedSecretAccessKey).toBe(
      before?.encryptedSecretAccessKey,
    );
    expect(after?.status).toBe("connected");
  });

  /** A bucket that is still broken stays broken, and says why. */
  test("a still-broken bucket comes back with an actionable code, not a green check", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({
      status: "error",
      readOnly: true,
    });

    await reverify(t, owner, workspaceId);
    await drainScheduled(t);

    const still = await binding(t, owner, workspaceId);
    expect(still?.status).toBe("error");
    expect(still?.errorCode).toBe("NOT_WRITABLE");
    expect(still?.lastError).toContain("put and delete");
  });
});

/* -------------------------------------------------------------------------- */

describe("every status is re-checkable", () => {
  test("unverified, connected and error all queue a probe", async () => {
    for (const status of ["unverified", "connected", "error"] as const) {
      const { t, owner, workspaceId } = await boundWorkspace({ status });
      const result = await reverify(t, owner, workspaceId);
      expect(result).toEqual({ queued: true, status });

      await drainScheduled(t);
      expect((await binding(t, owner, workspaceId))?.status).toBe("connected");
    }
  });

  /**
   * A re-check of a healthy binding must not take it offline while it runs.
   *
   * The gateway will only build a store from a `connected` binding, so flipping
   * the row back to `unverified` for the duration of the probe would cut off
   * every live MCP client — during a check the owner ran precisely *because*
   * things looked fine.
   */
  test("a connected binding stays connected while the probe is in flight", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({
      status: "connected",
    });

    await reverify(t, owner, workspaceId);
    // Queued, not yet run.
    expect((await binding(t, owner, workspaceId))?.status).toBe("connected");

    await drainScheduled(t);
    expect((await binding(t, owner, workspaceId))?.status).toBe("connected");
  });

  test("a workspace with no binding at all is told so, not silently queued", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");

    expect(errorCode(await captureError(() => reverify(t, owner, workspaceId)))).toBe(
      "NO_STORAGE_BINDING",
    );
    expect(
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("re-checking is owner-only", () => {
  async function sharedContext() {
    const { t, owner, workspaceId } = await boundWorkspace({ status: "error" });
    const editor = await createUser(t, "editor@example.invalid");
    const member = await createUser(t, "member@example.invalid");
    const stranger = await createUser(t, "stranger@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);
    await addMember(t, workspaceId, member, "member", owner);
    return { t, owner, editor, member, stranger, workspaceId };
  }

  test("an editor and a member are both refused, and nothing is queued", async () => {
    const { t, editor, member, workspaceId } = await sharedContext();

    for (const userId of [editor, member]) {
      expect(
        errorCode(await captureError(() => reverify(t, userId, workspaceId))),
      ).toBe("INSUFFICIENT_ROLE");
    }
    expect(
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
    ).toEqual([]);
  });

  /**
   * A non-member gets the workspace-not-found error, not a role complaint —
   * otherwise this endpoint confirms that a guessed workspace id is real.
   */
  test("a non-member cannot tell the workspace from one that never existed", async () => {
    const { t, stranger, workspaceId } = await sharedContext();

    const refused = await captureError(() =>
      reverify(t, stranger, workspaceId),
    );
    expect(errorCode(refused)).toBe("WORKSPACE_NOT_FOUND");

    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        slug: "temp-context",
        displayName: "temp",
        createdBy: stranger,
        kind: "personal" as const,
        structureTemplate: "para" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const nonexistent = await captureError(() =>
      reverify(t, stranger, dangling),
    );
    expect(JSON.stringify((refused as { data: unknown }).data)).toBe(
      JSON.stringify((nonexistent as { data: unknown }).data),
    );
  });

  test("an unauthenticated caller is refused outright, and queues nothing", async () => {
    const { t, workspaceId } = await boundWorkspace({ status: "error" });
    expect(
      errorCode(
        await captureError(() =>
          t.mutation(api.functions.storage.reverifyStorage, { workspaceId }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
    expect(
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("the rate limit engages", () => {
  /**
   * The endpoint is a URL a customer typed and we make the request. Unlimited,
   * this is a request amplifier aimed at somebody else's infrastructure with
   * our egress IP on it.
   */
  test("a burst is cut off, with a retry hint rather than a dead end", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({ status: "error" });

    let refusal: unknown;
    let allowed = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await reverify(t, owner, workspaceId);
        allowed += 1;
      } catch (error) {
        refusal = error;
        break;
      }
    }

    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(20);
    expect(errorCode(refusal)).toBe("RATE_LIMITED");
    expect(
      (refusal as { data: { retryAfterMs?: number } }).data.retryAfterMs,
    ).toBeGreaterThan(0);

    // Nothing was queued by the refused call: the limit and the schedule commit
    // or roll back together.
    const queued = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(queued).toHaveLength(allowed);
  });

  /** The limit is per workspace, so one context's budget is not another's. */
  test("a second workspace has its own budget", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({ status: "error" });
    const second = await createWorkspace(t, owner, "beta");
    await seedStorageBinding(t, {
      workspaceId: second,
      boundBy: owner,
      status: "error",
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await reverify(t, owner, workspaceId);
      } catch {
        break;
      }
    }
    // The first workspace is exhausted; the second is untouched.
    expect(errorCode(await captureError(() => reverify(t, owner, workspaceId)))).toBe(
      "RATE_LIMITED",
    );
    expect(await reverify(t, owner, second)).toEqual({
      queued: true,
      status: "error",
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("nothing about the credential leaks", () => {
  test("neither the return value nor the audit trail carries a secret", async () => {
    const { t, owner, workspaceId } = await boundWorkspace({ status: "error" });

    const result = await reverify(t, owner, workspaceId);
    await drainScheduled(t);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(serialized).not.toContain(FAKE_STORAGE.accessKeyId);

    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const requested = events.find(
      (event) => event.action === "storage.reverify_requested",
    );
    expect(requested).toBeDefined();
    expect(requested?.actorUserId).toBe(owner);
    expect(requested?.details).toEqual({ fromStatus: "error" });

    const allEvents = JSON.stringify(events);
    expect(allEvents).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(allEvents).not.toContain(FAKE_STORAGE.accessKeyId);
  });
});
