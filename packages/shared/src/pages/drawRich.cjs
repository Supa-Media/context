/**
 * The block kinds that make a page more than a list (owner, 2026-10-27:
 * "more pictures, clever ways to display information"; drawn and reviewed in
 * the round 2 artboard): the pick with the vote inside it, places as photo
 * spreads with a fit bar and a fact strip, prices on one shared axis, an
 * itinerary of photo stops and walks, budget tiers, and contacts with buttons.
 *
 * The model writes words and rows (`blocks.cjs` says how); the layout is
 * chosen here from the shape of the data: a place with no photo gets its
 * initial, an unknown price a hollow dot and an Ask, seven places or more a
 * shortlist instead of spreads.
 */

const { numberIn, fieldOf, seatsIn, UNKNOWN } = require("./blocks.cjs");
const { esc, SAFE_HREF, runsHtml, part, fieldHtml, plain, setting, itemName, sources, photo, faces, voters, sourceLink, gallery } = require("./html.cjs");

/** Fields a block draws in a place of its own; any other field on a place is a fact. */
const KNOWN = new Set(["photo", "photos", "price", "seats", "votes", "address", "why", "map", "phone", "email", "text", "site", "walk", "state", "status", "source", "sources", "link", "url"]);

const photosOf = (item) => [...sources(fieldOf(item, "photos")), ...sources(fieldOf(item, "photo"))];

/** The pick in a vote or tiers block: who decided, else the most votes, else the writer's own (the first, or `pick:`). */
function pickOf(block) {
  const names = block.items.map(itemName);
  const chosen = setting(block, "chosen");
  if (chosen && names.some((name) => name.toLowerCase() === chosen.toLowerCase())) return { name: names.find((name) => name.toLowerCase() === chosen.toLowerCase()), decided: true };
  const counts = block.items.map((item) => voters(fieldOf(item, "votes")).length);
  const most = Math.max(...counts);
  if (most > 0) return { name: names[counts.indexOf(most)], decided: false };
  const pick = setting(block, "pick");
  return { name: names.find((name) => name.toLowerCase() === pick.toLowerCase()) ?? names[0], decided: false };
}

