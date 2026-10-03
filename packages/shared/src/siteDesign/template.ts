/**
 * Layout templates: `{ content }`, `{ page.title }` and one loop.
 *
 * A layout is plain HTML with a few fields in braces, so an agent can write
 * one without learning a template language:
 *
 *     <header>{ site.name } { each item in site.nav }<a href="{ item.link }">{ item.title }</a>{ end }</header>
 *     <main>{ content }</main>
 *
 * Text fields are escaped wherever they land. `content`, `page.intro` and a
 * section's `content` are HTML, and are only ever placed between tags: the
 * template is sanitized first, with a marker where each one goes, and the
 * markers in text are then replaced by the slot's own sanitized HTML. A
 * marker that ended up inside an attribute is removed, never filled.
 */

import { escapeHtml } from "./entities";
import { sanitizeSiteHtml, type SiteHtmlOptions } from "./html";

/** The class on the element a designed page is drawn in; every rule is scoped to it. */
export const SITE_SCOPE_CLASS = "ctx-site";
export const SITE_SCOPE = `.${SITE_SCOPE_CLASS}`;

export interface SiteNavItem {
  title: string;
  link: string;
  current: boolean;
}

export interface SiteSection {
  heading: string;
  text: string;
  link: string;
  /** The section's Markdown, drawn as HTML. */
  contentHtml: string;
}

export interface SitePageData {
  siteName: string;
  nav: SiteNavItem[];
  title: string;
  description: string;
  path: string;
  /** The whole page body, drawn as HTML. */
  contentHtml: string;
  /** What comes before the first `##`, without the page's own `#` title. */
  introHtml: string;
  sections: SiteSection[];
}

export interface SiteDesignSource {
  /** `layout.html.md`'s block, or null for the default frame. */
  frame: string | null;
  /** The named layout or HTML page this page is drawn with, or null. */
  template: string | null;
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "field"; path: string }
  | { kind: "each"; name: string; source: string; body: Node[] };

const PLACEHOLDER = /\{[ \t]*(each[ \t]+[a-z][a-z0-9]*[ \t]+in[ \t]+[a-z]+(?:\.[a-z]+)*|end|[a-z]+(?:\.[a-z]+)*)[ \t]*\}/g;

const PAGE_FIELDS: Record<string, "text" | "html"> = {
  content: "html",
  "site.name": "text",
  "page.title": "text",
  "page.description": "text",
  "page.path": "text",
  "page.intro": "html",
};

const LOOP_FIELDS: Record<string, Record<string, "text" | "html">> = {
  "site.nav": { title: "text", link: "text", current: "text" },
  "page.sections": { heading: "text", text: "text", link: "text", content: "html" },
};

/** Private-use markers for HTML slots; stripped from everything a site writes. */
const MARK_OPEN = "\ue000";
const MARK_CLOSE = "\ue001";
const MARKERS = /[\ue000\ue001]/g;

type Parsed = { nodes: Node[]; problems: string[] };

function parse(template: string): Parsed {
  const problems: string[] = [];
  const root: Node[] = [];
  const stack: Array<{ node: Extract<Node, { kind: "each" }> | null; nodes: Node[] }> = [{ node: null, nodes: root }];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const top = stack.at(-1)!;
    if (match.index! > last) top.nodes.push({ kind: "text", text: template.slice(last, match.index) });
    last = match.index! + match[0].length;
    const inner = match[1]!.replace(/[ \t]+/g, " ");
    if (inner === "end") {
      if (stack.length === 1) problems.push("{ end } has no { each … } to close.");
      else stack.pop();
      continue;
    }
    const each = /^each ([a-z][a-z0-9]*) in (.+)$/.exec(inner);
    if (each !== null) {
      const node: Extract<Node, { kind: "each" }> = { kind: "each", name: each[1]!, source: each[2]!, body: [] };
      top.nodes.push(node);
      stack.push({ node, nodes: node.body });
      continue;
    }
    top.nodes.push({ kind: "field", path: inner });
  }
  if (last < template.length) stack.at(-1)!.nodes.push({ kind: "text", text: template.slice(last) });
  if (stack.length > 1) problems.push(`{ each ${stack.at(-1)!.node!.name} in ${stack.at(-1)!.node!.source} } has no { end }.`);
  return { nodes: root, problems };
}

