/**
 * The access scan (`scanAccessRows`, `lib/nodes/accessRows.ts`) reads only the
 * rows that carry a setting and the rows a grant names, never the whole tree:
 * a big workspace's tree is more than one function may read, and a chunked
 * move whose page refreshed the access snapshot stopped for good on "Too many
 * bytes read" (Dev2's Archive rename, 2026-10-22).
 *
 * SABOTAGE (a temporary local edit, reverted): scan by `by_workspace_path`
 * again and drop the grant lookup: the first test fails on the reads count.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { scanAccessRows } from "../../functions/lib/nodes/accessRows";
import { keyedFixture } from "./keyedFixture.helpers";

describe("the access scan", () => {
  test("finds the rows with a setting and the rows a grant names, in path order, and reads nothing else", async () => {
    const f = await keyedFixture();
    const answer = await f.t.run(async (ctx) => {
      const row = (path: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("nodes", {
          workspaceId: f.ws,
          path,
          name: path,
          kind: "folder",
          observedAt: 1,
          ...extra,
        } as never);
      await row("z-private", { access: { base: "private" } });
      await row("b-team", { access: { base: "team" } });
      const granted = (await row("m-granted")) as Id<"nodes">;
      for (let i = 0; i < 50; i += 1) await row(`plain-${i}`);
      await ctx.db.insert("nodeAccess", {
        workspaceId: f.ws,
        nodeId: granted,
        granteeKind: "members",
        role: "view",
        at: 1,
        source: "owner",
      } as never);
      let reads = 0;
      const counting = new Proxy(ctx.db, {
        get(target, key, receiver) {
          if (key === "query") {
            return (table: string) => {
              const q = (target.query as (t: string) => unknown)(
                table,
              ) as Record<string, unknown>;
              return new Proxy(q, {
                get(qt, qk) {
                  if (qk !== "withIndex") return Reflect.get(qt, qk);
                  return (...args: unknown[]) => {
                    const indexed = (
                      qt.withIndex as (...a: unknown[]) => {
                        collect: () => Promise<unknown[]>;
                      }
                    )(...args);
                    return {
                      ...indexed,
                      collect: async () => {
                        const got = await indexed.collect();
                        if (table === "nodes") reads += got.length;
                        return got;
                      },
                    };
                  };
                },
              });
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const rows = await scanAccessRows(
        { ...ctx, db: counting } as never,
        f.ws,
      );
      return { paths: rows.map((r) => r.path), reads };
    });
    // The keyed fixture's own folder rules are access rows too, so the scan finds them with the three added here.
    expect(answer.paths).toEqual(["1-projects", "1-projects/secret", "3-resources", "b-team", "m-granted", "z-private"]);
    expect(answer.reads).toBeLessThan(10);
  });
});
