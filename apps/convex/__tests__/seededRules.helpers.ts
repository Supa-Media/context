/**
 * Test-only seeding of access rules, for fixtures that used to write `privacy.md`.
 *
 * Access is kept on the tree's rows and `privacy.md` is no longer written by the
 * product (`docs/decisions/storage-and-credentials/notes-by-id.md`). Fixtures still
 * seed the rules as the file text, because that is the shape a customer's bucket
 * held and the shape these tests were written against. This file is where that
 * text becomes data:
 *
 * - `translateSeededRules` / `translateBucketRules` read a seeded `privacy.md`,
 *   set the equivalent rows through the product as the owner
 *   (`files.setDirectoryVisibility`, `setNoteVisibility`, `setFolderGroup`,
 *   `setNoteGroup`), then delete the file. Called at the end of `copyTree` and the
 *   other fixture builders, so a test's seeding calls are unchanged.
 * - `setFolderVisibility`, `setVisibility`, `setExactVisibility` and
 *   `ensureFolderVisibility` edit the seeded text on a store (a `MemoryStore` or
 *   `MemoryS3`) for the store-level suites that have no Convex side. They are
 *   not product code and nothing in `functions/` imports them.
 *
 * The renderers at the top are the deleted `lib/scaffold/privacyManifest.ts`,
 * kept here so a fixture still starts from the same text it always did.
 */

import {
  PRIVACY_KEY,
  effectiveVisibility,
  nextOverrides,
  isGroupScope,
  parsePrivacyManifest,
  renderPrivacyRulesBlock,
  replacePrivacyRulesBlock,
  visibilityOf,
  type PrivacyRule,
  type Visibility,
} from "../functions/lib/privacy";
import { INDEX_KEY, PARA_FOLDERS, type ContextKind, type CustomFolder, type StructureTemplate } from "../functions/lib/scaffold/store";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { TestConvex } from "./fixtures.helpers";
import { bucketView, type RulesSource } from "./bucketRegistry.helpers";


/* -------------------------------------------------------------------------- */
/*                              privacy.md                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render the block the gateway parses.
 *
 * The renderer itself now lives in `lib/privacy.ts`, which is also what the
 * console's visibility controls rewrite the manifest with. One renderer, so a
 * file this module creates and a file a later visibility change rewrites are
 * byte-identical in everything but the rules — no spurious whole-file diff
 * appearing in the customer's Obsidian vault the first time they share a
 * folder. The markers moved there with it; they are on-bucket format, so the
 * legacy "BRAIN" wording stays even though the word is retired from the
 * product's copy (2026-09-13). Changing it is a storage-layout migration.
 */
function renderStartingRulesBlock(
  folderDefaults: readonly string[],
  vis: Visibility,
  overrides: ReadonlyMap<string, Visibility>,
): string {
  return renderPrivacyRulesBlock(
    folderDefaults.map((folder) => ({ prefix: folder, vis })),
    overrides,
  );
}

/**
 * The exact-note rules a fresh context needs, which is one and only for a
 * workspace: **`index.md`**.
 *
 * ## Why a folder default cannot reach it
 *
 * `folder_defaults` are prefix rules and `index.md` is at the **root**, under
 * no prefix at all. So it matches nothing, falls through to
 * `default_visibility: private`, and a `team`-scope read of it returns not
 * found — which is precisely the bug the folder work missed. Making the
 * folders `team` and stopping there produced a workspace whose members can
 * read every note in it and cannot read the page that says what it is.
 *
 * That is worse than it sounds, because `index.md` is not an ordinary note. It
 * is the **front page every connected agent reads first**: the gateway gates
 * its whole orientation on `canSee("index.md", …)`, so a member's client got a
 * bare folder map with no statement of what the workspace is for or how it is
 * organised — and the fix was a line in a file they had no reason to open.
 *
 * ## Why an exact-note override is the right instrument and not a workaround
 *
 * `note_overrides` exists for exactly this: one named `.md` file whose
 * visibility differs from what its surroundings imply. Nothing else would do
 * the job — a `""` folder rule would open the entire bucket, and lifting
 * `default_visibility` to `team` would open every path nobody has ruled on,
 * including folders somebody adds next month. This opens one file, by name,
 * and it is a file **we wrote**: at the moment the manifest is rendered
 * `index.md` is the scaffolder's own text about the layout the scaffolder just
 * laid down, with nothing of the customer's in it.
 *
 * ## Personal contexts get nothing here, deliberately
 *
 * A workspace's `index.md` is its owner's own manifest and may describe anything;
 * publishing it to everyone they later share a folder with is not ours to
 * decide. A workspace stays all-private at the root as well as in its folders, and
 * `renderPrivacyManifestForFolders`' `personal` default keeps the repair path
 * out of this too.
 */
