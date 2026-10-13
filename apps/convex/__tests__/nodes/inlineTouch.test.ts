/**
 * A console change re-checks the Convex tree **before it answers**
 * (`keepTreeAndAnnounce` with the barrier's store), because the console now
 * reads that tree (phase 2): the tab that made the change asks for the folder
 * the moment the change returns, and must not be handed the tree from before.
 *
 * Sabotage: schedule the re-check instead (drop the `store` argument in
 * `announceTreeChange`) and the first case fails; drop the `PRIVACY_KEY`
 * re-read and the second does.
 */

import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { announceTreeChange } from "../../functions/lib/filesFns/treeOps";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

const ARGS = { workspaceId: "w1" as Id<"workspaces">, scope: "private" as const };

function recordingCtx() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const scheduled: { kind: string }[] = [];
  const name = (ref: unknown) => getFunctionName(ref as never);
  const ctx = {
    // Not paused, no search database, no tree state yet.
    runQuery: vi.fn(async () => null),
    runAction: vi.fn(async () => null),
    runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
      calls.push({ name: name(ref), args });
      return name(ref).endsWith("nodes:observe") ? { more: false } : null;
    }),
    scheduler: {
      runAfter: vi.fn(async (_delay: number, _ref: unknown, args: { operation: { kind: string } }) => {
        scheduled.push(args.operation);
        return "job";
      }),
    },
  };
  return { ctx: ctx as never, calls, scheduled };
}

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed("1-projects/a.md", "# A\n");
  return store;
}

describe("a console change and the Convex tree", () => {
  test("the touched paths are observed before the change answers, and nothing is left to a scheduled re-check", async () => {
    const { ctx, calls, scheduled } = recordingCtx();
    const store = bucket();
    await announceTreeChange(
      ctx,
      store,
      ARGS,
      { paths: ["1-projects/a.md"], narrows: false },
      { kind: "written", path: "1-projects/a.md" } as never,
      null,
    );
    const observed = calls.filter((call) => call.name.endsWith("nodes:observe"));
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.flatMap((call) => (call.args.rows as { path: string }[]).map((row) => row.path))).toContain("1-projects/a.md");
    expect(scheduled.filter((operation) => operation.kind === "nodesTouch")).toEqual([]);
  });

  test("a change that rewrote privacy.md re-reads the rules into the mirror", async () => {
    const { ctx, calls } = recordingCtx();
    const store = bucket();
    const before = { rules: [], overrides: new Map(), text: null, etag: "old", invalid: false };
    await announceTreeChange(
      ctx,
      store,
      ARGS,
      { paths: ["1-projects"], narrows: true },
      { kind: "visibility" } as never,
      before as never,
    );
    expect(calls.some((call) => call.name.endsWith("nodes:savePrivacy"))).toBe(true);
  });

  test("an unchanged privacy.md is not re-read", async () => {
    const { ctx, calls } = recordingCtx();
    const store = bucket();
    // The bucket has no privacy.md, so the state after has no etag either.
    const before = { rules: [], overrides: new Map(), text: null, etag: null, invalid: false };
    await announceTreeChange(
      ctx,
      store,
      ARGS,
      { paths: ["1-projects/a.md"], narrows: false },
      { kind: "written", path: "1-projects/a.md" } as never,
      before as never,
    );
    expect(calls.some((call) => call.name.endsWith("nodes:savePrivacy"))).toBe(false);
  });
});
