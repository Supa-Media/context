/**
 * Laying down a starting context in a bucket that does not have one.
 *
 * ## What this is allowed to do
 *
 * Write a handful of Markdown files at the root of the customer's bucket, with
 * **no key namespacing of any kind**. A note lives at `1-projects/foo.md`; the
 * manifest lives at `index.md`; the privacy manifest lives at `privacy.md`.
 * There is no `tenants/<id>/` and no `workspaces/<slug>/` — see CLAUDE.md,
 * "Tenancy is bucket-level, never prefix-level". The one prefix that ever
 * applies is the customer's own `rootPrefix`, and that is handled inside the
 * storage adapter, invisibly to everything here.
 *
 * ## What this is NOT allowed to do
 *
 * **Overwrite anything.** The primary case for connecting a bucket is not a
 * fresh one — it is an existing brain that has been running for months and
 * must come across with zero migration and zero visible change. Scaffolding
 * such a bucket would, at best, replace a hand-curated `index.md`; at worst it
 * would replace `privacy.md` and silently reset every folder's visibility.
 *
 * So there are two independent guards, and either one alone would be enough:
 *
 *  1. **Layout detection.** Before writing anything, look at the bucket. If it
 *     already contains any non-plumbing object, this is somebody's context and
 *     we do not touch it.
 *  2. **Per-key existence.** Every single write is preceded by a `get`, and a
 *     key that already exists is skipped. Belt and braces, because guard 1 is
 *     a judgement call over a listing and guard 2 is not a judgement call at
 *     all.
 *
 * Guard 1 has one narrowing, for the case where the thing in the bucket is our
 * own half-written scaffold rather than somebody's brain: see `resume` on
 * `scaffoldContext` and `hasForeignContent`. Guard 2 does not move.
 *
 * The residual race — an object created between the `get` and the `put` — is
 * unavoidable with the `ContextStore` surface, which has no create-if-absent
 * (S3's `If-None-Match: *` is not supported by every backend we accept, and
 * claiming it without a probe is exactly the mistake the capability probe
 * exists to prevent). The window is one round trip, on the first connect of a
 * bucket that was just observed to be empty, so it is documented rather than
 * defended.
 *
 * ## Why the privacy manifest format is copied rather than imported
 *
 * `privacy.md` is **on-bucket format**, and the gateway
 * (`apps/mcp/src/index.js`) is the thing that has to read it back. Its parser
 * is a module-private function, so it cannot be imported here — but the
 * format is not guesswork: `__tests__/scaffold.test.ts` extracts the gateway's
 * *actual* `parsePrivacyManifest` from its source and parses what this module
 * writes. If the two ever drift, that test fails.
 *
 * The renderer itself has since moved to `lib/privacy.ts`, which holds the
 * whole ported engine (parse, render, evaluate) and is differentially tested
 * against the gateway's real functions. This module keeps only the decision
 * about what a *starting* manifest says.
 */

import { PRIVACY_KEY, renderPrivacyRulesBlock, type Visibility } from "./privacy";

/**
 * The bit of `ContextStore` (`apps/mcp/src/store/index.js`) scaffolding needs.
 *
 * Declared structurally rather than imported: the adapter is JSDoc-typed
 * JavaScript, and its `@typedef`s are not exported bindings TypeScript can
 * pull in. Keep this in sync with that file's documented surface — the
 * adapters satisfy it by construction, and the tests run the real `S3Store`
 * against it.
 */
export interface ScaffoldStore {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(
    key: string,
    /**
     * Markdown, or the bytes of something the gateway can serve back. Bytes
     * require a `contentType`; a string without one is markdown, which is what
     * every write in this codebase meant before images existed.
     */
    value: string | ArrayBuffer | Uint8Array,
    options?: { onlyIf?: { etagMatches: string }; contentType?: string },
  ): Promise<{ etag: string } | null>;
  list(options?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: { key: string }[];
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }>;
}

/** Which starting layout to lay down. Mirrors `workspaces.structureTemplate`. */
export type StructureTemplate = "para" | "custom";

/**
 * Which shape of context is being laid down. Mirrors `workspaces.kind`.
 *
 * It decides exactly one thing here — what `privacy.md` says the folders
 * default to — and it is threaded through rather than defaulted at each layer
 * so that a caller who forgets it fails to compile rather than quietly
 * scaffolding the wrong one. See `renderPrivacyManifest`.
 */
export type ContextKind = "personal" | "shared";

/**
 * One root folder the owner named, with the one-line description that becomes
 * its `README.md`.
 *
 * `folder` is **a single path segment that becomes a bucket key prefix**, typed
 * by a person. Everything about how it is validated below follows from that;
 * see `validateCustomFolders`.
 */
export interface CustomFolder {
  folder: string;
  description: string;
}

export const INDEX_KEY = "index.md";
/** Re-exported so callers of this module keep one import. */
export { PRIVACY_KEY } from "./privacy";

/**
 * PARA is a **suggestion, not a schema** (see README). The gateway addresses
 * whatever paths exist; nothing below the tools cares about this list. It is
 * the default starting shape because a blank bucket is a worse first run than
 * five folders you can rename, and `structureTemplate: "custom"` opts out
 * entirely.
 */
export const PARA_FOLDERS = [
  "0-inbox",
  "1-projects",
  "2-areas",
  "3-resources",
  "4-archive",
] as const;

