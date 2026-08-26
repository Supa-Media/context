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

import { PRIVACY_KEY, renderPrivacyRulesBlock } from "./privacy";

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
    value: string,
    options?: { onlyIf?: { etagMatches: string } },
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

const FOLDER_PURPOSE: Record<string, { title: string; blurb: string; examples: string[] }> = {
  "0-inbox": {
    title: "Inbox",
    blurb:
      "Raw, unfiled captures. Anything that arrives before you have decided where it belongs — emailed notes, quick thoughts, clippings. Empty this regularly by moving notes somewhere else.",
    examples: ["a thought you had on a walk", "an emailed article you have not read yet"],
  },
  "1-projects": {
    title: "Projects",
    blurb:
      "Active work with an end state. A project has a finish line: when it is reached, the folder moves to 4-archive.",
    examples: ["ship the new pricing page", "plan the March offsite"],
  },
  "2-areas": {
    title: "Areas",
    blurb:
      "Ongoing responsibilities with no finish line. Areas are maintained, not completed.",
    examples: ["health", "finances", "the team you manage"],
  },
  "3-resources": {
    title: "Resources",
    blurb:
      "Reference material you want to be able to find again, not tied to one project or area.",
    examples: ["how our deploy pipeline works", "notes on a book you read"],
  },
  "4-archive": {
    title: "Archive",
    blurb:
      "Anything from the other folders that is no longer active. Nothing is deleted — it is moved here so the live folders stay readable.",
    examples: ["a project that shipped", "an area you no longer own"],
  },
};

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
function renderStartingRulesBlock(folderDefaults: readonly string[]): string {
  return renderPrivacyRulesBlock(
    folderDefaults.map((folder) => ({ prefix: folder, vis: "private" as const })),
    new Map(),
  );
}

/**
 * The access manifest for a brand-new context.
 *
 * **Every folder starts `private`**, and that is the sensible default rather
 * than a placeholder. `team` does not mean public — it means named people the
 * owner has granted access to — but a context that has just been created has
 * granted nobody anything, so there is no correct set of folders to open up.
 * Declaring each folder explicitly (rather than leaving `folder_defaults`
 * empty and relying on `default_visibility`) is what makes the file editable:
 * a person who wants to share their projects changes one word on one line,
 * instead of having to know the syntax for adding a rule.
 */
export function renderPrivacyManifest(template: StructureTemplate): string {
  const folders = template === "para" ? [...PARA_FOLDERS] : [];
  return [
    "---",
    "role: privacy-manifest",
    "version: 1",
    "---",
    "",
    "# Access map",
    "",
    "This file decides what a connected AI client is allowed to see. It lives in",
    "your bucket, it is readable in Obsidian, and you can edit it by hand.",
    "",
    "- `private` — only you. This is the default for everything.",
    "- `team` — you, plus the specific people you have granted access to. It is",
    "  never public: there is no anonymous tier.",
    "",
    "A rule under `folder_defaults` applies to that folder and everything under",
    "it; the longest matching rule wins. A rule under `note_overrides` names one",
    "exact `.md` file and beats its folder.",
    "",
    "Everything below starts private. To share a folder, change its `private` to",
    "`team`.",
    "",
    renderStartingRulesBlock(folders),
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*                                 index.md                                   */
/* -------------------------------------------------------------------------- */

export function renderIndex(template: StructureTemplate): string {
  const lines = [
    "---",
    "role: context-manifest",
    "version: 1",
    "---",
    "",
    "# Context",
    "",
    "This bucket is a context: plain Markdown files you own, readable by any AI",
    "client you connect. Nothing here is a database export — every file is a",
    "file, editable in Obsidian, in a text editor, or over rclone.",
    "",
    "## Conventions",
    "",
    "- One idea per note. Notes are shared between many tools, so keep them",
    "  concise and factual.",
    "- `privacy.md` decides what a connected client can see. Folder rules are",
    "  defaults; an exact note can override its folder.",
    "- Paths starting with a dot (`.history/`, `.audit/`) are plumbing, never",
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
      const purpose = FOLDER_PURPOSE[folder];
      lines.push(`- \`${folder}/\` — ${purpose.title.toLowerCase()}: ${purpose.blurb}`);
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

/** Every file a fresh context starts with, in write order. */
export function scaffoldFiles(
  template: StructureTemplate,
): { key: string; body: string }[] {
  const files = [
    { key: INDEX_KEY, body: renderIndex(template) },
    { key: PRIVACY_KEY, body: renderPrivacyManifest(template) },
  ];
  if (template === "para") {
    for (const folder of PARA_FOLDERS) {
      files.push({ key: `${folder}/README.md`, body: renderFolderReadme(folder) });
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

/** Pages of the root listing we are willing to walk before giving up. */
const DETECT_PAGE_CAP = 5;

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
      limit: 1000,
    });
    for (const object of listing.objects ?? []) {
      if (!isPlumbingKey(object.key)) return true;
    }
    for (const prefix of listing.delimitedPrefixes ?? []) {
      if (!isPlumbingKey(prefix)) return true;
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                 scaffolding                                */
/* -------------------------------------------------------------------------- */

export type ScaffoldReason =
  /** Files were written. `written` says which. */
  | "created"
  /** The bucket already holds a context. Nothing was read or written. */
  | "existing-context"
  /** A write failed partway. `written` says what did land. */
  | "failed";

export interface ScaffoldResult {
  scaffolded: boolean;
  reason: ScaffoldReason;
  /** Keys this call created. */
  written: string[];
  /** Keys that already existed and were therefore left exactly as they were. */
  skipped: string[];
  /** Present only when `reason` is `"failed"`. Never carries a credential. */
  error?: string;
}

/**
 * Write the starting layout, if and only if the bucket has none.
 *
 * Idempotent: running it twice writes nothing the second time, and running it
 * against somebody's existing brain writes nothing at all.
 */
export async function scaffoldContext(
  store: ScaffoldStore,
  options: { structureTemplate: StructureTemplate },
): Promise<ScaffoldResult> {
  if (await hasExistingContext(store)) {
    return {
      scaffolded: false,
      reason: "existing-context",
      written: [],
      skipped: [],
    };
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of scaffoldFiles(options.structureTemplate)) {
    try {
      // The second guard. `hasExistingContext` looked at the shape of the
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
    } catch (error) {
      return {
        scaffolded: written.length > 0,
        reason: "failed",
        written,
        skipped,
        error: scaffoldErrorMessage(error),
      };
    }
  }

  return { scaffolded: written.length > 0, reason: "created", written, skipped };
}

function scaffoldErrorMessage(error: unknown): string {
  const message = String(
    (error as { message?: unknown })?.message ?? error ?? "unknown error",
  );
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}
