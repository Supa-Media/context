/**
 * The page viewer: what `/p/@slug/<path>.page.md` opens.
 *
 * A page link Tex texts used to open the whole app: its bundle, its sign-in
 * check, the console and the file tree, before the page itself was asked for
 * (owner, 2026-11-10: "it's supposed to open up seamlessly, right now it
 * doesn't"). This is a page of its own, a few kilobytes, that asks for the
 * note at once and draws it in the same sealed runtime the app uses.
 *
 * It holds no session of its own. It reads with the sign-in this browser
 * already keeps for context.lc (the app's own stored token, refreshed the way
 * the app refreshes it, under the same lock), through the same control-plane
 * calls the app makes, so it can open only what the app would. Whatever it
 * cannot do (no sign-in here, a note it may not read, an encrypted note, an
 * edit, a vote) it hands to the app's `/note/…` link, which is where the link
 * went before; it is never worse than that.
 *
 * Read only: the frame is told nothing is editable, and the one control is
 * "Open in Context".
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page link opens the page".
 */

import { PAGE_CHANNEL, dialUrl, pageFrameUrls, readPageMessage } from "../features/console/files/pageView/pageWire";
import { webUrl } from "../features/console/files/webUrl";
import { appLinkFor, authKeys, pageAddressFrom, pageTitle, pictureDataUrl, tokenLasts } from "./viewerCore";

declare const VIEWER_CONVEX_URL: string;

/** How long a stored token must still have before it is used rather than refreshed, as the app's own rule. */
const TOKEN_MARGIN_MS = 60_000;
/** How long the sites-domain copy of the runtime has before the deployment's own copy is used. */
const READY_TIMEOUT_MS = 6_000;
/** The lock the app's sign-in refreshes under, so this tab and an open app never rotate the token at once. */
const REFRESH_LOCK = "__convexAuthRefreshToken";

const address = pageAddressFrom(window.location.pathname);
const appLink = appLinkFor(address);

function leave(): void {
  window.location.replace(appLink);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type CallKind = "query" | "action";

async function call(kind: CallKind, path: string, args: Record<string, unknown>, token: string | null): Promise<unknown> {
  const response = await fetch(`${VIEWER_CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const body = (await response.json()) as { status?: string; value?: unknown };
  if (body.status !== "success") throw new Error(`${path}: ${body.status ?? "no status"}`);
  return body.value;
}

/** This browser's sign-in for the app, refreshed if it is about to run out, or null. */
async function signedInToken(): Promise<string | null> {
  const store = storage();
  if (store === null || typeof VIEWER_CONVEX_URL !== "string" || !/^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)[:/])/.test(VIEWER_CONVEX_URL)) return null;
  const keys = authKeys(VIEWER_CONVEX_URL);
  const stored = store.getItem(keys.jwt);
  if (tokenLasts(stored, TOKEN_MARGIN_MS)) return stored;
  const refresh = async (): Promise<string | null> => {
    // Another tab may have refreshed while this one waited for the lock.
    const now = store.getItem(keys.jwt);
    if (tokenLasts(now, TOKEN_MARGIN_MS)) return now;
    const refreshToken = store.getItem(keys.refresh);
    if (refreshToken === null) return null;
    const result = (await call("action", "auth:signIn", { refreshToken }, null)) as { tokens?: { token?: unknown; refreshToken?: unknown } | null };
    const token = result?.tokens?.token;
    const next = result?.tokens?.refreshToken;
    if (typeof token !== "string" || typeof next !== "string") return null;
    // Stored at once, as the app stores them: the old refresh token is spent.
    store.setItem(keys.jwt, token);
    store.setItem(keys.refresh, next);
    return token;
  };
  const locks = (navigator as Navigator & { locks?: { request: <T>(name: string, run: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? await locks.request(REFRESH_LOCK, refresh) : await refresh();
}

function showError(): void {
  const status = document.getElementById("status");
  if (status) status.textContent = "Opening in Context…";
}

async function open(): Promise<void> {
  if (address === null) return leave();
  const opener = document.getElementById("open") as HTMLAnchorElement | null;
  if (opener) opener.href = appLink;
  const token = await signedInToken();
  if (token === null) return leave();
  const workspace = (await call("query", "functions/names:resolveMyName", { name: address.slug }, token)) as { workspaceId?: unknown } | null;
  const workspaceId = typeof workspace?.workspaceId === "string" ? workspace.workspaceId : null;
  if (workspaceId === null) return leave();
  const file = (await call("action", "functions/files:readNote", { workspaceId, path: address.path }, token)) as { text?: unknown; encrypted?: unknown } | null;
  if (typeof file?.text !== "string" || file.encrypted === true) return leave();
  draw(file.text, { token, workspaceId, notePath: address.path });
}

type Reader = { token: string; workspaceId: string; notePath: string };

function draw(source: string, reader: Reader): void {
  if (address === null) return;
  document.title = pageTitle(source, address.path);
  const urls = pageFrameUrls({ hostname: window.location.hostname, origin: window.location.origin }, address.slug);
  const holder = document.getElementById("page");
  if (holder === null) return;
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
  let which = 0;
  let ready = false;
  const frame = document.createElement("iframe");
  // Scripts, and nothing else: never same-origin, forms, popups or top navigation.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Page";
  frame.className = "frame";
  const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ channel: PAGE_CHANNEL, ...message }, "*");
  const render = () => {
    if (!ready) return;
    post({ type: "render", source, dark: dark?.matches === true, editable: false, canComment: false, me: null, inset: 0 });
  };
  const load = () => {
    ready = false;
    frame.src = urls[which];
    if (which < urls.length - 1) {
      const at = which;
      setTimeout(() => {
        if (!ready && which === at) {
          which += 1;
          load();
        }
      }, READY_TIMEOUT_MS);
    }
  };
  dark?.addEventListener?.("change", render);
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = readPageMessage(event.data);
    if (message === null) return;
    switch (message.type) {
      case "ready":
        ready = true;
        document.body.classList.add("drawn");
        render();
        return;
      case "height":
        frame.style.height = `${Math.max(120, message.height)}px`;
        return;
      case "open":
        if (webUrl(message.href) === message.href) window.open(message.href, "_blank", "noopener,noreferrer");
        else if (dialUrl(message.href) === message.href) window.location.assign(message.href);
        return;
      case "image": {
        const read = /^https?:\/\//i.test(message.src)
          ? call("action", "functions/files:readRemoteImage", { workspaceId: reader.workspaceId, notePath: reader.notePath, url: message.src }, reader.token)
          : call("action", "functions/files:readNoteImage", { workspaceId: reader.workspaceId, notePath: reader.notePath, leaf: message.src }, reader.token);
        void read.then(
          (value) => post({ type: "image", src: message.src, data: pictureDataUrl(value) }),
          () => post({ type: "image", src: message.src, data: null }),
        );
        return;
      }
      default:
        // A link to another note, a vote, a pick: the app does those, with its checks.
        leave();
    }
  });
  holder.appendChild(frame);
  load();
}

open().catch(() => {
  showError();
  leave();
});
