/**
 * The person's own view of Tex's browser: `context.lc/tex/<handle>`.
 *
 *   POST /view/frame `{ owner }` → `{ running: false }` or
 *        `{ running: true, url, title, width, height, scale, frame }`
 *   POST /view/input `{ owner, action }` → the same, after the action
 *
 * `frame` is a base64 JPEG of what the page shows now; `width` and `height`
 * are the page's viewport in CSS pixels, the space every `x` and `y` is in,
 * and `scale` is the JPEG's pixels per CSS pixel. An action is one of
 * `tap {x, y, button?}` (left only), `move {x, y}` (the pointer, so hover
 * works), `type {text}`, `key {name}` (Tab, Enter, Backspace),
 * `scroll {x, y, dx, dy}` (a wheel at the cursor) and `back`.
 *
 * Rules, each the reason for something below:
 *
 * - **It only finds a browser; it never starts one.** A person looking at an
 *   empty page must not cost a Browserbase session, so a missing browser is
 *   `running: false` and nothing else.
 * - **The owner tag is the only key.** It is the gateway's HMAC of the
 *   person's id (`apps/mcp/src/agent/browserProviders.js`), and the gateway
 *   computes it from the signed-in caller, never from the request. This Worker
 *   has no address but the gateway's service binding.
 * - **What the person types goes to the page and nowhere else.** It is never
 *   logged, never returned, and never seen by the model: the gateway's route
 *   for it is the Context app's alone.
 * - **Every field is bounded** before anything is sent to the browser, so a
 *   malformed request is a 400 that touched nothing.
 * - **The Browserbase link and session id never leave this Worker.** The
 *   person sees the page through these frames instead of the vendor's live
 *   view, which is a bearer link to the browser.
 */

import { browserbaseConfigured, findSession, OWNER_TAG, type BrowserbaseEnv } from "./browserbase";
import { attachPage, connectCdp, type AttachedPage } from "./cdp";
import { touchIdle } from "./idle";

/** The most one `type` action inserts. A sign-in field, not a document. */
export const MAX_VIEW_TEXT = 1_000;
/** A pointer's coordinates and a scroll's distance, in CSS pixels. */
export const MAX_COORDINATE = 10_000;
export const MAX_SCROLL = 3_000;
/** The keys a person can press from the page, and nothing else. */
export const VIEW_KEYS = { Tab: 9, Enter: 13, Backspace: 8 } as const;
/** The mouse buttons a tap may press. Left only: a right click opens menus a phone cannot dismiss. */
export const VIEW_BUTTONS = ["left"] as const;
/** Where a scroll with no position lands, as PR #1528's `scroll {dy}` did. */
const DEFAULT_WHEEL_AT = 10;
/** How a frame is taken: a modest JPEG at reduced scale, for a phone on a cellular link. */
export const FRAME_QUALITY = 55;
export const FRAME_SCALE = 0.6;

export type ViewKey = keyof typeof VIEW_KEYS;
export type ViewButton = (typeof VIEW_BUTTONS)[number];
export type ViewAction =
  | { kind: "tap"; x: number; y: number; button: ViewButton }
  | { kind: "move"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; name: ViewKey }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "back" };

export interface ViewFrame {
  running: true;
  url: string;
  title: string;
  width: number;
  height: number;
  scale: number;
  frame: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** A point on the page, both coordinates bounded, or null. */
function pointOf(action: Record<string, unknown>): { x: number; y: number } | null {
  const x = bounded(action.x, 0, MAX_COORDINATE);
  const y = bounded(action.y, 0, MAX_COORDINATE);
  return x === null || y === null ? null : { x, y };
}

/** One action, field by field, or null. Nothing unrecognised is passed on. */
export function parseViewAction(raw: unknown): ViewAction | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  switch (action.kind) {
    case "tap": {
      const at = pointOf(action);
      const button = action.button === undefined ? "left" : action.button;
      if (at === null || !(VIEW_BUTTONS as readonly unknown[]).includes(button)) return null;
      return { kind: "tap", ...at, button: button as ViewButton };
    }
    case "move": {
      const at = pointOf(action);
      return at === null ? null : { kind: "move", ...at };
    }
    case "type": {
      const text = action.text;
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_VIEW_TEXT) return null;
      return { kind: "type", text };
    }
    case "key": {
      const name = action.name;
      return typeof name === "string" && Object.prototype.hasOwnProperty.call(VIEW_KEYS, name)
        ? { kind: "key", name: name as ViewKey }
        : null;
    }
    case "scroll": {
      const dx = action.dx === undefined ? 0 : bounded(action.dx, -MAX_SCROLL, MAX_SCROLL);
      const dy = action.dy === undefined ? 0 : bounded(action.dy, -MAX_SCROLL, MAX_SCROLL);
      if (dx === null || dy === null || (dx === 0 && dy === 0)) return null;
      // No position at all is the page's corner; half of one is a mistake.
      const unplaced = action.x === undefined && action.y === undefined;
      const at = unplaced ? { x: DEFAULT_WHEEL_AT, y: DEFAULT_WHEEL_AT } : pointOf(action);
      return at === null ? null : { kind: "scroll", ...at, dx, dy };
    }
    case "back":
      return { kind: "back" };
    default:
      return null;
  }
}