const ICONS = {
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  text: '<path d="M4 5h16v11H9l-5 4z"/>',
  site: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** A button that opens a phone, mail, text or web address; nothing else is drawn as one. */
function contactButton(kind, value, name) {
  const raw = value.trim();
  const digits = raw.replace(/[^\d+]/g, "");
  const href =
    kind === "phone" ? `tel:${digits}` : kind === "text" ? `sms:${digits}` : kind === "email" ? `mailto:${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!SAFE_HREF.test(href) || ((kind === "phone" || kind === "text") && digits.replace(/\D/g, "").length < 3)) return "";
  const verb = { phone: "Call", email: "Email", text: "Text", site: "Open the site of" }[kind];
  return `<a class="pg-ibtn" href="${esc(href)}" data-href="${esc(href)}" aria-label="${esc(`${verb} ${name}`)}" title="${esc(raw)}">${icon(kind)}</a>`;
}

/** A round step for an axis that ends near `max`: 1, 2 or 5 times a power of ten. */
function niceStep(max) {
  const raw = max / 3 || 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? raw;
}

/** "$" in "$14.50", "€" in "€9": the sign a total is written with. */
const currency = (text) => (/[$€£¥₦]/.exec(text) ?? [""])[0];
const money = (sign, n) => `${sign}${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n % 1 ? 2 : 0)}`;

const RICH = {
  vote: (block, ctx) => {
    const { open, me } = ctx;
    const pick = pickOf(block);
    const counted = new Set(block.items.flatMap((item) => voters(fieldOf(item, "votes"))));
    const expected = numberIn(setting(block, "voters"));
    const action = (setting(block, "action") || "Go with {pick}").replace(/\{pick\}/gi, pick.name);
    const mine = (item) => Boolean(me) && voters(fieldOf(item, "votes")).some((name) => name.toLowerCase() === String(me).toLowerCase());
    const options = block.items
      .map((item) => {
        const name = itemName(item);
        const on = block.items.some(mine) ? mine(item) : name === pick.name;
        return (
          `<div class="pg-vopt" role="radio" aria-checked="${on}" tabindex="0" data-vote="${esc(name)}">` +
          photo(photosOf(item)[0], ctx, { name }) +
          `<div>${item.label ? part(item, -1, open, "b") : part(item, 0, open, "b")}${part(item, item.label ? 0 : 1, open, "small")}${sourceLink(item)}</div>` +
          faces(voters(fieldOf(item, "votes"))) +
          `</div>`
        );
      })
      .join("");
    const tally = counted.size > 0 || expected !== null ? `<small>${counted.size}${expected !== null ? ` of ${expected}` : ""} voted</small>` : "";
    return (
      `<div class="pg-verdict"><div class="pg-verdict-say"><div class="pg-k">${pick.decided ? "Decided" : "The pick"}</div>` +
      `<blockquote><span class="pg-verdict-pick">${esc(block.title)}${block.words.length && !/[.!?:]$/.test(block.title) ? "." : ""}</span>${block.words.length ? ` <span data-edit>${runsHtml(block.words, open)}</span>` : ""}</blockquote></div>` +
      `<div class="pg-vote" role="radiogroup" aria-label="${esc(block.title)}" data-block="${block.from}">${options}` +
      `<div class="pg-act"><button type="button" class="pg-btn" data-choose="${esc(pick.name)}" aria-pressed="${pick.decided}">${pick.decided ? "✓ " : ""}${esc(action)}</button>${tally}</div></div></div>`
    );
  },

  places: (block, ctx) => {
    const { open } = ctx;
    const near = setting(block, "near");
    const need = seatsIn(setting(block, "need"));
    const map = sources(setting(block, "map") ? { value: { text: setting(block, "map") } } : null)[0];
    const mapHtml = map ? `<figure class="pg-map">${photo(map, ctx, { name: block.title || "Map", cls: "pg-map-img" })}</figure>` : "";
    const mapLink = (item) => {
      const query = [itemName(item), plain(item.parts[0].runs), near].filter(Boolean).join(", ");
      const href = `https://maps.apple.com/?q=${encodeURIComponent(query)}`;
      return `<a class="pg-maplink" href="${esc(href)}" data-href="${esc(href)}">Map</a>`;
    };
    const priceHtml = (item, cls = "pg-vprice") => {
      const price = fieldOf(item, "price");
      if (!price) return "";
      return UNKNOWN.test(price.value.text) ? `<span class="${cls} ask">Ask for price</span>` : fieldHtml(price, open, "span", cls);
    };
    if (block.items.length > 6) {
      return (
        mapHtml +
        `<ol class="pg-short">${block.items
          .map(
            (item, i) =>
              `<li><span class="pg-no">${i + 1}</span>${photo(photosOf(item)[0], ctx, { name: itemName(item) })}<div>${part(item, -1, open, "b")}${part(item, 0, open, "small")}</div>${priceHtml(item, "pg-short-price") || mapLink(item)}</li>`,
          )
          .join("")}</ol>`
      );
    }
    const spreads = block.items
      .map((item, i) => {
        const name = itemName(item);
        const bento = gallery(photosOf(item), ctx, { name, no: String(i + 1) });
        const seatsField = fieldOf(item, "seats");
        const seats = seatsIn(seatsField?.value.text);
        let fit = "";
        if (seats !== null && need !== null) {
          const top = Math.max(seats, need) * 1.1;
          fit =
            `<div class="pg-fit${seats < need ? " short" : ""}"><div class="pg-fit-lbl"><span>Seats ${fieldHtml(seatsField, open)}</span><span>you need ${esc(setting(block, "need"))}</span></div>` +
            `<div class="pg-fit-bar"><i style="width:${((seats / top) * 100).toFixed(1)}%"></i><u style="left:${((need / top) * 100).toFixed(1)}%"></u></div></div>`;
        } else if (seatsField) fit = `<div class="pg-fit-lbl"><span>Seats ${fieldHtml(seatsField, open)}</span></div>`;
        const facts = (item.fields ?? []).filter((field) => !KNOWN.has(field.key)).slice(0, 6);
        const factsHtml = facts.length
          ? `<div class="pg-facts">${facts
              .map((field) => {
                const v = field.value.text.trim().toLowerCase();
                const cls = /^(yes|y|✓|true|own|included)$/.test(v) ? "y" : /^(no|n|✕|false|none)$/.test(v) ? "n" : /^(\?|ask|unknown)$/.test(v) ? "q" : "";
                return `<div>${esc(field.name)}${fieldHtml(field, open, "b", cls)}</div>`;
              })
              .join("")}</div>`
          : "";
        return (
          `<article class="pg-venue">${bento}<div class="pg-venue-h"><div>${part(item, -1, open, "h4")}${part(item, 0, open, "span", "pg-where")}${sourceLink(item)}</div>${mapLink(item)}</div>` +
          `${priceHtml(item)}${fit}${factsHtml}${part(item, 1, open, "p", "pg-why")}</article>`
        );
      })
      .join("");
    return `${mapHtml}<div class="pg-venues${block.items.length === 2 ? " two" : ""}">${spreads}</div>`;
  },

  prices: (block, ctx) => {
    const { open } = ctx;
    const values = block.items.map((item) => (UNKNOWN.test(item.parts[0].text) ? null : numberIn(item.parts[0].text)));
    const known = values.filter((v) => v !== null);
    const step = niceStep(Math.max(...known, 1) * 1.1);
    const top = step * Math.ceil((Math.max(...known, 1) * 1.1) / step);
    const group = numberIn(setting(block, "for"));
    const per = setting(block, "per");
    const pickName = setting(block, "pick").toLowerCase();
    const cheapest = Math.min(...known);
    const sign = currency(block.items.map((item) => item.parts[0].text).join(" "));
    const ticks = [];
    for (let t = step; t <= top + 1e-9; t += step) ticks.push(t);
    const head =
      `<div class="pg-ticks"><span></span><div>${ticks.map((t, i) => `<span>${esc(money(sign, t))}${i === ticks.length - 1 && per ? ` a ${esc(per)}` : ""}</span>`).join("")}</div>` +
      `<span>${group !== null ? `for ${esc(setting(block, "for"))}` : ""}</span></div>`;
    const rows = block.items
      .map((item, i) => {
        const value = values[i];
        const name = itemName(item);
        const pick = pickName ? name.toLowerCase() === pickName : value !== null && value === cheapest;
        const left = value === null ? 100 : Math.min(100, (value / top) * 100);
        const dot = `<span class="pg-dot${value === null ? " hollow" : ""}" style="left:${left.toFixed(1)}%">${part(item, 0, open, "em")}</span>`;
        const total = value === null ? `<span class="pg-tot ask">Ask</span>` : group !== null ? `<span class="pg-tot">${esc(money(sign, value * group))}</span>` : "<span></span>";
        return `<div class="pg-prow${pick ? " pick" : ""}">${photo(photosOf(item)[0], ctx, { name })}<div>${part(item, -1, open, "b")}${part(item, 1, open, "span", "pg-what")}${sourceLink(item)}<div class="pg-scale">${dot}</div></div>${total}</div>`;
      })
      .join("");
    return `<div class="pg-plot">${head}${rows}</div>`;
  },

  itinerary: (block, ctx) => {
    const { open } = ctx;
    return `<div class="pg-stops">${block.items
      .map((item, i) => {
        const walk = fieldOf(item, "walk");
        const leg = walk && i < block.items.length - 1 ? `<div class="pg-leg"><span>Walk</span>${fieldHtml(walk, open)}</div>` : "";
        return `<div class="pg-stop">${part(item, -1, open, "time", "pg-tm")}${photo(photosOf(item)[0], ctx, { name: plain(item.parts[0].runs) })}<div>${part(item, 0, open, "b")}${part(item, 1, open, "span")}${sourceLink(item)}</div></div>${leg}`;
      })
      .join("")}</div>`;
  },

  tiers: (block, ctx) => {
    const { open } = ctx;
    const pick = pickOf(block);
    const writer = (setting(block, "pick") || itemName(block.items[0])).toLowerCase();
    return `<div class="pg-tiers" data-block="${block.from}">${block.items
      .map((item) => {
        const name = itemName(item);
        const on = name === pick.name;
        const names = voters(fieldOf(item, "votes"));
        const lines = (item.fields ?? []).filter((field) => !KNOWN.has(field.key));
        const pics = photosOf(item).slice(0, 3);
        return (
          `<div class="pg-tier${on ? " pick" : ""}"><div class="pg-tier-top">${part(item, -1, open, "span", "pg-k")}${name.toLowerCase() === writer ? `<span class="pg-badge">The pick</span>` : ""}</div>` +
          `<div class="pg-pp">${part(item, 0, open, "span")}${part(item, 1, open, "small")}</div>` +
          (pics.length ? `<div class="pg-strip">${pics.map((src) => photo(src, ctx, { name })).join("")}</div>` : "") +
          (lines.length ? `<ul>${lines.map((field) => `<li><span>${esc(field.name)}</span>${fieldHtml(field, open)}</li>`).join("")}</ul>` : "") +
          (names.length ? `<div class="pg-who">${faces(names)}${names.length} picked this</div>` : "") +
          `<button type="button" class="pg-btn${on ? "" : " quiet"}" data-choose="${esc(name)}" aria-pressed="${pick.decided && on}">${pick.decided && on ? "✓ Chosen" : "Go with this one"}</button></div>`
        );
      })
      .join("")}</div>`;
  },

  contacts: (block, { open }) =>
    `<div class="pg-contacts">${block.items
      .map((item) => {
        const name = itemName(item);
        const buttons = ["phone", "text", "email", "site"]
          .map((kind) => {
            const field = fieldOf(item, kind);
            return field ? contactButton(kind, field.value.text, name) : "";
          })
          .join("");
        return `<div class="pg-contact"><div>${part(item, -1, open, "b")}${part(item, 0, open, "small")}${part(item, 1, open, "small")}</div><div class="pg-ib">${buttons}</div></div>`;
      })
      .join("")}</div>`,
};

module.exports = { RICH, pickOf, photosOf };
