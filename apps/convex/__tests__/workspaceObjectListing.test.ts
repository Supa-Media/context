/**
 * The workspace object's folder listing (`apps/mcp/src/workspaceStore/listing.js`)
 * gives exactly the answer the Convex tree gives (`listFolder` over
 * `folderRowsStore`), for every folder and every reader in one fixture, so
 * the app's tree draws the same names, visibilities and refusals from either.
 * The object's port is not trusted to be the same: this is the test that says so.
 */

import { describe, expect, it } from "vitest";
import { listFolder } from "../functions/lib/fileOps/listing";
import { folderRowsStore } from "../functions/lib/nodes/listing";
import { clearanceOf } from "../functions/lib/clearance";
import type { PrivacyMirror } from "../functions/lib/nodes/table";
import { listFolderFromRows } from "../../mcp/src/workspaceStore/listing.js";

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

const rows = [
  { path: "projects", kind: "folder" },
  { path: "projects/secret", kind: "folder" },
  { path: "projects/secret/opened", kind: "folder" },
  { path: "projects/secret/rates.md", kind: "file", size: 4, uploaded: 5 },
  { path: "projects/secret/opened/team.md", kind: "file" },
  { path: "projects/plan.md", kind: "file", size: 10, uploaded: 1000 },
  { path: "projects/plan-private.md", kind: "file" },
  { path: "projects/for-design.md", kind: "file" },
  { path: "areas", kind: "folder" },
  { path: "areas/shared.md", kind: "file" },
  { path: "areas/mine.md", kind: "file" },
  { path: "design", kind: "folder" },
  { path: "design/brief.md", kind: "file" },
  { path: "todo.md", kind: "file" },
] as const;

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const childrenOf = (folder: string) => rows.filter((row) => parentOf(row.path) === folder);

const readers = {
  owner: clearanceOf("private"),
  team: clearanceOf("team"),
  design: clearanceOf("team", ["design"]),
  guest: clearanceOf("team", ["#reads-as-guest"]),
};
const asked = ["", "projects", "projects/secret", "projects/secret/opened", "projects/secret/deeper", "areas", "design", "nothing"];

describe("the workspace object's listing matches the Convex tree's", () => {
  for (const [who, clearance] of Object.entries(readers)) {
    for (const folder of asked) {
      it(`${who} lists "${folder}" alike`, async () => {
        const children = childrenOf(folder).map((row) => ({ ...row }));
        const convex = await listFolder(folderRowsStore(folder, children as never, false, mirror), { path: folder, clearance });
        const object = listFolderFromRows({ folder, clearance, held, children, more: false, own: null, roots: [] });
        // Root folders' jobs are the Convex tree's `withFolderJobs`, not `listFolder`'s: compared without them.
        const plain = (page: { entries: Array<Record<string, unknown>> }) => ({
          ...page,
          entries: page.entries.map(({ role: _role, ...entry }) => entry),
        });
        expect(plain(object as never)).toEqual(plain(convex as never));
      });
    }
  }
});
