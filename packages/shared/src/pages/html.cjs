/**
 * The small pieces every page drawing is made of: escaping, a run of words
 * with its source map, a block item's part, a photo slot, a row of faces.
 *
 * Shared by `render.cjs` (the page and its nodes), `draw.cjs` and
 * `drawRich.cjs` (the blocks) and `cover.cjs` (the first screen), so the one
 * rule holds in all of them: nothing from the note reaches the markup except
 * as escaped text, a number computed here, or a class name chosen here.
 */

const { runsText } = require("./inline.cjs");

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Only these link targets are drawn as links; the runtime asks the app before opening any. */
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|sms:)[^\s"'<>]*$/i;

/**
 * A picture the page names (`photo: stand.jpg`): a workspace file the app
 * loads for the frame, or one a cover was handed as bytes. Never a script, a
 * style or anything with a scheme other than the web's.
 */
const SAFE_SRC = /^(?!\s)(?!(?:javascript|data|vbscript|file):)[^"'<>\s][^"'<>]{0,299}$/i;

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

const plain = (runs) => runsText(runs ?? []).trim();

/** One part of a block item (`-1` is its label): its words, editable in place. */
function part(item, index, open, tag = "span", cls = "") {
  const p = index === -1 ? item.label : item.parts[index];
  if (!p || p.text === "") return "";
  return `<${tag} class="${cls}" data-edit>${runsHtml(p.runs, open)}</${tag}>`;
}

/** A field's words, editable in place, or "" when the item has none of those names. */
function fieldHtml(field, open, tag = "span", cls = "") {
  if (!field) return "";
  return `<${tag} class="${cls}" data-edit>${runsHtml(field.value.runs, open)}</${tag}>`;
}

const setting = (block, key) => (block.settings[key] ? block.settings[key].value.trim() : "");

/** The name an item is known by: its label, or its first part. */
const itemName = (item) => plain(item.label ? item.label.runs : item.parts[0].runs);

/** The pictures a field names, split at commas: `photos: a.jpg, b.jpg`. */
function sources(field) {
  if (!field) return [];
  return field.value.text
    .split(",")
    .map((name) => name.trim().replace(/^<|>$/g, ""))
    .filter((name) => SAFE_SRC.test(name))
    .slice(0, 9);
}

/**
 * A photo slot. With a source, an `<img>` the runtime fills (`data-src`), or,
 * on a cover, the bytes it was handed (`images`); without, the first letter of
 * what it shows on a tint, so a place with no photo still has a face.
 */
function photo(src, ctx, { name = "", cls = "", label = "" } = {}) {
  const initial = esc((name.match(/[A-Za-z0-9]/) ?? [""])[0].toUpperCase());
  const ready = src && ctx.images && ctx.images.get(src);
  const img = !src ? "" : ready ? `<img src="${esc(ready)}" alt="${esc(name)}">` : `<img data-src="${esc(src)}" alt="${esc(name)}">`;
  return `<div class="pg-ph ${cls}" data-i="${initial}">${img}${label ? `<span class="pg-ph-label">${esc(label)}</span>` : ""}</div>`;
}

/** People as overlapping initials, each in one of six colors picked by their name. */
function faces(names, cls = "") {
  if (names.length === 0) return "";
  const hue = (name) => [...name].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6;
  const initials = (name) =>
    /^[A-Za-z]{1,3}$/.test(name)
      ? name.toUpperCase()
      : name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("");
  return `<span class="pg-faces ${cls}">${names
    .slice(0, 6)
    .map((name) => `<i class="f${hue(name)}" title="${esc(name)}">${esc(initials(name))}</i>`)
    .join("")}${names.length > 6 ? `<i class="more">+${names.length - 6}</i>` : ""}</span>`;
}

/** The names in a `votes:` field. */
const voters = (field) => (field ? field.value.text.split(",").map((name) => name.trim()).filter((name) => name && !/^(none|-)$/i.test(name)).slice(0, 40) : []);

module.exports = { esc, SAFE_HREF, SAFE_SRC, runsHtml, plain, part, fieldHtml, setting, itemName, sources, photo, faces, voters };
