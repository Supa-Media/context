/**
 * A site check: what an agent needs to know before it publishes, without a
 * browser — `write_note` `site: { action: "check" }`.
 *
 * It reads the folder exactly as Publish would (the publication clearance,
 * through the one barrier) and reports, for what Publish would release:
 *
 *  - **the route map**: every address and the file that answers it;
 *  - **links that go nowhere**: in pages, with the note and line, and in
 *    layouts, where a relative link means something different on every page;
 *  - **pictures**: each one the site draws, its size, the files that use it,
 *    and the ones that are missing, too large or not stored at all;
 *  - **what the cleaner removes** from each layout, page and stylesheet, and
 *    why, line by line — the reason a "larger template" draws nothing;
 *  - **pages that draw nothing**, or fewer pictures than they name.
 *
 * Given a code note's `path`, it also returns that note as the site draws it:
 * the cleaned HTML, or the CSS scoped under `.ctx-site`, after Context's own
 * base sheet. Nothing here writes, publishes, or widens what anyone can read:
 * an owner's or editor's agent already reads every file it reports on.
 */

import {
  SITE_BASE_CSS,
  SITE_SCOPE,
  parseLinks,
  parseWebsitePage,
  publishedImageLeaves,
  resolveLink,
  indexByName,
  sanitizeSiteCss,
  sanitizeSiteHtml,
  websiteCodeBlock,
  websiteCodeLanguage,
  websiteFolderReference,
  type Link,
  type SiteRemoval,
  type WebsiteRouteStatus,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { MAX_PUBLISHED_IMAGE_BYTES, MAX_PUBLISHED_IMAGES } from "./images";
import { websiteLinkDestination, type WebsiteLinkCatalogEntry } from "./links";
import { PUBLICATION_CLEARANCE } from "./publication";
import { scanWebsiteRoutes } from "./routes";

/** Pictures read for their size in one check; past this they are listed unread. */
export const MAX_CHECKED_PICTURES = 40;
const PICTURE_READS_AT_ONCE = 4;
/** The longest cleaned output a check hands back for one note. */
export const MAX_INSPECTED_OUTPUT = 40_000;
/** Findings of one kind a check reports before saying how many more. */
const MAX_FINDINGS = 60;

export interface SiteCheckLink {
  path: string;
  line: number;
  target: string;
  problem: string;
}

export interface SiteCheckPicture {
  name: string;
  bytes: number | null;
  usedBy: string[];
  problem: string | null;
}

export interface SiteCheckCode {
  path: string;
  role: string;
  removed: Array<{ line: number | null; what: string; why: string }>;
}

export interface SiteCheck {
  enabled: boolean;
  draft: string | null;
  routes: Array<{ address: string; path: string; status: string; audience: string }>;
  pageProblems: Array<{ path: string; problems: string[] }>;
  links: SiteCheckLink[];
  pictures: SiteCheckPicture[];
  code: SiteCheckCode[];
  /** Pages and layouts that draw nothing, or less than they say. */
  warnings: Array<{ path: string; why: string }>;
  /** How many findings of each kind were left out past the cap. */
  more: { links: number; removed: number };
  inspected: { path: string; output: string; truncated: boolean } | null;
}

type Page = { objectKey: string; markdown: string };

/* ---------------------------------- helpers ---------------------------------- */

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/** A code note's one block and where it starts in the note, or null. */
function codeOf(objectKey: string, text: string): { code: string; start: number } | null {
  const language = websiteCodeLanguage(objectKey);
  if (language === null) return null;
  const normalized = normalize(text);
  const body = parseWebsitePage(normalized).body;
  const block = websiteCodeBlock(body, language);
  if (!("code" in block)) return null;
  const bodyStart = Math.max(0, normalized.lastIndexOf(body));
  const fence = normalized.indexOf("\n", normalized.indexOf("`".repeat(3), bodyStart)) + 1;
  const start = block.code === "" ? fence : normalized.indexOf(block.code, fence);
  return { code: block.code, start: start < 0 ? fence : start };
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length]!;
}

/** The nearest live address to a broken one, by its last word or a small typo. */
function nearestAddress(target: string, addresses: readonly string[]): string | null {
  const wanted = target.split("#")[0]!.replace(/\/+$/, "").toLowerCase();
  const last = wanted.slice(wanted.lastIndexOf("/") + 1).replace(/\.md$/, "");
  let best: { address: string; distance: number } | null = null;
  for (const address of addresses) {
    const lower = address.toLowerCase();
    const distance = lower.endsWith(`/${last}`) && last !== "" ? 0 : editDistance(wanted, lower);
    if (distance <= 2 && (best === null || distance < best.distance)) best = { address, distance };
  }
  return best?.address ?? null;
}

