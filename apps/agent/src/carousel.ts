/**
 * Pictures as one swipeable set (Sendblue carousels, V2 lines only): which
 * of an answer's parts can go together, and which failure means the line has
 * none, so they go one by one instead (`inbox.ts`).
 */

import type { SendPart } from "./outgoing";
import { MAX_CAROUSEL } from "./sendblue";

/** The addresses of the pictures in a row from `index`, the run a carousel can carry. */
export function carouselRun(reply: SendPart[], index: number): string[] {
  const urls: string[] = [];
  for (const part of reply.slice(index)) {
    if (typeof part === "string" || !("url" in part.media)) break;
    urls.push(part.media.url);
  }
  return urls.slice(0, MAX_CAROUSEL);
}

/** A 4xx other than 429: the line said no to this request, and saying it again changes nothing. */
export function isRefusal(error: unknown): boolean {
  const status = (error as { status?: number | null }).status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}
