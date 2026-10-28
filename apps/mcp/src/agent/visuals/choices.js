/**
 * Visual answers for choosing between things (`./index.js`): options against a
 * budget, a gallery of photos, two things side by side, places nearby, and
 * tickets. Each takes the model's data and returns the card's inner HTML.
 */

import { CARD_HEIGHT, DARK, FIT_MAX, LIGHT, SERIF, TONES, clamp, esc, heading, list, num, page, pct, photo, photoUrl } from "./kit.js";
import { mapBlock } from "./map.js";

/** Options ranked against a limit: catering quotes, phone plans, anything with one number that decides. */
export function compare(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const items = list(data.items, 5);
  const values = items.map((item) => num(item.value));
  const limit = num(data.limit);
  const top = Math.max(limit ?? 0, ...values.map((v) => v ?? 0)) || 1;
  const best = data.lower_is_better === false ? Math.max(...values.map((v) => v ?? -Infinity)) : Math.min(...values.map((v) => v ?? Infinity));
  const rows = items
    .map((item, i) => {
      const v = values[i];
      const pick = item.pick === true || (v !== null && v === best && !items.some((other) => other.pick === true));
      const tight = limit !== null && v !== null && limit - v >= 0 && limit - v < limit * 0.07;
      const over = limit !== null && v !== null && v > limit;
      const bar = pick ? c.accent : over ? c.warm : tight ? c.warm : c.grey;
      const thumb = item.photo ? `<div style="width: 64px; flex-shrink: 0">${photo(item.photo, { height: 64, radius: 12, tone: TONES[i % TONES.length] })}</div>` : "";
      return `<div style="border-top: 1px solid ${c.line}; padding: 16px 0; display: flex; gap: 14px; align-items: center">
${thumb}<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0">
<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px">
<div style="display: flex; align-items: center; gap: 10px; min-width: 0"><div style="font-family: ${SERIF}; font-size: 23px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${esc(item.name, 30)}</div>
${pick ? `<div style="flex-shrink: 0; font-size: 13px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: ${c.accentSoft}; color: ${c.accent}">${esc(item.tag || "Tex's pick", 20)}</div>` : ""}</div>
<div style="font-size: 28px; font-weight: 600; letter-spacing: -0.01em; flex-shrink: 0">${esc(item.display ?? item.value, 14)}</div>
</div>
${v !== null ? `<div style="position: relative; height: 8px; border-radius: 999px; background: ${c.track}"><div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${pct((v / top) * 100)}; border-radius: 999px; background: ${bar}"></div>${limit !== null ? `<div style="position: absolute; top: -4px; bottom: -4px; left: ${pct((limit / top) * 100)}; width: 2px; background: ${c.ink}"></div>` : ""}</div>` : ""}
<div style="display: flex; justify-content: space-between; gap: 12px; font-size: 15px; color: ${c.muted}"><div>${esc(item.detail, 40)}</div><div style="font-weight: 600; color: ${over || tight ? c.warmInk : c.good}">${esc(item.note, 30)}</div></div>
</div></div>`;
    })
    .join("\n");
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
${data.subtitle ? `<div style="font-size: 18px; color: ${c.muted}; margin-top: -8px">${esc(data.subtitle, 80)}</div>` : ""}
<div style="display: flex; flex-direction: column; border-bottom: 1px solid ${c.line}">${rows}</div>
<div style="flex-grow: 1"></div>
${footer(c, data.footer)}`,
    { background: c.bg, ink: c.ink },
  );
}

/** A line along the bottom, signed "Tex · Context". */
export function footer(c, text) {
  return `<div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 14px; color: ${c.muted}; border-top: 1px solid ${c.line}; padding-top: 14px">
<div>${esc(text, 90)}</div>
<div style="flex-shrink: 0; font-weight: 600; color: ${c.ink}">Tex <span style="font-weight: 500; color: ${c.muted}">· Context</span></div>
</div>`;
}

const GALLERY_STYLES = {
  editorial: { bg: DARK.bg, ink: DARK.ink, muted: DARK.muted, line: DARK.line, chip: DARK.accent, chipInk: DARK.onAccent, font: SERIF },
  warm: { bg: LIGHT.bg, ink: LIGHT.ink, muted: LIGHT.muted, line: LIGHT.line, chip: LIGHT.accent, chipInk: LIGHT.onAccent, font: SERIF },
  polaroid: { bg: LIGHT.track, ink: LIGHT.ink, muted: LIGHT.body, line: LIGHT.line, chip: LIGHT.ink, chipInk: LIGHT.bg, font: SERIF },
};

/**
 * Things to look at: clothes, dishes, gifts, products. Two to four cards, a
 * photo each. `style` picks the look: editorial (clothes), warm (food, with
 * the pick large), polaroid (gifts).
 */
export function gallery(data) {
  const style = Object.hasOwn(GALLERY_STYLES, data.style) ? data.style : "editorial";
  const s = GALLERY_STYLES[style];
  const items = list(data.items, style === "warm" ? 3 : 4);
  const pickIndex = Math.max(0, items.findIndex((item) => item.pick === true));
  const chip = (text) => `<div style="position: absolute; top: 10px; left: 10px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: ${s.chip}; color: ${s.chipInk}">${esc(text, 24)}</div>`;
  const source = (item) => (item.source ? `photo · ${esc(item.source, 24)}` : "");
  let body;
  if (style === "warm") {
    const hero = items[pickIndex];
    const rest = items.filter((_, i) => i !== pickIndex);
    body = `${hero ? photo(hero.photo, { height: 270, radius: 10, tone: TONES[0], extra: `${hero.pick === true ? chip(hero.tag || "Tex's pick") : ""}<div style="position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 16px; border-radius: 0 0 10px 10px; background: rgba(26,23,20,0.82); color: #FFFDF9; display: flex; justify-content: space-between; align-items: baseline; gap: 12px"><div style="display: flex; flex-direction: column; min-width: 0"><div style="font-size: 24px; font-weight: 600">${esc(hero.name, 28)}</div><div style="font-size: 14px; color: #D8D2C9">${esc(hero.note, 40)}</div></div><div style="font-family: ${s.font}; font-size: 34px; font-weight: 600; flex-shrink: 0">${esc(hero.price, 12)}</div></div>` }) : ""}
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px">${rest
      .map(
        (item, i) => `<div style="display: flex; flex-direction: column; gap: 8px">${photo(item.photo, { height: 150, tone: TONES[(i + 4) % TONES.length], label: source(item) })}
<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px"><div style="font-size: 20px; font-weight: 600">${esc(item.name, 22)}</div><div style="font-family: ${s.font}; font-size: 26px; font-weight: 600">${esc(item.price, 12)}</div></div>
<div style="font-size: 15px; color: ${s.muted}">${esc(item.note, 40)}</div></div>`,
      )
      .join("")}</div>`;
  } else if (style === "polaroid") {
    const tilts = ["-1.5deg", "1.2deg", "1deg", "-1deg"];
    body = `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 22px; flex-grow: 1; padding-top: 6px">${items
      .map(
        (item, i) => `<div style="background: #FFFDF9; padding: 10px 10px 12px; border-radius: 4px; transform: rotate(${tilts[i]}); display: flex; flex-direction: column; gap: 6px; box-shadow: 0 6px 14px rgba(26,23,20,0.14)">
${photo(item.photo, { height: items.length > 2 ? 160 : 300, radius: 0, tone: TONES[i % TONES.length], label: source(item), extra: item.price ? `<div style="position: absolute; right: 8px; top: 8px; font-size: 16px; font-weight: 600; padding: 4px 9px; border-radius: 999px; background: #1A1714; color: #FFFDF9">${esc(item.price, 12)}</div>` : "" })}
<div style="font-family: Caveat, cursive; font-size: 27px; font-weight: 600; line-height: 1">${esc(item.name, 26)}</div>
<div style="font-size: 14px; color: ${s.muted}">${esc(item.note, 40)}</div></div>`,
      )
      .join("")}</div>`;
  } else {
    const columns = clamp(items.length, 1, 3);
    body = `<div style="display: grid; grid-template-columns: repeat(${columns}, minmax(0, 1fr)); gap: 12px; flex-grow: 1">${items
      .slice(0, 3)
      .map(
        (item, i) => `<div style="display: flex; flex-direction: column; gap: 10px">
${photo(item.photo, { height: 330, tone: TONES[i % TONES.length], label: source(item), style: item.pick === true ? `outline: 3px solid ${s.chip}; outline-offset: -3px;` : "", extra: item.pick === true ? chip(item.tag || "Tex's pick") : "" })}
<div style="font-family: ${s.font}; font-size: 30px; font-weight: 600">${esc(item.price, 12)}</div>
<div style="font-size: 16px; font-weight: 600; line-height: 1.25">${esc(item.name, 40)}</div>
<div style="font-size: 14px; color: ${s.muted}; line-height: 1.35">${esc(item.note, 60)}</div></div>`,
      )
      .join("")}</div>`;
  }
  return page(
    `${heading({ muted: s.muted }, data.kicker, data.title, { size: 40, font: s.font, kickerColor: s.muted })}
${body}
${data.footer ? `<div style="font-size: 14px; color: ${s.muted}; border-top: 1px solid ${s.line}; padding-top: 12px">${esc(data.footer, 90)}</div>` : ""}`,
    { background: s.bg, ink: s.ink, padding: "36px 32px 28px" },
  );
}

/** Two things side by side: homes, cars, jobs. A photo each, then rows with the better side marked. */
export function versus(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const sides = list(data.items, 2);
  while (sides.length < 2) sides.push({});
  const rows = list(data.rows, 7);
  const cell = (text, wins) => `<div style="font-size: 18px; font-weight: ${wins ? 700 : 500}; color: ${wins ? c.good : c.body}">${wins ? "✓ " : ""}${esc(text, 22)}</div>`;
  return page(
    `${heading(c, data.kicker, data.title, { size: 36 })}
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px">${sides
      .map(
        (side, i) => `<div style="display: flex; flex-direction: column; gap: 8px">${photo(side.photo, {
          height: 180,
          tone: TONES[i + 1],
          label: side.source ? `photo · ${esc(side.source, 20)}` : "",
          extra: `<div style="position: absolute; top: 10px; left: 10px; width: 36px; height: 36px; border-radius: 18px; background: ${c.ink}; color: ${c.bg}; font-weight: 600; font-size: 18px; display: flex; align-items: center; justify-content: center">${i === 0 ? "A" : "B"}</div>`,
        })}<div style="font-family: ${SERIF}; font-size: 20px; font-weight: 600">${esc(side.name, 30)}</div></div>`,
      )
      .join("")}</div>
<div style="display: flex; flex-direction: column; border-top: 1px solid ${c.line}; flex-grow: 1">${rows
      .map(
        (row) => `<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: center; padding: 0 2px; flex-grow: 1; border-bottom: 1px solid ${c.line}">
<div style="font-size: 15px; color: ${c.muted}; font-weight: 600">${esc(row.label, 20)}</div>${cell(row.a, row.better === "a")}${cell(row.b, row.better === "b")}</div>`,
      )
      .join("")}</div>`,
    { background: c.bg, ink: c.ink, gap: 16 },
  );
}

/** The shortest a fitted card is drawn. */
const MIN_FIT = 360;

/** About how tall one place's row is drawn, a little over, for a screenshot Worker that can't fit the card to it. */
function placeRow(item) {
  const said = (text) => typeof text === "string" && text.trim() !== "";
  const wide = (photoUrl(item.photo) ? 410 : 536) - (said(item.distance) ? 84 : 0);
  const lines = (text, px) => (said(text) ? Math.ceil(Math.min(text.length, 140) / (wide / px)) : 0);
  const where = [item.hours, item.address].filter(said).join(" · ");
  const text = 30 + 27 * Math.max(1, lines(item.name, 12)) + (said(item.cuisine) || said(item.price) ? 22 : 0) + 22 * (lines(item.detail, 7) + lines(where, 7)) + (said(item.note) ? 6 + 22 * lines(item.note, 7.6) : 0);
  return Math.max(text, photoUrl(item.photo) ? 141 : 0);
}

/** Places to go: restaurants, hotels, doctors. Numbered, a photo each, with how far. */
export function places(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  // As many as they asked for: "top 5" is five rows, not four (owner, 2026-10-27).
  const items = list(data.items, 6);
  // No photo, no slot: an empty coloured block reads as a picture that failed (owner, 2026-10-26).
  const size = 112;
  const rows = items.map((item, i) => {
    const pic = photoUrl(item.photo);
    const logo = photoUrl(item.logo);
    const badge = `<div style="width: 26px; height: 26px; border-radius: 13px; background: ${c.accent}; color: ${c.onAccent}; font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0">${i + 1}</div>`;
    const said = (text) => typeof text === "string" && text.trim() !== "";
    const tag = item.pick === true ? item.tag || "Tex's pick" : item.tag;
    const chip = said(tag) ? `<div style="flex-shrink: 0; font-size: 13px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: ${c.accentSoft}; color: ${c.accent}">${esc(tag, 40)}</div>` : "";
    const kind = [item.cuisine, item.price].filter(said).map((text) => esc(text, 40)).join(" · ");
    const lines = [item.detail, [item.hours, item.address].filter((part) => typeof part === "string" && part.trim() !== "").join(" · ")]
      .filter((line) => typeof line === "string" && line.trim() !== "")
      .map((line) => `<div style="font-size: 14px; line-height: 1.3; color: ${c.muted}">${esc(line, 140)}</div>`)
      .join("");
    const distance = typeof item.distance === "string" && item.distance.trim() !== "";
    return `<div style="display: flex; gap: 14px; align-items: flex-start; border-top: 1px solid ${c.line}; padding: 14px 0">
${pic ? `<div style="width: ${size}px; flex-shrink: 0">${photo(item.photo, { height: size, radius: 10, tone: c.track })}</div>` : ""}
<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0">
<div style="display: flex; align-items: center; gap: 10px">${badge}${logo ? `<div style="width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0; background: url('${logo}') center / contain no-repeat"></div>` : ""}<div style="font-family: ${SERIF}; font-size: 22px; line-height: 1.15; font-weight: 600; min-width: 0">${esc(item.name, 60)}</div>${chip}</div>
${kind ? `<div style="font-size: 14px; color: ${c.muted}">${kind}</div>` : ""}${lines}${item.note ? `<div style="font-family: ${SERIF}; font-size: 16px; line-height: 1.35; color: ${c.body}">${esc(item.note, 140)}</div>` : ""}</div>
${distance ? `<div style="text-align: right; flex-shrink: 0; padding-right: 4px"><div style="font-size: 18px; font-weight: 600">${esc(item.distance, 12)}</div>${item.distance_label ? `<div style="font-size: 13px; color: ${c.muted}">${esc(item.distance_label, 14)}</div>` : ""}</div>` : ""}</div>`;
  });
  // The card is as tall as what it holds (`fit`), so a short list leaves no empty band; the map (`./map.js`) sits above the rows, its pins numbered like them.
  const map = mapBlock(c, data.map);
  const height = clamp(140 + items.reduce((sum, item) => sum + placeRow(item), 0) + (data.footer ? 50 : 0) + (map ? Number(data.map.height) + 20 : 0), MIN_FIT, FIT_MAX);
  return {
    html: page(
      `${heading(c, data.kicker, data.title, { size: 36 })}
${map}
<div style="display: flex; flex-direction: column; border-bottom: 1px solid ${c.line}">${rows.join("")}</div>
${data.footer ? footer(c, data.footer) : ""}`,
      { background: c.bg, ink: c.ink, height, fit: true },
    ),
    height,
    fit: true,
  };
}

/**
 * Stops on a map: a day's errands, a trip's sights, where to meet. The map is
 * the gateway's (`./map.js`), numbered like the list under it; without one the
 * list still reads on its own.
 */
export function mapCard(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const stops = list(data.stops, 6);
  const map = mapBlock(c, data.map);
  const rows = stops
    .map(
      (stop, i) => `<div style="display: flex; gap: 12px; align-items: center; border-top: 1px solid ${c.line}; padding: 11px 0">
<div style="width: 26px; height: 26px; border-radius: 13px; background: ${c.accent}; color: ${c.onAccent}; font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0">${i + 1}</div>
<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px"><div style="font-family: ${SERIF}; font-size: 19px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${esc(stop.name, 50)}</div>
${stop.note || stop.address ? `<div style="font-size: 14px; line-height: 1.3; color: ${c.muted}">${esc(stop.note || stop.address, 90)}</div>` : ""}</div>
${stop.time ? `<div style="font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 500; color: ${c.muted}; flex-shrink: 0; max-width: 150px; text-align: right; line-height: 1.3">${esc(stop.time, 24)}</div>` : ""}</div>`,
    )
    .join("");
  const height = clamp(140 + (map ? Number(data.map.height) + 16 : 0) + stops.length * 84 + (data.footer ? 46 : 0), MIN_FIT, FIT_MAX);
  return {
    html: page(
      `${heading(c, data.kicker, data.title, { size: 34 })}
${map}
<div style="display: flex; flex-direction: column; border-bottom: 1px solid ${c.line}">${rows}</div>
${data.footer ? footer(c, data.footer) : ""}`,
      { background: c.bg, ink: c.ink, gap: 16, height, fit: true },
    ),
    height,
    fit: true,
  };
}

/** Tickets: flights, trains, shows. Boarding-pass cards and up to three facts underneath. */
export function tickets(data) {
  const items = list(data.items, 3);
  const facts = list(data.facts, 3);
  return page(
    `${heading({ muted: DARK.muted }, data.kicker, data.title, { size: 36, kickerColor: DARK.muted })}
${items
  .map(
    (t) => `<div style="display: flex; background: ${t.pick === true ? "#FFFDF9" : "#EDE8E0"}; color: #1A1714; border-radius: 10px; overflow: hidden; ${t.pick === true ? `outline: 3px solid ${DARK.accent}; outline-offset: -3px;` : ""}">
<div style="flex-grow: 1; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; min-width: 0">
<div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: 600; color: #635C52"><div>${esc(t.name, 26)}</div><div>${esc(t.tag ?? (t.pick === true ? "Tex's pick" : ""), 16)}</div></div>
<div style="display: flex; align-items: center; gap: 12px"><div style="font-family: 'JetBrains Mono', monospace; font-size: 28px; font-weight: 600">${esc(t.depart, 8)}</div>
<div style="flex-grow: 1; display: flex; flex-direction: column; align-items: center; gap: 2px"><div style="font-size: 13px; color: #635C52">${esc(t.duration, 14)}</div><div style="width: 100%; border-top: 2px dashed #A39C91"></div><div style="font-size: 13px; color: #635C52">${esc(t.stops, 16)}</div></div>
<div style="font-family: 'JetBrains Mono', monospace; font-size: 28px; font-weight: 600">${esc(t.arrive, 8)}</div></div>
<div style="font-size: 15px; color: #4A443C">${esc(t.note, 60)}</div></div>
<div style="width: 132px; flex-shrink: 0; border-left: 2px dashed #D8D2C9; padding: 18px 12px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px"><div style="font-size: 30px; font-weight: 600">${esc(t.price, 8)}</div><div style="font-size: 13px; color: #635C52">${esc(t.price_label || "per person", 14)}</div></div></div>`,
  )
  .join("\n")}
<div style="flex-grow: 1"></div>
${facts.length ? `<div style="display: grid; grid-template-columns: repeat(${facts.length}, minmax(0, 1fr)); gap: 10px">${facts.map((f) => `<div style="background: ${DARK.surface}; border-radius: 10px; padding: 12px 14px"><div style="font-size: 13px; color: ${DARK.muted}">${esc(f.label, 18)}</div><div style="font-size: 22px; font-weight: 600">${esc(f.value, 14)}</div></div>`).join("")}</div>` : ""}`,
    { background: DARK.bg, ink: DARK.ink, gap: 18 },
  );
}

/**
 * One option on its own card, for a set of them sent as one swipeable
 * carousel: a big photo, its number ("2 of 4") so they can answer "the 2nd
 * one", the price and up to four facts.
 */
export function option(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const facts = list(data.facts, 4);
  const index = num(data.index);
  const of = num(data.of);
  const number = index !== null ? `${clamp(Math.round(index), 1, 99)}${of !== null ? ` of ${clamp(Math.round(of), 1, 99)}` : ""}` : "";
  const pick = data.pick === true;
  const pill = (text, bg, ink) => `<div style="font-size: 15px; font-weight: 600; padding: 5px 11px; border-radius: 999px; background: ${bg}; color: ${ink}">${text}</div>`;
  const badge = number ? pill(esc(number, 10), "rgba(255,253,249,0.92)", "#1A1714") : "";
  const tag = pick || data.tag ? pill(esc(data.tag || "Tex's pick", 20), c.accent, c.onAccent) : "";
  const over = (html, side) => (html ? `<div style="position: absolute; top: 14px; ${side}: 14px">${html}</div>` : "");
  // No photo, no slot: a letter in a coloured block read as a picture that failed (owner, 2026-10-27: "why isn't it adding images?").
  const top = photoUrl(data.photo)
    ? photo(data.photo, { height: 380, radius: 10, tone: TONES[((index ?? 1) - 1 + TONES.length) % TONES.length], label: data.source ? `photo · ${esc(data.source, 24)}` : "", extra: over(badge, "left") + over(tag, "right") })
    : badge || tag
      ? `<div style="display: flex; justify-content: space-between; align-items: center">${badge || "<div></div>"}${tag}</div>`
      : "";
  // A card with no photo is as tall as what it holds, not a photo's height of nothing.
  const height = photoUrl(data.photo) ? CARD_HEIGHT : clamp(270 + Math.ceil(facts.length / 2) * 100 + (data.note ? 70 : 0), 340, CARD_HEIGHT);
  const html = page(
    `${top}
${data.kicker ? `<div style="font-size: 15px; font-weight: 500; color: ${c.muted}">${esc(data.kicker, 60)}</div>` : ""}
<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-top: -8px">
<div style="font-family: ${SERIF}; font-size: 34px; line-height: 1.08; font-weight: 600; letter-spacing: -0.01em; min-width: 0">${esc(data.name, 40)}</div>
<div style="text-align: right; flex-shrink: 0"><div style="font-size: 30px; font-weight: 600; letter-spacing: -0.01em; color: ${pick ? c.accent : c.ink}">${esc(data.price, 12)}</div>${data.price_note ? `<div style="font-size: 14px; color: ${c.muted}">${esc(data.price_note, 24)}</div>` : ""}</div>
</div>
${facts.length ? `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; border-bottom: 1px solid ${c.line}">${facts.map((f) => `<div style="border-top: 1px solid ${c.line}; padding: 10px 0"><div style="font-size: 13px; color: ${c.muted}">${esc(f.label, 24)}</div><div style="font-size: 17px; line-height: 1.25; font-weight: 600">${esc(f.value, 60)}</div></div>`).join("")}</div>` : ""}
${data.note ? `<div style="font-family: ${SERIF}; font-size: 17px; line-height: 1.4; color: ${c.body}">${esc(data.note, 140)}</div>` : ""}
<div style="flex-grow: 1"></div>
${footer(c, number ? `Reply ${clamp(Math.round(index), 1, 99)} for more on this one` : "")}`,
    { background: c.bg, ink: c.ink, gap: 16, height },
  );
  return { html, height };
}
