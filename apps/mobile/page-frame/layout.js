/**
 * A page's own layout, drawn around the page's parts (`renderPage`'s `parts`):
 * the writer's HTML and CSS place the cover and the `##` sections, and the
 * words in them are still the renderer's, escaped and editable as anywhere.
 *
 * The layout comes from the note, so it is cleaned here before it is drawn,
 * whatever the gateway refused at write (`packages/shared/src/pages/layout.cjs`):
 * it is read by `DOMParser` (which runs nothing), and only the elements and
 * attributes below survive. No element that runs, loads, embeds or submits;
 * no attribute but class, style, role, title, lang, dir, hidden, the table
 * spans, `aria-*` and `data-from`, so a layout can't pose as the runtime's own
 * markers (`data-edit`, `data-f`, `data-box`, `data-src`) and can't name an
 * address. Its `<style>` goes to the page's stylesheet unless it would load
 * something. The frame's CSP is the second wall: it loads nothing anyway.
 *
 * A part the layout doesn't place is never hidden: an unplaced section goes
 * into `data-from="rest"`, or after the layout when there is none, and an
 * unplaced cover goes before it.
 */

const TAGS = new Set(
  ("div section article header footer main aside nav figure figcaption h1 h2 h3 h4 h5 h6 p span strong em b i u s small mark " +
    "br hr ul ol li blockquote sup sub time abbr dl dt dd table thead tbody tfoot tr th td caption style").split(" "),
);
const ATTRIBUTES = new Set(["class", "style", "role", "title", "lang", "dir", "hidden", "colspan", "rowspan", "data-from"]);
const LOADS = /@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;

/** Section headings as a layout names them: case and spacing don't matter (as `slotKey` in `layout.cjs`). */
function slotKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The layout's elements with everything not allowed taken out, and its CSS. */
export function cleanLayout(html, doc = document) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? "")}</body>`, "text/html");
  const css = [];
  const walk = (el) => {
    for (const child of [...el.children]) {
      const tag = child.localName;
      if (!TAGS.has(tag)) {
        child.remove();
        continue;
      }
      if (tag === "style") {
        if (!LOADS.test(child.textContent)) css.push(child.textContent);
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const kept = (ATTRIBUTES.has(name) || /^aria-[a-z-]+$/.test(name)) && !(name === "style" && LOADS.test(attr.value));
        if (!kept) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(parsed.body);
  const fragment = doc.createDocumentFragment();
  for (const node of [...parsed.body.childNodes]) fragment.appendChild(doc.importNode(node, true));
  return { fragment, css: css.join("\n") };
}

/**
 * The page drawn into `root` through its layout. `parts` are `renderPage`'s:
 * `cover`, and `sections` as `{key, html}`. Returns the layout's CSS.
 */
export function drawLayout(root, layoutHtml, parts) {
  const doc = root.ownerDocument;
  const { fragment, css } = cleanLayout(layoutHtml, doc);
  const shell = doc.createElement("div");
  shell.className = "pg-layout";
  shell.appendChild(fragment);
  const placed = new Set();
  let coverPlaced = false;
  let rest = null;
  for (const slot of shell.querySelectorAll("[data-from]")) {
    const name = slotKey(slot.getAttribute("data-from"));
    if (name === "rest") {
      rest = rest ?? slot;
      continue;
    }
    if (name === "cover") {
      if (coverPlaced) continue;
      coverPlaced = true;
      slot.innerHTML = parts.cover;
      continue;
    }
    const index = parts.sections.findIndex((section, i) => section.key === name && !placed.has(i));
    if (index === -1) continue;
    placed.add(index);
    slot.innerHTML = parts.sections[index].html;
  }
  const left = parts.sections.filter((_, i) => !placed.has(i)).map((section) => section.html).join("");
  let after = "";
  if (rest) rest.innerHTML = left;
  else if (left) after = `<div class="pg-in pg-body">${left}</div>`;
  root.innerHTML = `${coverPlaced ? "" : parts.cover}`;
  root.appendChild(shell);
  if (after) root.insertAdjacentHTML("beforeend", after);
  return css;
}

/** Tap a picture or a drawing to see it across the page, and again to put it back. */
export function bindEnlarge(root, changed) {
  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("img.pg-img, .pg-ink-figure, .pg-exhibit") : null;
    if (!target || target.closest("a")) return;
    // Across the frame's whole width, from wherever it sits: a picture in a layout's narrow column too.
    const on = !target.classList.contains("pg-enlarged");
    target.classList.toggle("pg-enlarged", on);
    target.style.width = target.style.maxWidth = target.style.marginLeft = "";
    if (on) {
      const view = root.ownerDocument.documentElement.clientWidth;
      const left = target.getBoundingClientRect().left;
      const margin = parseFloat(root.ownerDocument.defaultView.getComputedStyle(target).marginLeft) || 0;
      target.style.width = `${view}px`;
      target.style.maxWidth = "none";
      target.style.marginLeft = `${margin - left}px`;
    }
    changed();
  });
}
