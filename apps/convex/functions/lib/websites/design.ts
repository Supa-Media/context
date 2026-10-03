/**
 * A served page's design: the frame, its layout and the site's stylesheets,
 * read from the code notes the last Publish released and sanitized here.
 *
 * Code notes follow a page's own rules (`docs/decisions/websites/code-notes.md`):
 *
 * - **What was published is what is drawn.** A code note unchanged since
 *   Publish is read live; one edited since is drawn from the copy Publish
 *   kept, so saving a stylesheet changes nothing a visitor sees.
 * - **Restrictions do not wait.** The live note is read at the publication
 *   clearance on every visit: a note `privacy.md` now holds back, one that
 *   was deleted, encrypted or drafted, is simply not drawn, and the page
 *   falls back to the parts that remain (in the end, the default look).
 * - **Members-only code is for members.** A code note whose audience is
 *   `members` is only drawn for a member.
 * - **Nothing a site wrote reaches the browser unsanitized**, and the
 *   browser sanitizes the composed page again (`siteDesign/template.ts`).
 */

import {
  DEFAULT_WEBSITE_ROOT,
  SITE_SCOPE,
  parseWebsitePage,
  sanitizeSiteCss,
  sanitizeSiteHtml,
  websiteCodeBlock,
  websiteCodeLanguage,
  type WebsiteDesign,
  type WebsiteRouteAudience,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { deploymentSells, planFor, statusOf } from "../billing/plan";
import { planIsPaying } from "../premium";
import { isEncryptedNote } from "../noteEncryption";
import { websiteTextRestricts } from "./changes";
import { readPublishedImages } from "./images";
import { PUBLICATION_CLEARANCE } from "./publication";

/** One code note the index holds as published. */
export interface DesignNote {
  objectKey: string;
  role: "frame" | "layout" | "style";
  sourceEtag: string;
  audience: WebsiteRouteAudience;
  releaseId?: string;
  releasePageId?: string;
}

/** The notes a page is drawn with: the frame, the layout it names, every stylesheet. */
export function designNotesFor(
  notes: readonly DesignNote[],
  layout: string | null,
  viewerAudience: WebsiteRouteAudience,
): DesignNote[] {
  const layoutKey = layout === null ? null : `${DEFAULT_WEBSITE_ROOT}/${layout}.html.md`;
  return notes
    .filter((note) => note.audience === "public" || viewerAudience === "members")
    .filter((note) => note.role !== "layout" || note.objectKey === layoutKey)
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

/** The published text of each note that may still be drawn, by key. */
async function publishedTexts(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  notes: readonly DesignNote[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (notes.length === 0) return texts;
  const live = await ctx
    .runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      ...PUBLICATION_CLEARANCE,
      operation: { kind: "readMany", paths: notes.map((note) => note.objectKey) },
    })
    .catch(() => null);
  if (live?.kind !== "notes") return texts;
  const changed: DesignNote[] = [];
  for (const note of notes) {
    const result = live.results.find((entry) => entry.path === note.objectKey);
    // Absent at the publication clearance: held back, deleted or moved. Gone now.
    if (result?.outcome !== "read") continue;
    const text = result.note.text;
    if (isEncryptedNote(text)) continue;
    // A members-only note asked for its narrowing already; a public one that
    // now asks for any is withdrawn, whatever else its bytes say.
    if (note.audience === "public" && websiteTextRestricts(text)) continue;
    const parsed = parseWebsitePage(text);
    if (parsed.draft || (note.audience === "public" && parsed.audience !== "public")) continue;
    if (result.note.etag === note.sourceEtag) texts.set(note.objectKey, text);
    else changed.push(note);
  }
  const wanted = changed.flatMap((note) =>
    note.releaseId === undefined || note.releasePageId === undefined
      ? []
      : [{ releaseId: note.releaseId, pageId: note.releasePageId, path: note.objectKey }],
  );
  if (wanted.length > 0) {
    const released = await ctx
      .runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        grantedNames: [],
        operation: { kind: "readWebsiteRelease", pages: wanted },
      })
      .catch(() => null);
    if (released?.kind === "websiteReleasePages") {
      for (const page of released.results) {
        if (page.outcome === "read" && !isEncryptedNote(page.text)) texts.set(page.path, page.text);
      }
    }
  }
  return texts;
}

