/**
 * Visual answers laid out in time (`./index.js`): a trip by day, one day hour
 * by hour, a plan over weeks, and a habit's streak.
 */

import { DARK, LIGHT, SERIF, clamp, esc, heading, list, num, page, pct } from "./kit.js";

/** A trip or event, by day: up to three days of stops, and what's booked. */
export function trip(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const days = list(data.days, 3);
  const colors = [c.accent, c.warm, c.good];
  const most = days.length === 3 ? 4 : 5;
  const chips = list(data.chips, 3);
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="display: grid; grid-template-columns: repeat(${Math.max(1, days.length)}, minmax(0, 1fr)); gap: 12px; flex-grow: 1; min-height: 0">${days
      .map(
        (day, d) => `<div style="background: ${c.surface}; border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 2px; overflow: hidden">
<div style="font-size: 15px; font-weight: 600; color: ${colors[d]}; padding-bottom: 8px">${esc(day.name, 20)}</div>
${list(day.stops, most)
  .map(
    (stop) => `<div style="display: flex; gap: 10px"><div style="display: flex; flex-direction: column; align-items: center; width: 12px; flex-shrink: 0"><div style="width: 12px; height: 12px; border-radius: 6px; background: ${colors[d]}; margin-top: 5px"></div><div style="width: 2px; flex-grow: 1; background: ${c.line}"></div></div>
<div style="display: flex; flex-direction: column; gap: 1px; padding-bottom: 12px; min-width: 0"><div style="font-size: 14px; font-weight: 600; color: ${c.muted}">${esc(stop.time, 12)}</div><div style="font-family: ${SERIF}; font-size: ${days.length === 3 ? 17 : 19}px; font-weight: 600; line-height: 1.2">${esc(stop.what, 34)}</div><div style="font-size: 14px; color: ${c.muted}">${esc(stop.note, 34)}</div></div></div>`,
  )
  .join("")}</div>`,
      )
      .join("")}</div>
${chips.length ? `<div style="display: flex; gap: 10px">${chips.map((chip) => tile(c, chip)).join("")}</div>` : ""}`,
    { background: c.bg, ink: c.ink },
  );
}

/** A small fact tile; `tone` good, warn or plain. */
export function tile(c, chip) {
  const tone = chip.tone === "warn" ? [c.warmSoft, c.warm] : chip.tone === "good" ? [c.goodSoft, c.good] : [c.accentSoft, c.accent];
  return `<div style="flex: 1; background: ${tone[0]}; border-radius: 10px; padding: 12px 14px; min-width: 0"><div style="font-size: 13px; color: ${tone[1]}; font-weight: 600">${esc(chip.label, 20)}</div><div style="font-size: 20px; font-weight: 600">${esc(chip.value, 22)}</div></div>`;
}

/** "9:30", "9:30 AM", "14:00" as hours after midnight, or null. */
export function hours(value) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(value ?? ""));
  if (!m) return null;
  let h = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  if (h > 23 || minutes > 59) return null;
  if (m[3]) {
    if (h > 12 || h === 0) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  }
  return h + minutes / 60;
}

const clock = (h) => {
  const whole = Math.floor(h) % 24;
  return `${whole % 12 === 0 ? 12 : whole % 12} ${whole >= 12 ? "PM" : "AM"}`;
};

/** One day, hour by hour: meetings, free time, travel and the thing to watch. */
export function day(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const events = list(data.events, 9)
    .map((event) => ({ ...event, s: hours(event.start), e: hours(event.end) }))
    .filter((event) => event.s !== null && event.e !== null && event.e > event.s);
  const first = Math.floor(Math.min(8, ...events.map((event) => event.s)));
  const last = Math.ceil(Math.max(first + 6, ...events.map((event) => event.e)));
  const span = clamp(last - first, 6, 14);
  const px = Math.floor(540 / span);
  const kinds = {
    meeting: [c.accentSoft, "0", c.accentInk],
    free: [c.goodSoft, `1.5px dashed ${c.good}`, c.good],
    travel: [c.track, "0", c.body],
    warn: [c.warmSoft, "0", c.warmInk],
  };
  const lines = Array.from({ length: span + 1 }, (_, i) => `<div style="position: absolute; left: 0; right: 0; top: ${i * px}px; display: flex; align-items: center; gap: 10px"><div style="width: 52px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: ${c.muted}; text-align: right">${clock(first + i)}</div><div style="flex-grow: 1; height: 1px; background: ${c.line}"></div></div>`).join("");
  const blocks = events
    .filter((event) => event.s < first + span)
    .map((event) => {
      const [bg, border, ink] = kinds[event.kind] ?? kinds.meeting;
      const top = (event.s - first) * px + 8;
      const height = Math.max(24, (Math.min(event.e, first + span) - event.s) * px - 4);
      return `<div style="position: absolute; left: 66px; right: 0; top: ${top}px; height: ${height}px; border-radius: 10px; padding: 6px 14px; background: ${bg}; border: ${border}; color: ${ink}; display: flex; justify-content: space-between; align-items: center; gap: 10px; overflow: hidden"><div style="font-size: ${height < 40 ? 15 : 18}px; font-weight: 600; line-height: 1.15">${esc(event.title, 34)}</div><div style="font-size: 14px; font-weight: 600; flex-shrink: 0">${esc(event.note, 22)}</div></div>`;
    })
    .join("");
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="position: relative; flex-grow: 1">${lines}${blocks}</div>`,
    { background: c.bg, ink: c.ink },
  );
}

