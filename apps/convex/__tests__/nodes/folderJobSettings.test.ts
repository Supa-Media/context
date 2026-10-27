/**
 * Which folder does each built-in job, chosen by a person or an AI client
 * (owner, 2026-10-18, `docs/decisions/app-and-console/folder-jobs.md`):
 * `builtInFolders.jobs` / `builtInFolders.setJob`, `decideJobChange`, and the
 * guesses offered after an import (`guessFolderJobs`).
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - `writeJob` not marking the old holder `NO_JOB`: "giving Projects to a
 *    nested folder leaves the old one doing nothing, even by its name";
 *  - `jobs` returning paths unfiltered: "a member never learns where a
 *    private folder doing a job is";
 *  - `setJob` asking for `editor` instead of `owner`: "only an owner changes
 *    a job".
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { folderJobsOf } from "../../functions/lib/nodes/folderJobs";
import { decideJobChange, isRefusal } from "../../functions/lib/nodes/folderJobSettings";
import { folderJobs } from "@context/shared/src/folderRoles.cjs";
import { guessFolderJobs } from "@context/shared/src/folderJobInfo.cjs";
import { OWNER, fixture, type Fixture } from "./moveFixture.helpers";
import type { FileStore } from "../../functions/lib/fileOps/store";
import { assertNotProtectedFolder } from "../../functions/lib/fileOps/nameTwins";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { keyedFixture } from "./keyedFixture.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

/** A live folder row at `path`, its parent row already there. */
async function addFolder(f: Fixture, path: string, role?: string): Promise<void> {
  await f.t.run(async (ctx) => {
    const slash = path.lastIndexOf("/");
    let parentId: Id<"nodes"> | undefined;
    if (slash >= 0) {
      const parent = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", path.slice(0, slash)))
        .unique();
      parentId = parent!._id;
    }
    await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      path,
      name: path.slice(slash + 1),
      kind: "folder",
      observedAt: 1,
      ...(parentId === undefined ? {} : { parentId }),
      ...(role === undefined ? {} : { role }),
    });
  });
}

/** The live row at `path`, as the database holds it. */
async function rowOf(f: Fixture, path: string): Promise<Doc<"nodes">> {
  const row = await f.t.run(
    async (ctx) => await treeNodeAt(ctx.db, f.ws, path),
  );
  return row!;
}

async function jobsNow(f: Fixture) {
  return (await f.t.run(async (ctx) => await folderJobsOf(ctx.db, f.ws))).jobs;
}

const empty = folderJobs([]);
const folderAt = () => true;

