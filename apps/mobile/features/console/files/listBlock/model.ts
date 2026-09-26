/**
 * A ```` ```list ```` fence, drawn as the notes it lists.
 *
 * The grammar and the row selection are `apps/mcp/src/lists.js`, imported
 * rather than reimplemented, for the reason `../formBlock.ts` gives about
 * forms: two grammars drift, and the drift shows up as a list that draws here
 * and not on a shared page. See `docs/decisions/folder-lists.md`.
 *
 * ## When the list is drawn rather than shown as source
 *
 * Whenever the caret is not in it — the rule `htmlPreviews` follows, and not
 * the one forms follow. A form is drawn only in read mode because filling it
 * in means putting a caret inside it; a list has nothing to type into, so it
 * can give its source back the moment the caret arrives, like a diagram does.
 *
 * And only where a surface configured a host (`listHost`). Without one there is
 * nowhere to read notes from, and an honest code block beats a list that can
 * only ever say "nothing here".
 */

import { syntaxTree } from "@codemirror/language";
import { Facet, type EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  LIST_FENCE_LANG,
  listLoadsSubfolders,
  parseListBody,
  renderListBlock,
  selectListRows,
} from "../../../../../mcp/src/lists.js";
import { revealSelection } from "../livePreview/engagement";
import { selectionTouches } from "../livePreview/reveal";
import type { OwnerSearch } from "../owners";

export { LIST_FENCE_LANG };

/* ------------------------ what the grammar hands back ------------------------ */

export interface ListCondition {
  readonly property: string;
  readonly op: "is" | "is not" | "contains" | "is set" | "is not set";
  readonly value?: string;
}

/** One parsed block. The shape `lists.js` produces, named for TypeScript. */
export interface ListConfig {
  readonly from: string;
  readonly where: readonly ListCondition[];
  readonly sort: { readonly key: string; readonly order: "asc" | "desc" };
  readonly show: readonly string[];
  readonly limit: number;
  readonly subfolders: boolean;
  /** Notes, or projects: folders and notes with a `status`. */
  readonly rows: "notes" | "projects";
  /** The property rows are grouped by, or null. */
  readonly group: string | null;
  readonly as: "list" | "board";
}

/** Whether the list needs every note under its folder, not just those directly in it. */
export function loadsSubfolders(config: ListConfig): boolean {
  return listLoadsSubfolders(config) as boolean;
}

export type PropertyValue = string | readonly string[];

/** A note the host can already see, with its frontmatter read. */
export interface ListNote {
  readonly path: string;
  readonly updatedAt?: number;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** The note's first heading, which names a project with no `title`. */
  readonly heading?: string | null;
  /** The note's first paragraph, which a folder page draws under its title. */
  readonly lede?: string | null;
}

export interface ListRow {
  readonly path: string;
  readonly title: string;
  readonly values: ReadonlyArray<{ key: string; value: PropertyValue | number | null }>;
  /** The value this row is grouped under; `""` when it has none. Only on a grouped list. */
  readonly group?: string;
  /** On a list of projects: a folder with a front note, or one note. */
  readonly kind?: "folder" | "note";
  readonly folder?: string;
  /** Sub-projects closed out of all of them; null when there are none. */
  readonly progress?: { readonly done: number; readonly total: number } | null;
  readonly children?: readonly ListRow[];
}

export interface ListSelection {
  readonly rows: readonly ListRow[];
  readonly total: number;
  readonly truncated: boolean;
}

export function parseList(body: string): { config: ListConfig | null; error: string | null } {
  const parsed = parseListBody(body) as { config?: ListConfig; error?: string };
  return parsed.config === undefined
    ? { config: null, error: parsed.error ?? "the block could not be read" }
    : { config: parsed.config, error: null };
}

export function renderList(config: ListConfig): string {
  return renderListBlock(config) as string;
}

export function selectRows(
  config: ListConfig,
  notes: readonly ListNote[],
  selfPath: string | null,
): ListSelection {
  return selectListRows(config, notes, { selfPath: selfPath ?? undefined }) as ListSelection;
}

/* ------------------------------- the host -------------------------------- */

/**
 * Where a surface's notes come from, handed down to the editor as one prop.
 * The editor adds the note it has open and where a row goes.
 */
