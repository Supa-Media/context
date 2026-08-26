/**
 * The two claims `lib/workspaceAuth.ts` makes about itself.
 *
 * Both were, until now, comments. `isolation.test.ts` proves the *payload*
 * half of "not a member is indistinguishable from does not exist" — that the
 * errors are byte-identical — and proves it well. What nothing checked was:
 *
 *  1. the **ordering**: "loads the membership FIRST … we throw without ever
 *     reading the workspace". An adversarial review moved `ctx.db.get` above
 *     the membership lookup and the entire suite stayed green, because that
 *     change alters no return value and no error payload.
 *  2. the **single-sourcing**: "constructed in one place so no future endpoint
 *     can accidentally leak the difference". Two endpoints in `grants.ts` and
 *     one in `audit.ts` inlined the literal instead, so their byte-identity
 *     with this helper held by coincidence — a sabotage of the helper failed
 *     six isolation tests and left `listGrants` and `listEvents` passing.
 *
 * Both tests below fail if the property they name is removed, which is the
 * only thing that makes the docstring worth reading.
 */

/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireWorkspaceAccess } from "../functions/lib/workspaceAuth";
import {
  addMember,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

/**
 * A `QueryCtx` that records which tables it touched, in order.
 *
 * Wrapping the real ctx rather than faking it keeps the function under test
 * running against a real database — what is instrumented is only *which*
 * reads happen and in what order.
 */
function recordingCtx(ctx: QueryCtx): { ctx: QueryCtx; reads: string[] } {
  const reads: string[] = [];
  const wrapped = {
    ...ctx,
    db: {
      ...ctx.db,
      get: (id: Id<"workspaces">) => {
        reads.push("get:workspaces");
        return ctx.db.get(id);
      },
      query: (table: string) => {
        reads.push(`query:${table}`);
        return (ctx.db.query as (t: string) => unknown)(table);
      },
    },
  } as unknown as QueryCtx;
  return { ctx: wrapped, reads };
}

describe("requireWorkspaceAccess reads membership first", () => {
  test("a non-member's rejection never touches the workspace row", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const mallory = await createUser(t, "mallory@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-context");

    const reads = await t.run(async (base) => {
      const { ctx, reads } = recordingCtx(base);
      const error = await captureError(() =>
        requireWorkspaceAccess(ctx, aliceWs, mallory),
      );
      expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
      return reads;
    });

    // Exactly one read, and it is the membership lookup. If `ctx.db.get` moves
    // above the membership check, `get:workspaces` appears here and this
    // fails — which is the entire point of the test.
    expect(reads).toEqual(["query:workspaceMembers"]);
    expect(reads).not.toContain("get:workspaces");
  });

  test("the same holds for a workspace id that refers to nothing", async () => {
    const t = setupTest();
    const mallory = await createUser(t, "mallory@example.invalid");
    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        slug: "temporary-placeholder",
        displayName: "Temporary",
        createdBy: mallory,
        kind: "personal" as const,
        structureTemplate: "para" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const reads = await t.run(async (base) => {
      const { ctx, reads } = recordingCtx(base);
      await captureError(() => requireWorkspaceAccess(ctx, dangling, mallory));
      return reads;
    });

    // Identical read pattern to the "exists but not yours" case above. The two
    // failures are indistinguishable in what they *do*, not merely in what
    // they return.
    expect(reads).toEqual(["query:workspaceMembers"]);
  });

  test("a member's successful read is membership first, then the workspace", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
    });
    await addMember(t, workspaceId, bob, "member", alice);

    const reads = await t.run(async (base) => {
      const { ctx, reads } = recordingCtx(base);
      const access = await requireWorkspaceAccess(ctx, workspaceId, bob);
      expect(access.membership.role).toBe("member");
      return reads;
    });

    expect(reads).toEqual(["query:workspaceMembers", "get:workspaces"]);
  });
});

describe("WORKSPACE_NOT_FOUND is constructed in exactly one place", () => {
  const SOURCES = import.meta.glob(
    ["../functions/**/*.ts"],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  /**
   * Comments are allowed to name the error — an endpoint documenting which
   * refusal a caller gets is exactly the kind of comment worth keeping. What
   * must not exist anywhere else is a *construction* of it.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  test("no module outside the helper builds the error itself", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith("functions/lib/workspaceAuth.ts"))
      .filter(([, source]) => withoutComments(source).includes("WORKSPACE_NOT_FOUND"))
      .map(([path]) => path);

    // Before this was enforced, `functions/grants.ts` (twice) and
    // `functions/audit.ts` each built their own copy. Anyone reintroducing one
    // gets this failure with a pointer to the helper.
    expect(
      offenders,
      "build this error with workspaceNotFound() from functions/lib/workspaceAuth.ts, so a change there cannot leave one endpoint behind",
    ).toEqual([]);
  });

  test("the helper is what the endpoints that used to inline it now throw", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const mallory = await createUser(t, "mallory@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-context");

    const { api } = await import("../_generated/api");
    const { asUser } = await import("./fixtures.helpers");

    // `t.run` may only return Convex values, so the shape is serialized inside
    // it rather than the error being handed back.
    const viaHelper = await t.run(async (ctx) => {
      const error = await captureError(() =>
        requireWorkspaceAccess(ctx, aliceWs, mallory),
      );
      return JSON.stringify((error as { data?: unknown }).data ?? null);
    });
    const viaGrants = await captureError(() =>
      asUser(t, mallory).query(api.functions.grants.listGrants, {
        workspaceId: aliceWs,
      }),
    );
    const viaAudit = await captureError(() =>
      asUser(t, mallory).query(api.functions.audit.listEvents, {
        workspaceId: aliceWs,
      }),
    );

    const shape = (error: unknown) =>
      JSON.stringify((error as { data?: unknown }).data ?? null);
    expect(shape(viaGrants)).toBe(viaHelper);
    expect(shape(viaAudit)).toBe(viaHelper);
  });
});