/** The one block a code note's text holds, or null. */
function blockOf(objectKey: string, text: string): string | null {
  const language = websiteCodeLanguage(objectKey);
  if (language === null) return null;
  const block = websiteCodeBlock(parseWebsitePage(text).body, language);
  return "code" in block ? block.code : null;
}

/**
 * Sanitize a page's design. Pictures a layout or stylesheet names are read
 * once, the way a page's pasted pictures are, and drawn as `data:` URLs.
 */
export async function sanitizeDesign(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  source: { frame: string | null; template: string | null; styles: string[] },
): Promise<WebsiteDesign> {
  const wanted = new Set<string>();
  const record = (name: string) => {
    wanted.add(name);
    return null;
  };
  const dry = [source.frame, source.template].flatMap((html) =>
    html === null ? [] : [sanitizeSiteHtml(html, { image: record })],
  );
  const sheets = [...source.styles, ...dry.flatMap((result) => result.styles)];
  for (const sheet of sheets) sanitizeSiteCss(sheet, { scope: SITE_SCOPE, image: record });
  const pictures =
    wanted.size === 0
      ? {}
      : await readPublishedImages(
          ctx,
          workspaceId,
          [[...wanted].map((name) => `![[${name}]]`).join("\n")],
        ).catch(() => ({}) as Record<string, string>);
  const image = (name: string) => (pictures as Record<string, string>)[name] ?? null;
  const frame = source.frame === null ? null : sanitizeSiteHtml(source.frame, { image });
  const template = source.template === null ? null : sanitizeSiteHtml(source.template, { image });
  const fonts = new Set<string>([...(frame?.fonts ?? []), ...(template?.fonts ?? [])]);
  const css: string[] = [];
  for (const sheet of [...source.styles, ...(frame?.styles ?? []), ...(template?.styles ?? [])]) {
    const result = sanitizeSiteCss(sheet, { scope: SITE_SCOPE, image });
    if (result.css !== "") css.push(result.css);
    for (const font of result.fonts) fonts.add(font);
  }
  return {
    frame: frame?.html ?? null,
    template: template?.html ?? null,
    css: css.join("\n"),
    fonts: [...fonts].slice(0, 4),
  };
}

/**
 * The design a page is drawn with, or null for the default look: a site with
 * no code notes, on a plan without designs, looks exactly as it did.
 */
export async function readWebsiteDesign(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    notes: readonly DesignNote[];
    /** The served page's text: its `layout:` and, for an HTML page, its block. */
    pageKey: string;
    pageText: string;
    pageIsHtml: boolean;
    viewerAudience: WebsiteRouteAudience;
  },
): Promise<WebsiteDesign | null> {
  const layout = args.pageIsHtml ? null : parseWebsitePage(args.pageText).layout;
  const chosen = designNotesFor(args.notes, layout, args.viewerAudience);
  if (chosen.length === 0 && !args.pageIsHtml) return null;
  const texts = await publishedTexts(ctx, args.workspaceId, chosen);
  let frame: string | null = null;
  let template: string | null = args.pageIsHtml ? blockOf(args.pageKey, args.pageText) : null;
  let base = !args.pageIsHtml || parseWebsitePage(args.pageText).base;
  const styles: string[] = [];
  for (const note of chosen) {
    const text = texts.get(note.objectKey);
    if (text === undefined) continue;
    // Only a note that is drawn can switch the base sheet off.
    if (!parseWebsitePage(text).base) base = false;
    const block = blockOf(note.objectKey, text);
    if (block === null) continue;
    if (note.role === "frame") frame = block;
    else if (note.role === "layout") template = block;
    else styles.push(block);
  }
  if (frame === null && template === null && styles.length === 0) return null;
  const design = await sanitizeDesign(ctx, args.workspaceId, { frame, template, styles });
  return base ? design : { ...design, base: false };
}

/**
 * Designs are Premium (decided by the owner, 2026-10-02): a site on a plan
 * that is not paying is drawn with the default look, whatever code notes it
 * holds. A deployment that sells nothing (self-hosted) has every feature.
 */
export async function siteDesignsAllowed(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  if (!deploymentSells()) return true;
  return planIsPaying(statusOf(await planFor(ctx, workspaceId)));
}
