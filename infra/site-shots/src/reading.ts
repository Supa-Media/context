/**
 * A reading of a page: what it says and a number on each thing a person could
 * press or type into, the top page first and then each embedded frame
 * (./frames.ts). Split from ./browse.ts, which drives the steps.
 */

import type { BrowsePage, Element, Reading } from "./browse";
import { FRAME_REF_BASE, MAX_FRAME_ELEMENTS, MAX_FRAME_TEXT, framesOf } from "./frames";
import { publicHttpsUrl } from "./shoot";
import { POPUP_PROBE } from "./popups";

/** The most text one reading hands back. */
export const MAX_BROWSE_TEXT = 12_000;
/**
 * The most of the top page's elements one reading numbers. It was 80, and a
 * bus checkout's card boxes, terms box and Purchase button sat past the 80th
 * (the owner's review, 2026-10-26), so they had no number to fill or press.
 * The gateway shows the model the first ones and every box past them, and
 * pages through the rest (`apps/mcp/src/agent/browse.js`).
 */
export const MAX_ELEMENTS = 300;
/** How many of the page's elements a reading looks at for something to number; past it a page is read as far as here. */
export const MAX_SCANNED = 5_000;

/**
 * Number what can be pressed or typed into, in page order, and read the page.
 * Run as a string, for the reason `MEASURE_SOURCE` gives. A field's value is
 * never read out: only whether it has one.
 */
export function snapshotSource(base: number, max: number): string {
  return `(() => {
  for (const el of document.querySelectorAll("[data-tex-ref]")) el.removeAttribute("data-tex-ref");
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 100);
  const labelOf = (el) => {
    const byId = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    return clean(el.getAttribute("aria-label")) || clean(byId && byId.innerText) || clean(el.closest("label") && el.closest("label").innerText) ||
      clean(el.innerText) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("alt")) ||
      clean(el.getAttribute("name")) || clean(el.value && el.type === "submit" ? el.value : "");
  };
  const elements = [];
  const query = "a[href], button, input:not([type=hidden]), textarea, select, summary, [onclick], [tabindex]:not([tabindex='-1']), " +
    "[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=menuitemradio], " +
    "[role=menuitemcheckbox], [role=option], [role=combobox], [role=treeitem], [contenteditable=true]";
  const pointer = (el) => !!el && getComputedStyle(el).cursor === "pointer";
  /*
    What a page made clickable without saying so: a box with only a click
    handler, styled with the hand cursor (a custom picker's options). Numbered
    once, at the outermost box the hand starts on, and never when it wraps
    something already numbered by what it is.
  */
  const clickable = (el) => pointer(el) && !pointer(el.parentElement) && !el.querySelector(query);
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < ${MAX_SCANNED}; i++) {
    const el = all[i];
    if (elements.length >= ${max}) break;
    const named = el.matches(query);
    if (!named && !clickable(el)) continue;
    if (!visible(el) || el.disabled) continue;
    const ref = ${base} + elements.length + 1;
    el.setAttribute("data-tex-ref", String(ref));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const kind = tag === "input" ? "input " + (type || "text") : tag === "a" ? "link" : el.getAttribute("role") || (named ? tag : "clickable");
    const item = { ref, kind, label: labelOf(el) };
    if (tag === "a") item.href = el.href;
    if (tag === "input" && (type === "checkbox" || type === "radio")) item.checked = el.checked;
    else if (tag === "input" || tag === "textarea") item.filled = (el.value || "").length > 0;
    else if (el.isContentEditable) item.filled = (el.innerText || "").trim().length > 0;
    if (tag === "select") item.label = item.label + " (now: " + clean(el.selectedOptions[0] && el.selectedOptions[0].innerText) + ")";
    elements.push(item);
  }
  const text = (document.body ? document.body.innerText : "") || "";
  const uploads = document.querySelectorAll("input[type=file]").length;
  return { url: location.href, title: document.title || "", text, elements, uploads };
})()`;
}

export const SNAPSHOT_SOURCE = snapshotSource(0, MAX_ELEMENTS);

/** Read the page as it is now. */
export async function snapshot(page: BrowsePage): Promise<Reading> {
  const raw = await page.evaluate<{ url?: unknown; title?: unknown; text?: unknown; elements?: unknown; uploads?: unknown }>(SNAPSHOT_SOURCE);
  let text = typeof raw?.text === "string" ? raw.text.replace(/\n{3,}/g, "\n\n").trim() : "";
  const items: unknown[] = Array.isArray(raw?.elements) ? [...raw.elements] : [];
  let uploads = Number.isInteger(raw?.uploads) ? (raw!.uploads as number) : 0;
  // Each frame read on its own, numbered from its own thousand, its words after the page's under its site's name.
  const framed: string[] = [];
  let cut = false;
  for (const [i, frame] of (await framesOf(page)).entries()) {
    const inner = await frame
      .evaluate<{ text?: unknown; elements?: unknown; uploads?: unknown }>(snapshotSource(FRAME_REF_BASE * (i + 1), MAX_FRAME_ELEMENTS))
      .catch(() => null);
    if (inner === null) continue;
    const words = typeof inner.text === "string" ? inner.text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_FRAME_TEXT) : "";
    const found = Array.isArray(inner.elements) ? inner.elements : [];
    if (!words && found.length === 0) continue;
    framed.push(`In a frame from ${frame.host.slice(0, 100)}:\n${words}`);
    items.push(...found);
    if (Number.isInteger(inner.uploads)) uploads += inner.uploads as number;
  }
  if (framed.length > 0) {
    // The frames' words are kept whole: the page's are cut first, so a menu in a frame is never lost below a long page.
    const tail = `\n\n${framed.join("\n\n")}`;
    const room = Math.max(0, MAX_BROWSE_TEXT - tail.length);
    cut = text.length > room;
    text = text.slice(0, room) + tail;
  }
  // Something drawn over the page (a dialog, a seat map): said, so a close_popup step can clear it (./popups.ts).
  const popup = (await page.evaluate<boolean>(POPUP_PROBE).catch(() => false)) === true;
  const elements: Element[] = [];
  for (const item of items) {
    const e = item as Record<string, unknown>;
    if (!Number.isInteger(e.ref) || typeof e.kind !== "string") continue;
    const element: Element = { ref: e.ref as number, kind: e.kind.slice(0, 40), label: typeof e.label === "string" ? e.label.slice(0, 160) : "" };
    if (typeof e.href === "string") {
      // A link the gateway may later open has to be one it could open at all.
      const href = publicHttpsUrl(e.href);
      if (href !== null) element.href = href;
    }
    if (typeof e.filled === "boolean") element.filled = e.filled;
    if (typeof e.checked === "boolean") element.checked = e.checked;
    elements.push(element);
  }
  return {
    url: typeof raw?.url === "string" ? raw.url.slice(0, 2_000) : "",
    title: typeof raw?.title === "string" ? raw.title.slice(0, 300) : "",
    text: text.slice(0, MAX_BROWSE_TEXT),
    truncated: cut || text.length > MAX_BROWSE_TEXT,
    elements,
    ...(uploads > 0 ? { uploads: Math.min(uploads, 100) } : {}),
    ...(popup ? { popup: true } : {}),
  };
}
