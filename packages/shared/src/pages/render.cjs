/**
 * A parsed page (`parse.cjs`) as HTML.
 *
 * One renderer for every place a page is drawn: the page runtime's frame
 * (`apps/mobile/page-frame/`), and the gateway's cover picture of a page that
 * Tex texts. It returns a string, and every word in it went through `esc`:
 * nothing from the note reaches the markup except as escaped text, a number
 * this file computed, or a class name it chose. The note's own CSS and boxes
 * are not in it; the runtime adds those, the CSS to its own sealed document
 * and each box to a sealed frame of its own.
 *
 * Every run of words carries `data-f`/`data-t`, its range in the source, and
 * every element whose words can be typed over carries `data-edit`. That is the
 * whole source map: the runtime turns typing in an element into replacements
 * of its runs' ranges, and a selection into a comment's range.
 */

const { BLOCK_KINDS } = require("./blocks.cjs");
const { esc, runsHtml, plain } = require("./html.cjs");
const { DRAW } = require("./draw.cjs");
const { RICH } = require("./drawRich.cjs");
const { coverHtml } = require("./cover.cjs");
const { drawingSvg } = require("../ink/drawing.cjs");
const { slotKey } = require("./layout.cjs");

const DRAWN = { ...DRAW, ...RICH };

function blockHtml(block, ctx) {
  const caption = block.title && block.kind !== "vote" ? `<div class="pg-k pg-caption">${esc(block.title)}</div>` : "";
  if (block.problems.length > 0) {
    return `<div class="pg-block pg-broken" data-node="${block.from}">${caption}<p class="pg-problem">${esc(block.problems[0].message)}</p><pre>${esc(block.items.map((item) => item.label ? `${item.label.text}: ${item.parts.map((p) => p.text).join(" | ")}` : item.parts.map((p) => p.text).join(" | ")).join("\n"))}</pre></div>`;
  }
  return `<div class="pg-block pg-${block.kind}-block" data-node="${block.from}">${caption}${DRAWN[block.kind](block, ctx)}</div>`;
}

/**
 * A ```` ```drawing ```` block: Tex's ink, drawn from the shapes `parse.cjs`
 * read, in both inks so the page's own theme picks one (`--pg-ink-light`,
 * `--pg-ink-dark`), cropped to the scene. Inline, so its words are set in the
 * page's face; each copy's ids are its own, so two drawings never share a
 * hatch. Nothing the writer typed reaches it but numbers and escaped words.
 */
