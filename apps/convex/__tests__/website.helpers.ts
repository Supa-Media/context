/**
 * One enabled website over an in-memory bucket, shared by the resolution
 * suites: an owner, a member, a stranger with a workspace of their own, and a
 * site whose route index has been built once.
 */

import { vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  drainDueScheduled,
  readIntoTree,
  seedStorageBinding,
  setupTest,
  type TestConvex,
  copyTree,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

export interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: ReturnType<typeof memoryS3>;
}

export async function fixture(slug = "atlas"): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const member = await createUser(t, `${slug}-member@example.invalid`);
  const stranger = await createUser(t, `${slug}-stranger@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug, {
    displayName: slug === "atlas" ? "Atlas Studio" : slug,
  });
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, `${slug}-elsewhere`);
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", `# ${slug}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, member, stranger, workspaceId, backend };
}

/**
 * What turning a website on writes to `privacy.md`: the `website/` folder at
 * `team`, which is the only thing that lets the site serve a page.
 */
export async function publishWebsiteFolder(
  t: TestConvex,
  owner: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  // The folder must have its row before the console can set it: the tree is copied first, as production does.
  await copyTree(t, workspaceId);
  // A site with no page yet has no `website` row, so there is no folder to set: the console answers "does not exist".
  const folder = await t.run((ctx) =>
    treeNodeAt(ctx.db, workspaceId, "website"),
  );
  if (folder === null) return;
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "website",
    visibility: "team",
  });
}

export async function publish(f: Fixture): Promise<void> {
  // A site needs a page in its folder before the folder can be published: a home page the caller has not written is written here.
  await copyTree(f.t, f.workspaceId);
  const folder = await f.t.run((ctx) =>
    treeNodeAt(ctx.db, f.workspaceId, "website"),
  );
  if (folder === null) await writeNote(f, "website/index.md", "---\ntitle: Home\n---\n\nHome\n");
  await publishWebsiteFolder(f.t, f.owner, f.workspaceId);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("websiteStates", {
      workspaceId: f.workspaceId,
      state: "enabled",
      enabledAt: Date.now(),
      enabledBy: f.owner,
      publicationRuleEnsuredAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  // What was seeded before keying reaches the tree, with each note's front matter
  // read into its facts, as the first walk and fact fill of a real workspace do.
  await readIntoTree(f.t, f.workspaceId);
  await asUser(f.t, f.owner).action(
    api.functions.websites.refreshRouteStatuses,
    { workspaceId: f.workspaceId },
  );
}

/** Someone pressing Publish: what the folder holds now becomes the site. */
export async function pressPublish(f: Fixture, as: Id<"users"> = f.owner) {
  await readIntoTree(f.t, f.workspaceId);
  return await asUser(f.t, as).action(api.functions.websites.publish, {
    workspaceId: f.workspaceId,
  });
}

/**
 * A product write of one note, as its owner unless `as` says otherwise. Once a
 * workspace is keyed this is the only way a test changes a note: a bucket
 * object written at a path is never read again.
 *
 * A write over an existing note passes the version the editor read, as the
 * console does; a path with no note yet is created.
 */
export async function writeNote(
  f: Pick<Fixture, "t" | "owner" | "workspaceId">,
  path: string,
  text: string,
  as: Id<"users"> = f.owner,
): Promise<string> {
  const current = await asUser(f.t, as)
    .action(api.functions.files.readNote, { workspaceId: f.workspaceId, path })
    .catch(() => null);
  const written = await asUser(f.t, as).action(api.functions.files.writeNote, {
    workspaceId: f.workspaceId,
    path,
    text,
    ...(current === null ? {} : { expectedEtag: current.etag }),
  });
  // The write's tree touch and fact fill are scheduled in production: run the due ones.
  await drainDueScheduled(f.t);
  return written.etag;
}

/** A product trash of one note, as its owner. The note leaves the tree; its copies stay. */
export async function trashNote(
  f: Pick<Fixture, "t" | "owner" | "workspaceId">,
  path: string,
  as: Id<"users"> = f.owner,
): Promise<void> {
  await asUser(f.t, as).action(api.functions.files.trashEntry, {
    workspaceId: f.workspaceId,
    path,
  });
  await drainDueScheduled(f.t);
}

/** One note's markdown, read through the product as its owner. */
export async function readNoteText(
  f: Pick<Fixture, "t" | "owner" | "workspaceId">,
  path: string,
): Promise<string> {
  const file = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
    workspaceId: f.workspaceId,
    path,
  });
  return file.text;
}

/**
 * The bucket key a note's body is stored at: `notes/<noteId>.md`, from the
 * note's tree row. A test that asks whether a note's bytes were opened, or that
 * writes them the way a gateway does, names the note by this key.
 */
export async function bodyKeyOf(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<string> {
  const noteId = await t.run(async (ctx) => {
    const row = (await ctx.db.query("nodes").collect()).find(
      (node) => node.workspaceId === workspaceId && node.path === path,
    );
    return row?.noteId;
  });
  if (noteId === undefined) throw new Error(`no tree row for ${path}`);
  return `notes/${noteId}.md`;
}
