/**
 * The file-path half of the bucket-backed website route contract.
 *
 * This module deliberately does not parse page frontmatter. Reference syntax,
 * audiences and draft semantics are still product decisions; mixing them into
 * path compilation would make a later decision change the stable route rules.
 * Consumers first compile object keys here, then pass each surviving file to
 * the separate metadata parser that will own those choices.
 *
 * The compiler is pure and input-order independent. It retains the exact
 * object key for the eventual bucket read, while deriving a normalized public
 * path and a case-folded lookup key for collision detection.
 */

/** The working canonical root; callers may override it at this one boundary. */
export const DEFAULT_WEBSITE_ROOT = "website";

/**
 * First URL segments already owned by the platform on a custom domain.
 *
 * The website and custom-domain project requires API, auth, asset, preview and
 * health routes to remain unavailable to customer files. Comparisons are
 * Unicode-normalized and case-insensitive, just like collision lookup.
 */
export const WEBSITE_RESERVED_FIRST_SEGMENTS = [
  ".well-known",
  "_expo",
  "api",
  "assets",
  "auth",
  "console",
  "favicon.ico",
  "health",
  "icon.png",
  "og",
  "preview",
  "robots.txt",
  "s",
] as const;

/** Keep this text identical to the custom-domain Worker's static-file regex. */
export const WEBSITE_PLATFORM_ROOT_ASSET_PATTERN =
  "js|png|ico|svg|webmanifest|json|css|woff2?|ttf|txt|map";

export type WebsiteRouteDiagnosticCode =
  | "unsafe_path"
  | "ambiguous_encoding"
  | "reserved_path"
  | "route_collision"
  | "case_collision";

export interface WebsiteRoute {
  /** Exact key to read from the workspace bucket. */
  objectKey: string;
  /** Exact file path below the configured website root. */
  relativeFilePath: string;
  /** Decoded, NFC-normalized public path, always beginning with `/`. */
  routePath: string;
  /** NFC-normalized, case-folded key for the derived route index. */
  lookupKey: string;
}

export interface WebsiteRouteDiagnostic {
  code: WebsiteRouteDiagnosticCode;
  /** Every file prevented from publishing by this diagnostic. */
  objectKeys: string[];
  /** Present only when one unambiguous public path can be named safely. */
  routePath?: string;
}

export interface WebsiteRouteCompilation {
  /** Publishable, collision-free route claimants. */
  routes: WebsiteRoute[];
  /** Invalid or conflicting Markdown route files. */
  diagnostics: WebsiteRouteDiagnostic[];
  /** Objects that are not Markdown pages under the configured root. */
  ignoredObjectKeys: string[];
}

export interface WebsiteRouteOptions {
  /** One root-level bucket folder name, without slashes. */
  root?: string;
  /** Override only for a host whose platform routing table differs. */
  reservedFirstSegments?: readonly string[];
}

