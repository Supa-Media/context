/**
 * The app's half of the page runtime: where the frame is loaded from, what it
 * may say, and what each thing it says does to the note.
 *
 * The frame (`apps/mobile/page-frame/`) draws a `.page.md` note in a sealed
 * origin and reports what the reader did. Everything it says is checked here
 * twice: once for shape (`readPageMessage`, because the frame runs on a note
 * anybody who can write to it wrote), and once against the note as it is now
 * (`pageChange`, through `@context/shared/src/pages/edits.cjs`), so the frame
 * can only change words a reader sees, tick a task the note has, or pick an
 * option a block offers. Comments are written by `comments.cjs`, as the
 * signed-in person, exactly as the editor writes them.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`.
 */

import { addThread, appendEvent, applyChanges } from "@context/shared/src/comments.cjs";
import { applyRunEdits, chooseOption, commentableRange, toggleTask } from "@context/shared/src/pages/index.cjs";

export const PAGE_CHANNEL = "context-page";

/** The tallest a page may report itself; a longer page is cut off rather than given an unbounded frame. */
export const PAGE_MAX_HEIGHT = 60_000;
const MAX_TEXT = 20_000;
const MAX_BODY = 4_000;
const MAX_EDITS = 200;

/** Where the runtime is served on every deployment's own origin, beside the diagram frame. */
export const LOCAL_FRAME_PATH = "/drawing-assets/page/index.html";

/** Hosts whose pages are drawn from the sites domain, which only production serves (`sitesDomain.ts`). */
const SITES_HOSTS = new Set(["context.lc", "tex.lc"]);

/**
 * The runtime's addresses, best first. In production that is the person's
 * `<handle>.ctxlc.site/_page/`, a different site from the one they are signed
 * in on; everywhere, the deployment's own copy follows as the fallback, which
 * is just as sealed (the frame's sandbox gives it an opaque origin wherever it
 * is served from) and is what staging and a self-hosted deployment use.
 */
export function pageFrameUrls(location: { hostname: string; origin: string }, slug: string | null): string[] {
  const local = `${location.origin}${LOCAL_FRAME_PATH}`;
  if (!SITES_HOSTS.has(location.hostname)) return [local];
  const label = slug !== null && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ? slug : "page";
  return [`https://${label}.ctxlc.site/_page/index.html`, local];
}

export type PageMessage =
  | { type: "ready" }
  | { type: "height"; height: number }
  | { type: "edit"; edits: { from: number; to: number; text: string }[] }
  | { type: "task"; at: number; checked: boolean }
  | { type: "choose"; block: number; option: string }
  | { type: "comment"; from: number; to: number; body: string }
  | { type: "reply" | "resolve" | "reopen"; thread: string; body: string }
  | { type: "open"; href: string }
  | { type: "note"; target: string }
  | { type: "image"; src: string };

const position = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 50_000_000;
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);

/**
 * Read a message that came from the page frame's window (the caller checks
 * which window). Anything not exactly one of the shapes is dropped.
 */
export function readPageMessage(data: unknown): PageMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.channel !== PAGE_CHANNEL) return null;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "height":
      return typeof m.height === "number" && Number.isFinite(m.height)
        ? { type: "height", height: Math.min(PAGE_MAX_HEIGHT, Math.max(0, Math.ceil(m.height))) }
        : null;
    case "edit": {
      if (!Array.isArray(m.edits) || m.edits.length === 0 || m.edits.length > MAX_EDITS) return null;
      const edits = [];
      for (const edit of m.edits as Record<string, unknown>[]) {
        const words = text(edit?.text, MAX_TEXT);
        if (!edit || !position(edit.from) || !position(edit.to) || edit.to < edit.from || words === null) return null;
        edits.push({ from: edit.from, to: edit.to, text: words });
      }
      return { type: "edit", edits };
    }
    case "task":
      return position(m.at) && typeof m.checked === "boolean" ? { type: "task", at: m.at, checked: m.checked } : null;
    case "choose": {
      const option = text(m.option, 300);
      return position(m.block) && option !== null ? { type: "choose", block: m.block, option } : null;
    }
    case "comment": {
      const body = text(m.body, MAX_BODY);
      return position(m.from) && position(m.to) && body !== null && body.trim() !== ""
        ? { type: "comment", from: m.from, to: m.to, body: body.trim() }
        : null;
    }
    case "reply":
    case "resolve":
    case "reopen": {
      const thread = typeof m.thread === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(m.thread) ? m.thread : null;
      const body = m.type === "reply" ? text(m.body, MAX_BODY) : "";
      if (thread === null || body === null || (m.type === "reply" && body.trim() === "")) return null;
      return { type: m.type, thread, body: body.trim() };
    }
    case "open": {
      const href = text(m.href, 2000);
      return href !== null ? { type: "open", href } : null;
    }
    case "note": {
      const target = text(m.target, 300);
      return target !== null && target.trim() !== "" ? { type: "note", target: target.trim() } : null;
    }
    case "image": {
      const src = text(m.src, 500);
      return src !== null && src.trim() !== "" ? { type: "image", src: src.trim() } : null;
    }
    default:
      return null;
  }
}

export type PageChange = { text: string } | { error: string };

/**
 * The note after one thing the reader did, or why not. `shown` is the copy of
 * the note the frame drew; a message about any other copy is stale, because
 * its positions are positions in that copy.
 */
export function pageChange(current: string, shown: string, message: PageMessage, author: string | null): PageChange | null {
  if (current !== shown) {
    if (message.type === "edit" || message.type === "task" || message.type === "choose" || message.type === "comment") return { error: "stale" };
  }
  switch (message.type) {
    case "edit":
      return applyRunEdits(current, message.edits);
    case "task":
      return toggleTask(current, message.at, message.checked);
    case "choose":
      return chooseOption(current, message.block, message.option);
    case "comment": {
      if (author === null) return { error: "This note can't take comments here." };
      if (!commentableRange(current, message.from, message.to)) return { error: "stale" };
      const made = addThread(current, { from: message.from, to: message.to, author, body: message.body });
      return made.error !== undefined ? { error: made.error } : { text: applyChanges(current, made.changes) };
    }
    case "reply":
    case "resolve":
    case "reopen": {
      if (author === null) return { error: "This note can't take comments here." };
      const kind = message.type === "reply" ? "comment" : message.type === "resolve" ? "resolved" : "reopened";
      const done = appendEvent(current, { thread: message.thread, kind, author, body: message.body || undefined });
      return done.error !== undefined ? { error: done.error } : { text: applyChanges(current, done.changes) };
    }
    default:
      return null;
  }
}
