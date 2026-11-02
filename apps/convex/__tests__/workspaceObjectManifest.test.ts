/**
 * The workspace object's listing for the agent tools (`apps/mcp/src/workspaceStore/manifest.js`) gives exactly the
 * keys, versions and note ids the Convex tree's `/gateway/tree/manifest` gives (`syncManifest` over the tree's rows,
 * `gatewayManifest.ts`), for every reader and folder in one fixture, so moving `list_notes`, `orient`'s map and the
 * other listings to the object changes nothing anybody is shown. The object's port is not trusted to be the same:
 * this is the test that says so.
 */

import { describe, expect, it } from "vitest";
import { syncManifest } from "../functions/lib/fileOps/syncManifest";
import { NO_BUCKET, nodesPagedStore, type NodePage } from "../functions/lib/nodes/manifestStore";
import { clearanceOf } from "../functions/lib/clearance";
import type { NodeRow, PrivacyMirror } from "../functions/lib/nodes/table";
import { manifestPage } from "../../mcp/src/workspaceStore/manifest.js";
import { judgeFor } from "../../mcp/src/workspaceStore/serve.js";
import { compareKeys } from "../../mcp/src/tree/served.js";

const folders = [
  { prefix: "projects", visibility: "team" },
  { prefix: "projects/secret", visibility: "private" },
  { prefix: "projects/secret/opened", visibility: "team" },
  { prefix: "design", visibility: "@design" },
];
const notes = [
  { path: "projects/plan-private.md", visibility: "private" },
  { path: "projects/for-design.md", visibility: "@design" },
  { path: "areas/shared.md", visibility: "team" },
];
const held = { etag: "m.1", accessVersion: 1, folders, notes };
const mirror = { etag: "m.1", invalid: false, folders, notes, rows: true } as unknown as PrivacyMirror;

const files: NodeRow[] = [
  { path: "projects/secret/rates.md", etag: "e1", size: 4, uploaded: 5, noteId: "n1" },
  { path: "projects/secret/opened/team.md", etag: "e2", noteId: "n2" },
  { path: "projects/plan.md", etag: "e3", size: 10, uploaded: 1000, noteId: "n3" },
  { path: "projects/plan-private.md", etag: "e4", noteId: "n4" },
  { path: "projects/for-design.md", etag: "e5", noteId: "n5" },
  { path: "projects/picture.png", etag: "e6", size: 7 },
  { path: "areas/shared.md", etag: "e7", noteId: "n7" },
  { path: "areas/mine.md", etag: "e8", noteId: "n8" },
  { path: "design/brief.md", etag: "e9", noteId: "n9" },
  { path: "todo.md", etag: "e10", noteId: "n10" },
  { path: ".context/plumbing.json", etag: "e11" },
  { path: "projectsX/next.md", etag: "e12", noteId: "n12" },
  { path: "Ünïcode/é.md", etag: "e13", noteId: "n13" },
].sort((a, b) => compareKeys(a.path, b.path)) as NodeRow[];

/** The tree's pages over the fixture, as `nodes.listLive` hands them out: live file rows in key order. */
const pages: NodePage = async (after, limit, root) => {
  const under = files.filter((row) => (root === undefined || row.path.startsWith(`${root}/`)) && (after === undefined || compareKeys(row.path, after) > 0));
  const page = under.slice(0, limit);
  return { rows: page, cursor: under.length > limit ? page[page.length - 1]!.path : null };
};

/** The object's rows, as `workspaceRows` answers the two calls the listing makes. */
const objectRows = {
  rules: () => held,
  filesUnder: (prefix: string, after: string | null) =>
    files
      .filter((row) => row.path.startsWith(prefix) && (after === null || compareKeys(row.path, after) > 0))
      .map((row) => ({ ...row, size: row.size ?? null, uploaded: row.uploaded ?? null, noteId: row.noteId ?? null, kind: "file" })),
};

/** Each reader as the Convex route clears it, and as the gateway sends it to the object. */
const readers = {
  owner: { clearance: clearanceOf("private"), object: { scope: "private", groups: [], audience: "member" } },
  team: { clearance: clearanceOf("team"), object: { scope: "team", groups: [], audience: "member" } },
  design: { clearance: clearanceOf("team", ["design"]), object: { scope: "team", groups: ["@design"], audience: "member" } },
  guest: { clearance: clearanceOf("team", ["#reads-as-guest"]), object: { scope: "team", groups: ["@#reads-as-guest"], audience: "guest" } },
} as const;
const asked = ["", "projects", "projects/secret", "projects/secret/opened", "areas", "design", "nothing"];

const versions = (entries: Array<Record<string, unknown>>) =>
  entries.map((entry) => ({ path: entry.path, etag: entry.etag, size: entry.size, updatedAt: entry.updatedAt, noteId: entry.noteId }));

describe("the workspace object's listing matches the Convex tree's manifest", () => {
  for (const [who, reader] of Object.entries(readers)) {
    for (const folder of asked) {
      it(`${who} lists "${folder}" alike`, async () => {
        const store = nodesPagedStore(NO_BUCKET, pages, mirror);
        const convex = await syncManifest(store, { clearance: reader.clearance, pageEntries: 10_000, ...(folder === "" ? {} : { folder }) });
        const rows = { ...objectRows, rules: (audience: string) => (audience === "member" || audience === "guest" ? held : null) };
        const object = manifestPage(rows as never, { folder }, judgeFor(rows as never, reader.object as never, null));
        expect(object.served).toBe(true);
        expect(versions((object as { entries: Array<Record<string, unknown>> }).entries)).toEqual(versions(convex.entries as never));
        expect((object as { cursor: string | null }).cursor).toBe(convex.cursor);
      });
    }
  }

  it("pages alike: the same cursor and the same next page", async () => {
    const store = nodesPagedStore(NO_BUCKET, pages, mirror);
    const first = await syncManifest(store, { clearance: clearanceOf("private"), pageEntries: 3 });
    const rows = objectRows as never;
    const judge = judgeFor(rows, { scope: "private", groups: [], audience: "member" } as never, null);
    const object = manifestPage(rows, { limit: 3 }, judge) as { entries: Array<Record<string, unknown>>; cursor: string };
    expect(versions(object.entries)).toEqual(versions(first.entries as never));
    expect(object.cursor).toBe(first.cursor);
    const second = await syncManifest(nodesPagedStore(NO_BUCKET, pages, mirror), { clearance: clearanceOf("private"), cursor: first.cursor!, pageEntries: 3 });
    const next = manifestPage(rows, { limit: 3, cursor: object.cursor }, judge) as { entries: Array<Record<string, unknown>> };
    expect(versions(next.entries)).toEqual(versions(second.entries as never));
  });
});