export interface FolderListSource {
  load(folder: string, subfolders: boolean): Promise<ListSource | null>;
  subscribe?(listener: () => void): () => void;
  /**
   * Change one frontmatter property of one listed note; `null` clears it.
   * Resolves to `null` once written, or to a sentence saying why not. Absent
   * where the reader may not write, and a list then offers no edits.
   *
   * `create` is for a folder page setting a folder's first property: the note
   * may not exist yet, and is then written new (see `writeNoteProperty`).
   */
  setProperty?(path: string, key: string, value: string | null, options?: { create?: boolean }): Promise<string | null>;
  /**
   * Several properties of one note in one write, the same road as
   * `setProperty`. A folder's status list is three keys (`folderPage/statuses.ts`).
   */
  setProperties?(
    path: string,
    changes: readonly (readonly [string, string | readonly string[] | null])[],
    options?: { create?: boolean },
  ): Promise<string | null>;
  /**
   * Who may own a note: the workspace's people and connected agents matching
   * `query`, asked of the server (`owners.searchOwners`). Absent where nobody
   * may write, and where there is no server to ask.
   */
  searchOwners?: OwnerSearch;
}

/** What the notes for one list came back as. */
export interface ListSource {
  readonly notes: readonly ListNote[];
  /**
   * The device holds every note this clearance may see. `false` while a first
   * sync is still arriving, so the list can say it may be missing some rather
   * than showing a short list as if it were the whole folder.
   */
  readonly complete: boolean;
}

/**
 * Where a list gets its notes and where a row goes when it is pressed.
 * A mutable ref, like `FormHostRef`, because the widget is built once and the
 * surface's callbacks change under it.
 */
export interface ListHostContext {
  /** The notes under `folder`, or `null` when this surface keeps no copy to read. */
  load(folder: string, subfolders: boolean): Promise<ListSource | null>;
  /** Open one listed note; `background` for a ⌘-click. */
  open(path: string, background: boolean): void;
  /** Called whenever the notes may have changed; returns the unsubscribe. */
  subscribe?(listener: () => void): () => void;
  /** See `FolderListSource.setProperty`. */
  setProperty?(path: string, key: string, value: string | null): Promise<string | null>;
  /** See `FolderListSource.searchOwners`. */
  searchOwners?: OwnerSearch;
  /** The note holding the block, which is never listed. */
  readonly selfPath: string | null;
}

export interface ListHostRef {
  current: ListHostContext | null;
  /** Incremented when the editor replaces one note with another. */
  generation?: number;
}

export const listHost = Facet.define<ListHostRef, ListHostRef | null>({
  combine: (values) => (values.length > 0 ? values[0] : null),
});

/* ---------------------------- finding the fences ---------------------------- */

/** A fence in the buffer that will be drawn, and what it parsed to. */
export interface ListFence {
  readonly from: number;
  readonly to: number;
  /** The whole fence verbatim; what `eq` compares on. */
  readonly source: string;
  /** Where the body starts, so the caption can put the caret there. */
  readonly bodyFrom: number;
  readonly config: ListConfig | null;
  readonly error: string | null;
}

function fenceTag(doc: EditorState["doc"], fence: SyntaxNode): string | null {
  const info = fence.getChild("CodeInfo");
  if (info === null) return null;
  const first = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : first.toLowerCase();
}

/**
 * Every `list` fence that should be drawn right now: closed, at the margin,
 * outside the frontmatter, not touched by the selection, and only when a host
 * is configured.
 */
export function listFences(state: EditorState, frontEnd = 0): ListFence[] {
  if (state.facet(listHost)?.current == null) return [];
  const fences: ListFence[] = [];
  const selection = revealSelection(state);
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "FencedCode") return;
      const fence = node.node;
      if (fenceTag(state.doc, fence) !== LIST_FENCE_LANG) return;
      const open = state.doc.lineAt(fence.from);
      const close = state.doc.lineAt(fence.to);
      if (open.from !== fence.from || close.to !== fence.to) return;
      // An unclosed fence is somebody still typing it: leave it as text.
      if (fence.getChildren("CodeMark").length < 2 || close.number === open.number) return;
      if (selectionTouches({ from: fence.from, to: fence.to }, selection)) return;
      const bodyFrom = Math.min(open.to + 1, close.from);
      const body = bodyFrom >= close.from ? "" : state.doc.sliceString(bodyFrom, close.from - 1);
      const parsed = parseList(body);
      fences.push({
        from: fence.from,
        to: fence.to,
        source: state.doc.sliceString(fence.from, fence.to),
        bodyFrom,
        config: parsed.config,
        error: parsed.error,
      });
      return false;
    },
  });
  return fences;
}