function startingOverrides(kind: ContextKind): Map<string, Visibility> {
  const overrides = new Map<string, Visibility>();
  if (kind === "shared") overrides.set(INDEX_KEY, "team");
  return overrides;
}

/**
 * What a fresh context's folders default to, which depends on what kind of
 * context it is.
 *
 * ## A personal workspace starts `private`, and that is the sensible default
 *
 * `team` does not mean public — it means named people the owner has granted
 * access to — but a workspace that has just been created has granted nobody
 * anything, so there is no correct set of folders to open up.
 *
 * ## A shared workspace starts `team`, and all-private would have been a bug
 *
 * A workspace exists *because* several people are in it; a workspace whose
 * every folder is private is a context its members connect to and find empty.
 * And not merely thin: `clampScopes` lets only an `owner` hand a client the
 * `context:private` scope, so an `editor` or a `member` cannot reach a private
 * note **at all**, by any grant they are able to issue. Scaffolding a shared
 * workspace all-private therefore ships it broken — every invitation the owner
 * sends lands somebody in an empty context, and the fix is a file they have to
 * know to edit.
 *
 * This is not a third tier and it does not widen anything. `team` is still
 * exactly "the named people in this workspace": at the moment the layout is
 * written the workspace has one member — the owner who just created it — so a
 * `team` default discloses nothing to anybody. What it does is make the next
 * invitation mean what the person sending it thinks it means.
 *
 * `default_visibility` stays `private` in both files (it is fixed in
 * `renderPrivacyRulesBlock`), so a path **outside** the declared folders still
 * fails closed on a shared workspace. Only the folders the scaffolder itself
 * created are opened, and only to that workspace's members.
 */
function startingVisibility(kind: ContextKind): Visibility {
  return kind === "shared" ? "team" : "private";
}

/**
 * The access manifest for a brand-new context.
 *
 * Declaring each folder explicitly (rather than leaving `folder_defaults`
 * empty and relying on `default_visibility`) is what makes the file editable:
 * a person who wants to change what one folder does changes one word on one
 * line, instead of having to know the syntax for adding a rule.
 *
 * What that one word starts as is `startingVisibility`'s decision — read it
 * before changing either branch.
 */
export function renderPrivacyManifest(
  template: StructureTemplate,
  customFolders: readonly CustomFolder[] = [],
  kind: ContextKind = "personal",
): string {
  const folders =
    template === "para"
      ? [...PARA_FOLDERS]
      : customFolders.map((entry) => entry.folder);
  return renderPrivacyManifestForFolders(folders, kind);
}

/**
 * The same manifest, for a folder list nobody chose from a template.
 *
 * Split out for `resetPrivacyManifest` in `lib/fileOps.ts`, which repairs a
 * bucket whose `privacy.md` is missing or unparseable and therefore has to
 * declare the folders that are *actually there* rather than the five PARA ones
 * a scaffold would have written. One renderer for both, so a repaired manifest
 * and a scaffolded one are the same file — the reason `renderStartingRulesBlock`
 * was shared with the console's visibility controls in the first place.
 *
 * **The repair path never passes `kind`, and must not start.** `kind` defaults
 * to `personal`, so `resetPrivacyManifest` renders every folder `private` — the
 * caller is always replacing a manifest that was failing closed, and all-private
 * is the only rewrite under which nothing changes hands. Passing `"shared"` here
 * would make repairing a typo a way to publish a whole bucket to every member,
 * which is why the argument is the *scaffolder's* and not the repairer's: a
 * fresh workspace has one member and nothing in it, and a workspace being
 * repaired has neither of those properties. The default is what keeps the two
 * apart, so a call site that adds a `kind` argument here is the bug.
 */
