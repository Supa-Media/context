/** Turn author-written note links into public, current-host website links. */

import {
  indexByName,
  parseLinks,
  resolveLink,
  websiteRouteLookupKey,
  type Link,
} from "@context/shared";

export interface WebsiteLinkCatalogEntry {
  kind: "route" | "share";
  objectKey: string;
  /** Root-relative, so a custom-domain visitor stays on that domain. */
  href: string;
  /** Shares are public; routes retain their indexed audience. */
  audience: "public" | "members";
  /** Exact indexed source version for routes; shares recheck standing live. */
  sourceEtag: string | null;
}

export interface WebsiteLinkOptions {
  fromPath: string;
  handle: string;
  ownedHosts: readonly string[];
  catalog: readonly WebsiteLinkCatalogEntry[];
}

type Destination = WebsiteLinkCatalogEntry & { anchor: string };

function splitAnchor(target: string): { file: string; anchor: string } {
  const hash = target.indexOf("#");
  if (hash === -1) return { file: target, anchor: "" };
  return { file: target.slice(0, hash), anchor: target.slice(hash) };
}

function safeAnchor(target: string): string | null {
  const anchor = splitAnchor(target).anchor;
  return anchor === "" || /^#[A-Za-z0-9._~!$&'+,;=:@/?%-]*$/.test(anchor)
    ? anchor
    : null;
}

function normalizedRoutePath(raw: string): string | null {
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.length > 1024 ||
    /[\u0000-\u001f\u007f\\?%]/.test(raw)
  ) {
    return null;
  }
  const withoutTrailing = raw === "/" ? raw : raw.replace(/\/+$/, "");
  if (withoutTrailing === "/") return "/";
  const segments = withoutTrailing.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    return null;
  }
  return withoutTrailing.normalize("NFC");
}

/**
 * `/Public%20Worship` names the page `/Public Worship`. Decoded before it is
 * checked, because the checks are about the path a person meant; an encoded
 * `/` or `\\` is refused outright rather than decoded into a different path.
 */
