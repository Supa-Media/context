/**
 * The Tex page's socket to the gateway (`GET /tex/page/live`), modelled on the
 * file tree's (`features/console/files/fileBrowser/objectTree.ts`).
 *
 * The console grant rides as a subprotocol beside `context.tex-page`, never in
 * the URL. On open the page says which chat it shows; the gateway pushes a
 * patch whenever anything on it changes, someone else's edit in a group
 * included. Closed to be authorized again (4001): reconnect at once, the
 * grant re-checked at join, which is how a person taken out of a group stops seeing it.
 * Refused (4403/4404): the page re-reads on a timer instead and asks the socket
 * again after a while. Anything else: reconnect after a growing wait.
 */

export const TEX_PAGE_PROTOCOL = "context.tex-page";
export const TEX_PAGE_SOCKET_PATH = "/tex/page/live";
export const TEX_PAGE_CLOSE_REAUTH = 4001;
export const TEX_PAGE_CLOSE_REFUSED = new Set([4403, 4404]);
export const REFUSED_RETRY_MS = 5 * 60_000;
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export interface PatchFrame {
  section: string;
  value?: unknown;
}

export function liveSocketUrl(gatewayOrigin: string): string {
  const url = new URL(TEX_PAGE_SOCKET_PATH, gatewayOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function liveProtocols(token: string): string[] {
  return [TEX_PAGE_PROTOCOL, `context.token.${token}`];
}

export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, failures));
}

/** A server frame, or null for anything that is not a patch. */
export function readPatch(data: unknown): PatchFrame | null {
  if (typeof data !== "string" || data.length > 1_000_000) return null;
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.t !== "patch" || typeof f.section !== "string") return null;
  return "value" in f ? { section: f.section, value: f.value } : { section: f.section };
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface LiveOptions {
  gatewayOrigin: string;
  handle: string;
  chat: string;
  token: (refresh: boolean) => Promise<string>;
  onPatch: (patch: PatchFrame) => void;
  /** Whether the socket is up: when it is not, the page re-reads on a timer. */
  onLive: (live: boolean) => void;
  open?: (url: string, protocols: string[]) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Live {
  /** Switch the chat the socket follows. */
  watch(chat: string): void;
  close(): void;
}

const OPEN = 1;

export function openLive(options: LiveOptions): Live {
  const open = options.open ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as SocketLike);
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let chat = options.chat;
  let socket: SocketLike | null = null;
  let stopped = false;
  let failures = 0;
  let refresh = false;
  let retry: unknown = null;
  let ping: unknown = null;
  const watchFrame = () => JSON.stringify({ t: "watch", handle: options.handle, chat });

  const clear = () => {
    if (retry !== null) clearTimer(retry);
    if (ping !== null) clearTimer(ping);
    retry = null;
    ping = null;
  };
  const later = (ms: number) => {
    clear();
    if (!stopped) retry = setTimer(() => void connect(), ms);
  };
  const keepAlive = () => {
    ping = setTimer(() => {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify({ t: "ping" }));
      keepAlive();
    }, PING_MS);
  };

  const connect = async () => {
    if (stopped) return;
    let token: string;
    try {
      token = await options.token(refresh);
    } catch {
      failures += 1;
      options.onLive(false);
      return later(failures >= 3 ? REFUSED_RETRY_MS : backoffMs(failures - 1));
    }
    refresh = false;
    if (stopped) return;
    let opened = false;
    const live = open(liveSocketUrl(options.gatewayOrigin), liveProtocols(token));
    socket = live;
    live.onopen = () => {
      opened = true;
      failures = 0;
      live.send(watchFrame());
      options.onLive(true);
      keepAlive();
    };
    live.onmessage = (event) => {
      const patch = readPatch(event.data);
      if (patch !== null) options.onPatch(patch);
    };
    live.onerror = () => {};
    live.onclose = (event) => {
      if (socket === live) socket = null;
      clear();
      if (stopped) return;
      options.onLive(false);
      if (event.code === TEX_PAGE_CLOSE_REAUTH) return later(0);
      if (TEX_PAGE_CLOSE_REFUSED.has(event.code)) return later(REFUSED_RETRY_MS);
      failures += 1;
      if (!opened) {
        refresh = failures === 1;
        if (failures >= 3) return later(REFUSED_RETRY_MS);
      }
      later(backoffMs(failures - 1));
    };
  };

  void connect();
  return {
    watch(next) {
      chat = next;
      if (socket?.readyState === OPEN) socket.send(watchFrame());
    },
    close() {
      stopped = true;
      clear();
      const live = socket;
      socket = null;
      try {
        live?.close(1000, "done");
      } catch {
        // Already closing.
      }
    },
  };
}