export function renderPrivacyManifestForFolders(
  folders: readonly string[],
  kind: ContextKind = "personal",
): string {
  const vis = startingVisibility(kind);
  const shared = kind === "shared";
  return [
    "---",
    "role: privacy-manifest",
    "version: 1",
    "---",
    "",
    "# Access map",
    "",
    "This file decides what a connected AI client is allowed to see. It lives in",
    // Wrapped to the same width as everything else in this file: it is Markdown
    // somebody reads in Obsidian, and one long line among short ones is visible.
    shared
      ? "this workspace's bucket, it is readable in Obsidian, and anyone with"
      : "your bucket, it is readable in Obsidian, and you can edit it by hand.",
    ...(shared ? ["access to the bucket can edit it by hand."] : []),
    "",
    shared
      ? "- `private` — this workspace's owners, and nothing else. An editor or a"
      : "- `private` — only you. This is the default for everything.",
    ...(shared
      ? [
          "  member cannot reach a private note at all, however they connect.",
          "- `team` — every member of this workspace. This is the default for",
          "  everything below. It is never public: there is no anonymous tier.",
        ]
      : [
          "- `team` — you, plus the specific people you have granted access to. It is",
          "  never public: there is no anonymous tier.",
        ]),
    "",
    "A rule under `folder_defaults` applies to that folder and everything under",
    "it; the longest matching rule wins. A rule under `note_overrides` names one",
    "exact `.md` file and beats its folder.",
    "",
    shared
      ? "Everything below starts team, because a workspace exists to be read by the"
      : "Everything below starts private. To share a folder, change its `private` to",
    shared
      ? "people in it. To hold a folder back to owners, change its `team` to `private`."
      : "`team`.",
    ...(shared
      ? [
          "",
          "Anything **not** listed below is private, including a folder somebody adds",
          "later. Add a line for it here when it should be readable by the workspace.",
          "",
          "`index.md` is listed by name under `note_overrides` because it sits at the",
          "root, under no folder, so no folder rule can reach it. It is the front page",
          "every connected client reads first: hold it back and this workspace has no",
          "description of itself for anybody but its owners.",
        ]
      : []),
    "",
    renderStartingRulesBlock(folders, vis, startingOverrides(kind)),
    "",
  ].join("\n");
}


/* -------------------------------------------------------------------------- */
/*                         seeding on a store (text)                          */
/* -------------------------------------------------------------------------- */

/** The minimal store surface the seeders need: text in, text out, under `privacy.md`. */
export interface SeedableStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, body: string): Promise<unknown>;
}

async function readRules(store: SeedableStore): Promise<{ text: string; rules: PrivacyRule[]; overrides: ReadonlyMap<string, Visibility> }> {
  const object = await store.get(PRIVACY_KEY);
  const text = object === null ? renderPrivacyManifest("para") : await object.text();
  const manifest = parsePrivacyManifest(text);
  return { text, rules: manifest.rules, overrides: manifest.overrides };
}

async function writeRules(store: SeedableStore, text: string, rules: PrivacyRule[], overrides: ReadonlyMap<string, Visibility>): Promise<void> {
  await store.put(PRIVACY_KEY, replacePrivacyRulesBlock(text, rules, overrides));
}

export interface SeededVisibility {
  path: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
}

/** Set a folder's default in the seeded text. Every note under it without an exception of its own follows. */
export async function setFolderVisibility(
  store: SeedableStore,
  options: { path: string; visibility: Visibility; clearance?: unknown },
): Promise<SeededVisibility> {
  const current = await readRules(store);
  const rules = current.rules.filter((rule) => rule.prefix !== options.path);
  rules.push({ prefix: options.path, vis: options.visibility });
  await writeRules(store, current.text, rules, current.overrides);
  const inherited = visibilityOf(options.path, rules);
  return { path: options.path, visibility: options.visibility, inherited, exception: false };
}

/** Set one note's visibility in the seeded text. Matching its folder's default removes the exception. */
export async function setVisibility(
  store: SeedableStore,
  options: { path: string; visibility: Visibility; clearance?: unknown },
): Promise<SeededVisibility> {
  await setExactVisibility(store, options.path, options.visibility);
  const current = await readRules(store);
  const inherited = visibilityOf(options.path, current.rules);
  const visibility = effectiveVisibility(options.path, current.rules, current.overrides);
  return { path: options.path, visibility, inherited, exception: visibility !== inherited };
}

/** Set one exact-note override in the seeded text. */
export async function setExactVisibility(
  store: SeedableStore,
  path: string,
  visibility: Visibility,
): Promise<{ path: string }> {
  const current = await readRules(store);
  const overrides = nextOverrides(path, visibility, current.rules, current.overrides);
  await writeRules(store, current.text, current.rules, overrides);
  return { path };
}

/** Give a folder a default only when the seeded text has no rule for it yet. */
export async function ensureFolderVisibility(
  store: SeedableStore,
  options: { path: string; visibility: Visibility },
): Promise<{ changed: boolean }> {
  const current = await readRules(store);
  if (current.rules.some((rule) => rule.prefix === options.path)) return { changed: false };
  await setFolderVisibility(store, options);
  return { changed: true };
}

/* -------------------------------------------------------------------------- */
/*                        translating into the rows                           */
/* -------------------------------------------------------------------------- */

/**
 * Who a seeded rule is written as: the workspace's owner, or, for a fixture that never made a membership row, the
 * person who created the workspace. Only the audit trail reads the name; the rows writer checks nothing about it.
 */
