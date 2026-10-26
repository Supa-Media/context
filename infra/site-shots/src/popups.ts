/**
 * A popup in the way: a dialog, a seat map, a cookie wall or a sign-up offer
 * drawn over the page (the owner's review, 2026-10-26). On a bus booking
 * site a "Seats Selection" map opened in a same-site frame after the first
 * leg was picked. A click is the mouse at a point (`./cdp.ts`), so every
 * press on the return leg landed on the popup's cover and did nothing, and
 * typing went where the dialog kept the focus, not into the passenger boxes.
 * Escape did not close it, and Tex handed the person its browser.
 *
 * So a reading says when something covers the page, a `close_popup` step
 * presses the popup's own close (or skip, or "no thanks"), and when it has
 * none hides it, and a click on an element something covers presses that
 * element directly. Run as strings, for the reason `MEASURE_SOURCE` gives.
 */

import type { BrowsePage, StepResult } from "./browse";
import { framesOf, type Doc } from "./frames";

/** Said for a click on an element a popup's cover sat over. */
export const COVERED_PRESS = "something covered it (a popup?), so it was pressed from inside the page; read to check it took, and close_popup if the popup is in the way";
/** Said for words that had to be put into a box directly. */
export const SET_DIRECTLY = "the box didn't take the keys (a popup may hold the focus), so the words were put in directly";

/**
 * `layerAt(x, y)`: the outermost box drawn over the page at that point that
 * looks like a popup (a dialog by its role or name, or a pinned frame), and
 * covers a good part of the screen; null when the page itself is there.
 */
const LAYER_FUNCS = `
  const marked = (n) => /(^|[-_ ])(modal|popup|pop-up|dialog|lightbox|fancybox|colorbox|overlay|backdrop|seatmap|seat-map)([-_ ]|$)/i.test(String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || "") + " " + (n.id || ""));
  const dialogish = (n) => n.getAttribute("role") === "dialog" || n.getAttribute("role") === "alertdialog" || n.getAttribute("aria-modal") === "true" || (n.tagName === "DIALOG" && n.open) || marked(n) || n.tagName === "IFRAME";
  const pinned = (n) => {
    const s = getComputedStyle(n);
    if (s.display === "none" || s.visibility === "hidden") return false;
    return s.position === "fixed" || (s.position === "absolute" && Number(s.zIndex) >= 100) || (n.tagName === "DIALOG" && n.open);
  };
  const big = (n) => {
    const r = n.getBoundingClientRect();
    return r.width * r.height >= innerWidth * innerHeight * 0.2;
  };
  const layerAt = (x, y) => {
    let found = null;
    for (let n = document.elementFromPoint(x, y); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (pinned(n) && dialogish(n) && big(n)) found = n;
    }
    return found;
  };`;

/** Whether something like a popup covers the middle of the page. */
export const POPUP_PROBE = `(() => {${LAYER_FUNCS}
  return !!layerAt(innerWidth / 2, innerHeight / 2);
})()`;

/** The words on a popup's way out: a close mark, close, skip, no thanks. */
const CLOSE_WORDS = String.raw`^(?:×|✕|✖|╳|x|close|close (?:this|window|dialog|popup|pop-up|map)|dismiss|skip|skip (?:this|it|for now|seat selection|seats?)|no,? thanks|no thank you|not now|maybe later|continue without (?:\w+ ?){1,3})$`;

/**
 * Press the visible close of a popup, and answer "pressed", or "none". In
 * the top page the close must sit inside something drawn over it; in a frame
 * (the popup's own document) any close or skip will do, and never "cancel",
 * which in a payment frame is not a popup's.
 */
export function closePopupSource(inFrame: boolean): string {
  return `(() => {${LAYER_FUNCS}
  const words = new RegExp(${JSON.stringify(CLOSE_WORDS)}, "i");
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const said = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.value || "").replace(/\\s+/g, " ").trim();
  const closeClass = (el) => /(^|[-_ ])close([-_ ]|$)|(^|[-_ ])(btn-close|dialog-titlebar-close|fancybox-close|mfp-close)/i.test(String(el.className || "") + " " + (el.id || ""));
  const inLayer = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (pinned(n) && dialogish(n)) return true;
    return false;
  };
  const candidates = document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit], [aria-label], [title], [class*=close], [id*=close]");
  for (const el of candidates) {
    if (!visible(el) || el.disabled) continue;
    const text = said(el);
    if (text.length > 40) continue;
    if (!words.test(text) && !(closeClass(el) && text.length <= 12)) continue;
    if (!${inFrame} && !inLayer(el)) continue;
    el.click();
    return "pressed";
  }
  return "none";
})()`;
}