/**
 * `line` is the manifest entry — one line, in the owner's voice, saying what
 * belongs in the folder. It is what `index.md` lists, and it is deliberately
 * the same *shape* as the one-line description a `custom` layout asks its owner
 * for, so a PARA manifest and a custom manifest read identically. `title`,
 * `blurb` and `examples` are the longer form, which only the folder's own
 * `README.md` uses.
 */
const FOLDER_PURPOSE: Record<
  string,
  { title: string; line: string; blurb: string; examples: string[] }
> = {
  "0-inbox": {
    title: "Inbox",
    line: "raw captures, unfiled. Process these into the folders below.",
    blurb:
      "Raw, unfiled captures. Anything that arrives before you have decided where it belongs — emailed notes, quick thoughts, clippings. Empty this regularly by moving notes somewhere else.",
    examples: ["a thought you had on a walk", "an emailed article you have not read yet"],
  },
  "1-projects": {
    title: "Projects",
    line:
      "active work with an end state. One folder per project.",
    blurb:
      "Active work with an end state. A project has a finish line: when it is reached, the folder moves to 4-archive.",
    examples: ["ship the new pricing page", "plan the March offsite"],
  },
  "2-areas": {
    title: "Areas",
    line: "ongoing responsibilities.",
    blurb:
      "Ongoing responsibilities with no finish line. Areas are maintained, not completed.",
    examples: ["health", "finances", "the team you manage"],
  },
  "3-resources": {
    title: "Resources",
    line:
      "reference material: book notes, articles, ideas.",
    blurb:
      "Reference material you want to be able to find again, not tied to one project or area.",
    examples: ["how our deploy pipeline works", "notes on a book you read"],
  },
  "4-archive": {
    title: "Archive",
    line:
      "anything no longer active. Move, don't delete.",
    blurb:
      "Anything from the other folders that is no longer active. Nothing is deleted — it is moved here so the live folders stay readable.",
    examples: ["a project that shipped", "an area you no longer own"],
  },
};

/* -------------------------------------------------------------------------- */
/*                          caller-supplied root folders                      */
/* -------------------------------------------------------------------------- */

/**
 * Caps on a custom layout.
 *
 * `MAX_CUSTOM_FOLDERS` is a product judgement — a starting layout somebody can
 * hold in their head — and also a bound on how many objects one call writes
 * into a customer's bucket. `MAX_FOLDER_NAME_LENGTH` is well under the gateway's
 * 512-character path cap, because this is one *segment* of a path that will
 * have note names appended to it. `MAX_FOLDER_DESCRIPTION_LENGTH` is one line
 * of prose, which is what it is asked for as.
 *
 * Exported so a client can refuse the same input before a round trip, and so a
 * test can prove the boundary rather than a number near it.
 */
export const MAX_CUSTOM_FOLDERS = 12;
export const MAX_FOLDER_NAME_LENGTH = 64;
export const MAX_FOLDER_DESCRIPTION_LENGTH = 200;

/**
 * Why a proposed layout was refused. A closed set, so the caller can say
 * something specific without matching on English.
 */
export type FolderRejection =
  | "too-many"
  | "empty"
  | "untrimmed"
  | "too-long"
  | "control-character"
  | "backslash"
  | "not-a-single-segment"
  | "traversal"
  | "hidden"
  | "reserved"
  | "duplicate"
  | "description-empty"
  | "description-too-long"
  | "description-control-character";

export type FolderValidation =
  | { ok: true; folders: CustomFolder[] }
  | { ok: false; reason: FolderRejection; folder?: string };

/** Root keys the scaffold owns. A *folder* by either name would be confusing. */
const RESERVED_FOLDER_NAMES = new Set([INDEX_KEY, PRIVACY_KEY]);

/** C0 controls, DEL, and C1. `\n` and `\r` are in here, which is what keeps a one-line description one line. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Refuse, or hand back exactly what will be written.
 *
 * ## Why this is strict to the point of rudeness
 *
 * A folder name here becomes a **key prefix in somebody's own bucket**, and
 * that bucket is also mounted in Obsidian, synced by rclone, and listed by the
 * gateway. So the failure modes are not cosmetic: `..` is a traversal attempt
 * against the adapter's key builder, a leading `.` produces a folder the
 * gateway classifies as plumbing and hides from every client (a folder the
 * owner created and can never see), a backslash is a path separator on the
 * machine that syncs the bucket even though S3 treats it as an ordinary byte,
 * and a control character produces a key that is unaddressable in a URL and
 * unreadable in a listing.
 *
 * **Every one of these is a refusal, never a repair.** Silently rewriting
 * `../escape` to `escape` or stripping a newline gives the person a folder they
 * did not ask for, under a name they will not recognise, in a bucket we do not
 * own. The one exception is the *description*, which is prose destined for the
 * body of a README rather than for a key: surrounding whitespace there is
 * trimmed, because rejecting a trailing space in a sentence is user-hostile and
 * buys nothing.
 *
 * The scaffolder's own guards still stand behind this — `scaffoldContext`
 * refuses to run at all against a non-empty bucket, and `get`s every key before
 * it `put`s it — so a validation bug here cannot become an overwrite.
 */