describe("decideJobChange", () => {
  test("refuses Website, an unknown job, taking a needed job away, a nested Archive and an Inbox folder", () => {
    const withInbox = folderJobs([{ path: "Inbox", name: "Inbox", top: true, role: "inbox" }]);
    const refused = (value: ReturnType<typeof decideJobChange>) => (isRefusal(value) ? value.message : "went ahead");
    expect(refused(decideJobChange(empty, "website", "Site", folderAt))).toMatch(/site is published from it/);
    expect(refused(decideJobChange(empty, "recipes", "Food", folderAt))).toMatch(/no "recipes" job.*inbox, projects.*about\.md/);
    expect(refused(decideJobChange(empty, "projects", null, folderAt))).toMatch(/Projects is needed/);
    expect(refused(decideJobChange(empty, "archive", "Life/Old", folderAt))).toMatch(/Archive stays at the top/);
    expect(refused(decideJobChange(withInbox, "clients", "Inbox/email", folderAt))).toMatch(/Inbox's own/);
    expect(refused(decideJobChange(withInbox, "projects", "Inbox", folderAt))).toMatch(/already your Inbox folder/);
    expect(refused(decideJobChange(empty, "projects", "Nope", () => false))).toMatch(/no folder there/);
  });

  test("moves a job: the old folder stops, the new one starts; asking again changes nothing", () => {
    const jobs = folderJobs([{ path: "1-projects", name: "1-projects", top: true }]);
    expect(decideJobChange(jobs, "projects", "Work/Projects", folderAt)).toEqual({ clear: ["1-projects"], set: "Work/Projects" });
    expect(decideJobChange(jobs, "projects", "1-projects", folderAt)).toEqual({ clear: [], set: null });
    expect(decideJobChange(empty, "tex", "Life/Assistant", folderAt)).toEqual({ clear: [], set: "Life/Assistant" });
  });
});

describe("guessFolderJobs", () => {
  test("an imported vault's folders are guessed with a reason, shallowest first", () => {
    const folders = ["00 Inbox", "Work", "Work/Projects", "Reference", "Archives", "Life", "Life/Areas", "Old/Projects"].map((path) => ({ path }));
    const guesses = guessFolderJobs(folders, folderJobs([]));
    expect(guesses).toEqual([
      { job: "inbox", path: "00 Inbox", why: "name says Inbox" },
      { job: "projects", path: "Old/Projects", why: "nested, name says Projects" },
      { job: "areas", path: "Life/Areas", why: "nested, name says Areas" },
      { job: "resources", path: "Reference", why: "another word for Resources" },
      { job: "archive", path: "Archives", why: "another word for Archive" },
    ]);
  });

  test("never guesses a folder a person said does no job, a nested Archive, or one past three levels", () => {
    const folders = [
      { path: "Projects", role: "none" },
      { path: "Life/Archive" },
      { path: "a/b/c/Resources" },
    ];
    expect(guessFolderJobs(folders, folderJobs([]))).toEqual([]);
  });
});

describe("builtInFolders.jobs and setJob", () => {
  test("an owner gives an imported vault's folders their jobs, and nothing is guessed twice", async () => {
    const f = await fixture();
    await addFolder(f, "00 Inbox");
    await addFolder(f, "Library");
    const before = await f.owner.action(api.functions.builtInFolders.jobs, { workspaceId: f.ws });
    // Resources is already `3-resources`, so `Library` is not offered for it.
    expect(before.guesses).toEqual([{ job: "inbox", path: "00 Inbox", why: "name says Inbox" }]);
    expect(before.missingNeeded).toContain("inbox");
    expect(before.jobs.find((job) => job.job === "inbox")).toMatchObject({ group: "needed", canChange: true, canRemove: false });

    await f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "inbox", path: "00 Inbox" });
    const after = await f.owner.action(api.functions.builtInFolders.jobs, { workspaceId: f.ws });
    expect(after.jobs.find((job) => job.job === "inbox")?.path).toBe("00 Inbox");
    expect(after.guesses.map((guess) => guess.job)).not.toContain("inbox");
    expect(after.missingNeeded).not.toContain("inbox");
    expect(after.inboxParts.map((part) => part.name)).toContain("email");
  });

  test("giving Projects to a nested folder leaves the old one doing nothing, even by its name", async () => {
    const f = await fixture();
    await addFolder(f, "Work");
    await addFolder(f, "Work/Projects");
    await f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "projects", path: "Work/Projects" });
    expect((await jobsNow(f)).projects).toBe("Work/Projects");
    expect((await rowOf(f, "1-projects")).role).toBe("none");
    expect((await rowOf(f, "Work/Projects")).role).toBe("projects");
  });

  test("Tex's folder can live nested anywhere, and an optional job can be taken away", async () => {
    const f = await fixture();
    await addFolder(f, "Life");
    await addFolder(f, "Life/Assistant");
    await addFolder(f, "Clients", "clients");
    await f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "tex", path: "Life/Assistant" });
    await f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "clients", path: null });
    const jobs = await jobsNow(f);
    expect(jobs.tex).toBe("Life/Assistant");
    expect(jobs.clients).toBeNull();
    expect((await rowOf(f, "Clients")).role).toBe("none");
  });

  test("refusals reach the caller in words, and change nothing", async () => {
    const f = await fixture();
    await addFolder(f, "Life");
    await addFolder(f, "Life/Old");
    await expect(
      f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "archive", path: "Life/Old" }),
    ).rejects.toThrow(/Archive stays at the top/);
    await expect(
      f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "resources", path: "1-projects" }),
    ).rejects.toThrow(/already your Projects folder/);
    expect((await jobsNow(f)).projects).toBe("1-projects");
  });

  test("only an owner changes a job", async () => {
    const f = await fixture();
    // A folder the member can see (`1-projects` is team), so only the role refuses.
    await expect(
      f.member.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "clients", path: "1-projects/launch" }),
    ).rejects.toThrow();
    expect((await jobsNow(f)).clients).toBeNull();
  });

  test("a member never learns where a private folder doing a job is, and is offered no changes", async () => {
    const f = await fixture();
    // `1-projects/secret` is private in the fixture.
    await f.owner.action(api.functions.builtInFolders.setJob, { workspaceId: f.ws, job: "tex", path: "1-projects/secret" });
    const seen = await f.member.action(api.functions.builtInFolders.jobs, { workspaceId: f.ws });
    expect(seen.jobs.find((job) => job.job === "tex")?.path).toBeNull();
    expect(seen.jobs.find((job) => job.job === "projects")?.path).toBe("1-projects");
    expect(seen.jobs.every((job) => !job.canChange && !job.canRemove)).toBe(true);
    expect(seen.guesses).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("secret");
  });
});

describe("the Inbox's own folders", () => {
  test("stay where they are wherever the Inbox is, while folders of a person's own beside them move freely", async () => {
    const f = await keyedFixture();
    await addFolder(f, "Capture", "inbox");
    await addFolder(f, "Capture/email");
    await addFolder(f, "Capture/ideas");
    // As the move barrier asks it: of the tree, on a store of its own.
    const named = Object.create(f.store) as FileStore;
    attachTreeListing(f.ctx, f.ws, named);
    const guarded = (path: string, intent: "move" | "remove") =>
      assertNotProtectedFolder(named, path, OWNER, intent).then(
        () => "allowed",
        (error: Error) => error.message,
      );
    expect(await guarded("Capture/email", "move")).toMatch(/Email is one of the Inbox's own folders/);
    expect(await guarded("Capture/email", "remove")).toBe("allowed");
    expect(await guarded("Capture/ideas", "move")).toBe("allowed");
    expect(await guarded("Capture/email/2026", "move")).toBe("allowed");
  });
});

describe("Tex's own folders (owner, 2026-10-21)", () => {
  test("stay where they are wherever Tex's folder is, while folders of a person's own beside them move freely", async () => {
    const f = await keyedFixture();
    await addFolder(f, "Assistant", undefined);
    await addFolder(f, "Assistant/tex", "tex");
    await addFolder(f, "Assistant/tex/transcripts");
    await addFolder(f, "Assistant/tex/trips");
    await addFolder(f, "Work");
    await addFolder(f, "Work/skills");
    const named = Object.create(f.store) as FileStore;
    attachTreeListing(f.ctx, f.ws, named);
    const guarded = (path: string, intent: "move" | "remove") =>
      assertNotProtectedFolder(named, path, OWNER, intent).then(
        () => "allowed",
        (error: Error) => error.message,
      );
    expect(await guarded("Assistant/tex/transcripts", "move")).toMatch(/transcripts is one of Tex's own folders/);
    expect(await guarded("Assistant/tex/transcripts", "remove")).toBe("allowed");
    expect(await guarded("Assistant/tex/trips", "move")).toBe("allowed");
    expect(await guarded("Work/skills", "move")).toBe("allowed");
  });
});
