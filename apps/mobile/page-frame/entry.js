/**
 * The page runtime: draws a `.page.md` note as a page, in a sealed frame.
 *
 * Built by `scripts/build-drawing-editor.mjs` into
 * `public/drawing-assets/page/`, and loaded by the app's Page view
 * (`features/console/files/pageView/`) in an `<iframe sandbox="allow-scripts">`
 * that never has `allow-same-origin`, served from `<handle>.ctxlc.site` in
 * production. The decision and its reasons are
 * `docs/decisions/app-and-console/pages.md`; the short version:
 *
 *  - **Only our code runs here.** The note is data: its words are drawn by
 *    `@context/shared`'s page renderer, every one escaped. The note's CSS is
 *    added as a stylesheet (it cannot run anything, and this page's CSP loads
 *    nothing from the network). The note's code, its ```` ```box ```` fences,
 *    each run in a sealed frame of their own (`box.js`) that this page reads
 *    nothing from but a height.
 *  - **The note is changed only by the app.** This page says what the reader
 *    did (typed over these words, ticked this task, picked this option,
 *    commented on these words) and the app re-reads the note and decides
 *    (`@context/shared/src/pages/edits.cjs`).
 *
 * ## The protocol (channel `context-page`)
 *
 *   frame → app   ready | height {height} | edit {edits:[{from,to,text}]}
 *                 | task {at, checked} | choose {block, option} | vote {block, option}
 *                 | comment {from, to, quote, body} | reply {thread, body}
 *                 | resolve {thread} | reopen {thread}
 *                 | open {href} | note {target} | image {src}
 *   app → frame   render {source, dark, editable, canComment, me}
 *                 | image {src, data}
 */

import pages from "@context/shared/src/pages/index.cjs";
import { bindComments } from "./comments.js";

const CHANNEL = "context-page";
const BOX_CHANNEL = "context-page-box";
const MAX_BOX_HEIGHT = 2400;

const root = document.getElementById("page");
const userStyle = document.getElementById("user-css");
const tokens = document.getElementById("tokens");
document.getElementById("base").textContent = pages.BASE_CSS;

let state = { source: "", dark: false, editable: false, canComment: false, me: null };
let page = null;
let pending = null; // a render held back while the reader is typing
const images = new Map();
const originals = new Map();
const owned = new Map(); // editable element → the runs drawn in it

function fromParent(event) {
  return event.source === window.parent && event.data && event.data.channel === CHANNEL;
}

function tell(message) {
  window.parent.postMessage({ channel: CHANNEL, ...message }, "*");
}

/* ------------------------------- drawing -------------------------------- */

function draw() {
  page = pages.parsePage(state.source);
  const threads = commentsLayer.threads(state.source);
  const open = new Set(threads.filter((thread) => thread.status === "open").map((thread) => thread.id));
  const { html, boxes: found, css } = pages.renderPage(page, { open, me: state.me });
  const { vars, dark } = pages.pageTokens(page.fields, state.dark);
  tokens.textContent = `:root{${vars}}`;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  userStyle.textContent = css.join("\n");
  const caret = saveCaret();
  root.innerHTML = html;
  originals.clear();
  owned.clear();
  for (const span of root.querySelectorAll("[data-f]")) originals.set(span, span.textContent);
  for (const el of root.querySelectorAll("[data-edit]")) owned.set(el, [...el.querySelectorAll("[data-f]")]);
  boxFrames.clear(); // the old boxes went with the old HTML
  for (const slot of root.querySelectorAll("[data-box]")) mountBox(slot, found[Number(slot.dataset.box)]);
  for (const img of root.querySelectorAll("img[data-src]")) loadImage(img);
  decorate();
  commentsLayer.refresh(threads);
  restoreCaret(caret);
  reportHeight();
}

/** A carousel's dots follow the photo in view (`gallery` in `packages/shared/src/pages/html.cjs`). */
function followGallery(track) {
  const dots = track.parentElement.querySelectorAll(".pg-gal-dots i");
  if (dots.length < 2) return;
  track.addEventListener(
    "scroll",
    () => {
      const slide = track.firstElementChild;
      const step = slide ? slide.getBoundingClientRect().width + 4 : 1;
      const at = Math.min(dots.length - 1, Math.round(track.scrollLeft / step));
      dots.forEach((dot, k) => dot.classList.toggle("on", k === at));
    },
    { passive: true },
  );
}

