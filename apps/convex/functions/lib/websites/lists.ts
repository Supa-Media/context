/** Live, viewer-filtered evaluation of Folder list blocks on public pages. */

import {
  listLoadsSubfolders,
  noteHeading,
  inlineTags,
  noteProperties,
  renderEvaluatedListBlocks,
  selectListRows,
} from "../../../../mcp/src/lists.js";
import { parseWebsitePage } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isEncryptedNote } from "../noteEncryption";
import { websiteTextRestricts } from "./changes";
import { websiteHrefFor, type WebsiteLinkCatalogEntry } from "./links";
import { currentRows, type RowFacts, type TreeRow } from "./treeFacts";

export { readBatches } from "./treeFacts";

type ViewerAudience = "public" | "members";
type ListConfig = {
  from: string;
  where: Array<{ property: string; op: string; value?: string }>;
  sort: { key: string; order: "asc" | "desc" };
  show: string[];
  limit: number;
  subfolders: boolean;
  rows?: "notes" | "projects";
  group?: string | null;
  as?: "list" | "board";
};
type SelectedRow = {
  path: string;
  href?: string | null;
  children?: SelectedRow[];
};

const MAX_PUBLIC_LIST_CANDIDATES = 500;

function canName(
  entry: WebsiteLinkCatalogEntry,
  viewer: ViewerAudience,
): boolean {
  return entry.audience === "public" || viewer === "members";
}

