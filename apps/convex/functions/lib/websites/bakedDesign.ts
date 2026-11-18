/**
 * A website's design, composed and sanitized once at Publish and kept in the
 * release beside its page copies (`<release>/design.json`, in the customer's
 * bucket like every other copy).
 *
 * _Decided by the owner, 2026-11-18_ (`docs/decisions/websites/kept-design.md`).
 * Before, every visit rebuilt a page's look from about five live lookups (the
 * tree's rows and facts, the notes, the release copies, the pictures), and any
 * one of them failing was answered as "no design": the site drew unstyled, or
 * an all-HTML page drew blank, and that copy was kept at the edge. Sites went
 * unstyled that way more than once (#1201, #2335). Now a visit reads one
 * object, and a failure to read it is a failure, never a look.
 *
 * A kept design is one variant per (audience, layout): the frame and every
 * stylesheet, plus the layout a page names. An HTML page's own block is
 * sanitized at the visit and drawn inside the variant with no layout.
 *
 * It is drawn only while it is still what the index publishes: every code note
 * the page would be drawn with is live in the route index under this release,
 * and the variant was made from exactly those notes. A narrowing drops a code
 * note's row (`narrowing.ts`) and a withheld note takes the design out of every
 * kept release (`deleteWebsiteReleasePages`), so a restriction never waits for
 * this; while one is pending the resolver rebuilds the look from the live
 * notes instead (`readWebsiteDesign`).
 */

import { parseWebsitePage, type WebsiteDesign, type WebsiteRouteAudience } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isEncryptedNote } from "../noteEncryption";
import { composeDesign, designNotesFor, htmlPageBlock, readWebsiteDesign, sanitizeDesign, type DesignNote } from "./design";

const FORMAT = 1;
const AUDIENCES: readonly WebsiteRouteAudience[] = ["public", "members"];
const LAYOUT_KEY = /^website\/([^/]+)\.html\.md$/;

interface Variant {
  audience: WebsiteRouteAudience;
  layout: string | null;
  /** The notes it was made from, by key, in drawing order. */
  notes: string[];
  design: WebsiteDesign | null;
}

export interface KeptDesign {
  format: typeof FORMAT;
  variants: Variant[];
}

/** A route row as Publish commits it. */
interface ReleasedRow {
  objectKey: string;
  status: string;
  code?: string | null;
  audience?: WebsiteRouteAudience | null;
  sourceEtag: string;
  releaseId?: string;
  releasePageId?: string;
}

/** The code notes a release draws with, as the resolver will see them. */
export function releasedDesignNotes(rows: readonly ReleasedRow[]): DesignNote[] {
  return rows.flatMap((row) =>
    row.status === "live" &&
    (row.code === "frame" || row.code === "layout" || row.code === "style") &&
    (row.audience === "public" || row.audience === "members")
      ? [
          {
            objectKey: row.objectKey,
            role: row.code,
            sourceEtag: row.sourceEtag,
            audience: row.audience,
            ...(row.releaseId === undefined ? {} : { releaseId: row.releaseId }),
            ...(row.releasePageId === undefined ? {} : { releasePageId: row.releasePageId }),
          },
        ]
      : [],
  );
}

function layoutName(objectKey: string): string | null {
  return LAYOUT_KEY.exec(objectKey)?.[1] ?? null;
}

/**
 * Compose every variant from the release's own copies of its code notes.
 * `texts` is those copies by key. Pure apart from the pictures a design names.
 */
export async function composeKeptDesign(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  notes: readonly DesignNote[],
  texts: ReadonlyMap<string, string>,
): Promise<KeptDesign> {
  const layouts: Array<string | null> = [
    null,
    ...notes.filter((note) => note.role === "layout").flatMap((note) => layoutName(note.objectKey) ?? []),
  ];
  const variants: Variant[] = [];
  for (const audience of AUDIENCES) {
    for (const layout of layouts) {
      const chosen = designNotesFor(notes, layout, audience);
      // A layout only some members may see is not a variant for the public.
      if (layout !== null && !chosen.some((note) => note.role === "layout")) continue;
      const design =
        chosen.length === 0
          ? null
          : await composeDesign(ctx, workspaceId, chosen, texts, { template: null, base: true });
      variants.push({ audience, layout, notes: chosen.map((note) => note.objectKey), design });
    }
  }
  return { format: FORMAT, variants };
}

/**
 * Keep the release's design beside its page copies. Called by Publish after
 * the copies are written and before the release is committed; a design that
 * cannot be made or kept stops the release, as a page copy that cannot be
 * kept does, so a committed release always has one.
 */
