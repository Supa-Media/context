/**
 * Embedded frames (./frames.ts, ./cdpFrames.ts): Google's admin console shows
 * an invoice's download menu in a payments.google.com frame, which Tex saw in
 * a picture and could not press (the owner, 2026-10-22).
 *
 * Sabotage record (2026-10-22): `where(page)` in place of `where(doc)` for
 * `fill` failed "never fills a login into another site's frame"; dropping the
 * click's `began` comparison failed "asks for nothing when no download began".
 */

import { describe, expect, it } from "vitest";
import { SNAPSHOT_SOURCE, runSteps, type BrowsePage } from "./browse";
import { frameLister } from "./cdpFrames";
import type { CdpTransport } from "./cdp";
import type { Downloads } from "./download";
import type { FrameDoc } from "./frames";

const PDF = btoa("%PDF-1.4 invoice");

/** The admin page, with one frame from payments.google.com holding the invoice menu. */
function adminPage({ frameHost = "payments.google.com" } = {}) {
  const state = { topClicks: [] as string[], frameClicks: [] as string[], frameTyped: [] as string[], points: [] as Array<[number, number]>, wheels: [] as number[][], hidden: [] as string[], frameFiles: [] as string[] };
  const frame: FrameDoc = {
    host: frameHost,
    async evaluate<T>(source: string) {
      if (source.includes("const ref = 1000 + elements.length + 1")) {
        return {
          text: "5709637891 (.pdf)\n5709637891 (.csv)",
          elements: [
            { ref: 1001, kind: "menuitem", label: "5709637891 (.pdf)" },
            { ref: 1002, kind: "input password", label: "Password", filled: false },
          ],
        } as T;
      }
      if (source.includes("location.hostname")) return { href: `https://${frameHost}/menu`, host: frameHost, origin: `https://${frameHost}` } as T;
      if (/^!!document\.querySelector\('\[data-tex-ref="100[12]"\]'\)$/.test(source)) return true as T;
      if (source.includes("data-tex-words") && source.includes("5709637891 (.pdf)")) return true as T;
      if (source.includes("context-hide-cards")) state.hidden.push(frameHost);
      if (source.includes('el.tagName !== "INPUT"')) return "input" as T;
      if (source.includes("box.files[0].size")) return 16 as T;
      return undefined as T;
    },
    async setFiles(selector, paths) {
      state.frameFiles.push(`${selector} ${paths.join(",")}`);
      return true;
    },
    async click(selector) {
      state.frameClicks.push(selector);
    },
    async type(_selector, text) {
      state.frameTyped.push(text);
    },
  };
  const page: BrowsePage = {
    async goto() {},
    async evaluate<T>(source: string) {
      if (source === SNAPSHOT_SOURCE) {
        return { url: "https://admin.google.com/billing", title: "Billing", text: "Payment accounts\nSeptember $25.26", elements: [{ ref: 1, kind: "button", label: "Download" }] } as T;
      }
      if (source.includes("location.hostname")) return { href: "https://admin.google.com/billing", host: "admin.google.com", origin: "https://admin.google.com" } as T;
      if (source.includes("devicePixelRatio")) return { ratio: 2, width: 640, height: 430 } as T;
      if (/^!!document\.querySelector/.test(source)) return (source.includes('"1"') as unknown) as T;
      if (source.includes("data-tex-words")) return false as T;
      if (source.startsWith("new Promise((done)")) return "none" as T;
      return undefined as T;
    },
    async click(selector) {
      state.topClicks.push(selector);
    },
    async type() {},
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    mouse: {
      async click(x, y) {
        state.points.push([x, y]);
      },
      async wheel(x, y, deltaY) {
        state.wheels.push([x, y, deltaY]);
      },
    },
    async screenshot() {
      return "";
    },
    async waitForNetworkIdle() {},
    async frames() {
      return [frame];
    },
  };
  return { page, state };
}