/**
 * Hide what covers the page when it has no close of its own: each popup
 * layer over the middle of the screen, and the dimmed cover behind it, then
 * let the page scroll again. Answers "hid" or "none".
 */
export const HIDE_POPUP_SOURCE = `(() => {${LAYER_FUNCS}
  let hid = 0;
  for (let i = 0; i < 4; i++) {
    const layer = layerAt(innerWidth / 2, innerHeight / 2);
    if (!layer) break;
    layer.style.setProperty("display", "none", "important");
    hid += 1;
  }
  // A cover that dims the whole page (it has nothing to read on it) goes too.
  for (const n of document.querySelectorAll("body *")) {
    if (!pinned(n) || !marked(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && (n.innerText || "").trim().length < 20) {
      n.style.setProperty("display", "none", "important");
      hid += 1;
    }
  }
  if (hid > 0) {
    for (const n of [document.documentElement, document.body]) if (n) n.style.setProperty("overflow", "auto", "important");
  }
  return hid > 0 ? "hid" : "none";
})()`;

/**
 * Whether something else is drawn over the element's middle, once it is
 * scrolled into view: a popup's cover, which a press at that point would hit
 * instead. Its own text, its label and what it sits in do not count.
 */
export function coveredSource(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
  if (hit.tagName === "LABEL" && (hit.control === el || hit.htmlFor === el.id)) return false;
  return true;
})()`;
}

/** Press the element from inside the page, as its own click would: what a cover over it cannot catch. */
export function domClickSource(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  if (typeof el.focus === "function") el.focus();
  el.click();
  return true;
})()`;
}

/** How many characters a box holds now, or -1 when it is not a box. Never the characters themselves. */
export function heldLengthSource(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return -1;
  if (el.isContentEditable) return (el.innerText || "").length;
  return typeof el.value === "string" ? el.value.length : -1;
})()`;
}

/**
 * Put words into a box from inside the page, the way a framework's own
 * input would see them: the native setter, then input and change. For a box
 * whose keys went elsewhere (a popup holding the focus).
 */
export function setValueSource(selector: string, text: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const value = ${JSON.stringify(text)};
  if (el.isContentEditable) { el.innerText = value; el.dispatchEvent(new Event("input", { bubbles: true })); return true; }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value");
  if (set && set.set) set.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur"));
  return true;
})()`;
}

/**
 * After typing: whether the box ended up empty, and the words had to be put
 * in from inside the page. A dialog that keeps the focus took the passenger
 * boxes' keys on 2026-10-26. Only a length is read back.
 */
export async function typedOrSet(doc: Doc, selector: string, text: string): Promise<boolean> {
  if (text.length === 0) return false;
  const held = await doc.evaluate<number>(heldLengthSource(selector)).catch(() => -1);
  if (held !== 0) return false;
  return (await doc.evaluate<boolean>(setValueSource(selector, text)).catch(() => false)) === true;
}

/** The `close_popup` step: its own close, in the page and then in each frame (the popup is often one), and only then hidden. */
export async function closePopup(page: BrowsePage, settle: () => Promise<void>): Promise<StepResult> {
  const pressed = { do: "close_popup", ok: true, reason: "pressed its close button" } as StepResult;
  if ((await page.evaluate<string>(closePopupSource(false)).catch(() => "none")) === "pressed") {
    await settle();
    return pressed;
  }
  for (const frame of await framesOf(page)) {
    if ((await frame.evaluate<string>(closePopupSource(true)).catch(() => "none")) === "pressed") {
      await settle();
      return pressed;
    }
  }
  if ((await page.evaluate<string>(HIDE_POPUP_SOURCE).catch(() => "none")) === "hid") {
    return { do: "close_popup", ok: true, reason: "it had no close button, so it was hidden; the page behind it can be used now" };
  }
  return { do: "close_popup", ok: false, reason: "nothing on the page looks like a popup; look to see what is in the way" };
}
