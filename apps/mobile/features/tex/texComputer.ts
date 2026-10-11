/**
 * `/tex/<handle>`: the person's own look at, and hands on, the browser Tex
 * drives for them. The page Tex texts when they have to sign in somewhere.
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

/** How far one press of a scroll button moves the page, in CSS pixels. */
export const SCROLL_STEP = 500;

export function texHref(handle: string): string {
  return `${TEX_ROUTE}/${encodeURIComponent(handle)}`;
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

export type TexAction =
  | { kind: "tap"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; name: TexKey }
  | { kind: "scroll"; dy: number }
  | { kind: "back" };

export type Frame =
  | { running: false }
  | { running: true; url: string; title: string; width: number; height: number; frame: string };

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
  const { width, height, frame } = record;
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
      frame,
    },
  };
}

/**
 * Where a tap on the picture lands on the page: the picture is the page's
 * viewport scaled to fit, so a tap scales back by the same ratio. Clamped to
 * the page, so a tap on the picture's very edge is still on it.
 */
export function tapToPage(
  point: { x: number; y: number },
  shown: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null {
  if (!(shown.width > 0) || !(shown.height > 0) || !(page.width > 0) || !(page.height > 0)) return null;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  return {
    x: Math.round(clamp((point.x / shown.width) * page.width, page.width) * 10) / 10,
    y: Math.round(clamp((point.y / shown.height) * page.height, page.height) * 10) / 10,
  };
}

/** `chatgpt.com` for the line under the picture, or the address itself. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** What the person is told after handing the browser back. */
export const HAND_BACK_NOTICE = "Text Tex “done” and it will carry on from here.";
