/**
 * The folders a site's pages name, and the notes that join the site from them.
 *
 * `folder: features` in `website/features.md` publishes `features/forms.md` at
 * `/features/forms`, without the note moving or being copied. The note is an
 * ordinary route row from then on: re-read at the publication clearance on
 * every visit, served from the release Publish kept, dropped the moment it
 * restricts. What this adds is only *which notes are candidates*; whether one
 * publishes is still the barrier's answer, at the clearance the caller scanned
 * with — so a note `privacy.md` holds back by name, a private subfolder and a
 * note pointed at a group are never read here at the publication clearance.
 *
 * A referenced note never outranks the site: a route one of `website/`'s own
 * files claims (live, draft or broken) keeps it, and a note whose path or
 * metadata the route compiler refuses is left off rather than reported as a
 * problem — a problem stops every Publish, and one stray note in a folder of
 * features should not hold the whole site hostage.
 */

import {
  DEFAULT_WEBSITE_ROOT,
  MAX_REFERENCED_WEBSITE_NOTES,
  isWebsiteRootKey,
  buildWebsiteRouteStatuses,
  referencedWebsiteKey,
  websiteFolderReference,
  websiteRouteLookupKey,
  type WebsiteRouteStatus,
} from "@context/shared";
import { websiteHrefFor } from "./links";
import { scanError } from "./releases";

type Page = { objectKey: string; markdown: string };

export async function referencedWebsitePages(
  own: readonly WebsiteRouteStatus[],
  ownPages: readonly Page[],
  elsewhere: readonly string[],
  read: (keys: string[]) => Promise<{ pages: Page[]; etags: Map<string, string> }>,
): Promise<{ statuses: WebsiteRouteStatus[]; pages: Page[]; etags: Map<string, string> }> {
  const markdownOf = new Map(ownPages.map((page) => [page.objectKey, page.markdown]));
  const candidates = [...elsewhere].sort();
  /** Note → the key it would have inside `website/`. The first page to name it wins. */
  const virtualKey = new Map<string, string>();
  for (const status of [...own].sort((a, b) => a.objectKey.localeCompare(b.objectKey))) {
    // A draft or broken page publishes nothing, its folder included.
    if (status.status !== "live") continue;
    const folder = websiteFolderReference(markdownOf.get(status.objectKey) ?? "");
    if (folder === null) continue;
    for (const note of candidates) {
      if (virtualKey.has(note)) continue;
      const key = referencedWebsiteKey(status.objectKey, folder, note);
      if (key !== null) virtualKey.set(note, key);
    }
  }
  if (virtualKey.size === 0) return { statuses: [], pages: [], etags: new Map() };
  if (virtualKey.size > MAX_REFERENCED_WEBSITE_NOTES) {
    throw scanError(
      `The folders this website's pages name hold more than ${MAX_REFERENCED_WEBSITE_NOTES} notes.`,
    );
  }

  const { pages, etags } = await read([...virtualKey.keys()]);
  const realKey = new Map<string, string>();
  const virtualPages = pages.map((page) => {
    const key = virtualKey.get(page.objectKey)!;
    realKey.set(key, page.objectKey);
    return { objectKey: key, markdown: page.markdown };
  });
  const taken = new Set(
    own.flatMap((status) => (status.routePath === null ? [] : [websiteRouteLookupKey(status.routePath)])),
  );
  // A note a folder publishes is a note, whatever its name: never a layout or a stylesheet.
  const statuses = buildWebsiteRouteStatuses(virtualPages, { code: false }).flatMap((status) => {
    if (status.status === "problem" || status.routePath === null) return [];
    if (taken.has(websiteRouteLookupKey(status.routePath))) return [];
    return [{ ...status, objectKey: realKey.get(status.objectKey)! }];
  });
  const kept = new Set(statuses.map((status) => status.objectKey));
  return {
    statuses,
    pages: pages.filter((page) => kept.has(page.objectKey)),
    etags: new Map([...etags].filter(([key]) => kept.has(key))),
  };
}

/**
 * The key the route compiler reads for an indexed row: its own for a page in
 * `website/`, and for a referenced note the one its address implies. Used where
 * a served page's live bytes are re-checked, so a referenced note is held to
 * the same draft and audience narrowing as the site's own pages.
 */
export function routeStatusKey(objectKey: string, routePath: string): string {
  if (isWebsiteRootKey(objectKey)) return objectKey;
  return `${DEFAULT_WEBSITE_ROOT}${routePath === "/" ? "/index" : routePath}.md`;
}

/** A note a folder page published, as the list under that page names it. */
export type FolderPage = { routePath: string; title: string; description: string | null };

/**
 * The published notes under a folder page, from the route index alone: every
 * live row beneath its address that is not one of `website/`'s own files. A
 * visitor sees the public ones; a member, the members-only ones too.
 */
export function folderPagesUnder(
  rows: ReadonlyArray<{
    objectKey: string;
    routePath: string | null;
    title: string | null;
    description: string | null;
    status: string;
    audience: "public" | "members";
  }>,
  routePath: string,
  member: boolean,
): FolderPage[] {
  const prefix = websiteRouteLookupKey(routePath === "/" ? "/" : `${routePath}/`);
  return rows
    .flatMap((row) =>
      row.status === "live" &&
      row.routePath !== null &&
      row.title !== null &&
      !isWebsiteRootKey(row.objectKey) &&
      (row.audience === "public" || member) &&
      websiteRouteLookupKey(row.routePath).startsWith(prefix)
        ? [{ routePath: row.routePath, title: row.title, description: row.description }]
        : [],
    )
    .sort((left, right) => left.routePath.localeCompare(right.routePath));
}

/**
 * The folder page's text with its notes listed under it: a link to each by
 * title, and its description where it has one. The links are addresses on the
 * site, which is what the link rewriter already leaves alone.
 */
export function withFolderList(body: string, pages: readonly FolderPage[]): string {
  if (pages.length === 0) return body;
  return `${body.replace(/\s+$/, "")}\n\n${folderListMarkdown(pages)}\n`;
}

/**
 * The list, only on a page that names a folder: one of the site's own files
 * with a `folder:` line it still carries. Any other page — the home page, a
 * page of the site's that sits above a folder page, a note a folder published
 * — has notes beneath its address without having asked for them.
 */
export function folderListFor(
  objectKey: string,
  text: string,
  body: string,
  pages: readonly FolderPage[],
): string {
  if (!isWebsiteRootKey(objectKey) || websiteFolderReference(text) === null) return body;
  return withFolderList(body, pages);
}

function folderListMarkdown(pages: readonly FolderPage[]): string {
  const items = pages.map((page) => {
    const title = oneLine(page.title).replace(/([\\[\]])/g, "\\$1");
    const line = `- [${title}](${websiteHrefFor(page.routePath)})`;
    return page.description === null ? line : `${line} — ${oneLine(page.description)}`;
  });
  return items.join("\n");
}

/** A line break in a title or description would end the list item early. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