/** What only a script can add: editing, sort buttons, tabs, carousel dots. */
function decorate() {
  for (const track of root.querySelectorAll(".pg-gal-track")) followGallery(track);
  for (const el of root.querySelectorAll("[data-edit]")) {
    const inside = el.closest(".pg-option, .pg-vopt");
    if (state.editable && !inside && el.querySelector("[data-f]")) {
      el.contentEditable = "true";
      el.spellcheck = true;
    }
  }
  for (const box of root.querySelectorAll("input[data-task]")) box.disabled = !state.editable;
  for (const list of root.querySelectorAll("[data-sortable]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pg-sort";
    button.textContent = "Sort by name";
    button.addEventListener("click", () => {
      const byName = button.textContent === "Sort by name";
      const rows = [...list.children];
      rows.sort((a, b) =>
        byName ? a.dataset.sortName.localeCompare(b.dataset.sortName) : Number(a.dataset.sortValue) - Number(b.dataset.sortValue),
      );
      for (const row of rows) list.appendChild(row);
      button.textContent = byName ? "Sort by value" : "Sort by name";
    });
    list.parentElement.insertBefore(button, list);
  }
}

/* ------------------------------- editing -------------------------------- */

let flushTimer = 0;

/** The words typed in one element, as replacements of its runs. Text typed between runs joins the run before it. */
function changesIn(el) {
  const spans = owned.get(el) ?? [];
  if (spans.length === 0) return [];
  const texts = new Map(spans.map((span) => [span, ""]));
  let last = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const owner = node.parentElement && node.parentElement.closest("[data-f]");
    const span = owner && texts.has(owner) ? owner : last ?? spans.find((s) => s.isConnected) ?? spans[0];
    texts.set(span, (texts.get(span) ?? "") + node.data);
    last = span;
  }
  const edits = [];
  for (const span of spans) {
    // A run the reader deleted outright is gone from the element: its words are now empty.
    const text = span.isConnected ? (texts.get(span) ?? "").replace(/\u00a0/g, " ") : "";
    if (text === originals.get(span)) continue;
    edits.push({ from: Number(span.dataset.f), to: Number(span.dataset.t), text });
  }
  return edits;
}

function flush(el) {
  clearTimeout(flushTimer);
  if (!el) return;
  const edits = changesIn(el);
  if (edits.length > 0) tell({ type: "edit", edits });
}

root.addEventListener("input", (event) => {
  const el = event.target.closest("[data-edit]");
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(el), 1200);
});
root.addEventListener("keydown", (event) => {
  const el = event.target.closest && event.target.closest("[data-edit]");
  if (!el || event.key !== "Enter") return;
  event.preventDefault();
  el.blur();
});
root.addEventListener("focusout", (event) => {
  const el = event.target.closest && event.target.closest("[data-edit]");
  if (el) flush(el);
  setTimeout(() => {
    if (pending !== null && !editing()) {
      state = pending;
      pending = null;
      draw();
    }
  }, 0);
});
root.addEventListener("paste", (event) => {
  if (!event.target.closest || !event.target.closest("[data-edit]")) return;
  event.preventDefault();
  const text = (event.clipboardData && event.clipboardData.getData("text/plain")) || "";
  document.execCommand("insertText", false, text.replace(/[\r\n]+/g, " "));
});

function editing() {
  const active = document.activeElement;
  return Boolean(active && active.isContentEditable && root.contains(active));
}

/** The caret as (which editable element, how many characters in), so a redraw puts it back. */
function saveCaret() {
  const active = document.activeElement;
  const selection = window.getSelection();
  if (!active || !active.isContentEditable || !selection || selection.rangeCount === 0) return null;
  const all = [...root.querySelectorAll("[data-edit]")];
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(active);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return { index: all.indexOf(active), offset: range.toString().length };
}

function restoreCaret(caret) {
  if (caret === null || caret.index < 0) return;
  const el = root.querySelectorAll("[data-edit]")[caret.index];
  if (!el || !el.isContentEditable) return;
  el.focus();
  let left = caret.offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (left <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, left);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    left -= node.data.length;
  }
}

/* ------------------------------ taps -------------------------------------- */

root.addEventListener("change", (event) => {
  const box = event.target;
  if (box.matches && box.matches("input[data-task]")) tell({ type: "task", at: Number(box.dataset.task), checked: box.checked });
});

