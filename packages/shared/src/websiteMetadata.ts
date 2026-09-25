import type {
  WebsiteRouteAudience,
  WebsiteRouteProblem,
  WebsiteRouteStatus,
} from "./websiteContract";
import {
  compileWebsiteRoutes,
  type WebsiteRouteDiagnostic,
  type WebsiteRouteOptions,
} from "./websiteRoutes";

/** The route-affecting subset of one ordinary Markdown note. */
export interface ParsedWebsitePage {
  audience: WebsiteRouteAudience;
  draft: boolean;
  title: string | null;
  description: string | null;
  nav: number | null;
  /** Markdown after frontmatter, normalized to LF but otherwise unchanged. */
  body: string;
  problems: WebsiteRouteProblem[];
}

export interface WebsitePageSource {
  objectKey: string;
  markdown: string;
}

type ControlledField = "audience" | "draft" | "title" | "description" | "nav";

const CONTROLLED_FIELDS = new Set<ControlledField>([
  "audience",
  "draft",
  "title",
  "description",
  "nav",
]);

const UNTITLED: WebsiteRouteProblem = {
  code: "untitled_page",
  message: "Add a non-empty title to publish this page.",
};
const EMPTY: WebsiteRouteProblem = {
  code: "empty_page",
  message: "Add page content to publish this route.",
};

function invalid(message: string): WebsiteRouteProblem {
  return { code: "invalid_metadata", message };
}

/** Parse one single-line YAML scalar without pretending to implement YAML. */
function scalar(
  field: "title" | "description",
  source: string,
): string | WebsiteRouteProblem {
  const value = source.trim();
  if (value === "|" || value === ">" || /^[&*!{}[\]]/.test(value)) {
    return invalid(`Website ${field} must be a single-line scalar.`);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      return invalid(`Website ${field} must be a single-line scalar.`);
    }
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded !== "string") throw new TypeError("not a string");
      return decoded.trim();
    } catch {
      return invalid(`Website ${field} must be a single-line scalar.`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      return invalid(`Website ${field} must be a single-line scalar.`);
    }
    return value.slice(1, -1).replace(/''/g, "'").trim();
  }
  if (value.includes("\t")) {
    return invalid(`Website ${field} must be a single-line scalar.`);
  }
  return value;
}

function base(body: string): Omit<ParsedWebsitePage, "problems"> {
  return {
    audience: "public",
    draft: false,
    title: null,
    description: null,
    nav: null,
    body,
  };
}

/**
 * Parse the approved route metadata from one ordinary Markdown page.
 *
 * Publication fields use a deliberately small YAML-shaped subset. Aliases,
 * tags, collections and multiline values fail closed so the shared parser and
 * the dependency-free Worker parser can retain exact parity.
 */
export function parseWebsitePage(markdown: string): ParsedWebsitePage {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  let frontmatter: string[] = [];
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    const closing = lines.indexOf("---", 1);
    if (closing < 0) {
      return {
        ...base(""),
        problems: [invalid("Website frontmatter is not closed.")],
      };
    }
    frontmatter = lines.slice(1, closing);
    body = lines.slice(closing + 1).join("\n");
    if (body.startsWith("\n")) body = body.slice(1);
  }

  const parsed = base(body);
  const seen = new Set<ControlledField>();

  for (const line of frontmatter) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(line);
    if (match === null) {
      const possible = /^\s*(audience|draft|title|description|nav)\b/.exec(
        line,
      )?.[1];
      if (possible !== undefined) {
        return {
          ...parsed,
          problems: [invalid(`Website ${possible} metadata is invalid.`)],
        };
      }
      continue;
    }

    const field = match[1] as ControlledField;
    if (!CONTROLLED_FIELDS.has(field)) continue;
    if (seen.has(field)) {
      return {
        ...parsed,
        problems: [invalid(`Website ${field} must appear only once.`)],
      };
    }
    seen.add(field);
    const value = match[2] ?? "";

    if (field === "audience") {
      if (value !== "public" && value !== "members") {
        return {
          ...parsed,
          problems: [invalid("Website audience must be public or members.")],
        };
      }
      parsed.audience = value;
      continue;
    }
    if (field === "draft") {
      if (value !== "true" && value !== "false") {
        return {
          ...parsed,
          problems: [invalid("Website draft must be true or false.")],
        };
      }
      parsed.draft = value === "true";
      continue;
    }
    if (field === "nav") {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        return {
          ...parsed,
          problems: [invalid("Website nav must be a non-negative integer.")],
        };
      }
      const nav = Number(value);
      if (!Number.isSafeInteger(nav)) {
        return {
          ...parsed,
          problems: [invalid("Website nav must be a safe integer.")],
        };
      }
      parsed.nav = nav;
      continue;
    }

    const result = scalar(field, value);
    if (typeof result !== "string") return { ...parsed, problems: [result] };
    if (field === "title") {
      if (result.length > 200) {
        return { ...parsed, problems: [invalid("Website title is too long.")] };
      }
      parsed.title = result === "" ? null : result;
    } else {
      if (result.length > 500) {
        return {
          ...parsed,
          problems: [invalid("Website description is too long.")],
        };
      }
      parsed.description = result === "" ? null : result;
    }
  }

  const problems: WebsiteRouteProblem[] = [];
  if (parsed.title === null) problems.push(UNTITLED);
  if (parsed.body.trim() === "") problems.push(EMPTY);
  return { ...parsed, problems };
}

