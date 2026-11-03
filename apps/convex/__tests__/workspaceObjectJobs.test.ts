/**
 * The workspace object's folder jobs (`apps/mcp/src/workspaceStore/jobsAnswer.js`, the `jobs` ask of
 * `workspaceStore/facts.js`) give exactly the answer Convex gives (`folderJobsAndClaims` in `lib/nodes/folderJobs.ts`,
 * filtered by `folderVisibleAtScope` as `gatewayFacts.ts`'s `jobs` branch does), for every reader in one fixture. The
 * fixture covers the cases where the two could drift: a job held by a private folder, a job row nested under a folder,
 * a job claimed by its role over a root that has its name, a trashed row, a removed row, and a folder named for a job
 * that a role row already claims. Sibling of `workspaceObjectListing.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { folderJobsAndClaims } from "../functions/lib/nodes/folderJobs";
import { folderVisibleAtScope } from "../functions/lib/fileOps/listing";
import { clearanceOf } from "../functions/lib/clearance";
import type { PrivacyRule } from "../functions/lib/privacy";
import { folderJobsAnswer } from "../../mcp/src/workspaceStore/jobsAnswer.js";
import { folderVisibleAtScope as objectFolderVisible } from "../../mcp/src/workspaceStore/listing.js";
import { parsedRules } from "../../mcp/src/workspaceStore/serve.js";
import { READS_AS_GUEST } from "../../mcp/src/privacy/engine.js";

// The paths' own row lookups are the control plane's indexed reads; the fake db below answers the two indexes the
// jobs read uses, and the path of a row is the path it was given (what `located` would find).
vi.mock("../functions/lib/nodes/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../functions/lib/nodes/paths")>();
  return {
    ...actual,
    nodePaths: async () => ({}),
    located: async (_db: unknown, row: unknown) => row,
  };
});

interface Spec {
  path: string;
  kind: "folder" | "file";
  role?: string;
  gone?: boolean;
}

const specs: Spec[] = [
  { path: "projects", kind: "folder", role: "projects" },
  { path: "archive", kind: "folder" },
  { path: "Vault", kind: "folder", role: "products" },
  { path: ".context/trash/old-clients", kind: "folder", role: "clients" },
  { path: "gone-areas", kind: "folder", role: "areas", gone: true },
  { path: "projects/plan.md", kind: "file" },
  { path: "projects/meetings", kind: "folder", role: "meetings" },
  { path: "Vault/tex", kind: "folder", role: "tex" },
  { path: "tex", kind: "folder" },
  { path: "website", kind: "folder" },
  { path: "Inbox", kind: "folder", role: "none" },
  { path: "inbox", kind: "folder" },
];

const folders = [
  { prefix: "projects", visibility: "team" },
  { prefix: "archive", visibility: "team" },
  { prefix: "Vault", visibility: "private" },
  { prefix: "projects/meetings", visibility: "private" },
];

/** The Convex rows for `specs`: top-level rows have no parent, and a removed row carries `goneAt`. */
const docs = specs.map((spec, index) => {
  const slash = spec.path.lastIndexOf("/");
  const top = slash < 0;
  return {
    _id: `row${index}`,
    workspaceId: "ws",
    name: top ? spec.path : spec.path.slice(slash + 1),
    path: spec.path,
    kind: spec.kind,
    role: spec.role,
    parentId: top ? undefined : "parent",
    goneAt: spec.gone ? 1 : undefined,
  };
});

/** The two indexes `folderJobsAndClaims` reads, over the fixture: equality on each field named by the index. */
function fakeDb() {
  return {
    query: () => ({
      withIndex: (_index: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => void) => {
        const conditions: Array<[string, unknown]> = [];
        const q = {
          eq(field: string, value: unknown) {
            conditions.push([field, value]);
            return q;
          },
        };
        build(q);
        const matched = docs.filter((doc) => conditions.every(([field, value]) => (doc as Record<string, unknown>)[field] === value));
        return {
          take: async (limit: number) => matched.slice(0, limit),
          [Symbol.asyncIterator]: async function* () {
            yield* matched;
          },
        };
      },
    }),
  };
}

const readers = {
  owner: clearanceOf("private"),
  team: clearanceOf("team"),
  guest: clearanceOf("team", [READS_AS_GUEST]),
};

/** Convex's answer for one reader, as `gatewayFacts.ts` gives it: the jobs and roots the reader sees. */
async function convexAnswer(clearance: ReturnType<typeof clearanceOf>) {
  const rules = folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility }) as PrivacyRule);
  const sees = (path: string) => folderVisibleAtScope(path, clearance, rules, new Map());
  const { answer } = await folderJobsAndClaims(fakeDb() as never, "ws" as never);
  const jobs: Record<string, string | null> = {};
  for (const [job, path] of Object.entries(answer.jobs)) jobs[job] = path !== null && sees(path) ? path : null;
  return { served: true, jobs, roots: answer.roots.filter(sees) };
}

/** The object's answer for one reader: the same rows, judged by the object's `folderVisibleAtScope` over its rules. */
function objectAnswer(scope: "private" | "team", names: string[]) {
  const held = { etag: "m.2", accessVersion: 1, folders, notes: [] };
  const { rules, overrides } = parsedRules(held);
  const clearance = { scope, names: new Set(names) };
  const folderSees = (path: string) => objectFolderVisible(path, clearance, rules, overrides);
  const rows = specs.filter((spec) => !spec.gone).map((spec) => ({ path: spec.path, kind: spec.kind, role: spec.role ?? null }));
  return folderJobsAnswer(rows, folderSees);
}

const scopes = {
  owner: ["private", []],
  team: ["team", []],
  guest: ["team", [READS_AS_GUEST]],
} as const;

describe("the workspace object's folder jobs match Convex's", () => {
  for (const who of Object.keys(readers) as Array<keyof typeof readers>) {
    it(`${who} is named the same jobs and roots`, async () => {
      const [scope, names] = scopes[who];
      const convex = await convexAnswer(readers[who]);
      const object = objectAnswer(scope, [...names]);
      expect(object).toEqual(convex);
    });
  }

  it("the fixture is not trivially equal: a team member is not named a private folder's job, and a trashed or removed row does no job", async () => {
    const team = await convexAnswer(readers.team);
    expect(team.jobs.products).toBeNull();
    expect(team.jobs.clients).toBeNull();
    expect(team.jobs.areas).toBeNull();
    expect(team.roots).not.toContain("Vault");
    const owner = await convexAnswer(readers.owner);
    expect(owner.jobs.products).toBe("Vault");
    expect(owner.jobs.tex).toBe("Vault/tex");
    expect(owner.jobs.meetings).toBe("projects/meetings");
    expect(team.jobs.meetings).toBeNull();
  });
});
