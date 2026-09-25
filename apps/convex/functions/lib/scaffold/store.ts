/**
 * Shared shapes for the scaffolder: the storage surface it writes through, and
 * the starting-layout vocabulary (`StructureTemplate`, `ContextKind`,
 * `CustomFolder`) threaded through every other module in this folder.
 *
 * Split out of `lib/scaffold.ts` — see that file's header comment for the
 * whole scaffolder's rules (no key namespacing, never overwrite, byte-identity
 * resume). Nothing here has behaviour; it is the vocabulary the rest is
 * written in.
 */

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
  get(key: string): Promise<{
    etag: string;
    uploaded?: Date;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    /**
     * Markdown, or the bytes of something the gateway can serve back. Bytes
     * require a `contentType`; a string without one is markdown, which is what
     * every write in this codebase meant before images existed.
     */
    value: string | ArrayBuffer | Uint8Array,
    options?: {
      onlyIf?: { etagMatches?: string; absent?: true };
      contentType?: string;
    },
  ): Promise<{ etag: string } | null>;
  list(options?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
    /**
     * Resume after this key. Honoured by `S3Store`; ignored by Dropbox, whose
     * listing has no such position — `syncManifest` checks rather than trusts.
     */
    startAfter?: string;
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
export { PRIVACY_KEY } from "../privacy";

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
export const FOLDER_PURPOSE: Record<
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
