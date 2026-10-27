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

const { BLOCK_KINDS, numberIn, shareIn } = require("./blocks.cjs");
const { runsText } = require("./inline.cjs");

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Only these link targets are drawn as links; the runtime asks the app before opening any. */
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)[^\s"'<>]*$/i;

/** Runs as HTML. `open` is the set of comment threads still open, whose words are highlighted. */
function runsHtml(runs, open) {
  let out = "";
  for (const run of runs) {
    if (run.image) {
      out += `<img class="pg-img" data-src="${esc(run.image.src)}" alt="${esc(run.image.alt)}">`;
      continue;
    }
    if (run.text === "") continue;
    const anchors = (run.anchors ?? []).filter((id) => open.has(id));
    const attrs = run.editable === false ? "" : ` data-f="${run.from}" data-t="${run.to}"`;
    let html = `<span class="r${anchors.length ? " pg-c" : ""}"${attrs}${anchors.length ? ` data-a="${esc(anchors.join(" "))}"` : ""}>${esc(run.text)}</span>`;
    if (run.code) html = `<code>${html}</code>`;
    if (run.strike) html = `<s>${html}</s>`;
    if (run.em) html = `<em>${html}</em>`;
    if (run.strong) html = `<strong>${html}</strong>`;
    if (run.note) html = `<a class="pg-note" href="#" data-note="${esc(run.note)}">${html}</a>`;
    else if (run.href) html = SAFE_HREF.test(run.href) ? `<a href="${esc(run.href)}" data-href="${esc(run.href)}">${html}</a>` : html;
    out += html;
  }
  return out;
}

const plain = (runs) => runsText(runs).trim();

/** One part of a block item: its words, editable in place. */
function part(item, index, open, tag = "span", cls = "") {
  const p = index === -1 ? item.label : item.parts[index];
  if (!p) return "";
  return `<${tag} class="${cls}" data-edit>${runsHtml(p.runs, open)}</${tag}>`;
}

const setting = (block, key) => (block.settings[key] ? block.settings[key].value.trim() : "");

/** Each kind's drawing. Values are read with `numberIn`/`shareIn`; widths are this file's numbers. */
const DRAW = {
  stats: (block, open) =>
    `<div class="pg-stats">${block.items
      .map((item) => `<div class="pg-stat">${part(item, -1, open, "small")}${part(item, 0, open, "strong")}${part(item, 1, open, "span", "pg-sub")}</div>`)
      .join("")}</div>`,

  compare: (block, open) => {
    const limit = numberIn(setting(block, "limit"));
    const values = block.items.map((item) => numberIn(item.parts[0].text) ?? 0);
    const higher = /^higher$/i.test(setting(block, "better"));
    const max = Math.max(...values, limit ?? 0) * 1.08 || 1;
    const pick = setting(block, "pick").toLowerCase();
    const best = higher ? Math.max(...values) : Math.min(...values);
    const rows = block.items.map((item, i) => {
      const value = values[i];
      const over = limit !== null && (higher ? value < limit : value > limit);
      const picked = pick ? item.label && plain(item.label.runs).toLowerCase() === pick : value === best;
      return (
        `<div class="pg-cmp-row${over ? " over" : ""}${picked ? " pick" : ""}" data-sort-name="${esc(item.label ? plain(item.label.runs) : "")}" data-sort-value="${value}">` +
        `${part(item, -1, open, "span", "pg-cmp-name")}${part(item, 0, open, "span", "pg-cmp-value")}` +
        `<div class="pg-track"><div class="pg-fill" style="width:${((value / max) * 100).toFixed(1)}%"></div>` +
        (limit !== null ? `<div class="pg-limit" style="left:${((limit / max) * 100).toFixed(1)}%"></div>` : "") +
        `</div>${part(item, 1, open, "span", "pg-sub")}</div>`
      );
    });
    const unit = setting(block, "unit");
    return (
      `<div class="pg-cmp" data-sortable>${rows.join("")}</div>` +
      (limit !== null || unit ? `<p class="pg-foot">${esc([unit, limit !== null ? `limit ${setting(block, "limit")}` : ""].filter(Boolean).join(" · "))}</p>` : "")
    );
  },

  chart: (block, open) => {
    const values = block.items.map((item) => numberIn(item.parts[0].text) ?? 0);
    const goal = numberIn(setting(block, "goal"));
    const lo = Math.min(0, ...values, goal ?? 0);
    const hi = Math.max(...values, goal ?? 0) * 1.1 || 1;
    const y = (v) => 180 - ((v - lo) / (hi - lo || 1)) * 170;
    const n = values.length;
    const w = 600;
    const x = (i) => (n === 1 ? w / 2 : 24 + (i * (w - 48)) / (n - 1));
    let marks;
    if (/^line$/i.test(setting(block, "type"))) {
      const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      marks =
        `<polyline class="pg-line" points="${points}"/>` +
        values.map((v, i) => `<circle class="pg-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5"><title>${esc(plain(block.items[i].parts[0].runs))}</title></circle>`).join("");
    } else {
      const band = (w - 24) / n;
      marks = values
        .map((v, i) => {
          const top = Math.min(y(v), y(0));
          return `<rect class="pg-bar" x="${(12 + i * band + band * 0.15).toFixed(1)}" y="${top.toFixed(1)}" width="${(band * 0.7).toFixed(1)}" height="${Math.max(1, Math.abs(y(v) - y(0))).toFixed(1)}" rx="4"><title>${esc(plain(block.items[i].parts[0].runs))}</title></rect>`;
        })
        .join("");
    }
    const goalLine = goal !== null ? `<line class="pg-goal" x1="0" x2="${w}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}"/>` : "";
    return (
      `<figure class="pg-chart"><svg viewBox="0 0 ${w} 190" preserveAspectRatio="none" role="img" aria-label="${esc(block.title || "chart")}">` +
      `<line class="pg-axis" x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${goalLine}${marks}</svg>` +
      `<div class="pg-chart-keys" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${block.items
        .map((item) => `<div>${part(item, -1, open, "span", "pg-key")}${part(item, 0, open, "strong")}</div>`)
        .join("")}</div>${setting(block, "unit") ? `<figcaption class="pg-foot">${esc(setting(block, "unit"))}</figcaption>` : ""}</figure>`
    );
  },

  progress: (block, open) =>
    `<div class="pg-progress">${block.items
      .map((item) => {
        const share = shareIn(item.parts[0].text) ?? 0;
        return `<div class="pg-prog-row${share >= 1 ? " done" : ""}">${part(item, -1, open, "span", "pg-cmp-name")}${part(item, 0, open, "span", "pg-cmp-value")}<div class="pg-track"><div class="pg-fill" style="width:${(share * 100).toFixed(1)}%"></div></div>${part(item, 1, open, "span", "pg-sub")}</div>`;
      })
      .join("")}</div>`,

  timeline: (block, open) =>
    `<ol class="pg-timeline">${block.items
      .map((item) => `<li>${part(item, -1, open, "span", "pg-when")}<div>${part(item, 0, open, "span", "pg-what")}${part(item, 1, open, "span", "pg-sub")}</div></li>`)
      .join("")}</ol>`,

  steps: (block, open) =>
    `<ol class="pg-steps">${block.items
      .map((item, i) => `<li><span class="pg-num">${i + 1}</span><div>${item.label ? part(item, -1, open, "span", "pg-what") : ""}${part(item, 0, open, "span", item.label ? "pg-sub" : "pg-what")}${part(item, 1, open, "span", "pg-sub")}</div></li>`)
      .join("")}</ol>`,

  choose: (block, open) => {
    const chosen = setting(block, "chosen").toLowerCase();
    return `<div class="pg-choose" data-block="${block.from}">${block.items
      .map((item) => {
        const name = item.label ? plain(item.label.runs) : plain(item.parts[0].runs);
        const on = chosen !== "" && name.toLowerCase() === chosen;
        return `<div class="pg-option${on ? " on" : ""}" role="button" tabindex="0" data-choose="${esc(name)}"><div>${item.label ? part(item, -1, open, "span", "pg-what") : ""}${part(item, 0, open, "span", item.label ? "pg-sub" : "pg-what")}${part(item, 1, open, "span", "pg-sub")}</div><span class="pg-tick">${on ? "Chosen" : "Choose"}</span></div>`;
      })
      .join("")}</div>`;
  },

  board: (block, open) => {
    const columns = new Map();
    for (const item of block.items) {
      const name = item.label ? plain(item.label.runs) : "";
      if (!columns.has(name)) columns.set(name, []);
      columns.get(name).push(item);
    }
    return `<div class="pg-board">${[...columns]
      .map(([name, items]) => `<div class="pg-col"><h4>${esc(name)}<span>${items.length}</span></h4>${items.map((item) => `<div class="pg-card">${part(item, 0, open, "span", "pg-what")}${part(item, 1, open, "span", "pg-sub")}</div>`).join("")}</div>`)
      .join("")}</div>`;
  },

  people: (block, open) =>
    `<div class="pg-people">${block.items
      .map((item) => {
        const name = item.label ? plain(item.label.runs) : "";
        const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
        return `<div class="pg-person"><span class="pg-face">${esc(initials)}</span><div>${part(item, -1, open, "span", "pg-what")}${part(item, 0, open, "span", "pg-sub")}${part(item, 1, open, "span", "pg-sub")}</div></div>`;
      })
      .join("")}</div>`,

  places: (block, open) => {
    const near = setting(block, "near");
    return `<ol class="pg-places">${block.items
      .map((item, i) => {
        const query = [plain(item.label ? item.label.runs : []), plain(item.parts[0].runs), near].filter(Boolean).join(", ");
        const href = `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
        return `<li><span class="pg-num">${i + 1}</span><div>${part(item, -1, open, "span", "pg-what")}${part(item, 0, open, "span", "pg-sub")}${part(item, 1, open, "span", "pg-sub")}</div><a class="pg-map" href="${esc(href)}" data-href="${esc(href)}">Map</a></li>`;
      })
      .join("")}</ol>`;
  },

  versus: (block, open) => {
    const better = setting(block, "better").toLowerCase();
    return (
      `<div class="pg-vs"><div class="pg-vs-head"><span></span><strong>${esc(setting(block, "a"))}</strong><strong>${esc(setting(block, "b"))}</strong></div>` +
      block.items
        .map((item) => `<div class="pg-vs-row">${part(item, -1, open, "span", "pg-key")}${part(item, 0, open, "span", better === "a" ? "win" : "")}${part(item, 1, open, "span", better === "b" ? "win" : "")}</div>`)
        .join("") +
      `</div>`
    );
  },
};

function blockHtml(block, open) {
  const caption = block.title ? `<div class="pg-caption">${esc(block.title)}</div>` : "";
  if (block.problems.length > 0) {
    return `<div class="pg-block pg-broken" data-node="${block.from}">${caption}<p class="pg-problem">${esc(block.problems[0].message)}</p><pre>${esc(block.items.map((item) => item.label ? `${item.label.text}: ${item.parts.map((p) => p.text).join(" | ")}` : item.parts.map((p) => p.text).join(" | ")).join("\n"))}</pre></div>`;
  }
  return `<div class="pg-block pg-${block.kind}-block" data-node="${block.from}">${caption}${DRAW[block.kind](block, open)}</div>`;
}

/** One node as HTML. `index` numbers boxes, which the runtime fills. */
function nodeHtml(node, open, boxes) {
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
    case "table":
      return `<div class="pg-table" data-node="${node.from}"><table><thead><tr>${node.head.map((cell) => `<th data-edit>${runsHtml(cell, open)}</th>`).join("")}</tr></thead><tbody>${node.rows
        .map((row) => `<tr>${row.map((cell) => `<td data-edit>${runsHtml(cell, open)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    case "code":
      return `<pre class="pg-code" data-node="${node.from}"><code>${esc(node.text)}</code></pre>`;
    case "block":
      return blockHtml(node, open);
    case "box":
      boxes.push(node);
      return `<div class="pg-box" data-box="${boxes.length - 1}" data-node="${node.from}" style="height:${node.height ?? 240}px"></div>`;
    default:
      return "";
  }
}

/**
 * The whole page: a header (kicker, title, the words before the first `##`),
 * then one section per `##`. With `layout: tabs` in the front matter, the
 * sections are tabs. Returns the HTML, the boxes to fill, and the note's CSS.
 */
function renderPage(page, { open = new Set(), cover = false } = {}) {
  const boxes = [];
  const css = page.nodes.filter((node) => node.type === "css").map((node) => node.text);
  const nodes = page.nodes.filter((node) => node.type !== "css");
  const firstSection = nodes.findIndex((node) => node.type === "heading" && node.level === 2);
  const head = firstSection === -1 ? nodes : nodes.slice(0, firstSection);
  const body = firstSection === -1 ? [] : nodes.slice(firstSection);
  const kicker = page.fields.kicker ? `<div class="pg-kicker">${esc(page.fields.kicker)}</div>` : "";
  const hasH1 = head.some((node) => node.type === "heading" && node.level === 1);
  const title = !hasH1 && page.title ? `<h1>${esc(page.title)}</h1>` : "";

  if (cover) {
    // The first screen: what a reader sees before scrolling, and the picture texted with the link.
    const lead = head.slice(0, 4);
    const first = body.find((node) => node.type === "block") ?? head.find((node) => node.type === "block");
    const parts = [...lead.filter((node) => node !== first), ...(first ? [first] : [])];
    return { html: `<header class="pg-head">${kicker}${title}${parts.map((node) => nodeHtml(node, open, boxes)).join("")}</header>`, boxes: [], css };
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
    .map(
      (section, i) =>
        `<section class="pg-section" data-section="${i}"${tabs && i > 0 ? " hidden" : ""}>${nodeHtml(section.heading, open, boxes)}${section.nodes.map((node) => nodeHtml(node, open, boxes)).join("")}</section>`,
    )
    .join("");
  const tabBar = tabs
    ? `<nav class="pg-tabs" role="tablist">${sections.map((section, i) => `<button type="button" role="tab" data-tab="${i}" aria-selected="${i === 0}">${esc(plain(section.heading.runs))}</button>`).join("")}</nav>`
    : "";
  return {
    html: `<header class="pg-head">${kicker}${title}${head.map((node) => nodeHtml(node, open, boxes)).join("")}</header>${tabBar}${sectionHtml}`,
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
        items: block.items.map((item) => ({ label: item.label ? plain(item.label.runs) : null, parts: item.parts.map((p) => plain(p.runs)) })),
      })),
  };
}

module.exports = { renderPage, pageData, esc, BLOCK_NAMES: Object.keys(BLOCK_KINDS) };
