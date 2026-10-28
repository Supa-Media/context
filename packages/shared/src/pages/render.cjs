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

const DRAWN = { ...DRAW, ...RICH };

function blockHtml(block, ctx) {
  const caption = block.title && block.kind !== "vote" ? `<div class="pg-k pg-caption">${esc(block.title)}</div>` : "";
  if (block.problems.length > 0) {
    return `<div class="pg-block pg-broken" data-node="${block.from}">${caption}<p class="pg-problem">${esc(block.problems[0].message)}</p><pre>${esc(block.items.map((item) => item.label ? `${item.label.text}: ${item.parts.map((p) => p.text).join(" | ")}` : item.parts.map((p) => p.text).join(" | ")).join("\n"))}</pre></div>`;
  }
  return `<div class="pg-block pg-${block.kind}-block" data-node="${block.from}">${caption}${DRAWN[block.kind](block, ctx)}</div>`;
}

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
 * Returns the HTML, the boxes to fill, and the note's CSS.
 *
 * `images` (src → data URL) hands a cover the pictures it cannot ask the app
 * for; `me` is the reader's name, so their own vote shows as theirs.
 */
function renderPage(page, { open = new Set(), cover = false, images = null, me = null } = {}) {
  const ctx = { open, images, me };
  const boxes = [];
  const css = page.nodes.filter((node) => node.type === "css").map((node) => node.text);
  const nodes = page.nodes.filter((node) => node.type !== "css");
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
  const tabs = /^tabs$/i.test(page.fields.layout ?? "") && sections.length > 1;
  const sectionHtml = sections
    .map((section, i) => {
      // The words right under a section's heading are its dek, drawn under it in the heading's quieter voice.
      const [lead, ...after] = section.nodes;
      const dekOf = lead && lead.type === "paragraph" ? `<p class="pg-dek" data-edit data-node="${lead.from}">${runsHtml(lead.runs, open)}</p>` : "";
      const restOf = dekOf ? after : section.nodes;
      return `<section class="pg-section" data-section="${i}"${tabs && i > 0 ? " hidden" : ""}><div class="pg-sec-h">${nodeHtml(section.heading, ctx, boxes)}${dekOf}</div>${restOf.map((node) => nodeHtml(node, ctx, boxes)).join("")}</section>`;
    })
    .join("");
  const tabBar = tabs
    ? `<nav class="pg-tabs" role="tablist">${sections.map((section, i) => `<button type="button" role="tab" data-tab="${i}" aria-selected="${i === 0}">${esc(plain(section.heading.runs))}</button>`).join("")}</nav>`
    : "";
  return {
    html: `${top}<div class="pg-in pg-body">${rest.map((node) => nodeHtml(node, ctx, boxes)).join("")}${tabBar}${sectionHtml}</div>`,
    boxes,
    css,
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