async function ownerOf(t: TestConvex, workspaceId: Id<"workspaces">): Promise<Id<"users">> {
  const found = await t.run(async (ctx) => {
    const member = (await ctx.db.query("workspaceMembers").collect()).find(
      (row) => row.workspaceId === workspaceId && row.role === "owner",
    );
    if (member !== undefined) return member.userId;
    return (await ctx.db.get(workspaceId))?.createdBy ?? null;
  });
  if (found === null) throw new Error("a seeded privacy.md needs a workspace with an owner to translate it");
  return found;
}

/**
 * The rows writer the console's own visibility actions call (`nodesAccess.consoleAccess`), after their
 * owner check. The translator calls it directly so a fixture with no bucket bound (the store-level move suites)
 * can still carry its rules into the rows: the storage check the public actions make is not what is under test here.
 */
async function writeRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  actorUserId: Id<"users">,
  change: { path: string; kind: "note" | "folder"; tier?: "private" | "team"; group?: string },
): Promise<void> {
  const answer = await t.mutation(internal.functions.nodesAccess.consoleAccess, { workspaceId, actorUserId, ...change });
  if (answer.ok) return;
  if (answer.code !== "NOT_FOUND" || change.tier === undefined) {
    throw new Error(`seeded rule for ${change.path} refused: ${answer.code}`);
  }
  // A rule for a path with no row yet is what the file mode allowed (a rule waiting for a note to arrive): the rows
  // hold it as pending, and the row is born with the access when the path is written (`lib/nodes/pendingAccess.ts`).
  await t.mutation(internal.functions.nodesAccess.setAccess, {
    workspaceId,
    path: change.path,
    base: change.tier,
    kind: change.kind === "note" ? "file" : "folder",
    actor: { userId: actorUserId, role: "owner" },
  });
}

/**
 * Read a seeded `privacy.md` from `source`, set its rules as rows through the product's rows writer as the owner, and
 * delete the file.
 */
export async function translateSeededRules(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  source: RulesSource,
): Promise<void> {
  const text = await source.text();
  if (text === null) return;
  const manifest = parsePrivacyManifest(text);
  await applyRules(t, workspaceId, manifest.rules, manifest.overrides);
  await source.remove();
}

/**
 * A rules mirror as a test seeded it (the shape the old `nodes.savePrivacy` took: folders and notes, and `invalid`
 * for a file that did not parse, which applies nothing). Translated the same way as a seeded `privacy.md`.
 */
export async function translateMirror(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  mirror: {
    invalid?: boolean;
    folders: readonly { prefix: string; visibility: string }[];
    notes: readonly { path: string; visibility: string }[];
  },
): Promise<void> {
  if (mirror.invalid === true) return;
  const rules: PrivacyRule[] = mirror.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility as Visibility }));
  const overrides = new Map<string, Visibility>(mirror.notes.map((note) => [note.path, note.visibility as Visibility]));
  await applyRules(t, workspaceId, rules, overrides);
}

async function applyRules(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): Promise<void> {
  const actor = await ownerOf(t, workspaceId);
  const groupOf = async (name: string) => {
    const resolved = await t.query(internal.functions.files.namedAudience, { workspaceId, name: name.replace(/^@/, "") });
    if (resolved === null) throw new Error(`seeded rule names ${name}, which is not a group of this workspace`);
    return resolved;
  };
  for (const rule of [...rules].sort((a, b) => a.prefix.length - b.prefix.length)) {
    if (isGroupScope(rule.vis)) {
      await writeRow(t, workspaceId, actor, { path: rule.prefix, kind: "folder", group: await groupOf(rule.vis) });
    } else {
      await writeRow(t, workspaceId, actor, { path: rule.prefix, kind: "folder", tier: rule.vis as "private" | "team" });
    }
  }
  for (const [path, vis] of overrides) {
    if (isGroupScope(vis)) {
      await writeRow(t, workspaceId, actor, { path, kind: "note", group: await groupOf(vis) });
    } else {
      await writeRow(t, workspaceId, actor, { path, kind: "note", tier: vis as "private" | "team" });
    }
  }
}

/**
 * The fixture hook: translate the `privacy.md` a workspace's bucket holds (the bucket it is bound to, when a test
 * seeded one through `memoryS3`). Nothing to do when the bucket holds none.
 */
export async function translateBucketRules(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  const binding = await t.run((ctx) =>
    ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first(),
  );
  const bucket = binding?.bucket;
  if (bucket === undefined) return;
  const view = bucketView(bucket);
  if (view === undefined) return;
  await translateSeededRules(t, workspaceId, view.rulesSource(PRIVACY_KEY));
}

/* -------------------------------------------------------------------------- */
/*                 the renderers (deleted from production)                    */
/* -------------------------------------------------------------------------- */
