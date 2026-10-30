/**
 * A page's first screen, chosen by what the page is (`kind:` in its front
 * matter; owner, 2026-10-27, round 2 artboard):
 *
 *  - `research` (and a page with no kind): the editorial split, a photo then
 *    the title on paper, side by side on a wide screen.
 *  - `plan`: a collage of three photos over the title.
 *  - `status`: one big number (`number: 412 of 1,000`) on a dark band, with a
 *    field of a thousand dots filled to it.
 *
 * Under the title: the opening words (the dek), and a status line, a pill
 * from `status:`. Photos come from `cover:` or, left out, the first ones the
 * page's blocks name, so a cover is never blank when the page has pictures.
 */

const { numberIn } = require("./blocks.cjs");
const { photosOf } = require("./drawRich.cjs");
const { esc, sources, photo } = require("./html.cjs");

const KINDS = { research: "Research", plan: "Plan", status: "Status" };

/** Words in a status that mean things are fine, so its pill is green rather than amber. */
const FINE = /\b(on track|done|booked|confirmed|ready|sent|paid|complete|approved|all set|decided)\b/i;
const NOT = /\b(not|nothing|no|un\w*|behind|late|blocked)\b/i;

/** The kind a page is drawn as. */
function pageKind(fields) {
  const kind = String(fields.kind ?? "").trim().toLowerCase();
  if (Object.hasOwn(KINDS, kind)) return kind;
  return fields.number ? "status" : "research";
}

/** The small line over the title: `kicker:` as written, else the kind and who it is for. */
function kickerOf(fields, kind) {
  if (fields.kicker) return fields.kicker;
  return [fields.kind ? KINDS[kind] : "", fields.for ? `for ${fields.for}` : ""].filter(Boolean).join(" · ");
}

function statusLine(fields) {
  if (!fields.status && !fields.updated) return "";
  const fine = fields.status && FINE.test(fields.status) && !NOT.test(fields.status);
  return (
    `<div class="pg-statusline">${fields.status ? `<span class="pg-pill${fine ? " ok" : ""}">${esc(fields.status)}</span>` : ""}` +
    `${fields.updated ? `<span>${esc(fields.updated)}</span>` : ""}</div>`
  );
}

/** "412 of 1,000" as the number, the total and its share, for the big figure and its dots. */
function numberOf(text) {
  const m = /^\s*([^\d-]*-?\d[\d,.]*\s*\S*?)\s*(?:of|\/|out of)\s*([^\d]*\d[\d,.]*.*)$/i.exec(String(text ?? ""));
  if (!m) return { big: String(text ?? "").trim(), total: "", share: null };
  const n = numberIn(m[1]);
  const total = numberIn(m[2]);
  return { big: m[1].trim(), total: m[2].trim(), share: n !== null && total ? Math.max(0, Math.min(1, n / total)) : null };
}

/** A thousand dots, 40 by 25, filled row by row to the share: three rectangles over two patterns, not a thousand circles. */
function dotField(share, label) {
  const on = Math.round(share * 1000);
  const rows = Math.floor(on / 40);
  const rest = on % 40;
  const dot = (id, cls) => `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse"><circle class="${cls}" cx="5" cy="5" r="3.4"/></pattern>`;
  return (
    `<svg class="pg-dots" viewBox="0 0 400 250" role="img" aria-label="${esc(label)}"><defs>${dot("pg-dot-off", "off")}${dot("pg-dot-on", "on")}</defs>` +
    `<rect width="400" height="250" fill="url(#pg-dot-off)"/>` +
    (rows ? `<rect width="400" height="${rows * 10}" fill="url(#pg-dot-on)"/>` : "") +
    (rest ? `<rect y="${rows * 10}" width="${rest * 10}" height="10" fill="url(#pg-dot-on)"/>` : "") +
    `</svg>`
  );
}

/** The photos a cover shows: `cover:` first, then the first ones the page's blocks name. */
function coverPhotos(page, nodes) {
  const named = sources(page.fields.cover ? { value: { text: page.fields.cover } } : null);
  const found = nodes.filter((node) => node.type === "block").flatMap((block) => block.items.flatMap(photosOf));
  return [...new Set([...named, ...found])].slice(0, 3);
}

/**
 * The cover's HTML. `title` and `dek` are already drawn (the note's own `#`
 * heading and first paragraph, editable in place) or the front matter's title.
 */
function coverHtml(page, nodes, { title, dek }, ctx) {
  const kind = pageKind(page.fields);
  const kicker = kickerOf(page.fields, kind);
  const k = kicker ? `<div class="pg-k">${esc(kicker)}</div>` : "";
  const status = statusLine(page.fields);
  const pics = coverPhotos(page, nodes);
  const name = page.title || "";

  if (kind === "status") {
    const number = numberOf(page.fields.number);
    const big = number.big ? `<div class="pg-big">${esc(number.big)}${number.total ? `<small> / ${esc(number.total)}</small>` : ""}</div>` : "";
    const dots = number.share !== null ? dotField(number.share, `${number.big} of ${number.total}`) : "";
    return `<header class="pg-cover pg-cover-num" data-kind="status"><div class="pg-in"><div class="pg-lead">${k}${title}${big}${status}${dek}</div>${dots}</div></header>`;
  }
  if (kind === "plan" && pics.length > 0) {
    return (
      `<header class="pg-cover" data-kind="plan"><div class="pg-cover-col n${pics.length}">${pics.map((src) => photo(src, ctx, { name })).join("")}</div>` +
      `<div class="pg-in pg-cover-t">${k}${title}${dek}${status}</div></header>`
    );
  }
  if (pics.length > 0) {
    return `<header class="pg-cover pg-cover-split" data-kind="${kind}">${photo(pics[0], ctx, { name })}<div class="pg-in pg-cover-t">${k}${title}${dek}${status}</div></header>`;
  }
  return `<header class="pg-cover pg-cover-plain" data-kind="${kind}"><div class="pg-in pg-cover-t">${k}${title}${dek}${status}</div></header>`;
}

module.exports = { coverHtml, pageKind, numberOf };
