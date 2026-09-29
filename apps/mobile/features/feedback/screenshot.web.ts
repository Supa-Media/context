import { FEEDBACK_LIMITS } from "@context/shared";
import { base64ToBytes } from "./model";
import type { Screenshot } from "./screenshot";

export type { Screenshot } from "./screenshot";

/**
 * The screenshot a feedback report carries, on the web.
 *
 * html2canvas draws a *copy* of the page, and the copy is what gets changed:
 * the live page the person is looking at is never touched. By default every
 * word in the copy is covered with a bar the same size, and every picture is
 * hidden, the way PostHog's recordings already mask the page — so a report
 * shows the layout of the problem without a note's text, title or a face in
 * it. Only "Show text" on the report screen draws the words, and only for the
 * picture it then shows the person before they send.
 *
 * Anything marked `data-feedback-exclude` — the report dialog itself — is
 * removed from the copy, since the capture can finish after it has opened.
 */

export const screenshotSupported = typeof document !== "undefined";

const MAX_WIDTH = 1600;

/** Hide pictures and field contents; covered text is done node by node below. */
const MASK_CSS = [
  "img, video, canvas, iframe, picture, svg image { visibility: hidden !important; }",
  "[style*='background-image'] { background-image: none !important; }",
  "input, textarea, [contenteditable] { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }",
  "::placeholder { color: transparent !important; }",
].join("\n");

const COVER_STYLE =
  "color: transparent !important; -webkit-text-fill-color: transparent !important;" +
  " background: rgba(128, 122, 114, 0.42) !important; border-radius: 2px;";

/**
 * Prepare html2canvas's copy of the page. Exported for the test that proves no
 * word survives, which is the whole promise of "words hidden".
 */
export function prepareCopy(doc: Document, { showText }: { showText: boolean }): void {
  for (const node of Array.from(doc.querySelectorAll("[data-feedback-exclude]"))) node.remove();
  if (showText) return;

  const style = doc.createElement("style");
  style.textContent = MASK_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);

  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || parent.tagName === "STYLE" || parent.tagName === "SCRIPT") continue;
    if ((node.nodeValue ?? "").trim() !== "") texts.push(node as Text);
  }
  for (const text of texts) {
    const cover = doc.createElement("span");
    cover.setAttribute("style", COVER_STYLE);
    // The letters become dots of the same count, so the bar keeps the word's
    // width and no character of it reaches the canvas, even if a style rule
    // somewhere outranks the transparent colour.
    cover.textContent = (text.nodeValue ?? "").replace(/\S/g, "•");
    text.replaceWith(cover);
  }
}

export async function captureScreen({ showText }: { showText: boolean }): Promise<Screenshot | null> {
  if (!screenshotSupported) return null;
  try {
    const { default: html2canvas } = await import("html2canvas");
    const width = window.innerWidth;
    const height = window.innerHeight;
    const canvas = await html2canvas(document.body, {
      scale: Math.min(1, MAX_WIDTH / Math.max(width, 1)),
      logging: false,
      useCORS: false,
      x: window.scrollX,
      y: window.scrollY,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      onclone: (copy) => prepareCopy(copy, { showText }),
    });
    // The server takes a picture of at most FEEDBACK_LIMITS.screenshotBytes;
    // a busy screen is tried at lower quality before it goes without one.
    for (const quality of [0.8, 0.6, 0.4]) {
      const previewUri = canvas.toDataURL("image/jpeg", quality);
      const data = base64ToBytes(previewUri.slice(previewUri.indexOf(",") + 1));
      if (data.byteLength > FEEDBACK_LIMITS.screenshotBytes) continue;
      return {
        data,
        contentType: "image/jpeg",
        previewUri,
        width: canvas.width,
        height: canvas.height,
      };
    }
    return null;
  } catch {
    // No picture is an honest outcome: the report screen leaves the row out.
    return null;
  }
}
