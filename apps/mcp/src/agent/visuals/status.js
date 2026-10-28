/**
 * Visual answers about how things stand (`./index.js`): work on a board, a
 * before-and-after chart, where money went, how-to steps, who is in a
 * meeting, and how a system fits together.
 */

import { DARK, LIGHT, SERIF, TONES, clamp, esc, heading, list, num, page, pct, photo } from "./kit.js";

/** Work by column: in progress, needs you, shipped. Each card a name, how far along, a note and an owner. */
export function board(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const columns = list(data.columns, 3);
  const tones = [[c.accentSoft, c.accent], [c.warmSoft, c.warm], [c.goodSoft, c.good]];
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="display: grid; grid-template-columns: repeat(${Math.max(1, columns.length)}, minmax(0, 1fr)); gap: 10px; flex-grow: 1">${columns
      .map((column, i) => {
        const [bg, ink] = tones[column.tone === "warn" ? 1 : column.tone === "good" ? 2 : column.tone === "blue" ? 0 : i % 3];
        const cards = list(column.items, 5);
        return `<div style="background: ${bg}; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow: hidden">
<div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 600; color: ${ink}"><div>${esc(column.name, 18)}</div><div style="padding: 2px 8px; border-radius: 999px; background: ${c.bg}">${Array.isArray(column.items) ? column.items.length : 0}</div></div>
${cards
  .map((card) => {
    const progress = num(card.progress);
    return `<div style="background: ${c.bg}; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px">
<div style="font-size: 16px; font-weight: 600; line-height: 1.25">${esc(card.name, 40)}</div>
${progress !== null ? `<div style="height: 6px; border-radius: 3px; background: ${c.track}; position: relative"><div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${pct(progress)}; border-radius: 3px; background: ${ink}"></div></div>` : ""}
<div style="display: flex; justify-content: space-between; align-items: center; gap: 6px"><div style="font-size: 13px; color: ${c.muted}">${esc(card.note, 26)}</div>${card.who ? `<div style="min-width: 24px; height: 24px; padding: 0 6px; border-radius: 12px; background: ${c.ink}; color: ${c.bg}; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center">${esc(initials(card.who), 3)}</div>` : ""}</div></div>`;
  })
  .join("")}</div>`;
      })
      .join("")}</div>`,
    { background: c.bg, ink: c.ink, padding: "36px 28px 28px" },
  );
}

const initials = (name) =>
  String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

/**
 * Numbers that moved: up to three headline figures (before, now, goal), then
 * bars for what moved them (fixes and the time each saved, spend by month).
 */
export function chart(data) {
  const c = DARK;
  const stats = list(data.stats, 3);
  const bars = list(data.bars, 6);
  const top = Math.max(1, ...bars.map((bar) => Math.abs(num(bar.value) ?? 0)));
  const states = { done: [c.good, c.goodSoft, 1], doing: [c.warm, c.warmSoft, 0.6], planned: [c.grey, c.track, 0.45] };
  const statTone = { good: c.good, warn: c.warm };
  return page(
    `${heading(c, data.kicker, data.title, { size: 36 })}
${stats.length ? `<div style="display: flex; align-items: center; gap: 16px; background: ${c.surface}; border-radius: 10px; padding: 16px 20px">${stats
      .map((stat, i) => `${i ? `<div style="font-size: 24px; color: ${c.muted}">→</div>` : ""}<div style="display: flex; flex-direction: column; min-width: 0"><div style="font-size: 13px; color: ${c.muted}">${esc(stat.label, 14)}</div><div style="font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 600; color: ${statTone[stat.tone] ?? c.ink}">${esc(stat.value, 9)}</div></div>`)
      .join("")}</div>` : ""}
<div style="display: flex; flex-direction: column; gap: 14px; flex-grow: 1">
${data.bars_title ? `<div style="font-size: 14px; font-weight: 600; color: ${c.muted}; ">${esc(data.bars_title, 40)}</div>` : ""}
${bars
  .map((bar) => {
    const [ink, soft, opacity] = states[bar.state] ?? states.done;
    const v = Math.abs(num(bar.value) ?? 0);
    return `<div style="display: flex; flex-direction: column; gap: 6px"><div style="display: flex; justify-content: space-between; align-items: center; gap: 10px"><div style="font-size: 18px; font-weight: 600">${esc(bar.name, 34)}</div>
<div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0"><div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 600">${esc(bar.display ?? bar.value, 10)}</div>${bar.state ? `<div style="font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: ${soft}; color: ${ink}">${esc(bar.state === "done" ? "Shipped" : bar.state === "doing" ? "In progress" : "Planned", 12)}</div>` : ""}</div></div>
<div style="height: 12px; border-radius: 6px; background: ${c.track}; position: relative"><div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${pct((v / top) * 100)}; border-radius: 6px; background: ${ink}; opacity: ${opacity}"></div></div></div>`;
  })
  .join("")}</div>`,
    { background: c.bg, ink: c.ink, gap: 22 },
  );
}

/** Where money went: the total, one stacked bar, and a row per category. */
export function spending(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const items = list(data.items, 7);
  const amounts = items.map((item) => Math.max(0, num(item.amount) ?? 0));
  const total = amounts.reduce((sum, n) => sum + n, 0) || 1;
  const colors = [c.accent, c.warm, c.plum, c.good, c.gold, c.grey, c.accentInk];
  return page(
    `<div style="display: flex; flex-direction: column; gap: 6px">${data.kicker ? `<div style="font-size: 15px; font-weight: 600; color: ${c.muted}">${esc(data.kicker, 60)}</div>` : ""}
<div style="display: flex; align-items: baseline; gap: 14px"><div style="font-size: 52px; font-weight: 600; letter-spacing: -0.02em">${esc(data.total, 12)}</div><div style="font-size: 18px; font-weight: 600; color: ${c.warm}">${esc(data.change, 26)}</div></div>
${data.title ? `<div style="font-size: 20px; font-weight: 600">${esc(data.title, 60)}</div>` : ""}</div>
<div style="display: flex; height: 26px; border-radius: 13px; overflow: hidden; gap: 3px">${items.map((_, i) => `<div style="width: ${pct((amounts[i] / total) * 100)}; background: ${colors[i]}"></div>`).join("")}</div>
<div style="display: flex; flex-direction: column; flex-grow: 1; border-top: 1px solid ${c.line}">${items
      .map(
        (item, i) => `<div style="display: flex; align-items: center; gap: 14px; flex-grow: 1; border-bottom: 1px solid ${c.line}"><div style="width: 14px; height: 14px; border-radius: 4px; background: ${colors[i]}; flex-shrink: 0"></div>
<div style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0"><div style="font-size: 18px; font-weight: 600">${esc(item.name, 26)}</div><div style="font-size: 14px; color: ${c.muted}">${esc(item.note, 44)}</div></div>
<div style="text-align: right; font-size: 20px; font-weight: 600; flex-shrink: 0">${esc(item.display ?? item.amount, 12)}</div></div>`,
      )
      .join("")}</div>`,
    { background: c.bg, ink: c.ink },
  );
}

/** How to do something: up to four numbered steps, a photo each, and what you need. */
export function steps(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const items = list(data.steps, 4);
  const tall = items.length <= 2;
  return page(
    `<div style="display: flex; justify-content: space-between; align-items: flex-end; gap: 12px">${heading(c, data.kicker, data.title, { size: 36 })}
${data.needs ? `<div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px; background: ${c.surface}; border-radius: 10px; padding: 8px 12px; flex-shrink: 0; max-width: 200px"><div style="font-size: 12px; color: ${c.muted}">You need</div><div style="font-size: 15px; font-weight: 600; text-align: right">${esc(data.needs, 40)}</div></div>` : ""}</div>
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; flex-grow: 1">${items
      .map(
        (step, i) => `<div style="background: ${c.surface}; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column">${photo(step.photo, {
          height: tall ? 330 : 150,
          radius: 0,
          tone: TONES[(i + 1) % TONES.length],
          label: step.source ? `photo · ${esc(step.source, 20)}` : "",
          extra: `<div style="position: absolute; top: 10px; left: 10px; width: 36px; height: 36px; border-radius: 18px; background: ${c.ink}; color: ${c.bg}; font-weight: 600; font-size: 18px; display: flex; align-items: center; justify-content: center">${i + 1}</div>`,
        })}
<div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 4px"><div style="font-size: 18px; font-weight: 600; line-height: 1.2">${esc(step.title, 34)}</div><div style="font-size: 14px; color: ${c.muted}; line-height: 1.35">${esc(step.tip, 60)}</div></div></div>`,
      )
      .join("")}</div>`,
    { background: c.bg, ink: c.ink, gap: 18 },
  );
}

/** Who is in a meeting or a chat: a face (or initials) each, when they last talked, and what to ask. */
export function people(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const items = list(data.people, 5);
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="display: flex; flex-direction: column; border-bottom: 1px solid ${c.line}">${items
      .map((person, i) => {
        const fresh = person.new === true;
        const face = person.photo
          ? `<div style="width: 72px; flex-shrink: 0">${photo(person.photo, { height: 72, radius: 36, tone: TONES[i % TONES.length] })}</div>`
          : `<div style="width: 72px; height: 72px; flex-shrink: 0; border-radius: 36px; background: ${TONES[i % TONES.length]}; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 600; color: #4A443C">${esc(initials(person.name ?? "?") || "?", 3)}</div>`;
        return `<div style="display: flex; gap: 16px; align-items: center; background: ${fresh ? c.warmSoft : "transparent"}; border-top: 1px solid ${c.line}; border-radius: ${fresh ? 10 : 0}px; padding: 14px ${fresh ? 12 : 0}px">${face}