const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const ROUTE_META_CHARACTER = /[?#]/;
const SAFE_ROOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Mirrors the root static-file surface in `infra/router/src/site.ts`. A page
// claiming one of these would be shadowed by the Expo asset proxy on a custom
// domain, so it is reserved even when its whole filename is not a named route.
const PLATFORM_ROOT_ASSET = new RegExp(
  `\\.(?:${WEBSITE_PLATFORM_ROOT_ASSET_PATTERN})$`,
  "i",
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Build the derived-index key that both handle and custom-domain routes use. */
export function websiteRouteLookupKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function assertRoot(root: string): void {
  if (!SAFE_ROOT.test(root) || root === "." || root === "..") {
    throw new TypeError(
      "A website root must be one safe root-level folder name without slashes.",
    );
  }
}

type Candidate = WebsiteRoute;

type CandidateResult =
  | { kind: "candidate"; value: Candidate }
  | { kind: "diagnostic"; value: WebsiteRouteDiagnostic };

function candidateFor(objectKey: string, prefix: string): CandidateResult {
  const relativeFilePath = objectKey.slice(prefix.length);

  // A percent-bearing object key can be represented in a URL, but it creates
  // two plausible decoded forms (`%2e` and `%252e`). Until request routing has
  // one decoding contract across both hosts, refusing it is the only result
  // that cannot route to a different file than the owner saw.
  if (relativeFilePath.includes("%")) {
    return {
      kind: "diagnostic",
      value: { code: "ambiguous_encoding", objectKeys: [objectKey] },
    };
  }

  const segments = relativeFilePath.split("/");
  const unsafe =
    relativeFilePath.length === 0 ||
    objectKey.length > 1024 ||
    CONTROL_OR_BACKSLASH.test(relativeFilePath) ||
    ROUTE_META_CHARACTER.test(relativeFilePath) ||
    segments.some(
      (segment, index) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        (segment.startsWith(".") &&
          !(
            index === 0 &&
            (segment.toLowerCase() === ".well-known" ||
              segment.toLowerCase() === ".well-known.md")
          )),
    );
  if (unsafe) {
    return {
      kind: "diagnostic",
      value: { code: "unsafe_path", objectKeys: [objectKey] },
    };
  }

  const filename = segments.at(-1)!;
  const basename = filename.slice(0, -3);
  if (basename.length === 0) {
    return {
      kind: "diagnostic",
      value: { code: "unsafe_path", objectKeys: [objectKey] },
    };
  }

  const routeSegments = [...segments.slice(0, -1), basename];
  if (basename.toLowerCase() === "index") routeSegments.pop();
  const routePath =
    routeSegments.length === 0
      ? "/"
      : `/${routeSegments.map((segment) => segment.normalize("NFC")).join("/")}`;

  return {
    kind: "candidate",
    value: {
      objectKey,
      relativeFilePath,
      routePath,
      lookupKey: websiteRouteLookupKey(routePath),
    },
  };
}

/**
 * Compile bucket object keys into collision-free website routes.
 *
 * Non-Markdown objects and objects outside the exact root are returned as
 * ignored because images and CSS may legitimately live beside route files.
 * Invalid Markdown files are diagnostics: silently ignoring one would make an
 * owner believe a page was live when the router had refused it.
 */
export function compileWebsiteRoutes(
  objectKeys: readonly string[],
  options: WebsiteRouteOptions = {},
): WebsiteRouteCompilation {
  const root = options.root ?? DEFAULT_WEBSITE_ROOT;
  assertRoot(root);
  const prefix = `${root}/`;
  const reserved = new Set(
    (options.reservedFirstSegments ?? WEBSITE_RESERVED_FIRST_SEGMENTS).map(
      (segment) => websiteRouteLookupKey(segment),
    ),
  );

  const uniqueKeys = [...new Set(objectKeys)].sort(compareText);
  const ignoredObjectKeys: string[] = [];
  const diagnostics: WebsiteRouteDiagnostic[] = [];
  const candidates: Candidate[] = [];

  for (const objectKey of uniqueKeys) {
    if (!objectKey.startsWith(prefix) || !/\.md$/i.test(objectKey)) {
      ignoredObjectKeys.push(objectKey);
      continue;
    }

    const result = candidateFor(objectKey, prefix);
    if (result.kind === "diagnostic") {
      diagnostics.push(result.value);
      continue;
    }

    const firstSegment = result.value.routePath.slice(1).split("/", 1)[0];
    const claimsPlatformAsset =
      result.value.routePath.split("/").length === 2 &&
      PLATFORM_ROOT_ASSET.test(firstSegment);
    if (
      firstSegment &&
      (firstSegment.startsWith("@") ||
        reserved.has(websiteRouteLookupKey(firstSegment)) ||
        claimsPlatformAsset)
    ) {
      diagnostics.push({
        code: "reserved_path",
        objectKeys: [objectKey],
        routePath: result.value.routePath,
      });
      continue;
    }
    candidates.push(result.value);
  }

  const claimants = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = claimants.get(candidate.lookupKey);
    if (group === undefined) claimants.set(candidate.lookupKey, [candidate]);
    else group.push(candidate);
  }

  const routes: WebsiteRoute[] = [];
  for (const key of [...claimants.keys()].sort(compareText)) {
    const group = claimants.get(key)!;
    group.sort((left, right) => compareText(left.objectKey, right.objectKey));
    if (group.length === 1) {
      routes.push(group[0]!);
      continue;
    }

    const paths = new Set(group.map((candidate) => candidate.routePath));
    if (paths.size === 1) {
      diagnostics.push({
        code: "route_collision",
        objectKeys: group.map((candidate) => candidate.objectKey),
        routePath: group[0]!.routePath,
      });
    } else {
      diagnostics.push({
        code: "case_collision",
        objectKeys: group.map((candidate) => candidate.objectKey),
      });
    }
  }

  routes.sort((left, right) => compareText(left.routePath, right.routePath));
  diagnostics.sort((left, right) => {
    const leftKey = left.routePath ?? left.objectKeys[0] ?? "";
    const rightKey = right.routePath ?? right.objectKeys[0] ?? "";
    return compareText(leftKey, rightKey) || compareText(left.code, right.code);
  });

  return { routes, diagnostics, ignoredObjectKeys };
}
