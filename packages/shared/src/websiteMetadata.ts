import type {
  WebsiteRouteAudience,
  WebsiteRouteProblem,
  WebsiteRouteStatus,
} from "./websiteContract";
import {
  compileWebsiteRoutes,
  DEFAULT_WEBSITE_ROOT,
  type WebsiteRouteDiagnostic,
  type WebsiteRouteOptions,
} from "./websiteRoutes";
import { stripComments } from "./comments.cjs";
import { devlogPromiseProblems, isDevlogObjectKey } from "./devlog";
import {
  WEBSITE_LAYOUT_NAME,
  websiteCodeBlock,
  websiteCodeLanguage,
  type WebsiteCodeRole,
} from "./siteDesign/codeNotes";
import { siteTemplateProblems } from "./siteDesign/template";

/** The route-affecting subset of one ordinary Markdown note. */
export interface ParsedWebsitePage {
  audience: WebsiteRouteAudience;
  draft: boolean;
  title: string | null;
  description: string | null;
  nav: number | null;
  /** `layout: cards`: draw the page with `website/cards.html.md`. */
  layout: string | null;
  /**
   * `base: off` on a code note: pages drawn with it start from nothing, not
   * from Context's base sheet (`siteDesign/baseCss.ts`). True unless off.
   */
  base: boolean;
  /** Markdown after frontmatter, normalized to LF but otherwise unchanged. */
  body: string;
  problems: WebsiteRouteProblem[];
}

export interface WebsitePageSource {
  objectKey: string;
  markdown: string;
}

type ControlledField = "audience" | "draft" | "title" | "description" | "nav" | "layout" | "base";