function check(nodes: Node[], scope: Map<string, string>, problems: string[], seen: { content: number }): void {
  for (const node of nodes) {
    if (node.kind === "text") continue;
    if (node.kind === "field") {
      if (node.path === "content") seen.content += 1;
      const [head, field] = node.path.split(".");
      const source = field === undefined ? undefined : scope.get(head!);
      const known =
        PAGE_FIELDS[node.path] !== undefined ||
        (source !== undefined && LOOP_FIELDS[source]?.[field!] !== undefined);
      if (!known) problems.push(`{ ${node.path} } is not a field a layout can use.`);
      continue;
    }
    if (LOOP_FIELDS[node.source] === undefined) {
      problems.push(`{ each ${node.name} in ${node.source} }: a layout can repeat site.nav or page.sections.`);
      continue;
    }
    const inner = new Map(scope);
    inner.set(node.name, node.source);
    check(node.body, inner, problems, seen);
  }
}

/** What is wrong with a layout, in words an agent can act on. */
export function siteTemplateProblems(template: string, role: "frame" | "layout" | "page"): string[] {
  const parsed = parse(template.replace(MARKERS, ""));
  const problems = [...parsed.problems];
  const seen = { content: 0 };
  check(parsed.nodes, new Map(), problems, seen);
  if (role === "frame" && seen.content === 0) {
    problems.push("layout.html.md needs { content } where each page goes.");
  }
  return problems;
}

type Values = { text: Map<string, string>; html: Map<string, string>; loops: Map<string, Array<Record<string, string>>> };

function render(nodes: Node[], values: Values, scope: Map<string, Record<string, string>>, slots: string[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.text;
      continue;
    }
    if (node.kind === "field") {
      const [head, field] = node.path.split(".");
      const item = field === undefined ? undefined : scope.get(head!);
      let html: string | undefined;
      let text: string | undefined;
      if (item !== undefined) {
        const kind = LOOP_FIELDS[item.__source!]?.[field!];
        if (kind === "html") html = item[field!];
        else if (kind === "text") text = item[field!];
      } else if (PAGE_FIELDS[node.path] === "html") {
        html = values.html.get(node.path);
      } else {
        text = values.text.get(node.path);
      }
      if (html !== undefined) {
        slots.push(html);
        out += `${MARK_OPEN}${slots.length - 1}${MARK_CLOSE}`;
      } else if (text !== undefined) {
        out += escapeHtml(text.replace(MARKERS, ""));
      }
      continue;
    }
    for (const item of values.loops.get(node.source) ?? []) {
      const inner = new Map(scope);
      inner.set(node.name, { ...item, __source: node.source });
      out += render(node.body, values, inner, slots);
    }
  }
  return out;
}

/** Sanitize a rendered template and put each slot's own sanitized HTML where its marker sits in text. */
function fill(rendered: string, slots: string[], options: SiteHtmlOptions): string {
  const html = sanitizeSiteHtml(rendered, options).html;
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith("<")
        ? part.replace(/\ue000\d*\ue001?/g, "").replace(MARKERS, "")
        : part.replace(/\ue000(\d+)\ue001/g, (_whole, index: string) => sanitizeSiteHtml(slots[Number(index)] ?? "", options).html),
    )
    .join("")
    .replace(MARKERS, "");
}

/** The frame used when a site has stylesheets or layouts but no `layout.html.md`. */
export const DEFAULT_SITE_FRAME = [
  '<header class="site-header"><a class="site-name" href="/">{ site.name }</a>',
  '<nav class="site-nav">{ each item in site.nav }<a href="{ item.link }" class="{ item.current }">{ item.title }</a>{ end }</nav></header>',
  '<main class="site-main">{ content }</main>',
  '<footer class="site-footer">{ site.name }</footer>',
].join("");

/** Draw one page: the page's layout inside the frame, all of it sanitized. */
export function composeSitePage(design: SiteDesignSource, data: SitePageData, options: SiteHtmlOptions = {}): string {
  const values: Values = {
    text: new Map([
      ["site.name", data.siteName],
      ["page.title", data.title],
      ["page.description", data.description],
      ["page.path", data.path],
    ]),
    html: new Map([
      ["content", data.contentHtml],
      ["page.intro", data.introHtml],
    ]),
    loops: new Map<string, Array<Record<string, string>>>([
      ["site.nav", data.nav.map((item) => ({ title: item.title, link: item.link, current: item.current ? "current" : "" }))],
      [
        "page.sections",
        data.sections.map((section) => ({
          heading: section.heading,
          text: section.text,
          link: section.link,
          content: section.contentHtml,
        })),
      ],
    ]),
  };
  const draw = (template: string, content: string): string => {
    const slots: string[] = [];
    const nodes = parse(template.replace(MARKERS, "")).nodes;
    const rendered = render(nodes, { ...values, html: new Map([...values.html, ["content", content]]) }, new Map(), slots);
    return fill(rendered, slots, options);
  };
  const page = draw(design.template ?? "{ content }", data.contentHtml);
  return draw(design.frame ?? DEFAULT_SITE_FRAME, page);
}
