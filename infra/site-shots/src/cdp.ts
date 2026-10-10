/**
 * Just enough of the Chrome DevTools Protocol to drive a page we did not
 * launch: Browserbase's (./browserbase.ts). `@cloudflare/puppeteer` only
 * connects to Cloudflare's own browsers, so this speaks CDP over a Worker
 * WebSocket and presents the same `BrowsePage` that ./browse.ts drives, which
 * keeps every rule there (the host check before typing, readings without
 * field values) the same whichever browser is behind it.
 */

import type { BrowsePage } from "./browse";

/** One CDP connection: send a method, get its result. */
export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  close(): void;
}

const CALL_TIMEOUT_MS = 12_000;

/** Open a CDP WebSocket from a Worker. `wss:` is fetched as `https:` with an Upgrade. */
export async function connectCdp(wsUrl: string, fetcher: typeof fetch = fetch): Promise<CdpTransport> {
  const response = await fetcher(wsUrl.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
  const socket = (response as Response & { webSocket?: WebSocket | null }).webSocket;
  if (!socket) throw new Error("the browser would not connect");
  socket.accept();
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    // The protocol's own error text can quote the page; it stays here.
    if (message.error) waiting.reject(new Error("cdp error"));
    else waiting.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiting of pending.values()) waiting.reject(new Error("closed"));
    pending.clear();
  });
  return {
    send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("timed out"));
        }, CALL_TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

const KEY_CODES: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attach to the browser's first page and drive it as a `BrowsePage`. */
export async function cdpPage(cdp: CdpTransport): Promise<BrowsePage> {
  const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
  let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
  if (!targetId) targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T>(method: string, params?: Record<string, unknown>) => cdp.send<T>(method, params, sessionId);

  async function evaluate<T>(source: string): Promise<T> {
    const result = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("the page threw");
    return result.result?.value as T;
  }

  async function settle(timeout: number): Promise<void> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const state = await evaluate<string>("document.readyState").catch(() => "loading");
      if (state === "complete") break;
      await sleep(200);
    }
    await sleep(300);
  }

  async function focus(selector: string): Promise<void> {
    const found = await evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.focus();
      return true;
    })()`);
    if (!found) throw new Error("no such element");
  }

  const page: BrowsePage = {
    async goto(url, { timeout }) {
      await send("Page.navigate", { url });
      await settle(timeout);
    },
    evaluate,
    async click(selector) {
      const box = await evaluate<{ x: number; y: number } | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box) throw new Error("no such element");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
    },
    async type(selector, text) {
      await focus(selector);
      await send("Input.insertText", { text });
    },
    async select() {
      throw new Error("select runs in the page");
    },
    async goBack({ timeout }) {
      await evaluate("history.back()");
      await settle(timeout);
    },
    keyboard: {
      async press(key) {
        const code = KEY_CODES[key];
        if (code === undefined) throw new Error("no such key");
        const text = key === "Enter" ? "\r" : undefined;
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
      },
    },
    async waitForNetworkIdle({ timeout }) {
      await settle(timeout);
    },
  };
  return page;
}