export function validateCustomFolders(
  input: readonly { folder: string; description: string }[],
): FolderValidation {
  if (input.length > MAX_CUSTOM_FOLDERS) {
    return { ok: false, reason: "too-many" };
  }

  const folders: CustomFolder[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const folder = entry.folder;
    if (typeof folder !== "string" || folder.length === 0) {
      return { ok: false, reason: "empty" };
    }
    if (folder !== folder.trim()) {
      return { ok: false, reason: "untrimmed", folder };
    }
    if (CONTROL_CHARACTERS.test(folder)) {
      // Reported without echoing the name: a control character in an error
      // string is the same problem one step further along.
      return { ok: false, reason: "control-character" };
    }
    if (folder.length > MAX_FOLDER_NAME_LENGTH) {
      return { ok: false, reason: "too-long", folder };
    }
    if (folder.includes("\\")) {
      return { ok: false, reason: "backslash", folder };
    }
    // Checked before the `.`-prefix rule so traversal gets its own answer.
    if (folder === "." || folder === "..") {
      return { ok: false, reason: "traversal", folder };
    }
    if (folder.includes("/")) {
      return { ok: false, reason: "not-a-single-segment", folder };
    }
    if (folder.startsWith(".")) {
      return { ok: false, reason: "hidden", folder };
    }
    if (RESERVED_FOLDER_NAMES.has(folder.toLowerCase())) {
      return { ok: false, reason: "reserved", folder };
    }
    // Case-insensitive, because two folders differing only in case are a
    // permanent source of "why are my notes in the other one" on a bucket that
    // is also synced to case-insensitive filesystems.
    const fingerprint = folder.toLowerCase();
    if (seen.has(fingerprint)) {
      return { ok: false, reason: "duplicate", folder };
    }
    seen.add(fingerprint);

    const description =
      typeof entry.description === "string" ? entry.description.trim() : "";
    if (description.length === 0) {
      return { ok: false, reason: "description-empty", folder };
    }
    if (description.length > MAX_FOLDER_DESCRIPTION_LENGTH) {
      return { ok: false, reason: "description-too-long", folder };
    }
    // Newlines included: it is asked for as one line, and a multi-line value
    // here lands in a Markdown file where it can open a code fence or a
    // front-matter block that was not there before.
    if (CONTROL_CHARACTERS.test(description)) {
      return { ok: false, reason: "description-control-character", folder };
    }

    folders.push({ folder, description });
  }

  return { ok: true, folders };
}

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
 * legacy "BRAIN" wording stays even though the product noun is "context".
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
 * A brain's `index.md` is its owner's own manifest and may describe anything;
 * publishing it to everyone they later share a folder with is not ours to
 * decide. A brain stays all-private at the root as well as in its folders, and
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
 * ## A personal brain starts `private`, and that is the sensible default
 *
 * `team` does not mean public — it means named people the owner has granted
 * access to — but a brain that has just been created has granted nobody
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
/*                                 index.md                                   */
/* -------------------------------------------------------------------------- */

/**
 * The manifest: what this context is, and one line per folder saying what
 * belongs in it.
 *
 * For a `custom` layout the owner's own folder names and one-line descriptions
 * take the place of the PARA ones, **verbatim** — they were validated before
 * they got here (`validateCustomFolders`), and rewording somebody's own
 * description in their own file would be as rude as renaming their folder.
 */
