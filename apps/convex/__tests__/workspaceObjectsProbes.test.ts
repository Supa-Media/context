/**
 * Who the workspace-object parity check asks about (`lib/workspaceObjects/probes.ts`). Once a workspace's object
 * decides who its members are, a read naming nobody sees nothing there, so asking as nobody reports every note
 * Convex shows as hidden: the check asks as real members instead, with the groups the object adds for them.
 */
import { describe, expect, test } from "vitest";
import { probesFor } from "../functions/lib/workspaceObjects/probes";
import type { ReaderRules } from "../functions/lib/workspaceObjects/rows";

const rules = { rules: [{ prefix: "crew", vis: "@crew" }], overrides: [] } as unknown as ReaderRules;

function fakeCtx(access: string, pages: Array<{ rows: Array<{ userId: string; role: string; groups: string[] }>; next: string | null }>) {
  let page = 0;
  return {
    runQuery: async (_fn: unknown, args: { scope?: string; cursor?: string | null }) => {
      if (args.scope !== undefined) return access;
      return pages[page++];
    },
  } as never;
}

describe("parity probes", () => {
  test("while Convex decides membership, the sampled grants are asked about, naming nobody", async () => {
    const probes = await probesFor(fakeCtx("dual", []), "ws" as never, rules);
    expect(probes.every((probe) => probe.ask === undefined)).toBe(true);
    expect(probes.map((probe) => probe.scope)).toEqual(["private", "team", "team"]);
  });

  test("once the object decides membership, real members are asked about, each with their role's scope and groups", async () => {
    const ctx = fakeCtx("object", [
      { rows: [{ userId: "u-owner", role: "owner", groups: [] }], next: "c1" },
      { rows: [{ userId: "u-crew", role: "member", groups: ["crew"] }], next: null },
    ]);
    const probes = await probesFor(ctx, "ws" as never, rules);
    expect(probes).toEqual([
      { scope: "private", groups: [], ask: { userId: "u-owner", groups: [] } },
      { scope: "team", groups: [], ask: { userId: "u-owner", groups: [] } },
      { scope: "team", groups: ["@crew"], ask: { userId: "u-crew", groups: [] } },
    ]);
  });
});
