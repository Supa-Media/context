/**
 * The words and address the Website card draws, from the server's view of it.
 *
 * Pure, so the card's copy is held by a test rather than by a render. Nothing
 * here decides whether the site is on or who may change it: `WebsiteStateView`
 * says both, and this only turns it into sentences.
 */

import type { WebsiteStateView } from "@context/shared";

/** The site's address, whole for Copy and Open and short for a sentence. */
export function websiteAddress(origin: string, handlePath: string): { url: string; short: string } {
  const path = handlePath.replace(/\/+$/, "");
  const url = `${origin.replace(/\/+$/, "")}${path}`;
  return { url, short: url.replace(/^https?:\/\//, "") };
}

/** What turning it on or off does, said before it happens. */
export function websiteWarning(view: WebsiteStateView, short: string): string {
  return view.state === "enabled"
    ? `${short} stops showing pages. Your website folder, domain and share links are kept.`
    : `Pages in the website folder go live at ${short}. Nothing outside it is published. If there's no homepage, website/index.md is created.`;
}

/** A failed switch, in words, without the server's internals. */
export function describeWebsiteFailure(error: unknown, turningOn: boolean): string {
  const data = (error as { data?: unknown } | null)?.data;
  const code = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
  if (code === "FORBIDDEN") return "Only an owner of this workspace can change its website.";
  return turningOn
    ? "The website didn't turn on. Check this workspace's storage is connected, then try again."
    : "The website didn't turn off. Try again.";
}