<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0"><div style="display: flex; align-items: baseline; gap: 8px"><div style="font-family: ${SERIF}; font-size: 21px; font-weight: 600">${esc(person.name, 26)}</div><div style="font-size: 14px; color: ${c.muted}">${esc(person.role, 26)}</div></div>
<div style="font-size: 15px; color: ${c.body}">${esc(person.last, 50)}</div><div style="font-size: 15px; font-weight: 600; color: ${fresh ? c.warmInk : c.accent}">${esc(person.ask, 50)}</div></div></div>`;
      })
      .join("")}</div>
<div style="flex-grow: 1"></div>`,
    { background: c.bg, ink: c.ink, gap: 18 },
  );
}

/** How a system fits together: up to four layers of parts, top to bottom, each joined to the next with a label. */
export function system(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const layers = list(data.layers, 4);
  const parts = layers.map((layer) => list(layer.parts, 3));
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="display: flex; flex-direction: column; flex-grow: 1; justify-content: center">${layers
      .map((layer, i) => {
        const core = layer.core === true;
        const row = parts[i]
          .map((part) => {
            const missing = part.state === "missing";
            const style = core
              ? `background: ${c.ink}; color: ${c.bg}; border: 0`
              : missing
                ? `background: ${c.warmSoft}; border: 1px dashed ${c.warm}`
                : `background: ${c.surface}; border: ${i === 0 ? `2px solid ${c.accent}` : `1px solid ${c.line}`}`;
            return `<div style="${style}; border-radius: 10px; padding: 12px 14px; min-width: 0"><div style="font-size: ${parts[i].length === 3 ? 18 : 21}px; font-weight: 600">${esc(part.name, 26)}</div><div style="font-size: 14px; color: ${core ? c.track : missing ? c.warmInk : c.muted}">${esc(part.note, 34)}</div></div>`;
          })
          .join("");
        const link = i < layers.length - 1 ? `<div style="display: flex; justify-content: center; align-items: center; gap: 10px; height: ${layers.length > 3 ? 34 : 46}px"><div style="width: 2px; height: 100%; background: ${c.ink}"></div><div style="font-size: 14px; color: ${c.muted}">${esc(layer.link, 30)}</div></div>` : "";
        return `${layer.label ? `<div style="font-size: 13px; font-weight: 600; color: ${c.muted}; padding-bottom: 6px">${esc(layer.label, 30)}</div>` : ""}
<div style="display: grid; grid-template-columns: repeat(${clamp(parts[i].length, 1, 3)}, minmax(0, 1fr)); gap: 10px">${row}</div>${link}`;
      })
      .join("")}</div>`,
    { background: c.bg, ink: c.ink },
  );
}