/** Carry out one action on the attached page. */
export async function applyAction(page: AttachedPage, action: ViewAction): Promise<void> {
  switch (action.kind) {
    case "tap":
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", { type, x: action.x, y: action.y, button: action.button, clickCount: 1 });
      }
      await sleep(400);
      return;
    case "move":
      // No button: a pointer that only hovers, so menus and tooltips open as they would.
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.x, y: action.y });
      await sleep(150);
      return;
    case "type":
      await page.send("Input.insertText", { text: action.text });
      return;
    case "key": {
      const code = VIEW_KEYS[action.name];
      // Enter carries a character; the others are raw keys, as a keyboard sends them.
      const text = action.name === "Enter" ? { text: "\r" } : {};
      await page.send("Input.dispatchKeyEvent", {
        type: action.name === "Enter" ? "keyDown" : "rawKeyDown",
        key: action.name,
        code: action.name,
        windowsVirtualKeyCode: code,
        ...text,
      });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: action.name, code: action.name, windowsVirtualKeyCode: code });
      if (action.name === "Enter") await sleep(400);
      return;
    }
    case "scroll":
      await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: action.dx, deltaY: action.dy });
      await sleep(200);
      return;
    case "back":
      await page.evaluate("history.back()");
      await page.settle(3_000);
      return;
  }
}

/** What the page shows now. */
export async function captureFrame(page: AttachedPage): Promise<ViewFrame> {
  const info = await page.evaluate<{ url?: unknown; title?: unknown; width?: unknown; height?: unknown }>(
    "({ url: location.href, title: document.title, width: innerWidth, height: innerHeight })",
  );
  const width = bounded(info?.width, 1, MAX_COORDINATE) ?? 1280;
  const height = bounded(info?.height, 1, MAX_COORDINATE) ?? 860;
  const shot = await page.send<{ data?: unknown }>("Page.captureScreenshot", {
    format: "jpeg",
    quality: FRAME_QUALITY,
    clip: { x: 0, y: 0, width, height, scale: FRAME_SCALE },
  });
  if (typeof shot?.data !== "string" || shot.data.length === 0) throw new Error("no frame");
  return {
    running: true,
    url: typeof info?.url === "string" ? info.url.slice(0, 2_000) : "",
    title: typeof info?.title === "string" ? info.title.slice(0, 200) : "",
    width,
    height,
    scale: FRAME_SCALE,
    frame: shot.data,
  };
}

export async function viewOnBrowserbase(env: BrowserbaseEnv, path: string, body: unknown, fetcher: typeof fetch = fetch): Promise<Response> {
  const owner = (body as { owner?: unknown })?.owner;
  if (typeof owner !== "string" || !OWNER_TAG.test(owner)) return json({ error: "an owner is required" }, 400);
  let action: ViewAction | null = null;
  if (path === "/view/input") {
    action = parseViewAction((body as { action?: unknown })?.action);
    if (action === null) return json({ error: "that action could not be read" }, 400);
  } else if (path !== "/view/frame") {
    return new Response(null, { status: 404 });
  }
  // Without Browserbase there is no browser that outlives a question to look at.
  if (!browserbaseConfigured(env)) return json({ running: false });
  const started = Date.now();
  const session = await findSession(env, owner, fetcher).catch(() => null);
  if (session === null) return json({ running: false });
  // The person looking at or driving it is using it.
  await touchIdle(env.BROWSER_IDLE, owner);
  let cdp;
  try {
    cdp = await connectCdp(session.connectUrl, fetcher);
  } catch {
    // Ended between the listing and the connect: as good as not running.
    return json({ running: false });
  }
  try {
    const page = await attachPage(cdp);
    if (action !== null) await applyAction(page, action);
    const frame = await captureFrame(page);
    // The action's kind and timing only: never a coordinate, a key's text, a word typed or the page.
    console.log(JSON.stringify({ event: "site_shots_view", action: action?.kind ?? "frame", ms: Date.now() - started }));
    return json(frame);
  } catch {
    return json({ error: "the browser could not do that" }, 502);
  } finally {
    cdp.close();
  }
}