export function renderIndex(
  template: StructureTemplate,
  customFolders: readonly CustomFolder[] = [],
  kind: ContextKind = "personal",
): string {
  const shared = kind === "shared";
  const lines = [
    "---",
    "role: context-manifest",
    "version: 1",
    "---",
    "",
    shared ? "# Workspace" : "# Context",
    "",
    shared
      ? "This bucket is a shared workspace: plain Markdown files the workspace owns,"
      : "This bucket is a context: plain Markdown files you own, readable by any AI",
    shared
      ? "readable by any AI client its members connect. Nothing here is a database"
      : "client you connect. Nothing here is a database export — every file is a",
    shared
      ? "export — every file is a file, editable in Obsidian, in a text editor, or"
      : "file, editable in Obsidian, in a text editor, or over rclone.",
    ...(shared ? ["over rclone."] : []),
    "",
    "## Conventions",
    "",
    "- One idea per note. Notes are shared between many tools, so keep them",
    "  concise and factual.",
    ...(shared
      ? [
          "- Write for the next person, not for yourself. A note nobody else can",
          "  follow is why the workspace exists and why it stops being used.",
        ]
      : []),
    "- `privacy.md` decides what a connected client can see. Folder rules are",
    "  defaults; an exact note can override its folder.",
    ...(shared
      ? [
          "- Every folder listed below is readable by every member. A folder held",
          "  back to owners says `private` in `privacy.md`, and says so there only.",
        ]
      : []),
    "- Paths starting with a dot (`.audit/`, `.context/`) are plumbing, never",
    "  notes, and are not shown to any client.",
    "",
  ];

  if (template === "para") {
    lines.push(
      "## Structure",
      "",
      "The starting shape is PARA. It is a suggestion, not a schema — rename",
      "these folders, nest them, or ignore them entirely. The tools address",
      "whatever paths exist.",
      "",
    );
    for (const folder of PARA_FOLDERS) {
      lines.push(`- \`${folder}/\` — ${FOLDER_PURPOSE[folder].line}`);
    }
    lines.push("");
  } else if (customFolders.length > 0) {
    lines.push(
      "## Structure",
      "",
      shared
        ? "These are the folders this workspace was set up with. They are a starting"
        : "These are the folders you named when you set this context up. They are a",
      shared
        ? "point, not a schema — rename them, nest inside them, add more, or delete"
        : "starting point, not a schema — rename them, nest inside them, add more, or",
      shared
        ? "them. The tools address whatever paths exist."
        : "delete them. The tools address whatever paths exist.",
      "",
    );
    for (const entry of customFolders) {
      lines.push(`- \`${entry.folder}/\` — ${entry.description}`);
    }
    lines.push("");
  } else {
    lines.push(
      "## Structure",
      "",
      "This context has no imposed folder structure. Create whatever paths suit",
      "the work; the tools address paths, not a taxonomy.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * A folder the owner named. Their description, verbatim, as the whole body.
 *
 * Deliberately shorter than the PARA READMEs: those explain a method the reader
 * may not know, whereas this folder's purpose is something its owner just wrote
 * down in their own words a moment ago.
 */
export function renderCustomFolderReadme(entry: CustomFolder): string {
  return [
    `# ${entry.folder}`,
    "",
    entry.description,
    "",
    "You named this folder when you set this context up. Rename it, nest inside",
    "it, or delete it — the tools address paths, not a fixed taxonomy.",
    "",
  ].join("\n");
}

export function renderFolderReadme(folder: string): string {
  const purpose = FOLDER_PURPOSE[folder];
  return [
    `# ${purpose.title}`,
    "",
    purpose.blurb,
    "",
    "Examples:",
    ...purpose.examples.map((example) => `- ${example}`),
    "",
    "This folder is a suggestion. Rename it, nest inside it, or delete it — the",
    "tools address paths, not a fixed taxonomy.",
    "",
  ].join("\n");
}

/**
 * Names this product does not write, kept out anyway because they are generic.
 *
 * A first version called `todo.md` "mandated by the connected-client house
 * rules". That contradicts a decision already recorded in `apps/mcp/src/index.js`
 * — the agent-ledger and `todo.md` conventions were deliberately removed from
 * `SERVER_INSTRUCTIONS` because "they are one customer's house rules... Ours is
 * the product's rules only." By that decision `todo.md` is a name its owner
 * chose, and this list would have no business holding it.
 *
 * It stays on the weaker and honestly weaker argument: `todo.md` at the root of
 * a notes bucket is a guess anybody would make. **That argument is unbounded** —
 * `notes.md`, `journal.md`, `ideas.md` are guesses too — so any list built on it
 * is an arbitrary stopping point, and this one stops at one entry. The residual
 * is real and is not a bug in the rule but a limit of it: a generic filename the
 * owner picked is still previewable.
 *
 * Kept rather than dropped because the two directions fail differently. Refusing
 * a name nobody would have guessed costs one owner one card; previewing one
 * anybody would guess is the thing the whole rule exists to stop.
 */
export const GENERIC_ROOT_KEYS = ["todo.md"] as const;

/**
 * Where `save_context` files a session — a folder name WE pick, not the owner.
 *
 * `defaultSessionFolder` in the gateway returns `4-archive/chat-history` when
 * the manifest declares a `4-archive` rule and `0-inbox/sessions` otherwise, so
 * every brain whose owner has run the hook once has one of these. That makes
 * them two guesses per handle on names nobody chose — the same shape as the
 * five PARA folders, and they get the same answer.
 *
 * A blanket `.md` refusal used to cover this without naming it. Replacing that
 * with a list was right (guessability is a property of a name, not of
 * file-versus-folder) and it made the edge the blanket rule had been hiding
 * into a gap: measured, `4-archive/chat-history` unfurled as "Chat history"
 * with a live card token.
 *
 * **The platform folder beneath is NOT bounded by refusing the parent**, and a
 * first version of this comment said it was, twice over.
 * `isProductMandatedPath` is exact-match — the neighbouring test pins that it
 * must not be `startsWith` — so `4-archive/chat-history/claude` previews with
 * its name regardless. And the parent is not the only place it can live:
 * `save_context` takes a `destination`, so the platform folder appears under
 * whatever the caller chose.
 *
 * Stopping at the parent is still right, and for a different reason than the
 * one that was written down: the platform segment is caller-supplied
 * (`/^[a-z0-9][a-z0-9-]{0,31}$/`), so the child set is unbounded and cannot be
 * enumerated, and under an owner-chosen `destination` refusing it would cost a
 * card for nothing. The residual is that `<session folder>/<platform>` is
 * previewable for the three platform names somebody might guess. Named rather
 * than argued away.
 */
export const SESSION_FOLDERS = ["4-archive/chat-history", "0-inbox/sessions"] as const;

/**
 * Folders the GATEWAY creates from a capture's `source`, not the owner.
 *
 * `writeInboxCapture` files any capture carrying an `external_id` under
 * `0-inbox/<safeSlug(source)>/`, so the folder name is whatever the sender
 * called itself — and three senders are the product's own. `packages/hook`
 * publishes exactly three client ids and bakes `--client <id>` into the
 * command it installs, so `hook:claude-code` slugs to `hook-claude-code`;
 * `POST /inbox` defaults `source` to `"inbox"`; the Granola webhook hardcodes
 * `"granola"`.
 *
 * The hook one is the sharpest of the whole list. It is the product's most
 * promoted surface — the safety net for a session nobody remembered to save —
 * and the folder appears the first time an installed hook fires, so it needs
 * no action by the owner at all beyond running the installer.
 *
 * A capture whose source the SENDER chose is a different matter and stays
 * previewable: that name is not ours to guess — **except when the slug falls
 * back**, which is why `0-inbox/capture` is on the list. A sender who picks a
 * source with no Latin alphanumerics gets a folder name of ours, so the
 * sender-chose-it exclusion does not reach the fallback.
 */
export const CAPTURE_SOURCE_FOLDERS = [
  "0-inbox/hook-claude-code",
  "0-inbox/hook-codex",
  "0-inbox/hook-gemini-cli",
  "0-inbox/inbox",
  "0-inbox/granola",
  // `safeSlug` ends `|| "capture"`, so a source containing no `[a-z0-9]` at
  // all — "日本語アプリ", "Здравствуй", "###", an emoji — lands in a folder
  // named by US rather than by the sender. Narrower than the others and still
  // a hardcoded literal in our source needing no knowledge of the owner, on
  // exactly the generic-guess ground `todo.md` sits on.
  "0-inbox/capture",
] as const;

/**
 * The one path the single-tenant calendar cron writes, and its folder.
 *
 * `2-areas/calendar/next-14-days.md` is hardcoded in the gateway and gated on
 * `CALENDAR_ICS_URL`, so it exists only where that is configured — which is
 * the original brain, the one deployment whose owner is publicly known. The
 * name requires no knowledge of them.
 */
export const CALENDAR_PATHS = ["2-areas/calendar", "2-areas/calendar/next-14-days.md"] as const;

/**
 * The root folders every workspace **preset** writes.
 *
 * `apps/mobile/features/workspace/presets.ts` ships two fixed layouts and sends
 * them down the `custom` template path, and `DEFAULT_PRESET` is `company` — so
 * these are what a shared context gets when nobody chooses. That makes them
 * ours, at addresses anybody who knows a handle can type, which is the whole
 * test `isProductMandatedPath` applies.
 *
 * The list below said `custom` was out of scope "because those folder names are
 * the owner's". That is still true of a layout somebody typed and false of one
 * we ship, and #203 is what made the difference matter: a shared context's
 * scaffold starts these `team`, so a folder card on one actually names its
 * contents.
 *
 * Kept in step with the preset file by `teamShare.test.ts`, which reads that
 * file rather than restating it here.
 */
const PRESET_FOLDERS = [
  "1-clients",
  "2-pipeline",
  "2-teams",
  "3-handbook",
  "3-practice",
  "4-customers",
  "5-archive",
] as const;

/**
 * A path this product itself puts into every brain, and therefore one anybody
 * can guess without knowing a thing about the owner.
 *
 * Used by `previewForNote` to decide what an unauthenticated crawler may be
 * told about a **guessable** address. The card rule turns on guessability: a
 * share link is 32 CSPRNG bytes and may carry a title, while `/@name/<path>` is
 * typed, so it may only answer for a path the owner explicitly linked — and
 * that bound is worth exactly as much as the name space it is defended by.
 *
 * The five PARA folders are in this list, and naming them here is what let the
 * preview stop refusing folders wholesale. A folder the owner named —
 * `1-projects/public-worship-chapter-transition` — is no more guessable than a
 * note filename, and refusing it cost a card for nothing; a folder *this
 * product* wrote is five guesses, which is the whole risk. Notes are a bigger
 * list than "index.md":
 * `scaffoldFiles` also lays a `README.md` into every PARA folder, so a fresh
 * brain arrives with six guessable note names before its owner writes anything.
 *
 * The test for this drives `scaffoldFiles` rather than restating its output, so
 * an eighth scaffolded file cannot quietly become an eighth guess.
 *
 * **The `custom` template was deliberately out of scope, and half of it no
 * longer is** — see `PRESET_FOLDERS` above. A layout somebody typed is still
 * theirs; one this product ships through the same code path is ours, and the
 * list below spreads those. What follows argues the original half.
 *
 * **The `custom` template is deliberately out of scope.** It also writes a
 * `README.md` per folder, but those folder names are the owner's — `Journal/`,
 * `Clients/` — so the guessability premise that makes this list a security
 * control simply does not hold for them, and refusing them would cost a card
 * for nothing. Only `PARA_FOLDERS` is consulted, and the test's claim that
 * driving `scaffoldFiles` catches a new file is a claim about the `para`
 * branch.
 */

export const PRODUCT_MANDATED_PATHS: readonly string[] = [
  INDEX_KEY,
  PRIVACY_KEY,
  ...GENERIC_ROOT_KEYS,
  // The five PARA folders themselves. `applyStructure` writes exactly these
  // into every `para` brain, so they are five guesses per handle — the
  // narrowest name space in the product and the reason the preview refused
  // folders wholesale before this list learned to name them.
  ...PARA_FOLDERS,
  ...SESSION_FOLDERS,
  ...CAPTURE_SOURCE_FOLDERS,
  ...CALENDAR_PATHS,
  ...PARA_FOLDERS.map((folder) => `${folder}/README.md`),
  // The preset layouts, for the reason `PRESET_FOLDERS` gives. `0-inbox`,
  // `1-projects` and their READMEs are already above via `PARA_FOLDERS`; a
  // duplicate would be harmless but this list is read by two tests as a set.
  ...PRESET_FOLDERS,
  ...PRESET_FOLDERS.map((folder) => `${folder}/README.md`),
];

/**
 * **The list, not a second statement of it.**
 *
 * This was a chain of `if`s, and `infra/router/src/preview.ts` mirrors it with
 * a literal that a test compares against a THIRD hand-written array — so the
 * comparison held two restatements against each other and never asked the
 * predicate. Adding `SESSION_FOLDERS` to the `if`s left that test green with
 * the router's copy short: routed ⊆ predicate was checked, predicate ⊆ routed
 * was not. The same one-directional hole as the `native-deps.json` `core`
 * list, in the guard written to stop hand-maintained enumerations.
 *
 * Exporting the array is what makes the mirror checkable: the predicate reads
 * it, and the test compares the router's literal against it rather than
 * against a copy somebody kept in step by remembering to.
 */
export function isProductMandatedPath(path: string): boolean {
  return PRODUCT_MANDATED_PATHS.includes(path);
}

/**
 * Every file a fresh context starts with, **in write order, essentials first**.
 *
 * A folder in object storage is not a thing you create — it is the prefix of a
 * key that exists. `README.md` is what makes each one real, and it carries the
 * folder's purpose while it is at it.
 *
 * The order is not cosmetic. A bucket can stop accepting writes partway
 * through — a credential rotated out from under us, a policy change, a bucket
 * that filled up — and what has landed by then is decided entirely by this
 * list. `privacy.md` goes first because it is the one file whose absence makes
 * the context behave differently rather than merely read thinner; see
 * `ESSENTIAL_KEYS`.
 */
export function scaffoldFiles(
  template: StructureTemplate,
  customFolders: readonly CustomFolder[] = [],
  kind: ContextKind = "personal",
): { key: string; body: string }[] {
  const files = [
    { key: PRIVACY_KEY, body: renderPrivacyManifest(template, customFolders, kind) },
    { key: INDEX_KEY, body: renderIndex(template, customFolders, kind) },
  ];
  if (template === "para") {
    for (const folder of PARA_FOLDERS) {
      files.push({ key: `${folder}/README.md`, body: renderFolderReadme(folder) });
    }
  } else {
    for (const entry of customFolders) {
      files.push({
        key: `${entry.folder}/README.md`,
        body: renderCustomFolderReadme(entry),
      });
    }
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/*                          detecting an existing context                     */
/* -------------------------------------------------------------------------- */

/**
 * A key whose path contains a dot-prefixed segment is gateway plumbing
 * (`.history/`, `.audit/`, `.context-probe/`, `.obsidian/`), not somebody's
 * notes. Same rule the gateway's `isPlumbing` applies.
 */
export function isPlumbingKey(key: string): boolean {
  return key.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Pages of the root listing we are willing to walk before giving up.
 *
 * Exported so `__tests__/scaffold.test.ts` can seed *more* plumbing than this
 * many pages can hold. That is what makes the delimiter test below non-vacuous:
 * with fewer objects than `DETECT_PAGE_CAP * 1000`, a flat listing eventually
 * reaches the real notes anyway and the test passes for the wrong reason.
 */
export const DETECT_PAGE_CAP = 5;
/** Keys per page. Named for the same reason as the cap above. */
export const DETECT_PAGE_SIZE = 1000;

/**
 * Does this bucket already hold a context?
 *
 * Listed **with a delimiter**, which is the part that matters. A flat listing
 * of a real brain returns `.history/…` objects first — `.` sorts before every
 * digit and letter — and there can be tens of thousands of them, so a
 * first-page flat listing of the founder's live bucket would come back looking
 * completely empty and we would scaffold straight over the top of it. With a
 * delimiter, that whole subtree collapses to the single prefix `.history/`,
 * and the real folders are visible on page one.
 *
 * The well-known files are checked directly as well, because a bucket whose
 * only content is `privacy.md` is still a context whose access rules must not
 * be reset.
 */
export async function hasExistingContext(store: ScaffoldStore): Promise<boolean> {
  for (const key of [PRIVACY_KEY, INDEX_KEY]) {
    if ((await store.get(key)) !== null) return true;
  }

  let cursor: string | undefined = undefined;
  for (let page = 0; page < DETECT_PAGE_CAP; page += 1) {
    const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list({
      prefix: "",
      delimiter: "/",
      cursor,
      limit: DETECT_PAGE_SIZE,
    });
    for (const object of listing.objects ?? []) {
      if (!isPlumbingKey(object.key)) return true;
    }
    for (const prefix of listing.delimitedPrefixes ?? []) {
      if (!isPlumbingKey(prefix)) return true;
    }
    if (!listing.truncated) return false;
    // A walk that did not finish knows nothing, and `false` here is the
    // fail-open answer: "no context, scaffold away", over a bucket we could not
    // see the end of. Two ways to not finish and both used to fall out of the
    // loop into `return false`: the page cap, and a store that reports another
    // page and then offers no continuation token — `readTag` in
    // `apps/mcp/src/store/s3.js` reads `IsTruncated` and
    // `NextContinuationToken` from independent tags with no cross-check, so
    // `{ truncated: true, cursor: undefined }` really does arrive here.
    if (!listing.cursor) return true;
    cursor = listing.cursor;
  }
  // The page cap, reached. Same reasoning: unfinished means occupied.
  return true;
}

/**
 * Is there anything in this bucket that **we did not put there**?
 *
 * ## The question `hasExistingContext` cannot answer
 *
 * A scaffold that fails partway leaves real objects in the bucket, so from
 * that moment on `hasExistingContext` says "this is somebody's context" — and
 * it is right, in the only sense it can see. It is also the reason the person
 * whose scaffold half-landed could not finish it through the product: the
 * retry's first guard saw the `privacy.md` the *first attempt* wrote and
 * refused, reporting a bucket we had half-written as a bucket we must not
 * touch (issue #22).
 *
 * So a resuming scaffold asks a narrower question, and the narrowing is the
 * whole safety argument: **every non-plumbing object in the bucket must be a
 * key this exact layout would write, holding the exact bytes this exact layout
 * would write there.** Byte-identity is what makes the answer "we wrote this"
 * rather than "something with this name is here": a person's own
 * hand-maintained `privacy.md` or `1-projects/README.md` is not byte-identical
 * to our generated one, and one note of theirs anywhere — `1-projects/ship.md`
 * — is a key no layout of ours contains. Either way this returns `true` and
 * the caller refuses, exactly as it does for a vault that was here before we
 * arrived.
 *
 * That also means a resume completes **the layout it started**. Asking to
 * resume a half-written PARA bucket with a `custom` layout finds `0-inbox/`
 * foreign and refuses, rather than interleaving two layouts in somebody's
 * bucket.
 *
 * Listed with the same delimiter and page cap as `hasExistingContext`, for the
 * same `.history/` reason. A folder prefix that *is* one of ours is then
 * walked flat, because "the prefix `1-projects/` exists" says nothing about
 * whether what is under it is our README or a thousand of their notes.
 */
export async function hasForeignContent(
  store: ScaffoldStore,
  files: readonly { key: string; body: string }[],
): Promise<boolean> {
  const ours = new Map(files.map((file) => [file.key, file.body]));
  const ourPrefixes = new Set(
    files
      .filter((file) => file.key.includes("/"))
      .map((file) => `${file.key.slice(0, file.key.indexOf("/"))}/`),
  );

  const isOurs = async (key: string): Promise<boolean> => {
    const body = ours.get(key);
    if (body === undefined) return false;
    const object = await store.get(key);
    // Listed but unreadable a moment later: treat as not ours, which refuses.
    if (object === null) return false;
    return (await object.text()) === body;
  };

  const walk = async (
    prefix: string,
    delimiter: string | undefined,
  ): Promise<boolean> => {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < DETECT_PAGE_CAP; page += 1) {
      const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list(
        { prefix, delimiter, cursor, limit: DETECT_PAGE_SIZE },
      );
      for (const object of listing.objects ?? []) {
        if (isPlumbingKey(object.key)) continue;
        if (!(await isOurs(object.key))) return true;
      }
      for (const found of listing.delimitedPrefixes ?? []) {
        if (isPlumbingKey(found)) continue;
        if (!ourPrefixes.has(found)) return true;
        // Ours by name. Now prove what is under it is ours by content.
        if (await walk(found, undefined)) return true;
      }
      if (!listing.truncated) return false;
      // Unfinished means "assume foreign", for the same reason
      // `hasExistingContext` assumes occupied: `false` is the answer that lets
      // a scaffold run over somebody's bucket.
      if (!listing.cursor) return true;
      cursor = listing.cursor;
    }
    return true;
  };

  return await walk("", "/");
}

/* -------------------------------------------------------------------------- */
/*                                 scaffolding                                */
/* -------------------------------------------------------------------------- */

/**
 * THE FILES A CONTEXT CANNOT FUNCTION SAFELY WITHOUT.
 *
 * `privacy.md`, and nothing else. That is read off the gateway's own code
 * (`apps/mcp/src/index.js`), not chosen as a preference:
 *
 *  - **`privacy.md` is load-bearing, and it is a security control.** It is the
 *    visibility manifest `loadPrivacyState` parses, and its absence is not a
 *    thinner version of the same thing — `loadPrivacyState` falls through to
 *    `loadLegacyPrivacyState`, so the context silently runs on the
 *    pre-manifest `.note-acl/*.json` format. `set_folder_visibility` refuses
 *    outright ("privacy.md is required before folder visibility can be
 *    changed"), and `persistExactVisibility` writes any per-note decision into
 *    the legacy sidecar instead of the manifest. Reads do fail closed —
 *    `visibilityOf` with no rules returns `private` — so nothing leaks, but a
 *    context whose access control is a fallback nobody chose is not one we
 *    should call created.
 *  - **`index.md` is not.** The gateway reads it in exactly one place, and
 *    guarded: `toolOrient`'s `if (index && canSee("index.md", …))`. Nothing
 *    else in the gateway opens it, no visibility decision consults it, and no
 *    write path requires it. A missing `index.md` costs a paragraph of
 *    orientation prose. Best-effort.
 *  - **Folder `README.md`s are not.** A folder in object storage is the prefix
 *    of a key that exists; the READMEs are the leg-up, not the structure. An
 *    owner whose `2-areas/README.md` never landed can ask their own agent for
 *    it in one sentence — which is the point of the product.
 *
 * So a scaffold that lands `privacy.md` and loses two READMEs **succeeded**,
 * with a caveat naming what is missing. Reporting that as total failure is
 * what left people stuck.
 */
export const ESSENTIAL_KEYS: readonly string[] = [PRIVACY_KEY];

export type ScaffoldReason =
  /** Every file landed. `written` says which. */
  | "created"
  /**
   * The essentials landed; something best-effort did not. `written` says what
   * landed, `missing` says what did not, and both are true at once — this is a
   * success with a caveat, not a failure.
   */
  | "partial"
  /** The bucket already holds a context. Nothing was read or written. */
  | "existing-context"
  /** An essential file did not land. `written` says what did. */
  | "failed";

export interface ScaffoldResult {
  scaffolded: boolean;
  reason: ScaffoldReason;
  /** Keys this call created. */
  written: string[];
  /** Keys that already existed and were therefore left exactly as they were. */
  skipped: string[];
  /**
   * Keys of this layout that are **not in the bucket** now — whether the write
   * was refused or never attempted. Empty on `created`. This is what a retry
   * has left to do, and what the console tells the owner about.
   */
  missing: string[];
  /** Present when something failed. Never carries a credential. */
  error?: string;
}

/**
 * Write the starting layout, if and only if the bucket has none — or finish
 * one this control plane already began.
 *
 * Idempotent: running it twice writes nothing the second time, and running it
 * against somebody's existing brain writes nothing at all.
 *
 * ## Best effort, except where it is not
 *
 * One failed `README.md` used to abandon the whole run and report `failed`,
 * which is both a lie and a dead end: the bucket had a working `privacy.md`
 * in it, and the person was told their context did not get set up. So the loop
 * carries on past a refused write and the *outcome* is decided by
 * `ESSENTIAL_KEYS` — `created` when everything landed, `partial` when the
 * essentials did and something optional did not, `failed` only when an
 * essential did not. A failed essential does stop the loop: there is no point
 * laying READMEs into a bucket that has just refused the access manifest, and
 * every extra `put` there is another write into storage that is misbehaving.
 */
export async function scaffoldContext(
  store: ScaffoldStore,
  options: {
    structureTemplate: StructureTemplate;
    /**
     * The owner's own root folders, for a `custom` layout. Must already have
     * been through `validateCustomFolders` — these become bucket keys, and this
     * function does not re-check them.
     */
    customFolders?: readonly CustomFolder[];
    /**
     * Finish a layout **we** already started, rather than refusing because it
     * is there.
     *
     * Set only by a caller holding control-plane evidence that this bucket was
     * observed empty and then written into by us — `storageBindings`'
     * `scaffoldMissing`. It swaps the first guard from "is anything here" to
     * "is anything here that we did not write", which is `hasForeignContent`;
     * read its comment for why that is still safe for somebody's live vault.
     * The per-key `get` below is unchanged either way, so nothing this flag
     * does can overwrite a byte.
     */
    resume?: boolean;
    /**
     * Personal brain or shared workspace. Decides what `privacy.md` says the
     * folders default to, and nothing else — see `startingVisibility`.
     *
     * Defaults to `personal`, which is the conservative branch: a caller that
     * forgets it scaffolds an all-private context, which is thin rather than
     * disclosing. The control plane always passes it; see `StructureChoice`.
     */
    kind?: ContextKind;
  },
): Promise<ScaffoldResult> {
  const files = scaffoldFiles(
    options.structureTemplate,
    options.customFolders ?? [],
    options.kind ?? "personal",
  );

  const occupied =
    options.resume === true
      ? await hasForeignContent(store, files)
      : await hasExistingContext(store);
  if (occupied) {
    return {
      scaffolded: false,
      reason: "existing-context",
      written: [],
      skipped: [],
      missing: [],
    };
  }

  const essential = new Set(ESSENTIAL_KEYS);
  const written: string[] = [];
  const skipped: string[] = [];
  let error: string | undefined;
  for (const file of files) {
    try {
      // The second guard. The detector above looked at the shape of the
      // bucket; this looks at the exact key about to be written.
      if ((await store.get(file.key)) !== null) {
        skipped.push(file.key);
        continue;
      }
      const put = await store.put(file.key, file.body);
      if (put === null) {
        skipped.push(file.key);
        continue;
      }
      written.push(file.key);
    } catch (caught) {
      // First failure wins the message: it is the one that describes what went
      // wrong with the bucket, and the five that follow it are echoes.
      error ??= scaffoldErrorMessage(caught);
      if (essential.has(file.key)) break;
    }
  }

  const landed = new Set([...written, ...skipped]);
  const missing = files
    .map((file) => file.key)
    .filter((key) => !landed.has(key));
  const reason: ScaffoldReason = !ESSENTIAL_KEYS.every((key) => landed.has(key))
    ? "failed"
    : missing.length > 0
      ? "partial"
      : "created";

  return {
    scaffolded: written.length > 0,
    reason,
    written,
    skipped,
    missing,
    error,
  };
}

function scaffoldErrorMessage(error: unknown): string {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? "unknown error",
  );
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}
