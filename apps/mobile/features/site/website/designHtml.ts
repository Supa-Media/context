/**
 * A designed page's words, as HTML a site's layout and CSS can style.
 *
 * The page is parsed by the same reader every published page uses
 * (`share/markdown.ts`), so a designed page and a plain one say the same
 * things; only the drawing differs. Every string here is escaped, and the
 * composed page is sanitized again before it reaches the document
 * (`composeSitePage` in `@context/shared`).
 */

import {
  composeSitePage,
  escapeHtml,
  type ResolvedWebsitePage,
  type SitePageData,
  type SiteSection,
  type WebsiteDesign,
} from "@context/shared";
import { parseNote, type Block, type Inline } from "../../share/markdown";

export interface DesignPictures {
  /** Workspace emoji, `name → data: URL`. */
  emoji: Readonly<Record<string, string>>;
  /** Pasted pictures, `leaf → data: URL`. */
  images: Readonly<Record<string, string>>;
}

function runsHtml(runs: readonly Inline[], pictures: DesignPictures): string {
  return runs
    .map((run) => {
      switch (run.kind) {
        case "strong":
          return `<strong>${escapeHtml(run.text)}</strong>`;
        case "em":
          return `<em>${escapeHtml(run.text)}</em>`;
        case "strike":
          return `<s>${escapeHtml(run.text)}</s>`;
        case "mark":
          return `<mark>${escapeHtml(run.text)}</mark>`;
        case "code":
          return `<code>${escapeHtml(run.text)}</code>`;
        case "kbd":
          return `<kbd>${escapeHtml(run.text)}</kbd>`;
        case "emoji": {
          const picture = pictures.emoji[run.name];
          return picture === undefined
            ? escapeHtml(run.text)
            : `<img class="emoji" src="${escapeHtml(picture)}" alt="${escapeHtml(run.text)}">`;
        }
        case "link":
          return `<a href="${escapeHtml(run.href)}">${escapeHtml(run.text)}</a>`;
        case "button":
          return `<a class="button" href="${escapeHtml(run.href)}">${escapeHtml(run.text)}</a>`;
        default:
          return escapeHtml(run.text);
      }
    })
    .join("");
}

function isButtonRow(runs: readonly Inline[]): boolean {
  let buttons = 0;
  for (const run of runs) {
    if (run.kind === "button") buttons += 1;
    else if (run.kind !== "text" || run.text.trim() !== "") return false;
  }
  return buttons > 0;
}

