/**
 * Notes' facts from the workspace object for the control plane's own readers (`functions/lib/nodes/objectFacts.ts`):
 * a List's props, the chaos score's extras and the map's links, each falling back to the control plane's copy for
 * whatever the object does not answer.
 *
 * Sabotage (temporary local edits, reverted): dropping the per-path fallback loses a note the object has not got
 * yet; dropping the not-served check reads an empty table as "no links".
 */

import { describe, expect, it } from "vitest";
import { objectChaosSource, objectLinkTable, objectPropSource, type FactRows } from "../../functions/lib/nodes/objectFacts";
import type { FileStore } from "../../functions/lib/fileOps/store";

const convexProps = (rows: Record<string, string>) => ({
  asked: [] as string[][],
  async rows(paths: string[]) {
    this.asked.push(paths);
    return new Map(paths.filter((path) => path in rows).map((path) => [path, { version: "c", encrypted: false, props: rows[path] }]));
  },
});

describe("object facts for the control plane's readers", () => {
  it("a List's props come from the object, and only the paths it lacks are asked of the control plane", async () => {
    const rows: FactRows = async (request) => ({
      served: true,
      props: (request.paths ?? []).filter((path) => path !== "b.md").map((path) => ({ path, version: "o", sealed: false, props: `{"from":"object"}` })),
    });
    const fallback = convexProps({ "b.md": `{"from":"convex"}` });
    const found = await objectPropSource(rows, fallback).rows(["a.md", "b.md"]);
    expect(found.get("a.md")?.props).toBe(`{"from":"object"}`);
    expect(found.get("b.md")?.props).toBe(`{"from":"convex"}`);
    expect(fallback.asked).toEqual([["b.md"]]);
  });

  it("an object that fails or does not serve hands every path to the control plane", async () => {
    for (const rows of [async () => ({ served: false }), async () => { throw new Error("down"); }] as FactRows[]) {
      const fallback = convexProps({ "a.md": "{}" });
      const found = await objectPropSource(rows, fallback).rows(["a.md"]);
      expect(found.get("a.md")?.version).toBe("c");
      expect(fallback.asked).toEqual([["a.md"]]);
    }
  });

  it("no object reading leaves the control plane's sources as they were", async () => {
    const fallback = convexProps({});
    expect(objectPropSource(null, fallback)).toBe(fallback);
    expect(await objectLinkTable(null, {} as FileStore)).toBeNull();
  });

  it("the chaos extras come from the object, its history from the control plane", async () => {
    const fallback = { extras: async () => new Map([["x.md", { lines: 1, exempt: false, review: false }]]), weekAgo: async () => 42 };
    const source = objectChaosSource(async () => ({ served: true, extras: [{ path: "long.md", lines: 2000, exempt: false, review: false }] }), fallback);
    expect([...(await source.extras())!.keys()]).toEqual(["long.md"]);
    expect(await source.weekAgo("all")).toBe(42);
    const down = objectChaosSource(async () => ({ served: false }), fallback);
    expect([...(await down.extras())!.keys()]).toEqual(["x.md"]);
  });

  it("the map's links come from the object, and a not-served answer is no table", async () => {
    const served = { list: async () => ({ objects: [{ key: "a.md" }, { key: "pic.png" }], truncated: false, delimitedPrefixes: [] }) } as unknown as FileStore;
    const table = await objectLinkTable(async () => ({ served: true, links: [["a.md", "name", "b"]], unparsed: 1 }), served);
    expect(table?.unparsed).toBe(1);
    expect(await objectLinkTable(async () => ({ served: false }), served)).toBeNull();
  });
});
