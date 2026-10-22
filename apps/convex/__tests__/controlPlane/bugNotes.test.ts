/**
 * A bug report filed by texting Tex lands as a note in the pinned context's
 * `tex-bugs/` folder, not in Sentry (`functions/bugNotes.ts`): under `team/`
 * for a real member of that context, under `user/` for everybody else, and
 * only where nobody reaching the context through the pin can read it.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `fileBugNote` skipping its visibility check. → "a folder anybody can
 *     read through the pin gets nothing" fails: the note is written.
 *  2. `destination` calling everyone a team member. → "a person who only
 *     reaches the pinned context files under user/, a member under team/"
 *     fails.
 *  3. The gateway route sending texting reports to Sentry again. → "a texted
 *     report becomes a note there, texts included, and nothing goes to Sentry"
 *     fails.
 *  4. `fileBugNote` not calling `shareWithTeam`. → "every real member reads
 *     each report, a later one included, and a pin reader does not" and
 *     "once the pinned workspace has moved, a report is base team" fail.
 *  5. `shareWithTeam` setting base `team` before the move. → "every real
 *     member reads each report, a later one included, and a pin reader does
 *     not" fails: the pin reader, still reading `team`, reads it.
 *  5b. `shareWithTeam` keeping the old private + members position after the
 *     move. → "once the pinned workspace has moved, a report is base team"
 *     fails: a member's MCP connection, holding no names, cannot read it.
 *  5c. `destination` handing `pinReaders: []` after the move. → "once the
 *     pinned workspace has moved, a folder open to the members alone takes a
 *     report" fails: judged as a member, the members' folder reads as open.
 *  6. `accessNamesFor` holding `members` for any caller. → not caught here,
 *     since `grantedNamesFor` gives a non-member no names before it looks;
 *     "a members grant reaches a real member, never a guest or someone
 *     outside" in `nodes/rowAccess.test.ts` fails instead.
 *  7. `fileBugNote` sharing inside its own try again. → "a grant that throws
 *     leaves the report filed, not reported as unsent" fails: the report is
 *     called unsent though the note holds the person's texts.
 *  8. `setAccessRow` dropping the actor's `clientId` from the audit row. →
 *     "naming the team is audited as Tex acting, not as the owner naming
 *     people by hand" fails.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";

vi.setConfig({ testTimeout: 30_000 });

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { fileBugNote } from "../../functions/bugNotes";
import { bugFolder, bugNotePath, renderBugNote } from "../../functions/lib/feedback/bugNote";
import { grantedNamesFor } from "../../functions/lib/grantedNames";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
// A workspace laid out before the numbers were dropped (2026-10-21): its folders keep them.
import { LEGACY_PARA_FOLDERS, renderPrivacyManifestForFolders } from "../../functions/lib/scaffold";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import {
  addMember,
  asUser,
  copyTree,
  createUser,
  createWorkspace,
  drainScheduled,
  gatewayPost,
  seedStorageBinding,
  type TestConvex,
} from "../fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./fixtures.helpers";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";
const TEXTS = "Them: find my avocado note\n\nTex: I couldn't find a note about avocados.";
const PINNED_BUCKET = "pinned-context";

let backend: MemoryS3;
let sentry: string[] = [];

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  vi.stubEnv("FEEDBACK_SENTRY_DSN", DSN);
  sentry = [];
  backend = memoryS3(PINNED_BUCKET);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("ingest.example.invalid")) {
      sentry.push(url);
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }
    return await backend.fetchImpl(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function world(rules: "para" | "team-everywhere" = "para") {
  const tenants = await twoConnectedTenants();
  const { t, alice, grantA } = tenants;
  const staff = await createUser(t, "staff@example.invalid");
  const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  backend.seed(PRIVACY_KEY, rules === "para" ? renderPrivacyManifestForFolders(LEGACY_PARA_FOLDERS) : teamEverywhere());
  backend.seed("index.md", "# Context\n");
  await seedStorageBinding(t, { workspaceId: pinned, boundBy: staff, bucket: PINNED_BUCKET });
  await copyTree(t, pinned);
  // Tex's own client and grant, as `textLinks.ts` makes them.
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthClients", {
      clientId: "context_texts",
      clientName: "Tex",
      redirectUris: [],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: [],
      responseTypes: [],
      createdAt: Date.now(),
    });
    await ctx.db.patch(grantA, { clientId: "context_texts" });
    await ctx.db.insert("names", { name: "alice-handle", kind: "user", userId: alice, claimedBy: alice, claimedAt: Date.now() });
  });
  return { ...tenants, staff, pinned };
}

/** The pinned workspace's move to "team means members" (`functions/pinnedAccounts.ts`), run to its end. */
async function movePinned(t: TestConvex) {
  await t.mutation(internal.functions.pinnedAccounts.start, {});
  await drainScheduled(t);
}