root.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    for (const button of root.querySelectorAll("[data-tab]")) button.setAttribute("aria-selected", String(button === tab));
    for (const section of root.querySelectorAll("[data-section]")) section.hidden = section.dataset.section !== tab.dataset.tab;
    reportHeight();
    return;
  }
  // A source link inside an option opens its site; it never casts a vote or makes a choice.
  const out = event.target.closest("a.pg-src");
  if (out) {
    event.preventDefault();
    if (out.dataset.href) tell({ type: "open", href: out.dataset.href });
    return;
  }
  const vote = event.target.closest("[data-vote]");
  if (vote && state.editable) {
    tell({ type: "vote", block: Number(vote.closest("[data-block]").dataset.block), option: vote.dataset.vote });
    return;
  }
  const option = event.target.closest("[data-choose]");
  if (option && state.editable) {
    const block = Number(option.closest("[data-block]").dataset.block);
    const on = option.classList.contains("on") || option.getAttribute("aria-pressed") === "true";
    tell({ type: "choose", block, option: on ? "" : option.dataset.choose });
    return;
  }
  const link = event.target.closest("a");
  if (link) {
    event.preventDefault();
    if (link.dataset.note) tell({ type: "note", target: link.dataset.note });
    else if (link.dataset.href) tell({ type: "open", href: link.dataset.href });
    return;
  }
  const th = event.target.closest("th");
  if (th && !th.isContentEditable) sortTable(th);
});

root.addEventListener("keydown", (event) => {
  const option = event.target.closest && event.target.closest("[data-choose], [data-vote]");
  if (option && option.tagName !== "BUTTON" && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    option.click();
  }
});

/** A table sorted by a column, in the view only. */
function sortTable(th) {
  const table = th.closest("table");
  const column = [...th.parentElement.children].indexOf(th);
  const body = table.tBodies[0];
  const up = th.dataset.sorted !== "up";
  const rows = [...body.rows];
  const key = (row) => (row.cells[column] ? row.cells[column].textContent.trim() : "");
  const number = (text) => Number(text.replace(/[^0-9.-]/g, ""));
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const both = x !== "" && y !== "" && !Number.isNaN(number(x)) && !Number.isNaN(number(y));
    const order = both ? number(x) - number(y) : x.localeCompare(y);
    return up ? order : -order;
  });
  for (const row of rows) body.appendChild(row);
  for (const cell of th.parentElement.children) delete cell.dataset.sorted;
  th.dataset.sorted = up ? "up" : "down";
}

/* -------------------------------- boxes ------------------------------------ */

const boxFrames = new Map(); // window → { frame, node }

/** One ```box fence, in a sealed frame of its own: no same-origin, and `box.js`'s CSP lets it fetch nothing. */
function mountBox(slot, node) {
  if (!node) return;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "Part of this page drawn by its own code");
  frame.src = "./box.html";
  slot.appendChild(frame);
  boxFrames.set(frame.contentWindow, { frame, node, slot });
}

window.addEventListener("message", (event) => {
  if (fromParent(event)) {
    const message = event.data;
    if (message.type === "render" && typeof message.source === "string") {
      const next = {
        source: message.source,
        dark: message.dark === true,
        editable: message.editable === true,
        canComment: message.canComment === true,
        me: typeof message.me === "string" ? message.me.slice(0, 60) : null,
      };
      // The app's floating chrome over the page's top, in pixels: a cover with no photo starts its words below it (`css.cjs`).
      const inset = Number.isFinite(message.inset) ? Math.max(0, Math.min(200, Math.round(message.inset))) : 0;
      document.documentElement.style.setProperty("--pg-top", `${inset}px`);
      if (editing() && state.source !== "") {
        pending = next;
        return;
      }
      state = next;
      draw();
    } else if (message.type === "image" && typeof message.src === "string") {
      const data = typeof message.data === "string" && /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(message.data) ? message.data : null;
      images.set(message.src, data);
      for (const img of root.querySelectorAll("img[data-src]")) if (img.dataset.src === message.src && data) img.src = data;
    }
    return;
  }
  const box = boxFrames.get(event.source);
  if (!box || !event.data || event.data.channel !== BOX_CHANNEL) return;
  if (event.data.type === "ready") {
    box.frame.contentWindow.postMessage({ channel: BOX_CHANNEL, type: "box", html: box.node.html, page: pages.pageData(page) }, "*");
  } else if (event.data.type === "height" && Number.isFinite(event.data.height) && box.node.height === null) {
    box.slot.style.height = `${Math.min(MAX_BOX_HEIGHT, Math.max(40, Math.ceil(event.data.height)))}px`;
    reportHeight();
  }
});

function loadImage(img) {
  const src = img.dataset.src;
  if (images.has(src)) {
    if (images.get(src)) img.src = images.get(src);
    return;
  }
  images.set(src, null);
  tell({ type: "image", src });
}

/* ------------------------------ height ------------------------------------- */

let lastHeight = -1;
function reportHeight() {
  const height = Math.ceil(document.documentElement.scrollHeight);
  if (height === lastHeight) return;
  lastHeight = height;
  tell({ type: "height", height });
}
new ResizeObserver(reportHeight).observe(document.body);

const commentsLayer = bindComments({
  root,
  pages,
  tell,
  state: () => state,
  page: () => page,
  reportHeight,
});

tell({ type: "ready" });