/** Is this a link into the site, rather than out of it or within the page? */
function linksIntoSite(link: Link, handle: string, ownedHosts: ReadonlySet<string>): boolean {
  if (link.kind === "wiki") return true;
  const target = link.target.trim();
  if (target === "" || target.startsWith("#") || target.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target);
  if (scheme === null) return true;
  if (!/^https?$/i.test(scheme[1]!)) return false;
  try {
    const url = new URL(target);
    const host = url.hostname.toLowerCase();
    if (host === "context.lc") {
      const prefix = `/@${handle.toLowerCase()}`;
      return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
    }
    return ownedHosts.has(host);
  } catch {
    return false;
  }
}

/* ------------------------------- the analysis ------------------------------- */

export interface SiteCheckInput {
  handle: string;
  ownedHosts: readonly string[];
  statuses: readonly WebsiteRouteStatus[];
  pages: readonly Page[];
  /** Published shares a page may link to; routes come from `statuses`. */
  shares: readonly WebsiteLinkCatalogEntry[];
  inspect?: string;
}

/** Everything a check finds that needs no bucket read; pictures come back unsized. */
export function analyzeSite(input: SiteCheckInput): Omit<SiteCheck, "enabled" | "draft"> {
  const text = new Map(input.pages.map((page) => [page.objectKey, normalize(page.markdown)]));
  const live = input.statuses.filter((status) => status.status === "live");
  const catalog: WebsiteLinkCatalogEntry[] = [
    ...live.flatMap((status) =>
      status.routePath === null
        ? []
        : [{ kind: "route" as const, objectKey: status.objectKey, href: status.routePath, audience: status.audience, sourceEtag: null }],
    ),
    ...input.shares.filter((entry) => entry.kind === "share"),
  ];
  const addresses = catalog.filter((entry) => entry.kind === "route").map((entry) => entry.href);
  const ownedHosts = new Set(input.ownedHosts.map((host) => host.toLowerCase()));
  const byName = indexByName(input.statuses.map((status) => status.objectKey));
  const statusOf = new Map(input.statuses.map((status) => [status.objectKey, status]));
  const more = { links: 0, removed: 0 };

  /* Links. */
  const links: SiteCheckLink[] = [];
  const addLink = (finding: SiteCheckLink) => {
    if (links.length < MAX_FINDINGS) links.push(finding);
    else more.links += 1;
  };
  const brokenBecause = (link: Link, fromPath: string): string => {
    const target = link.target.trim();
    if (target.startsWith("/")) {
      const near = nearestAddress(target, addresses);
      return `no page has the address ${target.split("#")[0]}${near === null ? "" : `; did you mean ${near}?`}`;
    }
    const resolved = resolveLink(link, fromPath, byName);
    const page = resolved === null ? undefined : statusOf.get(resolved);
    if (page?.status === "draft") return `${page.objectKey} is a draft, so the link goes nowhere until it is published`;
    if (page?.status === "problem") return `${page.objectKey} has a problem and is not published`;
    return "no published page or shared note goes by that name";
  };
  for (const page of live) {
    if (page.code !== undefined) continue;
    const markdown = text.get(page.objectKey);
    if (markdown === undefined) continue;
    const destination = websiteLinkDestination({
      fromPath: page.objectKey,
      handle: input.handle,
      ownedHosts: input.ownedHosts,
      catalog,
    });
    for (const link of parseLinks(markdown)) {
      if (link.embed || !linksIntoSite(link, input.handle, ownedHosts)) continue;
      if (destination(link) !== null) continue;
      addLink({
        path: page.objectKey,
        line: lineAt(markdown, link.start),
        target: link.target.trim(),
        problem: brokenBecause(link, page.objectKey),
      });
    }
  }

  /* Code notes: what the cleaner removes, the links and pictures they name. */
  const pictureUse = new Map<string, Set<string>>();
  const usePicture = (name: string, path: string) => {
    const users = pictureUse.get(name) ?? new Set<string>();
    users.add(path);
    pictureUse.set(name, users);
  };
  const code: SiteCheckCode[] = [];
  const warnings: Array<{ path: string; why: string }> = [];
  let inspected: SiteCheck["inspected"] = null;
  for (const status of live) {
    if (status.code === undefined || status.code === "script") continue;
    const note = text.get(status.objectKey);
    const block = note === undefined ? null : codeOf(status.objectKey, note);
    if (note === undefined || block === null) continue;
    const removed: SiteCheckCode["removed"] = [];
    const record = (removal: SiteRemoval) => {
      if (removed.length >= MAX_FINDINGS) {
        more.removed += 1;
        return;
      }
      removed.push({
        line: removal.at === undefined ? null : lineAt(note, block.start + removal.at),
        what: removal.what,
        why: removal.why,
      });
    };
    // Every name resolves here: whether a picture exists is the pictures
    // section's question, so the cleaner reports only what it removes itself.
    const image = (name: string) => {
      usePicture(name, status.objectKey);
      return "data:image/png;base64,AAAA";
    };
    let output: string;
    if (status.code === "style") {
      output = sanitizeSiteCss(block.code, { scope: SITE_SCOPE, image, removed: record }).css;
    } else {
      const cleaned = sanitizeSiteHtml(block.code, { image, removed: record });
      for (const sheet of cleaned.styles) sanitizeSiteCss(sheet, { scope: SITE_SCOPE, image, removed: record });
      output = cleaned.html;
      const hadContent = /\{\s*content\s*\}/.test(block.code);
      if ((status.code === "frame" || status.code === "layout") && hadContent && !/\{\s*content\s*\}/.test(output)) {
        warnings.push({
          path: status.objectKey,
          why: "{ content } sits inside something the cleaner removes, so every page drawn with it shows nothing",
        });
      }
      if (status.code === "html" && output.replace(/<(?!img\b)[^>]*>/g, "").trim() === "") {
        warnings.push({ path: status.objectKey, why: "after cleaning, this page has no words or pictures left" });
      }
      for (const match of block.code.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (href === "" || href.includes("{") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
          continue;
        }
        const line = lineAt(note, block.start + (match.index ?? 0));
        if (!href.startsWith("/")) {
          addLink({
            path: status.objectKey,
            line,
            target: href,
            problem: "a relative link in site code points somewhere different on every page; start it with /",
          });
          continue;
        }
        const destination = websiteLinkDestination({
          fromPath: status.objectKey,
          handle: input.handle,
          ownedHosts: input.ownedHosts,
          catalog,
        });
        if (destination({ kind: "inline", embed: false, target: href, start: 0, end: 0 } as Link) === null) {
          const near = nearestAddress(href, addresses);
          addLink({
            path: status.objectKey,
            line,
            target: href,
            problem: `no page has the address ${href.split("#")[0]}${near === null ? "" : `; did you mean ${near}?`}`,
          });
        }
      }
    }
    if (removed.length > 0) code.push({ path: status.objectKey, role: status.code, removed });
    if (input.inspect === status.objectKey) {
      const full =
        status.code === "style" ? `/* Context's base sheet, drawn before yours */\n${SITE_BASE_CSS}\n\n/* ${status.objectKey} */\n${output}` : output;
      inspected = {
        path: status.objectKey,
        output: full.slice(0, MAX_INSPECTED_OUTPUT),
        truncated: full.length > MAX_INSPECTED_OUTPUT,
      };
    }
  }

  /* Pages: their pictures, and pages with nothing to show. */
  const remote: Array<{ path: string; name: string }> = [];
  for (const page of live) {
    if (page.code !== undefined) continue;
    const markdown = text.get(page.objectKey);
    if (markdown === undefined) continue;
    const leaves = publishedImageLeaves(markdown);
    for (const leaf of leaves) usePicture(leaf, page.objectKey);
    if (leaves.length > MAX_PUBLISHED_IMAGES) {
      warnings.push({
        path: page.objectKey,
        why: `this page shows ${leaves.length} pictures and a page draws at most ${MAX_PUBLISHED_IMAGES}; the rest are left out`,
      });
    }
    for (const match of markdown.matchAll(/!\[[^\]\n]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?/gi)) {
      remote.push({ path: page.objectKey, name: match[1]! });
    }
    const body = parseWebsitePage(markdown).body.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (body === "" && websiteFolderReference(markdown) === null) {
      warnings.push({ path: page.objectKey, why: "this page has no words, so visitors see only the site's frame" });
    }
  }
  const pictures: SiteCheckPicture[] = [...pictureUse].map(([name, users]) => ({
    name,
    bytes: null,
    usedBy: [...users].sort(),
    problem: null,
  }));
  for (const { path, name } of remote) {
    pictures.push({
      name,
      bytes: null,
      usedBy: [path],
      problem: "a picture from another site never loads on yours; attach it with write_note images",
    });
  }

  const routes = input.statuses
    .filter((status) => status.routePath !== null && status.status !== "problem")
    .map((status) => ({
      address: status.routePath!,
      path: status.objectKey,
      status: status.status,
      audience: status.audience,
    }))
    .sort((left, right) => left.address.localeCompare(right.address));
  const pageProblems = input.statuses
    .filter((status) => status.problems.length > 0)
    .map((status) => ({ path: status.objectKey, problems: status.problems.map((problem) => problem.message) }));

  if (input.inspect !== undefined && inspected === null) {
    inspected = {
      path: input.inspect,
      output: `${input.inspect} is not a layout, HTML page or stylesheet the site publishes now, so there is nothing to show.`,
      truncated: false,
    };
  }
  return { routes, pageProblems, links, pictures, code, warnings, more, inspected };
}