function couldMatch(
  config: ListConfig,
  path: string,
  selfPath: string,
): boolean {
  if (path === selfPath || !path.endsWith(".md")) return false;
  const prefix = `${config.from}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
  return listLoadsSubfolders(config) || !rest.includes("/");
}

function canonicalEntries(
  catalog: readonly WebsiteLinkCatalogEntry[],
): Map<string, WebsiteLinkCatalogEntry> {
  const byPath = new Map<string, WebsiteLinkCatalogEntry>();
  for (const entry of catalog) {
    if (entry.kind === "route") byPath.set(entry.objectKey, entry);
  }
  for (const entry of catalog) {
    if (!byPath.has(entry.objectKey)) byPath.set(entry.objectKey, entry);
  }
  return byPath;
}

/** A page as Publish kept it: where its copy lives, by file. */
export interface ReleasedPage {
  objectKey: string;
  releaseId?: string;
  releasePageId?: string;
}

const RELEASE_BATCH = 50;

/** The published copies of `pages`, by file; a copy that is gone is absent. */
export async function releasedTexts(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  pages: readonly ReleasedPage[],
): Promise<Map<string, string>> {
  const wanted = pages.flatMap((page) =>
    page.releaseId === undefined || page.releasePageId === undefined
      ? []
      : [{ releaseId: page.releaseId, pageId: page.releasePageId, path: page.objectKey }],
  );
  const texts = new Map<string, string>();
  for (let offset = 0; offset < wanted.length; offset += RELEASE_BATCH) {
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      grantedNames: [],
      operation: { kind: "readWebsiteRelease", pages: wanted.slice(offset, offset + RELEASE_BATCH) },
    });
    if (result.kind !== "websiteReleasePages") continue;
    for (const page of result.results) {
      if (page.outcome === "read") texts.set(page.path, page.text);
    }
  }
  return texts;
}

/**
 * Whether a route still publishes to the audience it was indexed for, by its
 * facts: a draft never, and a public route only while nothing in its front
 * matter narrows it. A note `privacy.md` holds back never gets this far.
 */
function stillPublishes(entry: WebsiteLinkCatalogEntry, facts: RowFacts): boolean {
  if (facts.site.draft) return false;
  return entry.audience !== "public" || !facts.site.restricts;
}

/** The list facts of a page as Publish kept it, read from that copy. */
function releasedFacts(text: string): RowFacts | null {
  if (isEncryptedNote(text)) return null;
  const parsed = parseWebsitePage(text);
  return {
    properties: noteProperties(text),
    inlineTags: inlineTags(text),
    heading: noteHeading(text),
    site: { draft: parsed.draft, restricts: websiteTextRestricts(text) },
  };
}

export async function renderPublicWebsiteLists(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    markdown: string;
    selfPath: string;
    viewerAudience: ViewerAudience;
    catalog: readonly WebsiteLinkCatalogEntry[];
  },
): Promise<string> {
  const byPath = canonicalEntries(args.catalog);
  const cache = new Map<string, TreeRow | null>();
  /** Each route's facts as published; null when it no longer publishes. */
  const published = new Map<string, RowFacts | null>();
  let foundStaleRoute = false;

  const rendered = await renderEvaluatedListBlocks(
    args.markdown,
    async (config: ListConfig) => {
      const entries = [...byPath.values()].filter(
        (entry) =>
          canName(entry, args.viewerAudience) &&
          couldMatch(config, entry.objectKey, args.selfPath),
      );
      if (entries.length > MAX_PUBLIC_LIST_CANDIDATES) {
        throw new Error("folder list candidate limit exceeded");
      }
      // Routes and shares alike are read at the publication clearance: a
      // shared note is shown to its link's readers, `team` with no names.
      const missing = entries
        .map((entry) => entry.objectKey)
        .filter((path) => !cache.has(path));
      const rows = await currentRows(ctx, args.workspaceId, missing);
      if (rows === null) throw new Error("folder list tree not served");
      for (const path of missing) cache.set(path, rows.get(path) ?? null);

      // An edit waits for Publish, so a route whose live version changed but
      // still publishes is listed by the copy Publish kept, as the page itself
      // is served. A restriction is never answered from that copy.
      const edited: WebsiteLinkCatalogEntry[] = [];
      for (const entry of entries) {
        if (entry.kind !== "route" || published.has(entry.objectKey)) continue;
        const row = cache.get(entry.objectKey) ?? null;
        if (row === null || row.facts === null) continue;
        if (!stillPublishes(entry, row.facts)) {
          published.set(entry.objectKey, null);
        } else if (entry.sourceEtag !== null && row.etag === entry.sourceEtag) {
          published.set(entry.objectKey, row.facts);
        } else {
          edited.push(entry);
        }
      }
      const copies = await releasedTexts(ctx, args.workspaceId, edited);
      for (const entry of edited) {
        const copy = copies.get(entry.objectKey);
        published.set(entry.objectKey, copy === undefined ? null : releasedFacts(copy));
      }

      const notes = [];
      for (const entry of entries) {
        const row = cache.get(entry.objectKey) ?? null;
        if (row === null || row.facts === null) continue;
        const facts =
          entry.kind === "route"
            ? published.get(entry.objectKey) ?? null
            : row.facts;
        if (facts === null) {
          // Restricted since Publish, or no kept copy to list it by.
          if (entry.kind === "route") foundStaleRoute = true;
          continue;
        }
        notes.push({
          path: entry.objectKey,
          updatedAt: row.updatedAt,
          properties: facts.properties,
          inlineTags: facts.inlineTags,
          heading: facts.heading,
        });
      }
      const selection = selectListRows(config, notes, {
        selfPath: args.selfPath,
      });
      const withHref = (row: SelectedRow): SelectedRow => ({
        ...row,
        // Percent-encoded per segment: a raw space ends a Markdown link
        // target, so `/Team Notes` came out as plain text.
        href: hrefOf(byPath.get(row.path)),
        ...(Array.isArray(row.children)
          ? { children: row.children.map(withHref) }
          : {}),
      });
      return {
        ...selection,
        rows: selection.rows.map(withHref),
      };
    },
  );

  if (foundStaleRoute) {
    await ctx.runMutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: args.workspaceId,
    });
  }
  return rendered;
}

function hrefOf(entry: WebsiteLinkCatalogEntry | undefined): string | null {
  if (entry === undefined) return null;
  return entry.kind === "route" ? websiteHrefFor(entry.href) : entry.href;
}
