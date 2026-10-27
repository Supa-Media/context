/**
 * The page box refuses to draw outside its sandbox.
 *
 * `box.js` runs whatever HTML its parent hands it, scripts and all, and it
 * cannot check who that parent is: the runtime frames it with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, so the legitimate
 * parent is reached across an opaque origin, which has no origin to compare.
 * That is safe only while the box itself is opaque too — nothing it runs can
 * then read a cookie, a store, or anything else of the site the file came
 * from.
 *
 * `securityHeaders.ts` serves this one file without a framing header, because
 * `X-Frame-Options` and `frame-ancestors` can never match an opaque ancestor
 * and would blank every box. So any page anywhere may frame it, and one that
 * leaves the sandbox off gets a real document of the serving site talking to
 * a parent the box still cannot check. The box has to refuse that itself.
 *
 * A fresh jsdom per case, because the box defines `window.page` once and for
 * all, and because the origin is a property of the window it is given.
 *
 * Sabotage: drop the `SEALED` guard from `box.js` and "a box framed with a
 * real origin runs nothing it is handed" fails on both counts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const BOX = readFileSync(path.join(__dirname, "..", "page-frame", "box.js"), "utf8");

const HTML = '<p id="drawn">hello</p><script>window.__boxScriptRan = true;<\/script>';

type Run = { ran: boolean; drawn: boolean; posted: { type?: string }[] };

/** Run the real `box.js` in a document served from `origin`, then hand it one box message. */
function runBox(origin: string): Run {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", url: "https://context.lc/drawing-assets/page/box.html" });
  const { window } = dom;
  // An opaque origin serializes as "null"; a frame left out of the sandbox has a real one.
  Object.defineProperty(window, "origin", { value: origin, configurable: true, writable: true });
  const posted: { type?: string }[] = [];
  Object.defineProperty(window, "parent", { value: window, configurable: true, writable: true });
  window.postMessage = ((message: { type?: string }) => {
    posted.push(message);
  }) as typeof window.postMessage;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  window.eval(BOX);
  window.dispatchEvent(new window.MessageEvent("message", { data: { channel: "context-page-box", type: "box", page: {}, html: HTML }, source: window }));
  const ran = (window as unknown as { __boxScriptRan?: boolean }).__boxScriptRan === true;
  const drawn = window.document.getElementById("drawn") !== null;
  dom.window.close();
  return { ran, drawn, posted };
}

test("a box framed with a real origin runs nothing it is handed", () => {
  const { ran, drawn, posted } = runBox("https://context.lc");
  expect(ran).toBe(false);
  expect(drawn).toBe(false);
  expect(posted).toEqual([]);
});

test("a box in its sandbox, where the origin is opaque, draws and runs as before", () => {
  const { ran, drawn, posted } = runBox("null");
  expect(ran).toBe(true);
  expect(drawn).toBe(true);
  expect(posted.some((message) => message?.type === "ready")).toBe(true);
});