export async function keepReleaseDesign(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  releaseId: string,
  rows: readonly ReleasedRow[],
): Promise<void> {
  const notes = releasedDesignNotes(rows).filter((note) => note.releaseId === releaseId);
  const wanted = notes.flatMap((note) =>
    note.releasePageId === undefined ? [] : [{ releaseId, pageId: note.releasePageId, path: note.objectKey }],
  );
  const texts = new Map<string, string>();
  for (let offset = 0; offset < wanted.length; offset += 50) {
    const read = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      grantedNames: [],
      operation: { kind: "readWebsiteRelease", pages: wanted.slice(offset, offset + 50) },
    });
    if (read.kind !== "websiteReleasePages") throw new Error("website design: the release copies did not read back");
    for (const page of read.results) {
      if (page.outcome !== "read") throw new Error(`website design: the release has no copy of ${page.path}`);
      if (!isEncryptedNote(page.text)) texts.set(page.path, page.text);
    }
  }
  const kept = await composeKeptDesign(ctx, workspaceId, notes, texts);
  const written = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    grantedNames: [],
    operation: { kind: "writeWebsiteReleaseDesign", releaseId, text: JSON.stringify(kept) },
  });
  if (written.kind !== "websiteReleaseWritten") throw new Error("website design: the bucket did not keep it");
}

export function parseKeptDesign(text: string): KeptDesign | null {
  try {
    const parsed = JSON.parse(text) as Partial<KeptDesign>;
    if (parsed.format !== FORMAT || !Array.isArray(parsed.variants)) return null;
    return parsed as KeptDesign;
  } catch {
    return null;
  }
}

/**
 * The kept variant a page is drawn with, or "rebuild" when the release has no
 * design that still matches the index (a release kept before designs were,
 * one a withheld note took its design from, or a narrowing since). Throws
 * when the design could not be read: that is a failure, never a look.
 */
export async function readKeptDesign(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    notes: readonly DesignNote[];
    pageKey: string;
    pageText: string;
    pageIsHtml: boolean;
    viewerAudience: WebsiteRouteAudience;
  },
): Promise<{ design: WebsiteDesign | null } | "rebuild"> {
  const parsed = parseWebsitePage(args.pageText);
  const layout = args.pageIsHtml ? null : parsed.layout;
  const chosen = designNotesFor(args.notes, layout, args.viewerAudience);
  if (chosen.length === 0 && !args.pageIsHtml) return { design: null };
  const releases = new Set(chosen.map((note) => note.releaseId));
  const releaseId = chosen[0]?.releaseId;
  let variant: Variant | null = null;
  if (chosen.length > 0) {
    if (releases.size !== 1 || releaseId === undefined) return "rebuild";
    const read = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      grantedNames: [],
      operation: { kind: "readWebsiteReleaseDesign", releaseId },
    });
    if (read.kind !== "websiteReleaseDesign") throw new Error("website design: an unexpected answer");
    if (read.text === null) return "rebuild";
    const kept = parseKeptDesign(read.text);
    if (kept === null) return "rebuild";
    variant =
      kept.variants.find((held) => held.audience === args.viewerAudience && held.layout === layout) ?? null;
    const keys = chosen.map((note) => note.objectKey);
    if (variant === null || variant.notes.join("\n") !== keys.join("\n")) return "rebuild";
  }
  if (!args.pageIsHtml) return { design: variant?.design ?? null };
  return { design: await withHtmlPage(ctx, args.workspaceId, variant?.design ?? null, args.pageKey, args.pageText) };
}

/** A kept design with an HTML page's own block drawn inside it. */
async function withHtmlPage(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  kept: WebsiteDesign | null,
  pageKey: string,
  pageText: string,
): Promise<WebsiteDesign | null> {
  const block = htmlPageBlock(pageKey, pageText);
  if (block === null) return kept;
  const page = await sanitizeDesign(ctx, workspaceId, { frame: null, template: block, styles: [] });
  const base = kept?.base !== false && parseWebsitePage(pageText).base;
  const merged: WebsiteDesign = {
    frame: kept?.frame ?? null,
    template: page.template,
    css: [kept?.css ?? "", page.css].filter((css) => css !== "").join("\n"),
    fonts: [...new Set([...(kept?.fonts ?? []), ...page.fonts])].slice(0, 4),
  };
  return base ? merged : { ...merged, base: false };
}

/**
 * The design a served page is drawn with: the kept one when the release has
 * one that still matches the index and no restriction is pending (`kept`),
 * else rebuilt from the live notes. "failed" when it could not be read, which
 * the resolver answers as `incomplete`, never as the page having no look.
 */
export async function pageDesign(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  objectKey: string,
  viewerAudience: WebsiteRouteAudience,
  design: { notes: DesignNote[]; text: string; html: boolean; kept?: boolean },
): Promise<{ design: WebsiteDesign | null } | "failed"> {
  const args = {
    workspaceId,
    notes: design.notes,
    pageKey: objectKey,
    pageText: design.text,
    pageIsHtml: design.html,
    viewerAudience,
  };
  try {
    if (design.kept === true) {
      const kept = await readKeptDesign(ctx, args);
      if (kept !== "rebuild") return kept;
    }
    return { design: await readWebsiteDesign(ctx, args) };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "website_design_unreadable",
        workspaceId,
        reason: error instanceof Error ? error.message.slice(0, 200) : "failed",
      }),
    );
    return "failed";
  }
}