function decodedRoutePath(raw: string): string | null {
  if (/%(?:2f|5c)/i.test(raw)) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * A route as a Markdown link target: each segment percent-encoded, so a page
 * called `Public Worship` is `/Public%20Worship` — a raw space ends a link
 * target, which is how every link to such a page came out as plain text.
 */
export function websiteHrefFor(routePath: string): string {
  return routePath.split("/").map(encodeURIComponent).join("/");
}

function directRoute(
  link: Link,
  handle: string,
  ownedHosts: ReadonlySet<string>,
): { routePath: string; anchor: string } | null {
  if (link.kind !== "inline") return null;
  const target = link.target.trim();
  const { file } = splitAnchor(target);
  const anchor = safeAnchor(target);
  if (anchor === null) return null;
  if (file.startsWith("/") && !file.startsWith("//")) {
    const decoded = decodedRoutePath(file);
    const routePath = decoded === null ? null : normalizedRoutePath(decoded);
    return routePath === null ? null : { routePath, anchor };
  }

  let url: URL;
  try {
    url = new URL(file);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.search !== "") return null;
  const hostname = url.hostname.toLowerCase();
  let routePath: string;
  if (hostname === "context.lc") {
    const prefix = `/@${handle.toLowerCase()}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return null;
    }
    routePath = url.pathname.slice(prefix.length) || "/";
  } else if (ownedHosts.has(hostname)) {
    routePath = url.pathname;
  } else {
    return null;
  }
  const decoded = decodedRoutePath(routePath);
  const normalized = decoded === null ? null : normalizedRoutePath(decoded);
  return normalized === null ? null : { routePath: normalized, anchor };
}

function catalogMaps(catalog: readonly WebsiteLinkCatalogEntry[]) {
  const routesByHref = new Map<string, WebsiteLinkCatalogEntry>();
  const byObject = new Map<string, WebsiteLinkCatalogEntry>();
  // A website route is the canonical public address when a note also has an
  // unlisted share. Insert routes first and never replace them with a share.
  for (const entry of catalog) {
    if (entry.kind !== "route") continue;
    routesByHref.set(websiteRouteLookupKey(entry.href), entry);
    byObject.set(entry.objectKey, entry);
  }
  for (const entry of catalog) {
    if (!byObject.has(entry.objectKey)) byObject.set(entry.objectKey, entry);
  }
  return { routesByHref, byObject };
}

function destinationResolver(options: WebsiteLinkOptions) {
  const { routesByHref, byObject } = catalogMaps(options.catalog);
  const ownedHosts = new Set(
    options.ownedHosts.map((host) => host.toLowerCase()),
  );
  const publishablePaths = [
    ...new Set(options.catalog.map((entry) => entry.objectKey)),
  ];
  const byName = indexByName(publishablePaths);
  return (link: Link): Destination | null => {
    const direct = directRoute(link, options.handle, ownedHosts);
    if (direct !== null) {
      const entry = routesByHref.get(websiteRouteLookupKey(direct.routePath));
      return entry === undefined ? null : { ...entry, anchor: direct.anchor };
    }

    const objectKey = resolveLink(link, options.fromPath, byName);
    if (objectKey === null) return null;
    const entry = byObject.get(objectKey);
    if (entry === undefined) return null;
    const anchor = safeAnchor(link.target.trim());
    return anchor === null ? null : { ...entry, anchor };
  };
}

/** Share targets actually named by this page, deduplicated for one safe read. */
export function websiteReferencedSharePaths(
  markdown: string,
  options: WebsiteLinkOptions,
): string[] {
  const paths = new Set<string>();
  const destinationFor = destinationResolver(options);
  for (const link of parseLinks(markdown)) {
    if (link.embed) continue;
    const destination = destinationFor(link);
    if (destination?.kind === "share") paths.add(destination.objectKey);
  }
  return [...paths];
}

function wikiReplacement(
  markdown: string,
  link: Link,
  href: string,
): {
  start: number;
  end: number;
  text: string;
} | null {
  const start = link.start - 2;
  const close = markdown.indexOf("]]", link.end);
  if (start < 0 || close === -1 || markdown.slice(start, link.start) !== "[[") {
    return null;
  }
  const suffix = markdown.slice(link.end, close);
  const rawLabel = suffix.startsWith("|")
    ? suffix.slice(1)
    : splitAnchor(link.target).file;
  const label = rawLabel.replace(/\\/g, "\\\\").replace(/\[/g, "\\[");
  return { start, end: close + 2, text: `[${label}](${href})` };
}

/**
 * Rewrite only destinations the server classified as publishable. Everything
 * else stays relative/wikilink-shaped, which the public renderer draws as
 * plain text rather than exposing a bucket path as a working URL.
 */
export function rewriteWebsiteLinks(
  markdown: string,
  options: WebsiteLinkOptions,
  readableSharePaths: ReadonlySet<string>,
): string {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const destinationFor = destinationResolver(options);
  for (const link of parseLinks(markdown)) {
    if (link.embed) continue;
    const destination = destinationFor(link);
    if (
      destination === null ||
      (destination.kind === "share" &&
        !readableSharePaths.has(destination.objectKey))
    ) {
      continue;
    }
    const href = `${websiteHrefFor(destination.href)}${destination.anchor}`;
    if (link.kind === "wiki") {
      const replacement = wikiReplacement(markdown, link, href);
      if (replacement !== null) replacements.push(replacement);
    } else if (href !== link.target) {
      replacements.push({ start: link.start, end: link.end, text: href });
    }
  }
  if (replacements.length === 0) return markdown;

  replacements.sort((left, right) => left.start - right.start);
  let out = "";
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    out += markdown.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return out + markdown.slice(cursor);
}