/** Production's shape: the access rows judge, as in `shareFollowsNoteId.test.ts`. */
async function judgedByRows(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const migration = await ctx.db.query("nodeMigration").first();
    const flags = { accessSource: "rows" as const, privacyAuthority: true };
    if (migration === null) await ctx.db.insert("nodeMigration", { paused: false, updatedAt: 1, ...flags });
    else await ctx.db.patch(migration._id, flags);
    const privacy = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first();
    const authorityRow = { etag: "e1", invalid: false, folders: [], notes: [] };
    if (privacy === null) await ctx.db.insert("nodePrivacy", { workspaceId, observedAt: 1, ...authorityRow });
    else await ctx.db.patch(privacy._id, authorityRow);
  });
}

/** A manifest with `areas` opened to the team: every account reads it through the pin. */
function teamEverywhere(): string {
  return renderPrivacyManifestForFolders(LEGACY_PARA_FOLDERS).replace("  2-areas: private\n", "  2-areas: private\n  areas: team\n");
}

async function report(t: TestConvex, body: Record<string, unknown>) {
  return await bodyOf(await gatewayPost(t, "/gateway/feedback", { accessToken: ACCESS_A, ...body }));
}

async function notesIn(t: TestConvex, workspaceId: Id<"workspaces">): Promise<string[]> {
  const result = await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "notePaths" },
  });
  return result.kind === "notePaths" ? (result.paths ?? []) : [];
}

async function readNote(t: TestConvex, workspaceId: Id<"workspaces">, path: string): Promise<string> {
  const result = await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "read", path },
  });
  return result.kind === "file" ? result.text : "";
}

const bugs = (paths: string[]) => paths.filter((path) => path.includes("/tex-bugs/"));