/** A plan over weeks: tasks as bars, who owns each, which are late, and today. */
export function plan(data, theme) {
  const c = theme === "dark" ? DARK : LIGHT;
  const tasks = list(data.tasks, 8);
  const weeks = clamp(Math.round(num(data.weeks) ?? Math.max(4, ...tasks.map((t) => (num(t.start) ?? 0) + (num(t.length) ?? 1)))), 2, 12);
  const label = 160;
  const fill = { done: [c.good, "0"], late: [c.warm, "0"], on_track: [c.accent, "0"] };
  const today = num(data.today);
  const row = tasks.length > 6 ? 52 : 62;
  return page(
    `${heading(c, data.kicker, data.title, { size: 38 })}
<div style="display: flex; flex-direction: column; flex-grow: 1">
<div style="display: flex; padding-bottom: 8px; border-bottom: 1px solid ${c.line}"><div style="width: ${label}px; flex-shrink: 0"></div><div style="flex-grow: 1; display: grid; grid-template-columns: repeat(${weeks}, minmax(0, 1fr)); font-size: 13px; font-weight: 600; color: ${c.muted}; text-align: center">${Array.from({ length: weeks }, (_, i) => `<div>${esc(Array.isArray(data.week_labels) && typeof data.week_labels[i] === "string" ? data.week_labels[i] : `W${i + 1}`, 8)}</div>`).join("")}</div></div>
<div style="position: relative; display: flex; flex-direction: column">
${tasks
  .map((t) => {
    const start = clamp(num(t.start) ?? 0, 0, weeks);
    const length = clamp(num(t.length) ?? 1, 0.25, weeks - start);
    const [bg, border] = fill[t.state] ?? fill.on_track;
    return `<div style="display: flex; align-items: center; height: ${row}px; border-bottom: 1px solid ${c.line}"><div style="width: ${label}px; flex-shrink: 0; display: flex; flex-direction: column; min-width: 0"><div style="font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${esc(t.name, 22)}</div><div style="font-size: 13px; color: ${c.muted}">${esc(t.who, 20)}</div></div>
<div style="position: relative; flex-grow: 1; height: 14px"><div style="position: absolute; top: 0; height: 14px; left: ${pct((start / weeks) * 100)}; width: ${pct((length / weeks) * 100)}; border-radius: 999px; background: ${bg}; border: ${border}"></div></div></div>`;
  })
  .join("")}
${today !== null ? `<div style="position: absolute; top: 0; bottom: 0; left: calc(${label}px + (100% - ${label}px) * ${(clamp(today, 0, weeks) / weeks).toFixed(4)}); width: 2px; background: ${c.ink}"></div>` : ""}
</div>
<div style="display: flex; gap: 18px; padding: 12px 0 6px; font-size: 13px; color: ${c.muted}; align-items: center">
${today !== null ? `<div style="display: flex; align-items: center; gap: 6px"><div style="width: 2px; height: 14px; background: ${c.ink}"></div>Today</div>` : ""}
<div style="display: flex; align-items: center; gap: 6px"><div style="width: 18px; height: 10px; border-radius: 5px; background: ${c.accent}"></div>On track</div>
<div style="display: flex; align-items: center; gap: 6px"><div style="width: 18px; height: 10px; border-radius: 5px; background: ${c.warm}"></div>Late</div>
<div style="display: flex; align-items: center; gap: 6px"><div style="width: 18px; height: 10px; border-radius: 5px; background: ${c.good}"></div>Done</div></div>
</div>`,
    { background: c.bg, ink: c.ink },
  );
}

/** A habit: the streak as one big number, then the last five weeks, oldest first, Monday first. */
export function streak(data) {
  const marks = String(data.marks ?? "").replace(/[^10\-.x ]/gi, "").slice(-35);
  const cells = Array.from({ length: 35 }, (_, i) => marks[i - (35 - marks.length)] ?? "-");
  const count = num(data.count);
  const facts = list(data.facts, 3);
  return page(
    `<div style="display: flex; flex-direction: column; gap: 6px">${data.kicker ? `<div style="font-size: 15px; font-weight: 600; color: #A79F95">${esc(data.kicker, 60)}</div>` : ""}
<div style="display: flex; align-items: baseline; gap: 14px">${count !== null ? `<div style="font-family: 'Instrument Sans', sans-serif; font-size: 96px; line-height: 0.95; font-weight: 600; letter-spacing: -0.015em; color: #82C98E">${esc(count, 5)}</div>` : ""}<div style="font-size: 28px; font-weight: 600; line-height: 1.1">${esc(data.title, 60)}</div></div></div>
<div style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1">
<div style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; font-size: 13px; font-weight: 600; color: #A79F95; text-align: center"><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div><div>S</div></div>
<div style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px">${cells
      .map((mark) => {
        const style = mark === "1" ? "background: #82C98E" : mark === "0" || mark.toLowerCase() === "x" ? "background: #2B2825" : "border: 1px dashed rgba(237,232,224,0.16)";
        return `<div style="height: 58px; border-radius: 10px; ${style}"></div>`;
      })
      .join("")}</div></div>
${facts.length ? `<div style="display: grid; grid-template-columns: repeat(${facts.length}, minmax(0, 1fr)); gap: 10px">${facts.map((f) => `<div style="background: #201E1B; border-radius: 10px; padding: 12px 14px"><div style="font-size: 13px; color: #A79F95">${esc(f.label, 18)}</div><div style="font-size: 24px; font-weight: 600">${esc(f.value, 14)}</div></div>`).join("")}</div>` : ""}`,
    { background: DARK.bg, ink: DARK.ink, gap: 22 },
  );
}