function drawingFigure(node, ctx) {
  if (node.scene === null) return `<pre class="pg-code" data-node="${node.from}"><code>${esc(node.problems?.[0]?.message ?? "")}</code></pre>`;
  ctx.drawings = (ctx.drawings ?? 0) + 1;
  const one = (dark) => {
    const id = `d${ctx.drawings}${dark ? "n" : "l"}-`;
    return drawingSvg(node.scene, { dark, seed: `${node.from}` })
      .replace(/\bink-(rough|paper|hatch)\b/g, `${id}$1`)
      .replace(/^<svg [^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${DRAWING_CROP}" role="img" aria-label="${esc(node.caption || "A drawing")}" class="${dark ? "pg-ink-dark" : "pg-ink-light"}">`);
  };
  const caption = node.caption ? `<figcaption>${esc(node.caption)}</figcaption>` : "";
  return `<figure class="pg-ink-figure" data-node="${node.from}">${one(false)}${one(true)}${caption}</figure>`;
}

/** The part of a drawing the scene is in (`SAFE` in `ink/drawing.cjs`), with room for Tex at its foot. */
const DRAWING_CROP = "90 110 1020 820";

/** One node as HTML. `boxes` collects the code boxes, which the runtime fills. */
function nodeHtml(node, ctx, boxes) {
  const open = ctx.open;
  switch (node.type) {
    case "heading": {
      const level = node.level;
      return `<h${level} data-edit data-node="${node.from}">${runsHtml(node.runs, open)}</h${level}>`;
    }
    case "paragraph":
      return `<p data-edit data-node="${node.from}">${runsHtml(node.runs, open)}</p>`;
    case "rule":
      return `<hr>`;
    case "quote":
      return `<blockquote class="${node.alert ? `pg-alert pg-alert-${node.alert}` : ""}" data-node="${node.from}"><p data-edit>${runsHtml(node.runs, open)}</p></blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const tasks = node.items.some((item) => item.task);
      return `<${tag} class="${tasks ? "pg-tasks" : ""}" data-node="${node.from}">${node.items
        .map((item) => {
          const box = item.task
            ? `<input type="checkbox" data-task="${item.task.at}"${item.task.checked ? " checked" : ""} aria-label="Done">`
            : "";
          return `<li class="${item.task && item.task.checked ? "done" : ""}" style="margin-left:${item.depth * 1.25}em">${box}<span data-edit>${runsHtml(item.runs, open)}</span></li>`;
        })
        .join("")}</${tag}>`;
    }
    case "table": {
      // Four columns or more, a phone draws each row as a card, every cell under its column's name (`css.cjs`).
      const labels = node.head.map((cell) => esc(plain(cell)));
      return `<div class="pg-table${node.head.length >= 4 ? " pg-table-cards" : ""}" data-node="${node.from}"><table><thead><tr>${node.head.map((cell) => `<th data-edit>${runsHtml(cell, open)}</th>`).join("")}</tr></thead><tbody>${node.rows
        .map((row) => `<tr>${row.map((cell, i) => `<td data-edit data-label="${labels[i] ?? ""}">${runsHtml(cell, open)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    }
    case "code":
      return `<pre class="pg-code" data-node="${node.from}"><code>${esc(node.text)}</code></pre>`;
    case "block":
      return blockHtml(node, ctx);
    case "drawing":
      return drawingFigure(node, ctx);
    case "box":
      boxes.push(node);
      return `<div class="pg-box" data-box="${boxes.length - 1}" data-node="${node.from}" style="height:${node.height ?? 240}px"></div>`;
    default:
      return "";
  }
}

/**
 * The whole page: a cover (`cover.cjs`: the kicker, the title, the words
 * before anything else, a status line, photos or a number by the page's
 * kind), then the rest of the words before the first `##`, then one section
 * per `##`. With `layout: tabs` in the front matter, the sections are tabs.
 * Returns the HTML, the boxes to fill, the note's CSS, and its layout with the parts
 * that fill it (`layout.cjs`), or null for both.
 *
 * `images` (src → data URL) hands a cover the pictures it cannot ask the app
 * for; `me` is the reader's name, so their own vote shows as theirs.
 */
function renderPage(page, { open = new Set(), cover = false, images = null, me = null } = {}) {
  const ctx = { open, images, me };
  const boxes = [];
  const css = page.nodes.filter((node) => node.type === "css").map((node) => node.text);
  const nodes = page.nodes.filter((node) => node.type !== "css" && node.type !== "layout");
  // The page's own layout (`layout.cjs`), drawn by the runtime around the parts below; one that can't be drawn is left out, and the page reads as it would without it.
  const layoutNode = page.nodes.find((node) => node.type === "layout");
  const layout = layoutNode && layoutNode.problems.length === 0 ? layoutNode.html : null;
  const firstSection = nodes.findIndex((node) => node.type === "heading" && node.level === 2);
  const head = firstSection === -1 ? nodes : nodes.slice(0, firstSection);
  const body = firstSection === -1 ? [] : nodes.slice(firstSection);

  // The cover takes the note's own title and opening words, so they stay editable where they are drawn.
  const h1 = head.find((node) => node.type === "heading" && node.level === 1);
  const dekNode = head.find((node) => node.type === "paragraph");
  const firstBlock = head.findIndex((node) => node.type === "block" || node.type === "box");
  const dek = dekNode && (firstBlock === -1 || head.indexOf(dekNode) < firstBlock) ? dekNode : null;
  const title = h1 ? nodeHtml(h1, ctx, boxes) : page.title ? `<h1>${esc(page.title)}</h1>` : "";
  const dekHtml = dek ? `<p class="pg-dek" data-edit data-node="${dek.from}">${runsHtml(dek.runs, open)}</p>` : "";
  const top = coverHtml(page, nodes, { title, dek: dekHtml }, ctx);
  const rest = head.filter((node) => node !== h1 && node !== dek);

  if (cover) {
    // The first screen: what a reader sees before scrolling, and the picture texted with the link.
    const first = rest.find((node) => node.type === "block") ?? body.find((node) => node.type === "block");
    return { html: `${top}<div class="pg-in pg-body">${first ? nodeHtml(first, ctx, []) : ""}</div>`, boxes: [], css };
  }

  const sections = [];
  let current = null;
  for (const node of body) {
    if (node.type === "heading" && node.level === 2) {
      current = { heading: node, nodes: [] };
      sections.push(current);
    } else current.nodes.push(node);
  }
  const tabs = layout === null && /^tabs$/i.test(page.fields.layout ?? "") && sections.length > 1;
  const sectionParts = sections.map((section, i) => {
      // The words right under a section's heading are its dek, drawn under it in the heading's quieter voice.
      const [lead, ...after] = section.nodes;
      const dekOf = lead && lead.type === "paragraph" ? `<p class="pg-dek" data-edit data-node="${lead.from}">${runsHtml(lead.runs, open)}</p>` : "";
      const restOf = dekOf ? after : section.nodes;
      return {
        key: slotKey(plain(section.heading.runs)),
        html: `<section class="pg-section" data-section="${i}"${tabs && i > 0 ? " hidden" : ""}><div class="pg-sec-h">${nodeHtml(section.heading, ctx, boxes)}${dekOf}</div>${restOf.map((node) => nodeHtml(node, ctx, boxes)).join("")}</section>`,
      };
    });
  const sectionHtml = sectionParts.map((part) => part.html).join("");
  const tabBar = tabs
    ? `<nav class="pg-tabs" role="tablist">${sections.map((section, i) => `<button type="button" role="tab" data-tab="${i}" aria-selected="${i === 0}">${esc(plain(section.heading.runs))}</button>`).join("")}</nav>`
    : "";
  const lead = rest.map((node) => nodeHtml(node, ctx, boxes)).join("");
  return {
    html: `${top}<div class="pg-in pg-body">${lead}${tabBar}${sectionHtml}</div>`,
    boxes,
    css,
    layout,
    // What a layout's `data-from` slots are filled with: the cover with the words before the first `##`, and each section by its heading.
    parts: layout === null ? null : { cover: `${top}${lead ? `<div class="pg-in pg-lead">${lead}</div>` : ""}`, sections: sectionParts },
  };
}

/** The data a box's script is handed as `window.page`: the front matter and every block's items as plain words. */
function pageData(page) {
  return {
    title: page.title,
    fields: { ...page.fields },
    blocks: page.nodes
      .filter((node) => node.type === "block")
      .map((block) => ({
        kind: block.kind,
        title: block.title,
        settings: Object.fromEntries(Object.entries(block.settings).map(([key, value]) => [key, value.value])),
        words: plain(block.words ?? []),
        items: block.items.map((item) => ({
          label: item.label ? plain(item.label.runs) : null,
          parts: item.parts.map((p) => plain(p.runs)),
          fields: Object.fromEntries((item.fields ?? []).map((field) => [field.key, plain(field.value.runs)])),
        })),
      })),
  };
}

module.exports = { renderPage, pageData, esc, BLOCK_NAMES: Object.keys(BLOCK_KINDS) };
