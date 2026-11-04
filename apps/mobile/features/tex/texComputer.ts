/**
 * `/tex/@<handle>` (and `/tex/group/<words>`): the person's own look at, and
 * hands on, the browser Tex drives for them. The page Tex texts when they have
 * to sign in somewhere.
 *
 * `apps/mcp/src/http/texComputer.js` is the server half of this contract. The
 * gateway decides whose browser it is from the console grant, never from the
 * handle; the handle is only how the page is addressed, and the gateway
 * refuses one that is not the caller's own. This page refuses it first, so a
 * person who opens somebody else's address is told so without asking.
 *
 * Pure, so the tests can walk every state without a Convex client or a
 * network, as `features/approvals/gateway.ts` is.
 */

import { loginHref } from "../auth/redirect";

export const TEX_ROUTE = "/tex";

/** The global name namespace, as the gateway restates it. */
const HANDLE = /^[a-z0-9-]{2,32}$/;

/** How often the frame refreshes while a browser is running, and while none is. */
export const LIVE_POLL_MS = 1_000;
export const IDLE_POLL_MS = 5_000;

/** The most one Send inserts. The screenshot Worker refuses more. */
export const MAX_TYPED = 1_000;

/** `/tex/@<handle>`: the person's own Tex page, as Tex texts it (the owner, 2026-11-03). */
export function texHref(handle: string): string {
  return `${TEX_ROUTE}/@${encodeURIComponent(handle)}`;
}

/** The three to five words that name a group chat's home (`tex/groups/<words>`, `apps/convex/functions/lib/textGroupHome.ts`). */
const GROUP_WORDS = /^[a-z]+(?:-[a-z]+){1,4}$/;

/** `/tex/group/<words>`: a group chat's Tex page, addressed by its home's words. */
export function texGroupHref(words: string): string {
  return `${TEX_ROUTE}/group/${encodeURIComponent(words)}`;
}

/** A group's words from an address, or null for anything that is not three to five lower-case words. */
export function normalizeGroupWords(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const words = raw.trim().toLowerCase();
  return GROUP_WORDS.test(words) ? words : null;
}

/** A group chat's words, from its home folder as the gateway names it (`tex/groups/<words>`), or null. */
export function groupWordsOf(folder: string | null | undefined): string | null {
  const match = typeof folder === "string" ? /^tex\/groups\/([^/]+)$/.exec(folder) : null;
  return match ? normalizeGroupWords(match[1]) : null;
}

/** `@Seyi` and `seyi` are one handle; anything outside the namespace is none. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const handle = raw.trim().replace(/^@/, "").toLowerCase();
  return HANDLE.test(handle) ? handle : null;
}

/** One workspace as `listMyWorkspaces` lists it: the fields this page reads. */
export interface WorkspaceRow {
  workspaceId: string;
  slug: string;
  kind: string;
  role: string;
}

/**
 * The person's own handle and the workspace whose grant asks for it: the
 * personal workspace they own. Never one they were invited into, which is
 * also `personal`. Mirrors `ownHandle` on the gateway.
 */
export function ownWorkspace(workspaces: readonly WorkspaceRow[]): { handle: string; workspaceId: string } | null {
  const own = workspaces.find((w) => w.kind === "personal" && w.role === "owner");
  const handle = normalizeHandle(own?.slug);
  return own && handle ? { handle, workspaceId: own.workspaceId } : null;
}

export type TexPageView =
  | { kind: "wait" }
  | { kind: "signIn"; href: string }
  | { kind: "notFound" }
  | { kind: "notYours"; own: string | null }
  | { kind: "ready"; handle: string; workspaceId: string };

/**
 * `/tex/group/<words>`: which page to draw, before anything is asked of the
 * gateway. There is no handle in the address, so it is always the signed-in
 * person's own page; whether the group is one of theirs is the gateway's call
 * (`apps/mcp/src/http/texPage/page.js`), answered off their live grant.
 */
export function resolveTexGroupPage(inputs: {
  words: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  workspaces: readonly WorkspaceRow[] | undefined;
}): TexPageView {
  const words = normalizeGroupWords(inputs.words);
  if (inputs.auth.isLoading) return { kind: "wait" };
  if (words === null) return { kind: "notFound" };
  if (!inputs.auth.isAuthenticated) return { kind: "signIn", href: loginHref(texGroupHref(words)) };
  if (inputs.workspaces === undefined) return { kind: "wait" };
  const own = ownWorkspace(inputs.workspaces);
  if (own === null) return { kind: "notYours", own: null };
  return { kind: "ready", handle: own.handle, workspaceId: own.workspaceId };
}