function blockHtml(block: Block, pictures: DesignPictures): string {
  switch (block.kind) {
    case "heading":
      return `<h${block.level}>${runsHtml(block.content, pictures)}</h${block.level}>`;
    case "paragraph":
      return isButtonRow(block.content)
        ? `<p class="buttons">${runsHtml(block.content.filter((run) => run.kind === "button"), pictures)}</p>`
        : `<p>${runsHtml(block.content, pictures)}</p>`;
    case "bullet":
      return `<ul>${block.items.map((item) => `<li>${runsHtml(item, pictures)}</li>`).join("")}</ul>`;
    case "ordered":
      return `<ol>${block.items.map((item) => `<li>${runsHtml(item, pictures)}</li>`).join("")}</ol>`;
    case "quote":
      return `<blockquote><p>${runsHtml(block.content, pictures)}</p></blockquote>`;
    case "code":
      return `<pre><code${block.language === undefined ? "" : ` class="language-${escapeHtml(block.language)}"`}>${escapeHtml(block.text)}</code></pre>`;
    case "rule":
      return "<hr>";
    case "images":
      return `<figure class="images align-${block.align}">${block.images
        .map((image) => {
          const src = pictures.images[image.target];
          const alt = escapeHtml(image.alt === "" ? image.target : image.alt);
          if (src === undefined) return `<span class="missing">${alt}</span>`;
          return `<img src="${escapeHtml(src)}" alt="${alt}"${image.width === null ? "" : ` width="${image.width}"`}>`;
        })
        .join("")}</figure>`;
    case "table":
      return `<table><thead><tr>${block.header.map((cell) => `<th>${runsHtml(cell, pictures)}</th>`).join("")}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${runsHtml(cell, pictures)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
  }
}

export function blocksHtml(blocks: readonly Block[], pictures: DesignPictures): string {
  return blocks.map((block) => blockHtml(block, pictures)).join("");
}

function plainText(runs: readonly Inline[]): string {
  return runs.map((run) => run.text).join("");
}

function firstLink(blocks: readonly Block[]): string {
  for (const block of blocks) {
    const runs =
      block.kind === "paragraph" || block.kind === "quote" || block.kind === "heading"
        ? block.content
        : block.kind === "bullet" || block.kind === "ordered"
          ? block.items.flat()
          : [];
    const link = runs.find((run) => run.kind === "link" || run.kind === "button");
    if (link !== undefined && (link.kind === "link" || link.kind === "button")) return link.href;
  }
  return "";
}

/**
 * The page split the way a layout reads it: what comes before the first
 * `##` (less the page's own `#` title), then one section per `##`.
 */
export function pageSections(
  blocks: readonly Block[],
  pictures: DesignPictures,
): { introHtml: string; sections: SiteSection[] } {
  const first = blocks.findIndex((block) => block.kind === "heading" && block.level === 2);
  const lead = first === -1 ? [...blocks] : blocks.slice(0, first);
  const intro = lead[0]?.kind === "heading" && lead[0].level === 1 ? lead.slice(1) : lead;
  const sections: SiteSection[] = [];
  if (first !== -1) {
    let current: { heading: Inline[]; blocks: Block[] } | null = null;
    const close = () => {
      if (current === null) return;
      const paragraph = current.blocks.find((block) => block.kind === "paragraph");
      sections.push({
        heading: plainText(current.heading),
        text: paragraph?.kind === "paragraph" ? plainText(paragraph.content) : "",
        link: firstLink(current.blocks),
        contentHtml: blocksHtml(current.blocks, pictures),
      });
    };
    for (const block of blocks.slice(first)) {
      if (block.kind === "heading" && block.level === 2) {
        close();
        current = { heading: block.content, blocks: [] };
      } else {
        current?.blocks.push(block);
      }
    }
    close();
  }
  return { introHtml: blocksHtml(intro, pictures), sections };
}

/** Everything a layout can say about one page. */
export function designPageData(
  view: Extract<ResolvedWebsitePage, { kind: "page" }>,
  pictures: DesignPictures,
): SitePageData {
  const blocks = parseNote(view.markdown).blocks;
  const { introHtml, sections } = pageSections(blocks, pictures);
  return {
    siteName: view.siteName,
    nav: view.navigation.map((item) => ({
      title: item.title,
      link: item.routePath,
      current: item.routePath === view.routePath,
    })),
    title: view.title,
    description: view.description ?? "",
    path: view.routePath,
    contentHtml: blocksHtml(blocks, pictures),
    introHtml,
    sections,
  };
}

/** The page's whole HTML: its layout in the site's frame, sanitized. */
export function designedPageHtml(
  view: Extract<ResolvedWebsitePage, { kind: "page" }>,
  design: WebsiteDesign,
  pictures: DesignPictures,
): string {
  return composeSitePage(
    { frame: design.frame, template: design.template },
    designPageData(view, pictures),
    // Pictures arrived as `data:` URLs already; a name is never looked up here.
    { image: () => null },
  );
}

/**
 * Where a link in a designed page goes: a page on this site (a path to hand
 * to the site's own navigation), or null for anything to leave alone.
 */
export function sitePathOf(href: string, currentRoute: string): string | null {
  if (href === "" || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.includes("\\")) return null;
  try {
    const url = new URL(href, `https://site.invalid${currentRoute === "/" ? "/" : `${currentRoute}`}`);
    if (url.origin !== "https://site.invalid") return null;
    return decodeURIComponent(url.pathname) + url.hash;
  } catch {
    return null;
  }
}