/* ---------------------------------- reading ---------------------------------- */

/** A stored picture's size, or why it cannot be drawn. */
function pictureProblem(name: string, bytes: number | null): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) {
    return "a picture is named by the leaf it was stored as, with no folder; write_note images returns it";
  }
  if (!/\.(?:png|jpe?g|gif|webp)$/i.test(name)) return "sites draw PNG, JPEG, GIF and WebP pictures";
  if (bytes === null) return "no picture is stored under this exact name";
  if (bytes > MAX_PUBLISHED_IMAGE_BYTES) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB is over the ${MAX_PUBLISHED_IMAGE_BYTES / 1024 / 1024} MB a site draws; attach a smaller copy`;
  }
  return null;
}

async function sizePictures(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  pictures: SiteCheckPicture[],
): Promise<SiteCheckPicture[]> {
  const unread = pictures.filter((picture) => picture.problem === null);
  // A few at a time: each read holds a whole picture, up to 5 MB, in memory.
  const sized: SiteCheckPicture[] = [];
  const wanted = unread.slice(0, MAX_CHECKED_PICTURES);
  for (let offset = 0; offset < wanted.length; offset += PICTURE_READS_AT_ONCE) {
    sized.push(
      ...(await Promise.all(
        wanted.slice(offset, offset + PICTURE_READS_AT_ONCE).map(async (picture) => {
          const named = pictureProblem(picture.name, 0);
          if (named !== null) return { ...picture, problem: named };
          const read = await ctx
            .runAction(internal.functions.files.runFileOperation, {
              workspaceId,
              ...PUBLICATION_CLEARANCE,
              operation: { kind: "readImage" as const, leaf: picture.name },
            })
            .catch(() => null);
          const bytes = read?.kind === "image" ? read.bytes.byteLength : null;
          return { ...picture, bytes, problem: pictureProblem(picture.name, bytes) };
        }),
      )),
    );
  }
  const skipped = unread.slice(MAX_CHECKED_PICTURES).map((picture) => ({
    ...picture,
    problem: `not checked: a check reads at most ${MAX_CHECKED_PICTURES} pictures`,
  }));
  return [...sized, ...skipped, ...pictures.filter((picture) => picture.problem !== null)];
}

/** The whole check for one workspace's site, read at the publication clearance. */
export async function siteCheckFor(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  draftOf: (snapshot: Awaited<ReturnType<typeof scanWebsiteRoutes>>) => Promise<string>,
  inspect?: string,
): Promise<SiteCheck | null> {
  const facts = await ctx.runQuery(internal.functions.websites.siteFacts, { workspaceId });
  if (facts === null) return null;
  if (!facts.enabled) {
    return {
      enabled: false,
      draft: null,
      routes: [],
      pageProblems: [],
      links: [],
      pictures: [],
      code: [],
      warnings: [],
      more: { links: 0, removed: 0 },
      inspected: null,
    };
  }
  const snapshot = await scanWebsiteRoutes(ctx, workspaceId, PUBLICATION_CLEARANCE, { publication: true });
  const published = await ctx.runQuery(internal.functions.websites.websiteLinkCatalog, { workspaceId });
  const analysis = analyzeSite({
    handle: facts.handle,
    ownedHosts: published.ownedHosts,
    statuses: snapshot.statuses,
    pages: snapshot.pages,
    shares: published.entries.filter((entry) => entry.kind === "share"),
    ...(inspect === undefined ? {} : { inspect }),
  });
  return {
    enabled: true,
    draft: await draftOf(snapshot),
    ...analysis,
    pictures: await sizePictures(ctx, workspaceId, analysis.pictures),
  };
}