const CONTROLLED_FIELDS = new Set<ControlledField>([
  "audience",
  "draft",
  "title",
  "description",
  "nav",
  "layout",
  "base",
]);

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
    layout: null,
    base: true,
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

  /*
    A page's comments are the workspace's conversation about it, never part of
    what the site publishes: the anchors and the `comments` block are removed
    here, where every site surface takes its body from.
  */
  const parsed = base(stripComments(body));
  const seen = new Set<ControlledField>();

  for (const line of frontmatter) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(line);
    if (match === null) {
      const possible = /^\s*(audience|draft|title|description|nav|layout|base)\b/.exec(
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
    if (field === "base") {
      if (value !== "on" && value !== "off") {
        return { ...parsed, problems: [invalid("Website base must be on or off.")] };
      }
      parsed.base = value === "on";
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

    if (field === "layout") {
      if (!WEBSITE_LAYOUT_NAME.test(value)) {
        return {
          ...parsed,
          problems: [
            invalid("Website layout must be a layout's name, like `layout: cards` for cards.html.md."),
          ],
        };
      }
      parsed.layout = value;
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

  // A missing title or an empty body is not a problem: the page is titled by
  // its first heading or its file name, and someone pressed Publish on it.
  return { ...parsed, problems: [] };
}

/**
 * The title a page is published and listed by: its own `title:`, else its
 * first `#` heading, else its file name.
 */
export function websitePageTitle(
  objectKey: string,
  title: string | null,
  body: string,
): string {
  if (title !== null && title !== "") return title;
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  if (heading) return heading.slice(0, 200);
  return objectKey.slice(objectKey.lastIndexOf("/") + 1).replace(/\.md$/i, "");
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

function codeProblem(message: string): WebsiteRouteProblem {
  return { code: "code_note", message };
}

/** What is wrong with a code note's block, for its role in the site. */
function codeNoteProblems(
  objectKey: string,
  role: WebsiteCodeRole,
  body: string,
  prefix: string,
): WebsiteRouteProblem[] {
  const language = websiteCodeLanguage(objectKey)!;
  const block = websiteCodeBlock(body, language);
  if ("problem" in block) return [codeProblem(block.problem)];
  if ((role === "style" || role === "script") && objectKey.slice(prefix.length).includes("/")) {
    return [codeProblem("Stylesheets and scripts go at the top of the website folder.")];
  }
  if (role === "frame" || role === "layout" || role === "html") {
    return siteTemplateProblems(block.code, role === "frame" ? "frame" : role === "html" ? "page" : "layout").map(
      codeProblem,
    );
  }
  return [];
}

/** Produce the authenticated status for every Markdown route claimant. */
export function buildWebsiteRouteStatuses(
  pages: readonly WebsitePageSource[],
  options: WebsiteRouteOptions = {},
): WebsiteRouteStatus[] {
  const byKey = new Map<string, string>();
  for (const page of pages) byKey.set(page.objectKey, page.markdown);
  const keys = [...byKey.keys()];
  const root = options.root ?? DEFAULT_WEBSITE_ROOT;
  const prefix = `${root}/`;
  const code = options.code !== false;
  const parsedByKey = new Map(keys.map((key) => [key, parseWebsitePage(byKey.get(key)!)]));
  /* The layouts pages name. Path compilation stays path-only; this is the
     one fact it needs from the pages themselves. */
  const layoutObjectKeys = new Set<string>();
  if (code) {
    for (const [key, page] of parsedByKey) {
      if (page.layout === null || websiteCodeLanguage(key) !== null) continue;
      const layoutKey = `${prefix}${page.layout}.html.md`;
      if (byKey.has(layoutKey)) layoutObjectKeys.add(layoutKey);
    }
  }
  const compileOptions: WebsiteRouteOptions = { ...options, code, layoutObjectKeys };
  const compilation = compileWebsiteRoutes(keys, compileOptions);
  const ignored = new Set(compilation.ignoredObjectKeys);
  const routeByKey = new Map(
    compilation.routes.map((route) => [route.objectKey, route.routePath]),
  );
  const roleByKey = new Map<string, WebsiteCodeRole>([
    ...compilation.codeNotes.map((note) => [note.objectKey, note.role] as const),
    ...compilation.routes.flatMap((route) =>
      route.code === "html" ? [[route.objectKey, "html"] as const] : [],
    ),
  ]);
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
    const page = parsedByKey.get(objectKey)!;
    const pathDiagnostics = diagnosticsByKey.get(objectKey) ?? [];
    const language = code ? websiteCodeLanguage(objectKey) : null;
    // A code note a diagnostic kept out of the compilation is still one.
    const role: WebsiteCodeRole | undefined =
      roleByKey.get(objectKey) ??
      (language === null ? undefined : language === "html" ? "html" : language === "css" ? "style" : "script");
    let routePath = routeByKey.get(objectKey) ?? null;
    if (routePath === null && (role === undefined || role === "html")) {
      // A claimant removed only because another claimant conflicts still has a
      // useful owner-facing path. The full compilation remains authoritative.
      routePath =
        compileWebsiteRoutes([objectKey], compileOptions).routes[0]?.routePath ?? null;
    }
    const layoutProblems: WebsiteRouteProblem[] =
      options.wholeSite !== true || role !== undefined || page.layout === null
        ? []
        : page.layout === "layout"
          ? [codeProblem("`layout: layout` names the frame, which every page already has.")]
          : layoutObjectKeys.has(`${prefix}${page.layout}.html.md`)
            ? []
            : [codeProblem(`\`layout: ${page.layout}\` needs ${prefix}${page.layout}.html.md, which isn't there.`)];
    const problems = [
      ...pathDiagnostics.map(diagnosticProblem),
      ...page.problems,
      ...(role === undefined ? [] : codeNoteProblems(objectKey, role, page.body, prefix)),
      ...layoutProblems,
      // An exploring line that reads like a promise holds the release, the
      // way a broken page does: the devlog is where that rule is kept — and
      // only there. Every workspace's site compiles through this function, so
      // the rule is scoped to the devlog page itself rather than to any page
      // that happens to be written in weeks.
      ...(isDevlogObjectKey(objectKey, root)
        ? devlogPromiseProblems(page.body).map(
            (message): WebsiteRouteProblem => ({ code: "devlog_promise", message }),
          )
        : []),
    ];
    const pageLike = role === undefined || role === "html";
    statuses.push({
      objectKey,
      routePath: pageLike ? routePath : null,
      status: problems.length > 0 ? "problem" : page.draft ? "draft" : "live",
      audience: page.audience,
      title:
        role === undefined
          ? websitePageTitle(objectKey, page.title, page.body)
          : websitePageTitle(objectKey.replace(/\.(?:html|css|js)\.md$/i, ".md"), page.title, ""),
      description: page.description,
      nav: pageLike ? page.nav : null,
      problems,
      ...(role === undefined ? {} : { code: role }),
    });
  }
  return statuses;
}