describe("a page's embedded frames", () => {
  it("are read after the page, numbered from their own thousand, under their site's name", async () => {
    const { page } = adminPage();
    const result = await runSteps(page, [{ do: "read" }]);
    expect(result.page.elements.map((e) => e.ref)).toEqual([1, 1001, 1002]);
    expect(result.page.text).toContain("In a frame from payments.google.com:\n5709637891 (.pdf)");
  });

  it("are pressed by number and by words, in the frame and not on the page", async () => {
    const { page, state } = adminPage();
    expect((await runSteps(page, [{ do: "click", ref: 1001 }])).ran).toEqual([{ do: "click", ok: true }]);
    expect((await runSteps(page, [{ do: "click", text: "5709637891 (.pdf)" }])).ran).toEqual([{ do: "click", ok: true }]);
    expect(state.frameClicks).toEqual(['[data-tex-ref="1001"]', "[data-tex-words]"]);
    expect(state.topClicks).toEqual([]);
  });

  it("never fills a login into another site's frame, whatever site the page is", async () => {
    const { page, state } = adminPage();
    const result = await runSteps(page, [{ do: "fill", ref: 1002, value: "hunter2", origin: "https://admin.google.com", field: "password" }]);
    expect(result.ran).toEqual([{ do: "fill", ok: false, reason: "origin mismatch" }]);
    expect(state.frameTyped).toEqual([]);
    // The frame's own site is the one it fills for.
    const theirs = await runSteps(page, [{ do: "fill", ref: 1002, value: "hunter2", origin: "https://payments.google.com", field: "password" }]);
    expect(theirs.ran).toEqual([{ do: "fill", ok: true }]);
  });

  it("types only where the frame's own site is one the person named", async () => {
    const { page, state } = adminPage();
    const result = await runSteps(page, [{ do: "type", ref: 1002, text: "hello", enter: false, onlyOn: ["admin.google.com"] }]);
    expect(result.ran[0]).toMatchObject({ ok: false, reason: "this page is not on a site the person named" });
    expect(state.frameTyped).toEqual([]);
  });

  it("blank a card's boxes in a frame before a look", async () => {
    const { page, state } = adminPage({ frameHost: "js.stripe.com" });
    await runSteps(page, [{ do: "look" }]);
    expect(state.hidden).toEqual(["js.stripe.com"]);
  });

  it("scroll under the point named, or the middle of the screen", async () => {
    const { page, state } = adminPage();
    await runSteps(page, [{ do: "scroll", direction: "down", x: null, y: null }, { do: "scroll", direction: "up", x: 400, y: 600 }]);
    expect(state.wheels).toEqual([[320, 215, 344], [200, 300, -344]]);
  });
});

describe("an upload into a frame", () => {
  const file = { name: "invoice.pdf", type: "application/pdf", data: PDF };
  const uploads = { stage: async (f: { name: string }) => `/tmp/.uploads/${f.name}`, said() {} };

  it("has the browser set the file in the frame that holds the box", async () => {
    const { page, state } = adminPage();
    const result = await runSteps(page, [{ do: "upload", ref: 1001, file, onlyOn: ["payments.google.com"] }], { uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.frameFiles).toHaveLength(1);
    expect(state.frameFiles[0]).toMatch(/^\[data-tex-file-box="[a-f0-9]{32}"\] \/tmp\/\.uploads\/invoice\.pdf$/);
  });

  it("checks the frame's own site, not the page's", async () => {
    const { page, state } = adminPage();
    const result = await runSteps(page, [{ do: "upload", ref: 1001, file, onlyOn: ["admin.google.com"] }], { uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: false, reason: "this page is not on a site the person named" }]);
    expect(state.frameFiles).toEqual([]);
  });
});

