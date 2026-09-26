import { emojiPictures, type EmojiPictures } from "../share/emojiPictures";
import type { HomePage } from "./homeSite";

/**
 * The homepage's live site as the router hands it over: a JSON block in the
 * HTML (`infra/router/src/homeSite.ts`), read on the first render so the first
 * paint is the site and nothing replaces it.
 */

/** Whose `website/` folder is the homepage. A self-host names its own. */
export const HOME_SITE_HANDLE = process.env.EXPO_PUBLIC_HOME_SITE ?? "context-lc";

/** The element the router writes; the same name as `HOME_SITE_ELEMENT_ID` there. */
export const HOME_SITE_ELEMENT_ID = "context-home-site";

export interface HomeSnapshot {
  siteName: string;
  /** The site's revision when it was read, to tell whether it is current. */
  revision: string | null;
  /** Every published note in `website/`: `nav:` order first, then by path. */
  pages: HomePage[];
  /** The workspace emoji the pages use, drawn in place of their `:name:`. */
  emoji: EmojiPictures;
}

/** A snapshot from anywhere (the HTML, or the action), checked, or `null`. */
export function parseHomeSnapshot(value: unknown): HomeSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.siteName !== "string" || !Array.isArray(body.pages)) return null;
  if (body.revision !== null && typeof body.revision !== "string") return null;
  const pages: HomePage[] = [];
  for (const raw of body.pages) {
    if (typeof raw !== "object" || raw === null) return null;
    const page = raw as Record<string, unknown>;
    if (typeof page.routePath !== "string" || !page.routePath.startsWith("/")) return null;
    if (typeof page.title !== "string" || typeof page.markdown !== "string") return null;
    if (page.path !== undefined && (typeof page.path !== "string" || !/\.md$/i.test(page.path))) return null;
    pages.push({
      ...(typeof page.path === "string" ? { path: page.path } : {}),
      routePath: page.routePath,
      title: page.title,
      markdown: page.markdown,
    });
  }
  // An empty folder is not a homepage; the built-in copy is drawn instead.
  if (pages.length === 0) return null;
  return { siteName: body.siteName, revision: body.revision, pages, emoji: emojiPictures(body.emoji) };
}

/** What the page's HTML carried, or `null` off the web or without one. */
export function injectedHomeSnapshot(
  doc: Pick<Document, "getElementById"> | undefined = typeof document === "undefined" ? undefined : document,
): HomeSnapshot | null {
  const text = doc?.getElementById(HOME_SITE_ELEMENT_ID)?.textContent;
  if (!text) return null;
  try {
    return parseHomeSnapshot(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Where the homepage's pages come from for this visit.
 *
 * - `live`: the site, from the HTML or once asked for. Only a new revision of
 *   the site ever replaces it (somebody edited `website/`), never the copy.
 * - `waiting`: no site in the HTML (a local build, a router that timed out),
 *   so it is asked for, and nothing is drawn until it answers or gives up.
 * - `builtIn`: the site is off or unreachable; the built-in pages, for the
 *   rest of the visit.
 *
 * The built-in pages are never drawn and then replaced: that swap was the
 * flicker. A visit decides once between the site and the copy.
 */
export type HomeSource =
  | { kind: "live"; snapshot: HomeSnapshot }
  | { kind: "waiting" }
  | { kind: "builtIn" };

export function initialHomeSource(injected: HomeSnapshot | null, web: boolean): HomeSource {
  if (injected !== null) return { kind: "live", snapshot: injected };
  return web ? { kind: "waiting" } : { kind: "builtIn" };
}

export type HomeSourceEvent =
  | { type: "answered"; snapshot: HomeSnapshot | null }
  | { type: "gaveUp" };

export function homeSourceReducer(state: HomeSource, event: HomeSourceEvent): HomeSource {
  if (event.type === "gaveUp") return state.kind === "waiting" ? { kind: "builtIn" } : state;
  if (state.kind === "builtIn") return state;
  if (event.snapshot !== null) return { kind: "live", snapshot: event.snapshot };
  // A live site that stops answering stays as it was drawn; only waiting falls back.
  return state.kind === "waiting" ? { kind: "builtIn" } : state;
}

/** Whether the site has moved on from what is drawn, so it is worth asking again. */
export function isStale(source: HomeSource, revision: string | null | undefined): boolean {
  return (
    source.kind === "live" &&
    typeof revision === "string" &&
    revision !== source.snapshot.revision
  );
}
