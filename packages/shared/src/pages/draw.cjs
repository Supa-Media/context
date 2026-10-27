/**
 * The first block kinds a page drew (`blocks.cjs`), in the page's own look:
 * big numbers on hairlines, bars against a limit, weekly bars, rails for
 * time, lanes for work. The richer kinds (vote, places, prices, itinerary,
 * tiers, contacts) are `drawRich.cjs`.
 *
 * Each takes the parsed block and `ctx` (`{ open, images }`) and returns HTML.
 * Values are read with `numberIn`/`shareIn`; widths are this file's numbers.
 */

const { numberIn, shareIn, fieldOf } = require("./blocks.cjs");
const { esc, part, plain, setting, itemName, faces } = require("./html.cjs");

/** A short name ("Zay", "LK", "Sam Okafor") drawn as a face; anything longer stays words. */
const looksLikeName = (text) => /^[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*)?$/.test(text.trim()) && text.trim().length <= 24;

const DRAW = {
  stats: (block, { open }) =>
    `<div class="pg-nums">${block.items
      .map((item) => `<div>${part(item, 0, open, "b")}${part(item, -1, open, "span")}${part(item, 1, open, "small")}</div>`)
      .join("")}</div>`,

  compare: (block, { open }) => {
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

  chart: (block, ctx) => (/^line$/i.test(setting(block, "type")) ? lineChart(block, ctx) : barChart(block, ctx)),

  progress: (block, { open }) =>
    `<div class="pg-progress">${block.items
      .map((item) => {
        const share = shareIn(item.parts[0].text) ?? 0;
        return `<div class="pg-prog-row${share >= 1 ? " done" : ""}">${part(item, -1, open, "span", "pg-cmp-name")}${part(item, 0, open, "span", "pg-cmp-value")}<div class="pg-track"><div class="pg-fill" style="width:${(share * 100).toFixed(1)}%"></div></div>${part(item, 1, open, "span", "pg-sub")}</div>`;
      })
      .join("")}</div>`,

  timeline: (block, { open }) =>
    `<ol class="pg-rail">${block.items
      .map((item, i) => {
        const state = (fieldOf(item, "state", "status")?.value.text ?? "").trim().toLowerCase();
        const cls = /^(done|yes|✓)$/.test(state) ? "done" : /^(now|doing|in progress)$/.test(state) ? "now" : "";
        const last = i === block.items.length - 1;
        return `<li class="${cls}">${part(item, -1, open, "time")}<div class="pg-rail-mark"><i></i>${last ? "" : "<s></s>"}</div><div class="pg-rail-t">${part(item, 0, open, "b")}${part(item, 1, open, "span")}</div></li>`;
      })
      .join("")}</ol>`,

  steps: (block, { open }) =>
    `<ol class="pg-steps">${block.items
      .map((item, i) => `<li><span class="pg-num">${i + 1}</span><div>${item.label ? part(item, -1, open, "b") : ""}${part(item, 0, open, item.label ? "span" : "b")}${part(item, 1, open, "span")}</div></li>`)
      .join("")}</ol>`,

  choose: (block, { open }) => {
    const chosen = setting(block, "chosen").toLowerCase();
    return `<div class="pg-choose" data-block="${block.from}">${block.items
      .map((item) => {
        const name = itemName(item);
        const on = chosen !== "" && name.toLowerCase() === chosen;
        return `<div class="pg-option${on ? " on" : ""}" role="radio" aria-checked="${on}" tabindex="0" data-choose="${esc(name)}"><div>${item.label ? part(item, -1, open, "b") : ""}${part(item, 0, open, item.label ? "span" : "b")}${part(item, 1, open, "span")}</div><span class="pg-tick">${on ? "Chosen" : "Choose"}</span></div>`;
      })
      .join("")}</div>`;
  },

  board: (block, { open }) => {
    const columns = new Map();
    for (const item of block.items) {
      const name = item.label ? plain(item.label.runs) : "";
      if (!columns.has(name)) columns.set(name, []);
      columns.get(name).push(item);
    }
    return `<div class="pg-lanes">${[...columns]
      .map(([name, items]) => {
        const done = /^(done|shipped|finished)$/i.test(name);
        return `<div class="pg-lane"><h4>${esc(name)}<span>${items.length}</span></h4>${items
          .map((item) => {
            const who = item.parts[1] ? plain(item.parts[1].runs) : "";
            const face = looksLikeName(who) ? faces([who]) : "";
            return `<div class="pg-task${done ? " done" : ""}"><span class="pg-bx"></span>${part(item, 0, open, "span")}${face || part(item, 1, open, "small")}</div>`;
          })
          .join("")}</div>`;
      })
      .join("")}</div>`;
  },

  people: (block, { open }) =>
    `<div class="pg-people">${block.items
      .map((item) => `<div class="pg-person">${faces([itemName(item)])}<div>${part(item, -1, open, "b")}${part(item, 0, open, "small")}${part(item, 1, open, "small")}</div></div>`)
      .join("")}</div>`,

  versus: (block, { open }) => {
    const better = setting(block, "better").toLowerCase();
    return (
      `<div class="pg-vs"><div class="pg-vs-head"><span></span><b>${esc(setting(block, "a"))}</b><b>${esc(setting(block, "b"))}</b></div>` +
      block.items
        .map((item) => `<div class="pg-vs-row">${part(item, -1, open, "span", "pg-key")}${part(item, 0, open, "span", better === "a" ? "win" : "")}${part(item, 1, open, "span", better === "b" ? "win" : "")}</div>`)
        .join("") +
      `</div>`
    );
  },
};

/** Bars as columns, the value over each and its label under it; the last one, the latest, in the accent. */
function barChart(block, { open }) {
  const values = block.items.map((item) => numberIn(item.parts[0].text) ?? 0);
  const goal = numberIn(setting(block, "goal"));
  const top = Math.max(...values.map(Math.abs), goal ?? 0) || 1;
  const unit = setting(block, "unit");
  return (
    `<figure class="pg-bars" role="img" aria-label="${esc(block.title || "chart")}"><div class="pg-bars-plot" style="grid-template-columns:repeat(${values.length},minmax(0,1fr))">` +
    (goal !== null ? `<div class="pg-bars-goal" style="bottom:${((Math.max(0, goal) / top) * 100).toFixed(1)}%"><span>${esc(setting(block, "goal"))}</span></div>` : "") +
    block.items
      .map((item, i) => `<div>${part(item, 0, open, "b")}<i style="height:${((Math.max(0, values[i]) / top) * 100).toFixed(1)}%"></i>${part(item, -1, open, "span")}</div>`)
      .join("") +
    `</div>${unit ? `<figcaption class="pg-foot">${esc(unit)}</figcaption>` : ""}</figure>`
  );
}

function lineChart(block, { open }) {
  const values = block.items.map((item) => numberIn(item.parts[0].text) ?? 0);
  const goal = numberIn(setting(block, "goal"));
  const lo = Math.min(0, ...values, goal ?? 0);
  const hi = Math.max(...values, goal ?? 0) * 1.1 || 1;
  const y = (v) => 180 - ((v - lo) / (hi - lo || 1)) * 170;
  const n = values.length;
  const w = 600;
  const x = (i) => (n === 1 ? w / 2 : 24 + (i * (w - 48)) / (n - 1));
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const marks =
    `<polyline class="pg-line" points="${points}"/>` +
    values.map((v, i) => `<circle class="pg-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5"><title>${esc(plain(block.items[i].parts[0].runs))}</title></circle>`).join("");
  const goalLine = goal !== null ? `<line class="pg-goal" x1="0" x2="${w}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}"/>` : "";
  return (
    `<figure class="pg-chart"><svg viewBox="0 0 ${w} 190" preserveAspectRatio="none" role="img" aria-label="${esc(block.title || "chart")}">` +
    `<line class="pg-axis" x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${goalLine}${marks}</svg>` +
    `<div class="pg-chart-keys" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${block.items
      .map((item) => `<div>${part(item, -1, open, "span", "pg-key")}${part(item, 0, open, "strong")}</div>`)
      .join("")}</div>${setting(block, "unit") ? `<figcaption class="pg-foot">${esc(setting(block, "unit"))}</figcaption>` : ""}</figure>`
  );
}

module.exports = { DRAW };
