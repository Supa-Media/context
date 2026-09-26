/** Live, viewer-filtered evaluation of Folder list blocks on public pages. */

import {
  listLoadsSubfolders,
  noteHeading,
  noteProperties,
  renderEvaluatedListBlocks,
  selectListRows,
} from "../../../../mcp/src/lists.js";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isEncryptedNote } from "../noteEncryption";
import type { WebsiteLinkCatalogEntry } from "./links";

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
type ReadNote = {
  path: string;
  text: string;
  etag: string;
  updatedAt?: number;
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

async function readBatches(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  scope: "private" | "team",
  paths: readonly string[],
): Promise<Map<string, ReadNote>> {
  const pending = [...new Set(paths)];
  const notes = new Map<string, ReadNote>();
  let passes = 0;
  while (pending.length > 0) {
    // `readMany` guarantees its first path makes progress even at the byte cap.
    if (passes++ > paths.length + 1)
      throw new Error("folder list read did not progress");
    const batch = pending.splice(0, 50);
    const result = await ctx.runAction(
      internal.functions.files.runFileOperation,
      {
        workspaceId,
        scope,
        grantedNames: [],
        operation: { kind: "readMany" as const, paths: batch },
      },
    );
    if (result.kind !== "notes") throw new Error("folder list read failed");
    const deferred: string[] = [];
    for (const item of result.results) {
      if (item.outcome === "deferred") {
        deferred.push(item.path);
      } else if (item.outcome === "read") {
        notes.set(item.path, {
          path: item.path,
          text: item.note.text,
          etag: item.note.etag,
          ...(item.note.updatedAt === undefined
            ? {}
            : { updatedAt: item.note.updatedAt }),
        });
      }
    }
    pending.unshift(...deferred);
  }
  return notes;
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
  const cache = new Map<string, ReadNote | null>();
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
      const missingRoutes = entries
        .filter(
          (entry) => entry.kind === "route" && !cache.has(entry.objectKey),
        )
        .map((entry) => entry.objectKey);
      const missingShares = entries
        .filter(
          (entry) => entry.kind === "share" && !cache.has(entry.objectKey),
        )
        .map((entry) => entry.objectKey);
      const [routes, shares] = await Promise.all([
        readBatches(ctx, args.workspaceId, "private", missingRoutes),
        readBatches(ctx, args.workspaceId, "team", missingShares),
      ]);
      for (const path of missingRoutes)
        cache.set(path, routes.get(path) ?? null);
      for (const path of missingShares)
        cache.set(path, shares.get(path) ?? null);

      const notes = [];
      for (const entry of entries) {
        const note = cache.get(entry.objectKey) ?? null;
        if (note === null || isEncryptedNote(note.text)) continue;
        if (
          entry.kind === "route" &&
          (entry.sourceEtag === null || note.etag !== entry.sourceEtag)
        ) {
          foundStaleRoute = true;
          continue;
        }
        notes.push({
          path: entry.objectKey,
          updatedAt: note.updatedAt ?? null,
          properties: noteProperties(note.text),
          heading: noteHeading(note.text),
        });
      }
      const selection = selectListRows(config, notes, {
        selfPath: args.selfPath,
      });
      const withHref = (row: SelectedRow): SelectedRow => ({
        ...row,
        href: byPath.get(row.path)?.href ?? null,
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
