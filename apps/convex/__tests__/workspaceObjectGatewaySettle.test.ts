/**
 * A gateway request's own write waits for the workspace's object only briefly (`functions/lib/rowWatch/drain.ts`
 * `GATEWAY_SETTLE`). The gateway gives up on a control-plane answer after `CONTROL_PLANE_WRITE_TIMEOUT_MS`
 * (`apps/mcp/src/controlPlane/client.js`); with the old wait (`SETTLE_MS`, ten seconds, plus a push run inline that
 * could hang on the object), every note save in a workspace whose push was not landing answered "control plane
 * unavailable: timed out" although its change had committed (2026-11-02).
 *
 * Sabotage, each confirmed to fail a case here: pass no options from `objectFirst` to `objectSettled` (the write
 * waits the full ten seconds), or run the inline drain whatever `drain` says (the push is claimed by the write).
 */

import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { GATEWAY_SETTLE, objectSettled, SETTLE_MS } from "../functions/lib/rowWatch/drain";
import { objectFirst } from "../functions/lib/rowWatch/objectFirst";

const WORKSPACE = "workspace-stuck" as Id<"workspaces">;

/** An action context whose workspace always has a change waiting for its object: its push never lands. */
function stuckPush() {
  const ran: string[] = [];
  const ctx = {
    runQuery: async (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      ran.push(name);
      return name === "functions/workspaceObjectPush:waitingSince";
    },
    runMutation: async (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      ran.push(name);
      // No mark: the write runs straight and only the settle follows.
      return false;
    },
    scheduler: { runAfter: async () => null },
  } as unknown as ActionCtx;
  return { ctx, ran };
}

describe("a gateway write and a push that is not landing", () => {
  test("the gateway's settle gives up well inside the gateway's wait, and never runs the push itself", async () => {
    const { ctx, ran } = stuckPush();
    const started = Date.now();
    expect(await objectSettled(ctx, WORKSPACE, GATEWAY_SETTLE)).toBe(false);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(GATEWAY_SETTLE.settleMs!);
    expect(waited).toBeLessThan(GATEWAY_SETTLE.settleMs! + 1_500);
    expect(GATEWAY_SETTLE.settleMs!).toBeLessThan(SETTLE_MS);
    expect(ran).not.toContain("functions/workspaceObjectPush:claim");
  });

  test("objectFirst passes the gateway's settle on, so the write answers what it committed in time", async () => {
    const { ctx, ran } = stuckPush();
    const started = Date.now();
    expect(await objectFirst(ctx, WORKSPACE, async () => "committed", { settle: GATEWAY_SETTLE })).toBe("committed");
    expect(Date.now() - started).toBeLessThan(GATEWAY_SETTLE.settleMs! + 1_500);
    expect(ran).not.toContain("functions/workspaceObjectPush:claim");
  });

  test("any other caller still runs the push inline", async () => {
    const { ctx, ran } = stuckPush();
    expect(await objectSettled(ctx, WORKSPACE, { settleMs: 0 })).toBe(false);
    expect(ran).toContain("functions/workspaceObjectPush:claim");
  });
});
