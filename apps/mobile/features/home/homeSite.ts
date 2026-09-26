import { parseWebsitePage } from "@context/shared";
import type { FileEntry, FolderListing } from "../console/files/types";
import type { DemoContextTree } from "../console/placeholderData/treeHelpers";
import type { LegalPageContent } from "../legal/LegalPage";
import { privacyContent, termsContent } from "../legal/content";
import { BUILT_IN_PAGES } from "./builtInPages";

/**
 * The homepage as a workspace: what its tree holds, which file each page is,
 * and where a link inside it goes.
 *
 * Pure, so the rules a visitor meets (which pages are listed and in what
 * order, which links leave the shell, what an unknown page draws) are tested
 * here rather than found by clicking.
 */

/** What the switcher shows. The homepage is `@context`, not a customer's handle. */
export const HOME_WORKSPACE_LABEL = "@context";

export interface HomePage {
  routePath: string;
  title: string;
  /** Markdown with no frontmatter. */
  markdown: string;
}

/** A built-in page, keyed by its file stem: `index` is `/`, `pricing` is `/pricing`. */
export function builtInPage(stem: string, source: string): HomePage {
  const parsed = parseWebsitePage(source);
  return {
    routePath: stem === "index" ? "/" : `/${stem}`,
    title: parsed.title ?? stem,
    markdown: parsed.body,
  };
}

/** The built-in site, in the order its files list them. */
export const BUILT_IN_SITE: readonly HomePage[] = Object.entries(BUILT_IN_PAGES).map(
  ([stem, source]) => builtInPage(stem, source),
);

/** Privacy and Terms, as two more notes in the tree rather than two pages outside it. */
export function legalMarkdown(content: LegalPageContent, standalone: string): string {
  const sections = content.sections
    .map((section) => `## ${section.title}\n\n${section.body.join("\n\n")}`)
    .join("\n\n");
  return (
    `# ${content.title}\n\n*Updated ${content.updated}*\n\n${content.intro}\n\n` +
    `This is also on [its own page](${standalone}), to link to or print.\n\n${sections}\n`
  );
}

/*
  Also real routes, `/privacy` and `/terms`, which stay: a policy needs an
  address of its own to be linked from a consent screen. The link inside each
  note is how the homepage reaches them (`APP_ROUTES`).
*/
export const LEGAL_PAGES: readonly HomePage[] = [
  { routePath: "/legal/privacy", title: "Privacy", markdown: legalMarkdown(privacyContent, "/privacy") },
  { routePath: "/legal/terms", title: "Terms", markdown: legalMarkdown(termsContent, "/terms") },
];

/**
 * The one private note, which is what shows how visibility works: it carries
 * the private marker in the tree, and says what that means when it is opened.
 * It says plainly that the visitor is seeing the owner's view, because a
 * teammate would never see a private note listed at all.
 */
export const PRIVATE_PAGE: HomePage = {
  routePath: "/roadmap",
  title: "Roadmap",
  markdown:
    "# Roadmap\n\n" +
    "This note is private. You can see it here because this page shows `@context` the way its " +
    "owner sees it.\n\n" +
    "A teammate would not see this note in the tree at all, and neither would their AI. " +
    "Private notes are left out, not greyed out.\n\n" +
    "[<kbd>See who sees what</kbd>](/who-sees-what)\n",
};

/** Paths the tree and tabs address pages by, so labels and order come for free. */
const LEGAL_FOLDER = "Legal";

function fileName(title: string): string {
  // A title is somebody's words; a slash in one would read as a folder.
  return `${title.replace(/[/\\]/g, "-").trim() || "Untitled"}.md`;
}

export interface HomeTree {
  tree: DemoContextTree;
  /** Tree path → page. */
  pages: ReadonlyMap<string, HomePage>;
  /** Route path → tree path. */
  paths: ReadonlyMap<string, string>;
}

/**
 * The tree for a list of site pages: numbered in menu order so the tree keeps
 * it (the number is a sort prefix, which the tree never draws), then the
 * private note, then Legal.
 */
export function homeTree(site: readonly HomePage[]): HomeTree {
  const pages = new Map<string, HomePage>();
  const paths = new Map<string, string>();
  const root: FileEntry[] = [];
  const add = (path: string, page: HomePage, over: Partial<FileEntry> = {}) => {
    pages.set(path, page);
    paths.set(page.routePath, path);
    return entry(path, over);
  };
  const listed = [...site, PRIVATE_PAGE];
  listed.forEach((page, index) => {
    const path = `${String(index + 1).padStart(2, "0")}-${fileName(page.title)}`;
    root.push(add(path, page, page === PRIVATE_PAGE ? { visibility: "private", exception: true } : {}));
  });
  root.push({ ...entry(LEGAL_FOLDER), kind: "folder" });
  const legal = LEGAL_PAGES.map((page) => add(`${LEGAL_FOLDER}/${fileName(page.title)}`, page));
  const notes: Record<string, string> = {};
  for (const [path, page] of pages) notes[path] = page.markdown;
  const first = paths.get("/") ?? [...pages.keys()][0] ?? "";
  return {
    pages,
    paths,
    tree: {
      listings: {
        "": listing("", root),
        [LEGAL_FOLDER]: listing(LEGAL_FOLDER, legal),
      },
      notes,
      defaultSelection: first,
      defaultExpanded: [LEGAL_FOLDER],
      readOnlyReason: "This workspace is read only. Make your own to start writing.",
    },
  };
}

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "team",
    inherited: "team",
    exception: false,
    // `readOnly` is the generated-file marker (`privacy.md`); nothing here is
    // that. The browser's `canEdit: false` is what keeps every note unwritable.
    readOnly: false,
    ...over,
  };
}

function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", entries, truncated: false, manifestUsable: true };
}

/** What an unknown `?page=` draws, in the shell's own voice. */
export const MISSING_PAGE_MARKDOWN =
  "# Nothing here\n\nThis page doesn't exist, or isn't published yet.\n\n[<kbd>Go to Welcome</kbd>](/)\n";

/**
 * Paths that belong to the app rather than to the site. A link to one leaves
 * the shell for that screen; every other root-relative link is a page.
 */
const APP_ROUTES = ["/login", "/console", "/connect", "/invite", "/privacy", "/terms", "/s/"];

export type HomeLink = { kind: "page"; routePath: string } | { kind: "app"; href: string };

/** Where a root-relative link inside a page goes. Anything else was already refused. */
export function homeLink(href: string): HomeLink | null {
  const raw = href.split("#")[0]!.split("?")[0]!;
  let routePath: string;
  try {
    routePath = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!routePath.startsWith("/") || routePath.startsWith("//")) return null;
  const app = APP_ROUTES.some((route) =>
    route.endsWith("/") ? routePath.startsWith(route) : routePath === route || routePath.startsWith(`${route}/`),
  );
  if (app) return { kind: "app", href: raw };
  const trimmed = routePath.length > 1 ? routePath.replace(/\/+$/, "") : routePath;
  return { kind: "page", routePath: trimmed === "" ? "/" : trimmed };
}

/** The `?page=` a route path is written as in the address bar; the home page has none. */
export function pageParam(routePath: string): string | undefined {
  return routePath === "/" ? undefined : routePath.slice(1);
}

/** The route path a `?page=` names. */
export function routeFromParam(param: string | string[] | undefined): string {
  const value = Array.isArray(param) ? param[0] : param;
  if (value === undefined || value === "") return "/";
  const trimmed = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}
