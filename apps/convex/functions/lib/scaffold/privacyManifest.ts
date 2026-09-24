/**
 * Rendering a fresh context's `privacy.md`.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { renderPrivacyRulesBlock, type Visibility } from "../privacy";
import { INDEX_KEY, PARA_FOLDERS, type ContextKind, type CustomFolder, type StructureTemplate } from "./store";

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