function diagnosticProblem(
  diagnostic: WebsiteRouteDiagnostic,
): WebsiteRouteProblem {
  const route = diagnostic.routePath ?? "this route";
  switch (diagnostic.code) {
    case "unsafe_path":
      return {
        code: diagnostic.code,
        message: "This website file path is unsafe.",
      };
    case "ambiguous_encoding":
      return {
        code: diagnostic.code,
        message: "This website file path has ambiguous URL encoding.",
      };
    case "reserved_path":
      return {
        code: diagnostic.code,
        message: `${route} is reserved by Context.LC.`,
      };
    case "route_collision":
      return {
        code: diagnostic.code,
        message: `Multiple website files claim ${route}.`,
      };
    case "case_collision":
      return {
        code: diagnostic.code,
        message: "Multiple website files differ only by case or Unicode form.",
      };
  }
}

/** Produce the authenticated status for every Markdown route claimant. */
export function buildWebsiteRouteStatuses(
  pages: readonly WebsitePageSource[],
  options: WebsiteRouteOptions = {},
): WebsiteRouteStatus[] {
  const byKey = new Map<string, string>();
  for (const page of pages) byKey.set(page.objectKey, page.markdown);
  const keys = [...byKey.keys()];
  const compilation = compileWebsiteRoutes(keys, options);
  const ignored = new Set(compilation.ignoredObjectKeys);
  const routeByKey = new Map(
    compilation.routes.map((route) => [route.objectKey, route.routePath]),
  );
  const diagnosticsByKey = new Map<string, WebsiteRouteDiagnostic[]>();
  for (const diagnostic of compilation.diagnostics) {
    for (const objectKey of diagnostic.objectKeys) {
      const current = diagnosticsByKey.get(objectKey);
      if (current === undefined) diagnosticsByKey.set(objectKey, [diagnostic]);
      else current.push(diagnostic);
    }
  }

  const statuses: WebsiteRouteStatus[] = [];
  for (const objectKey of keys.sort()) {
    if (ignored.has(objectKey)) continue;
    const page = parseWebsitePage(byKey.get(objectKey)!);
    const pathDiagnostics = diagnosticsByKey.get(objectKey) ?? [];
    let routePath = routeByKey.get(objectKey) ?? null;
    if (routePath === null) {
      // A claimant removed only because another claimant conflicts still has a
      // useful owner-facing path. The full compilation remains authoritative.
      routePath =
        compileWebsiteRoutes([objectKey], options).routes[0]?.routePath ?? null;
    }
    const problems = [
      ...pathDiagnostics.map(diagnosticProblem),
      ...page.problems,
    ];
    statuses.push({
      objectKey,
      routePath,
      status: problems.length > 0 ? "problem" : page.draft ? "draft" : "live",
      audience: page.audience,
      title: page.title,
      description: page.description,
      nav: page.nav,
      problems,
    });
  }
  return statuses;
}
