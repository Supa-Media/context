/**
 * Embedded frames: what a reading, a click by number or words, typing and
 * filling reach besides the top page (the owner, 2026-10-22). Google's admin
 * console shows an invoice's download menu in a payments.google.com frame;
 * reading only the top page, Tex saw it in a picture and could press none of it.
 *
 * Each frame is its own document, read with its own numbers: the top page's
 * are 1 to 300, the first frame's from 1001, the second's from 2001, so a
 * number names one element whichever document holds it. A step on a frame's
 * element checks that frame's own site (`where` in ./browse.ts), never the
 * top page's: a password typed for one site never lands in another's frame.
 *
 * Only Browserbase's browser lists frames (./cdpFrames.ts); a page without
 * `frames` is read and driven as before, top page only.
 */

import type { BrowsePage } from "./browse";

/** A document inside the page, on the page's site or another. */
export interface FrameDoc {
  /** The frame's own site. */
  host: string;
  evaluate<T>(source: string): Promise<T>;
  /** Press what `selector` names in this frame, where it shows on the screen. */
  click(selector: string): Promise<void>;
  /** Type into what `selector` names in this frame. */
  type(selector: string, text: string): Promise<void>;
  /** Set files the browser holds (`paths` on its own disk) on the file box `selector` names, as the browser itself (./upload.ts). */
  setFiles?(selector: string, paths: string[]): Promise<boolean>;
}

/** The page itself or one of its frames: what a step acts on. */
export type Doc = Pick<FrameDoc, "evaluate" | "click" | "type" | "setFiles">;

export const FRAME_REF_BASE = 1_000;
export const MAX_FRAMES = 8;
/** At most this many of a frame's elements are numbered, and this much of its text kept. */
export const MAX_FRAME_ELEMENTS = 80;
export const MAX_FRAME_TEXT = 3_000;

/** The page's frames, when its browser can list them. */
export async function framesOf(page: BrowsePage): Promise<FrameDoc[]> {
  if (typeof page.frames !== "function") return [];
  return (await page.frames().catch(() => [] as FrameDoc[])).slice(0, MAX_FRAMES);
}

/** Our own selectors only (`[data-tex-ref="3"]`, `[data-tex-words]`), which hold no single quote. */
const has = (selector: string) => `!!document.querySelector('${selector}')`;

/** The document holding `selector`: the top page first, then each frame. */
export async function docWith(page: BrowsePage, selector: string): Promise<Doc | null> {
  if (await page.evaluate<boolean>(has(selector)).catch(() => false)) return page;
  for (const frame of await framesOf(page)) {
    if (await frame.evaluate<boolean>(has(selector)).catch(() => false)) return frame;
  }
  return null;
}

/** The first document where `source` (one that marks an element and answers true) finds what it looks for. */
export async function docMarking(page: BrowsePage, source: string): Promise<Doc | null> {
  if (await page.evaluate<boolean>(source).catch(() => false)) return page;
  for (const frame of await framesOf(page)) {
    if (await frame.evaluate<boolean>(source).catch(() => false)) return frame;
  }
  return null;
}