describe("bug reports by text, as notes in the pinned context", () => {
  test("a texted report becomes a note there, texts included, and nothing goes to Sentry", async () => {
    const { t, pinned } = await world();
    const answer = await report(t, { message: "Search found nothing for a note I know exists.", texts: TEXTS });
    expect(answer.report).toEqual({ eventId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(sentry).toEqual([]);
    const filed = bugs(await notesIn(t, pinned));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatch(/^areas\/tex-bugs\/user\/\d{4}-\d{2}-\d{2} \d{4} search found nothing for a note i know [0-9a-f]{6}\.md$/);
    const note = await readNote(t, pinned, filed[0]!);
    expect(note).toContain("Search found nothing for a note I know exists.");
    expect(note).toContain("Them: find my avocado note");
    expect(note).toContain('from: "@alice-handle"');
    expect(note).toContain(`reference: "${(answer.report as { eventId: string }).eventId}"`);
  });

  test("a report without texts says so", async () => {
    const { t, pinned } = await world();
    await report(t, { message: "The link in your last text did not open." });
    const [path] = bugs(await notesIn(t, pinned));
    const note = await readNote(t, pinned, path!);
    expect(note).toContain("texts: not shared");
    expect(note).not.toContain("avocado");
  });

  test("a person who only reaches the pinned context files under user/, a member under team/", async () => {
    const { t, pinned, alice, staff } = await world();
    await report(t, { message: "first" });
    await addMember(t, pinned, alice, "editor", staff);
    await report(t, { message: "second" });
    const filed = bugs(await notesIn(t, pinned)).sort();
    expect(filed).toHaveLength(2);
    expect(filed.some((path) => path.startsWith("areas/tex-bugs/user/") && path.includes(" first "))).toBe(true);
    expect(filed.some((path) => path.startsWith("areas/tex-bugs/team/") && path.includes(" second "))).toBe(true);
  });

  test("a folder anybody can read through the pin gets nothing, and the report is not counted", async () => {
    const { t, pinned } = await world("team-everywhere");
    expect(await report(t, { message: "x", texts: TEXTS })).toEqual({ report: null, refused: "unavailable" });
    expect(bugs(await notesIn(t, pinned))).toEqual([]);
    expect(JSON.stringify(backend.snapshot())).not.toContain("avocado");
    expect(sentry).toEqual([]);
  });

  test("judged by the access rows, it files privately and refuses a folder opened to every account", async () => {
    const { t, pinned, staff } = await world();
    await judgedByRows(t, pinned);
    expect((await report(t, { message: "rows first", texts: TEXTS })).report).not.toBeNull();
    expect(bugs(await notesIn(t, pinned))).toHaveLength(1);

    await asUser(t, staff).action(api.functions.files.setDirectoryVisibility, { workspaceId: pinned, path: "areas", visibility: "team", accounts: true });
    expect(await report(t, { message: "rows second", texts: TEXTS })).toEqual({ report: null, refused: "unavailable" });
    expect(bugs(await notesIn(t, pinned))).toHaveLength(1);
  });

  test("every real member reads each report, a later one included, and a pin reader does not", async () => {
    const { t, pinned, staff, alice } = await world();
    await judgedByRows(t, pinned);
    const early = await createUser(t, "early@example.invalid");
    await addMember(t, pinned, early, "member", staff);
    expect((await report(t, { message: "shared with the team", texts: TEXTS })).report).not.toBeNull();
    const [path] = bugs(await notesIn(t, pinned));
    const late = await createUser(t, "late@example.invalid");
    await addMember(t, pinned, late, "member", staff);

    const sees = async (userId: Id<"users">) => {
      const names = await t.run((ctx) => grantedNamesFor(ctx, pinned, userId));
      const seen = await t.action(internal.functions.files.runFileOperation, {
        workspaceId: pinned,
        scope: "team",
        grantedNames: names,
        operation: { kind: "visiblePaths", paths: [path!] },
      });
      return seen.kind === "visiblePaths" && seen.paths.length === 1;
    };
    expect(await sees(early)).toBe(true);
    expect(await sees(late)).toBe(true);
    // Alice reaches the pinned context through the pin alone: no membership, no names.
    expect(await sees(alice)).toBe(false);
    const base = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", pinned).eq("path", path!))
        .unique();
      return row?.access?.base;
    });
    expect(base).toBe("private");
  });

  test("once the pinned workspace has moved, a report is base team: every real member reads it, a pin reader does not", async () => {
    const { t, pinned, staff, alice } = await world();
    await judgedByRows(t, pinned);
    await movePinned(t);
    const member = await createUser(t, "moved@example.invalid");
    await addMember(t, pinned, member, "member", staff);
    expect((await report(t, { message: "after the move", texts: TEXTS })).report).not.toBeNull();
    const [path] = bugs(await notesIn(t, pinned));

    const sees = async (userId: Id<"users">) => {
      const { scope, grantedNames } = await t.query(internal.functions.files.authorizeFileAccess, {
        actorUserId: userId,
        workspaceId: pinned,
        minimum: "member",
      });
      const seen = await t.action(internal.functions.files.runFileOperation, {
        workspaceId: pinned,
        scope,
        grantedNames,
        operation: { kind: "visiblePaths", paths: [path!] },
      });
      return seen.kind === "visiblePaths" && seen.paths.length === 1;
    };
    expect(await sees(member)).toBe(true);
    // An ordinary MCP connection of a member holds no names at all, and reads it too: that is the point of `team`.
    const seen = await t.action(internal.functions.files.runFileOperation, {
      workspaceId: pinned,
      scope: "team",
      operation: { kind: "visiblePaths", paths: [path!] },
    });
    expect(seen.kind === "visiblePaths" && seen.paths).toEqual([path]);
    expect(await sees(alice)).toBe(false);
    const state = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", pinned).eq("path", path!))
        .unique();
      const grants = await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect();
      const audited = (await ctx.db.query("auditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", pinned)).collect())
        .filter((event) => event.action === "access.base");
      return { base: row?.access?.base, grants: grants.length, audited: audited.map((event) => event.actorClientId) };
    });
    expect(state).toEqual({ base: "team", grants: 0, audited: ["context_texts"] });
  });

  test("once the pinned workspace has moved, a folder opened to every account still refuses a report", async () => {
    const { t, pinned, staff } = await world();
    await judgedByRows(t, pinned);
    await movePinned(t);
    expect((await report(t, { message: "first", texts: TEXTS })).report).not.toBeNull();
    await asUser(t, staff).action(api.functions.files.setDirectoryVisibility, { workspaceId: pinned, path: "areas", visibility: "team", accounts: true });
    expect(await report(t, { message: "opened", texts: TEXTS })).toEqual({ report: null, refused: "unavailable" });
    expect(bugs(await notesIn(t, pinned))).toHaveLength(1);
  });

  test("once the pinned workspace has moved, a folder open to the members alone takes a report", async () => {
    const { t, pinned, staff } = await world();
    await judgedByRows(t, pinned);
    await movePinned(t);
    expect((await report(t, { message: "first", texts: TEXTS })).report).not.toBeNull();
    await asUser(t, staff).action(api.functions.files.setDirectoryVisibility, { workspaceId: pinned, path: "areas", visibility: "team" });
    expect((await report(t, { message: "members only", texts: TEXTS })).report).not.toBeNull();
    expect(bugs(await notesIn(t, pinned))).toHaveLength(2);
  });

  test("naming the team is audited as Tex acting, not as the owner naming people by hand", async () => {
    const { t, pinned, staff } = await world();
    await judgedByRows(t, pinned);
    const member = await createUser(t, "auditor@example.invalid");
    await addMember(t, pinned, member, "member", staff);
    expect((await report(t, { message: "audited", texts: TEXTS })).report).not.toBeNull();

    const listed = await t.run(async (ctx) =>
      (await ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", pinned))
        .collect()).filter((event) => event.action === "access.list"),
    );
    expect(listed).toHaveLength(1);
    // The owner is the authority the grant is made under; the client is who acted.
    expect(listed[0]!.actorUserId).toEqual(staff);
    expect(listed[0]!.actorClientId).toEqual("context_texts");
  });

  test("another AI's report still goes to Sentry", async () => {
    const { t, pinned, grantA } = await world();
    await t.run((ctx) => ctx.db.patch(grantA, { clientId: "client-not-texts" }));
    // The client row for that id, so the grant still resolves.
    await t.run((ctx) =>
      ctx.db.insert("oauthClients", {
        clientId: "client-not-texts",
        clientName: "Some AI",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      }),
    );
    expect((await report(t, { message: "read_note timed out" })).report).not.toBeNull();
    expect(sentry).toHaveLength(1);
    expect(bugs(await notesIn(t, pinned))).toEqual([]);
  });
});

