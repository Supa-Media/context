/**
 * What a website page unfurls as: its own title, its site's name, a line of
 * description, and a version for its card image.
 *
 * A link to a published page used to unfurl as Context's own marketing card,
 * because the router answers every crawler on a customer's domain with the
 * frozen product preview. That rule exists so a guessable address cannot be
 * used to learn anything about a workspace. A live public website page is not
 * that case: turning the site on is the owner publishing it, and a crawler is
 * told exactly what an anonymous visitor to the same address is shown and
 * nothing else — the argument `websites.md` makes for the site's favicon.
 *
 * Resolution is the page resolver's, run as an anonymous viewer, so every rule
 * a visitor is held to (the site is on, `privacy.md` publishes the page, it is
 * live, not members-only, not encrypted) holds here with no second copy.
 * Anything else is one absence.
 */

import type { ResolvedWebsitePage } from "@context/shared";
import type { ActionCtx } from "../../../_generated/server";
import { hashTitle } from "../cardKey";
import { MAX_SITE_CARD_TITLE } from "../siteCardArt";
import { resolveWebsitePageAs } from "./resolver";

export interface WebsitePreview {
  siteName: string;
  title: string;
  description: string | null;
}

/** `og:title` never needs more than this, and the metadata allows 200. */
export const MAX_SITE_PREVIEW_TITLE = 120;
/** Long enough for two lines under a title in every unfurler that shows it. */
export const MAX_SITE_PREVIEW_DESCRIPTION = 200;

/**
 * Bumped when the card's artwork changes, so a new design is a new image URL.
 * An unfurler caches by URL, and nothing else would tell it the picture moved.
 */
export const SITE_CARD_DESIGN = "1";

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function clean(value: string, max: number): string | null {
  const text = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

/** Inline Markdown reduced to the words a reader sees. */
function plainInline(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The page's first paragraph of prose, for a page whose frontmatter gives no
 * `description:`. Headings, code, tables, lists (a list block renders as
 * one) and images are passed over; the page's own words are what it already
 * shows.
 */
export function excerptFromMarkdown(markdown: string): string | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  let paragraph: string[] = [];
  const flush = (): string | null => {
    const text = plainInline(paragraph.join(" "));
    paragraph = [];
    return /[\p{L}\p{N}]/u.test(text) ? text : null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const fenceMark = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark !== undefined) {
      const found = flush();
      if (found !== null) return clean(found, MAX_SITE_PREVIEW_DESCRIPTION);
      fence = fenceMark;
      continue;
    }
    const skipped =
      line === "" ||
      /^#{1,6}\s/.test(line) ||
      /^(\||-{3,}|\*{3,}|_{3,}|<!--)/.test(line) ||
      /^([-*+]|\d+[.)])\s/.test(line) ||
      /^!\[[^\]]*\]\([^)]*\)$/.test(line);
    if (skipped) {
      const found = flush();
      if (found !== null) return clean(found, MAX_SITE_PREVIEW_DESCRIPTION);
      continue;
    }
    paragraph.push(line.replace(/^(>\s?)+/, ""));
  }
  const found = flush();
  return found === null ? null : clean(found, MAX_SITE_PREVIEW_DESCRIPTION);
}

/** The preview a resolved page publishes, or `null` for every other answer. */
export function websitePreviewFromPage(page: ResolvedWebsitePage): WebsitePreview | null {
  if (page.kind !== "page" || page.audience !== "public") return null;
  const siteName = clean(page.siteName, MAX_SITE_PREVIEW_TITLE);
  // A site's home page is the site: it unfurls under the site's own name
  // rather than as "Home".
  const title = page.routePath === "/" ? siteName : clean(page.title, MAX_SITE_PREVIEW_TITLE);
  if (siteName === null || title === null) return null;
  const description =
    (page.description === null ? null : clean(page.description, MAX_SITE_PREVIEW_DESCRIPTION)) ??
    excerptFromMarkdown(page.markdown);
  return { siteName, title, description };
}

/** What a crawler of this address is told, resolved as an anonymous visitor. */
export async function websitePreview(
  ctx: ActionCtx,
  args: { handle: string; routePath: string },
): Promise<WebsitePreview | null> {
  try {
    return websitePreviewFromPage(await resolveWebsitePageAs(ctx, args, null));
  } catch {
    return null;
  }
}

/** What the card draws: the title cut to the card's measure, and the name. */
export function siteCardFacts(preview: WebsitePreview): { title: string; siteName: string } {
  return {
    title: clean(preview.title, MAX_SITE_CARD_TITLE) ?? preview.title,
    siteName: preview.siteName,
  };
}

/** The card's cache key: what it draws, and which design drew it. */
export function siteCardVersion(preview: WebsitePreview): string {
  const facts = siteCardFacts(preview);
  return hashTitle(`${SITE_CARD_DESIGN}\n${facts.siteName}\n${facts.title}`);
}