describe("a click that starts a download", () => {
  it("hands the file back, and the steps after it wait for the next call", async () => {
    const { page } = adminPage();
    let begun = 0;
    const asked: number[] = [];
    const downloads: Downloads = {
      began: () => begun,
      async take(since) {
        asked.push(since);
        return { name: "5709637891.pdf", type: "application/pdf", size: 16, data: PDF };
      },
    };
    const clicking = { ...page, mouse: { ...page.mouse, async click() { begun += 1; } } };
    const result = await runSteps(clicking, [{ do: "click", x: 300, y: 200 }, { do: "scroll", direction: "down", x: null, y: null }], { downloads });
    expect(result.file).toMatchObject({ name: "5709637891.pdf", data: PDF });
    expect(result.ran).toEqual([{ do: "click", ok: true, reason: "that saved a file, handed back with this reading" }]);
    expect(asked).toHaveLength(1);
  });

  it("asks for nothing when no download began", async () => {
    const { page } = adminPage();
    let asked = 0;
    const downloads: Downloads = { began: () => 0, async take() { asked += 1; return null; } };
    const result = await runSteps(page, [{ do: "click", x: 300, y: 200 }], { downloads });
    expect(result.file).toBeUndefined();
    expect(asked).toBe(0);
  });
});

describe("Browserbase's frames over CDP", () => {
  /** A page at admin.google.com with payments.google.com in an iframe at (100, 50), and a same-site frame of no size. */
  function browser() {
    const listeners: Record<string, Array<(params: unknown, sessionId?: string) => void>> = {};
    const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const cdp: CdpTransport = {
      on(method, listener) {
        (listeners[method] ??= []).push(listener);
      },
      async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
        sent.push({ method, params, sessionId });
        const answer = (value: unknown) => value as T;
        if (method === "Page.getFrameTree") {
          if (sessionId === "pay-session") return answer({ frameTree: { frame: { id: "PAY" } } });
          return answer({ frameTree: { frame: { id: "TOP" }, childFrames: [{ frame: { id: "PAY" } }, { frame: { id: "TINY" } }] } });
        }
        if (method === "Page.createIsolatedWorld") return answer(params.frameId === "TINY" ? { executionContextId: 7 } : {});
        if (method === "DOM.getFrameOwner") {
          if (sessionId !== undefined) throw new Error("not here");
          return answer({ backendNodeId: params.frameId === "PAY" ? 11 : 12 });
        }
        if (method === "DOM.getBoxModel") {
          return answer(params.backendNodeId === 11 ? { model: { content: [100, 50, 500, 50, 500, 350, 100, 350], width: 400, height: 300 } } : { model: { content: [0, 0], width: 0, height: 0 } });
        }
        if (method === "Runtime.evaluate") {
          const expr = String(params.expression);
          if (expr.includes("location.protocol")) return answer({ result: { value: sessionId === "pay-session" ? "payments.google.com" : "admin.google.com" } });
          if (expr.includes("getBoundingClientRect")) return answer({ result: { value: { x: 20, y: 30 } } });
          return answer({ result: { value: true } });
        }
        return answer({});
      },
      close() {},
    };
    const topSend = <T>(method: string, params?: Record<string, unknown>) => {
      if (method === "Target.setAutoAttach") {
        for (const fn of listeners["Target.attachedToTarget"] ?? []) fn({ sessionId: "pay-session", targetInfo: { targetId: "PAY", type: "iframe" } });
      }
      return cdp.send<T>(method, params);
    };
    return { cdp, topSend, sent };
  }

  it("lists another site's frame on its own session, leaves out one with no size, and presses where it shows", async () => {
    const { cdp, topSend, sent } = browser();
    const points: Array<[number, number]> = [];
    const frames = await frameLister(cdp, topSend, async (x, y) => {
      points.push([x, y]);
    })();
    expect(frames.map((f) => f.host)).toEqual(["payments.google.com"]);
    await frames[0]!.click('[data-tex-ref="1001"]');
    // The iframe's box at (100, 50) plus the element's middle at (20, 30) inside it.
    expect(points).toEqual([[120, 80]]);
    // Its reading ran in the frame's own session, never the page's.
    expect(sent.some((s) => s.method === "Runtime.evaluate" && s.sessionId === "pay-session")).toBe(true);
  });
});