describe("the note itself", () => {
  test("goes under the folder doing the Areas job, else areas/", () => {
    expect(bugFolder("2-areas", true)).toBe("2-areas/tex-bugs/team");
    expect(bugFolder(null, false)).toBe("areas/tex-bugs/user");
  });

  test("never collides, and its name is plain words", () => {
    const now = Date.UTC(2026, 9, 18, 13, 42);
    expect(bugNotePath("areas/tex-bugs/user", { message: "Can't open ../../secret", eventId: "abcdef0123", now })).toBe(
      "areas/tex-bugs/user/2026-10-18 1342 can t open secret abcdef.md",
    );
  });

  test("renders nothing the person or the model wrote: no link, image or fence escape", () => {
    const note = renderBugNote({
      message: "![x](https://tracker.example.invalid/p.png) broke\n```\n# not a heading",
      texts: "Them: ````\nTex: [click](https://example.invalid)",
      handle: "alfa",
      team: false,
      eventId: "e",
      now: 0,
    });
    expect(note).toContain("# x https://tracker.example.invalid/p.png broke\n");
    // The texts' four backticks are inside a five-backtick fence.
    expect(note).toContain("`````text\nThem: ````\nTex: [click](https://example.invalid)\n`````");
    expect(note).toContain("````text\n![x](https://tracker.example.invalid/p.png) broke\n```\n# not a heading\n````");
  });
});

/**
 * `fileBugNote` on its own, with the control plane stubbed: the sharing step
 * is the last thing it does, and what it does when that step fails is not
 * reachable through the gateway route.
 */
describe("a report that is filed but cannot be shared", () => {
  const where = { workspaceId: "w1" as Id<"workspaces">, folder: "areas/tex-bugs/user", handle: null, team: false, pinReaders: [] };

  function stub(runMutation: () => Promise<boolean>) {
    const written: string[] = [];
    return {
      written,
      ctx: {
        runAction: async (_ref: unknown, args: { operation: { kind: string; path?: string } }) => {
          if (args.operation.kind === "visiblePaths") return { kind: "visiblePaths", paths: [] };
          written.push(args.operation.path ?? "");
          return { kind: "ok" };
        },
        runMutation,
      },
    };
  }

  test("a refused grant leaves the report filed", async () => {
    const { ctx, written } = stub(async () => false);
    expect(await fileBugNote(ctx as never, where, { message: "refused", eventId: "abcdef", now: 0 })).toBe(true);
    expect(written).toHaveLength(1);
  });

  test("a grant that throws leaves the report filed, not reported as unsent", async () => {
    const { ctx, written } = stub(async () => {
      throw new Error("the members could not be read");
    });
    // The note with the person's texts is already in the bucket. Calling that
    // "not sent" releases their budget, tells them to try again, and files a
    // second copy of the same texts.
    expect(await fileBugNote(ctx as never, where, { message: "threw", eventId: "abcdef", now: 0 })).toBe(true);
    expect(written).toHaveLength(1);
  });
});