/** Which page to draw, before anything is asked of the gateway. */
export function resolveTexPage(inputs: {
  handle: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  /** `undefined` while the list is loading. */
  workspaces: readonly WorkspaceRow[] | undefined;
}): TexPageView {
  const handle = normalizeHandle(inputs.handle);
  if (inputs.auth.isLoading) return { kind: "wait" };
  if (handle === null) return { kind: "notFound" };
  if (!inputs.auth.isAuthenticated) return { kind: "signIn", href: loginHref(texHref(handle)) };
  if (inputs.workspaces === undefined) return { kind: "wait" };
  const own = ownWorkspace(inputs.workspaces);
  if (own === null || own.handle !== handle) return { kind: "notYours", own: own?.handle ?? null };
  return { kind: "ready", handle, workspaceId: own.workspaceId };
}

/**
 * Where bare `/tex?…` goes: the signed-in person's own `/tex/<handle>?…`. A
 * link made before anyone is known (a runner's pairing link, say) cannot name
 * the handle, so the app fills it in. Signed out, it signs in and comes back
 * here; with no personal workspace of their own, nowhere (`null`).
 */
export function ownTexHref(
  inputs: { auth: { isLoading: boolean; isAuthenticated: boolean }; workspaces: readonly WorkspaceRow[] | undefined },
  query: string,
): { kind: "wait" } | { kind: "go"; href: string | null } {
  const suffix = query ? `?${query}` : "";
  if (inputs.auth.isLoading) return { kind: "wait" };
  if (!inputs.auth.isAuthenticated) return { kind: "go", href: loginHref(`${TEX_ROUTE}${suffix}`) };
  if (inputs.workspaces === undefined) return { kind: "wait" };
  const own = ownWorkspace(inputs.workspaces);
  return { kind: "go", href: own ? `${texHref(own.handle)}${suffix}` : null };
}

/** The gateway route for one of the three things this page does. */
export function texComputerEndpoint(mcpEndpoint: string, route: "frame" | "input" | "stop"): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/tex/computer${route === "frame" ? "" : `/${route}`}`;
}

export type TexKey = "Tab" | "Enter" | "Backspace";

/** What the page can ask of the browser; `infra/site-shots/src/view.ts` bounds every field. */
export type TexAction =
  | { kind: "tap"; x: number; y: number; button: "left" }
  | { kind: "move"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; name: TexKey }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number };

/**
 * What the browser shows. `width` and `height` are its viewport in CSS
 * pixels, the space every action is in; `scale` is the picture's pixels per
 * CSS pixel, 1 when the gateway did not say.
 */
export type Frame =
  | { running: false }
  | { running: true; url: string; title: string; width: number; height: number; scale: number; frame: string };

export type FrameRead =
  | { kind: "frame"; frame: Frame }
  | { kind: "notYours" }
  | { kind: "expired" }
  | { kind: "failed" };

/** One answer from the gateway, field by field. */
export function readFrame(status: number, body: unknown): FrameRead {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (status === 403 && record?.error === "not_yours") return { kind: "notYours" };
  if (status === 401 || status === 403) return { kind: "expired" };
  if (status !== 200 || record === null) return { kind: "failed" };
  if (record.running === false) return { kind: "frame", frame: { running: false } };
  const { width, height, frame, scale } = record;
  if (
    record.running !== true ||
    typeof frame !== "string" ||
    frame.length === 0 ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return { kind: "failed" };
  }
  return {
    kind: "frame",
    frame: {
      running: true,
      url: typeof record.url === "string" ? record.url : "",
      title: typeof record.title === "string" ? record.title : "",
      width,
      height,
      scale: typeof scale === "number" && scale > 0 && Number.isFinite(scale) ? scale : 1,
      frame,
    },
  };
}

/** `chatgpt.com` for the top bar, or the address itself. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** What the person is told after handing the browser back. */
export const HAND_BACK_NOTICE = "Text Tex “done” and it will carry on from here.";
